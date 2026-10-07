import { test } from 'node:test';
import { DomainError } from '../src/domain/errors.js';
import { aliquotEnvelope, assert, counts, expectHardCrash, freshApp, receiveEnvelope, resealEnvelopeForDifferentPayload, sampleEnvelope, tamperPayload, transferEnvelope, } from './helpers.js';
async function sealedContainer(app, overrides = {}, envelopeOptions = {}) {
    const env = sampleEnvelope(overrides, envelopeOptions);
    const outcome = await app.sync.apply(env);
    assert.equal(outcome.result, 'APPLIED');
    const container = [...app.store.containers.values()].find((item) => item.sampleId === outcome.resultReference);
    assert.ok(container, 'a sealed container must accompany every created sample');
    return container.id;
}
// ---------------------------------------------------------------------------
// 1. Two devices: independent sequence spaces, same device never duplicates.
// ---------------------------------------------------------------------------
test('two devices independently offline each create exactly one sample, replays are stable DUPLICATEs', async () => {
    const app = freshApp();
    const device1Seq = { value: 10 };
    const device2Seq = { value: 10 };
    const envA = sampleEnvelope({ barcode: 'BC-DEV1-1' }, { deviceId: 'device_1', operationId: 'd1-op-1', clientSequence: device1Seq.value });
    const envB = sampleEnvelope({ barcode: 'BC-DEV2-1' }, { deviceId: 'device_2', operationId: 'd2-op-1', clientSequence: device2Seq.value });
    const a1 = await app.sync.apply(envA);
    const b1 = await app.sync.apply(envB);
    assert.equal(a1.result, 'APPLIED');
    assert.equal(b1.result, 'APPLIED');
    assert.notEqual(a1.resultReference, b1.resultReference);
    // Gateway retries send the identical client operation many times.
    const a2 = await app.sync.apply(envA);
    const a3 = await app.sync.apply(envA);
    const b2 = await app.sync.apply(envB);
    assert.equal(a2.result, 'DUPLICATE');
    assert.equal(a3.result, 'DUPLICATE');
    assert.equal(b2.result, 'DUPLICATE');
    assert.equal(a2.resultReference, a1.resultReference);
    assert.equal(a3.resultReference, a1.resultReference);
    assert.equal(b2.resultReference, b1.resultReference);
    assert.deepEqual(counts(app), { samples: 2, containers: 2, transfers: 0, receiving: 0, aliquots: 0, syncRecords: 2, audit: 2, outbox: 2 });
    const sample = app.store.samples.get(a1.resultReference);
    assert.equal(sample.status, 'SEALED');
    assert.ok(sample.containerId, 'no registered-but-unfinished sample is allowed');
});
// ---------------------------------------------------------------------------
// 2. Batch upload interrupted mid-stream: resume replays do not duplicate.
// ---------------------------------------------------------------------------
test('batch upload interruption: crash on one row, other rows and the crashed row all converge once', async () => {
    const app = freshApp();
    const batch = Array.from({ length: 5 }, (_, index) => sampleEnvelope({ barcode: `BC-BATCH-${index + 1}` }, { deviceId: 'device_1', operationId: `batch-op-${index + 1}`, clientSequence: 100 + index }));
    await app.sync.apply(batch[0]);
    await app.sync.apply(batch[1]);
    // Process dies while applying the third row, after both entities were written.
    app.sampling.crashPoint = 'after_container_write';
    await expectHardCrash(app.sync.apply(batch[2]), 'sample.create.after_container_write');
    await app.sync.apply(batch[3]);
    await app.sync.apply(batch[4]);
    // Post-crash state: the APPLYING claim plus its two entities exist, notification
    // may be missing, but there must be no orphan container or duplicate sample.
    assert.equal(app.store.samples.size, 5);
    assert.equal(app.store.containers.size, 5);
    for (const container of app.store.containers.values()) {
        assert.ok(app.store.samples.get(container.sampleId), 'every container references a live sample');
    }
    // The crashed row heals to APPLIED on its first identical retry.
    const crashedClaim = [...app.store.syncRecords.values()].find((record) => record.envelope.operationId === 'batch-op-3');
    assert.equal(crashedClaim.state, 'APPLYING');
    const healed = await app.sync.apply(batch[2]);
    assert.equal(healed.result, 'APPLIED');
    assert.equal(crashedClaim.state, 'APPLIED');
    assert.equal(crashedClaim.resultReference, healed.resultReference);
    // Gateway retries the whole batch after reconnect.
    for (const env of batch) {
        const outcome = await app.sync.apply(env);
        assert.ok(outcome.result === 'APPLIED' || outcome.result === 'DUPLICATE', `unexpected ${outcome.result}`);
    }
    assert.equal(app.store.samples.size, 5);
    assert.equal(app.store.containers.size, 5);
    assert.equal(app.store.audit.filter((record) => record.action === 'sample.sealed').length, 5);
    assert.equal(app.store.outbox.filter((message) => message.topic === 'sample.sealed').length, 5);
    for (const sample of app.store.samples.values()) {
        assert.equal(sample.status, 'SEALED');
        const container = app.store.containers.get(sample.containerId);
        assert.equal(container.sealStatus, 'INTACT');
    }
});
// ---------------------------------------------------------------------------
// 3. Out-of-order catch-up: later sequences arriving first must not fail.
// ---------------------------------------------------------------------------
test('out-of-order catch-up: operations arrive in reverse sequence order and all apply', async () => {
    const app = freshApp();
    const containerId = await sealedContainer(app, { barcode: 'BC-SEQ-1' }, { deviceId: 'device_1', operationId: 'seq-op-0', clientSequence: 1 });
    // Receive depends on handover, but the gateway delivers the receive first.
    const receive = receiveEnvelope(containerId, {}, { deviceId: 'device_1', operationId: 'seq-op-2', clientSequence: 3 });
    const handover = transferEnvelope(containerId, {}, { deviceId: 'device_1', operationId: 'seq-op-1', clientSequence: 2 });
    await assert.rejects(app.sync.apply(receive), (error) => error instanceof DomainError && error.code === 'receiving.invalid_state' && error.retryable);
    // No durable claim was made for the retryable failure.
    assert.equal(app.store.syncRecords.size, 1);
    await app.sync.apply(handover);
    const retriedReceive = await app.sync.apply(receive);
    assert.equal(retriedReceive.result, 'APPLIED');
    // A very old sequence number is never rejected as STALE; sequences only order
    // per-device streams, they do not gate application.
    const old = sampleEnvelope({ barcode: 'BC-SEQ-OLD' }, { deviceId: 'device_1', operationId: 'seq-op-late', clientSequence: 0 });
    const late = await app.sync.apply(old);
    assert.equal(late.result, 'APPLIED');
    assert.equal(app.store.samples.size, 2);
    assert.equal(app.store.containers.size, 2);
    assert.equal(app.store.transfers.size, 1);
    assert.equal(app.store.receiving.size, 1);
});
// ---------------------------------------------------------------------------
// 4. Cross-project same operation/barcode: scoped keys keep them distinct.
// ---------------------------------------------------------------------------
test('cross-project same device operation id and same barcode produce independent samples', async () => {
    const app = freshApp();
    const inAlpha = sampleEnvelope({ barcode: 'BC-SHARED' }, {
        tenantId: 'tenant_a', projectId: 'project_alpha', deviceId: 'device_shared', operationId: 'handoff-op-1', clientSequence: 5,
    });
    // Device reused on another project after handoff, same operationId + sequence.
    const inBeta = sampleEnvelope({ barcode: 'BC-SHARED' }, {
        tenantId: 'tenant_a', projectId: 'project_beta', deviceId: 'device_shared', operationId: 'handoff-op-1', clientSequence: 5,
    });
    const alpha = await app.sync.apply(inAlpha);
    const beta = await app.sync.apply(inBeta);
    assert.equal(alpha.result, 'APPLIED');
    assert.equal(beta.result, 'APPLIED');
    assert.notEqual(alpha.resultReference, beta.resultReference);
    // Replays stay scoped: alpha replay returns alpha, beta replay returns beta.
    assert.equal((await app.sync.apply(inAlpha)).resultReference, alpha.resultReference);
    assert.equal((await app.sync.apply(inBeta)).resultReference, beta.resultReference);
    const alphaSample = app.store.samples.get(alpha.resultReference);
    const betaSample = app.store.samples.get(beta.resultReference);
    assert.equal(alphaSample.projectId, 'project_alpha');
    assert.equal(betaSample.projectId, 'project_beta');
    assert.equal(alphaSample.status, 'SEALED');
    assert.equal(betaSample.status, 'SEALED');
    assert.equal(app.store.samples.size, 2);
    assert.equal(app.store.containers.size, 2);
});
// ---------------------------------------------------------------------------
// 5. Repeated requests: same content stable, different content conflicts.
// ---------------------------------------------------------------------------
test('identical retry is a stable idempotent replay; divergent payload is a durable CONFLICT', async () => {
    const app = freshApp();
    const env = sampleEnvelope({ barcode: 'BC-CONFLICT-1', sealCode: 'SEAL-A', volume: 100 }, { deviceId: 'device_1', operationId: 'conflict-op-1', clientSequence: 7 });
    const first = await app.sync.apply(env);
    assert.equal(first.result, 'APPLIED');
    const retry = await app.sync.apply(env);
    assert.equal(retry.result, 'DUPLICATE');
    assert.equal(retry.resultReference, first.resultReference);
    // Same operation id, different content (different seal code), hash recomputed.
    const divergent = resealEnvelopeForDifferentPayload({
        ...env,
        payload: { ...env.payload, sealCode: 'SEAL-B' },
    });
    const conflict1 = await app.sync.apply(divergent);
    assert.equal(conflict1.result, 'CONFLICT');
    assert.ok(conflict1.conflictReason);
    // Conflict is stable: both further divergent replays and the original content
    // replay return the same decisions, nothing is re-executed.
    const conflict2 = await app.sync.apply(divergent);
    assert.equal(conflict2.result, 'CONFLICT');
    const originalAgain = await app.sync.apply(env);
    assert.equal(originalAgain.result, 'DUPLICATE');
    assert.equal(originalAgain.resultReference, first.resultReference);
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    const container = app.store.containers.get(app.store.samples.get(first.resultReference).containerId);
    assert.equal(container.sealCode, 'SEAL-A', 'the originally applied content is never mutated');
});
test('tampered payload whose hash does not match canonical content is rejected without claiming the operation', async () => {
    const app = freshApp();
    const env = sampleEnvelope({ barcode: 'BC-TAMPER-1' }, { operationId: 'tamper-op-1' });
    const tampered = tamperPayload(env, { totalVolumeMl: 999 }); // original hash retained
    await assert.rejects(app.sync.apply(tampered), (error) => error instanceof DomainError && error.code === 'sync.payload_hash_mismatch');
    const clean = await app.sync.apply(env);
    assert.equal(clean.result, 'APPLIED', 'rejection did not consume the idempotency key');
    assert.equal(app.store.samples.size, 1);
});
test('reusing a physical barcode under a new operation in the same project is a durable conflict, not a second sample', async () => {
    const app = freshApp();
    const first = sampleEnvelope({ barcode: 'BC-PHYSICAL-1' }, { operationId: 'physical-op-1', clientSequence: 1 });
    const second = sampleEnvelope({ barcode: 'BC-PHYSICAL-1' }, { operationId: 'physical-op-2', clientSequence: 2 });
    await app.sync.apply(first);
    const outcome = await app.sync.apply(second);
    assert.equal(outcome.result, 'CONFLICT');
    assert.match(outcome.conflictReason ?? '', /barcode/);
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    // Retrying the conflicting operation stays CONFLICT; the first sample is intact.
    assert.equal((await app.sync.apply(second)).result, 'CONFLICT');
});
// ---------------------------------------------------------------------------
// 6. Mid-application failure safety for every operation family.
// ---------------------------------------------------------------------------
test('sample crash before completion leaves no orphan: retry seals the same sample/container and emits once', async () => {
    const app = freshApp();
    const env = sampleEnvelope({ barcode: 'BC-CRASH-1' }, { operationId: 'crash-op-1', clientSequence: 1 });
    app.sampling.crashPoint = 'after_container_write';
    await expectHardCrash(app.sync.apply(env), 'sample.create.after_container_write');
    const claim = [...app.store.syncRecords.values()].find((record) => record.envelope.operationId === 'crash-op-1');
    assert.equal(claim.state, 'APPLYING', 'the crash cannot be reported as success');
    assert.equal(claim.resultReference, undefined);
    const retry = await app.sync.apply(env);
    assert.equal(retry.result, 'APPLIED');
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    assert.equal(app.store.audit.filter((record) => record.action === 'sample.sealed').length, 1);
    assert.equal(app.store.outbox.filter((message) => message.topic === 'sample.sealed').length, 1);
    const sample = [...app.store.samples.values()][0];
    assert.equal(sample.status, 'SEALED');
    assert.equal(sample.containerId, [...app.store.containers.values()][0].id);
    // Further retries are now plain idempotent replays.
    assert.equal((await app.sync.apply(env)).result, 'DUPLICATE');
});
test('handover and receive replays heal state, notifications and logs exactly once', async () => {
    const app = freshApp();
    const containerId = await sealedContainer(app, { barcode: 'BC-FLOW-1' }, { operationId: 'flow-op-0', clientSequence: 1 });
    const handover = transferEnvelope(containerId, {}, { operationId: 'flow-op-1', clientSequence: 2 });
    const receive = receiveEnvelope(containerId, {}, { operationId: 'flow-op-2', clientSequence: 3 });
    await app.sync.apply(handover);
    await app.sync.apply(receive);
    // Simulate every gateway retry after the response was lost.
    assert.equal((await app.sync.apply(handover)).result, 'DUPLICATE');
    assert.equal((await app.sync.apply(receive)).result, 'DUPLICATE');
    assert.equal((await app.sync.apply(handover)).result, 'DUPLICATE');
    const container = app.store.containers.get(containerId);
    assert.equal(container.custodyStatus, 'RELEASED_TO_LAB');
    assert.equal(container.temperatureLog.length, 3, 'initial seal + handover + receipt readings, no duplicates');
    assert.equal(app.store.transfers.size, 1);
    assert.equal(app.store.receiving.size, 1);
    assert.equal(app.store.audit.filter((record) => record.action === 'custody.handed_over').length, 1);
    assert.equal(app.store.audit.filter((record) => record.action === 'sample.received').length, 1);
    assert.equal(app.store.outbox.filter((message) => message.topic === 'custody.handed-over').length, 1);
    assert.equal(app.store.outbox.filter((message) => message.topic === 'sample.received').length, 1);
    // Different content for the same operation is a conflict, never a silent skip.
    const divergent = resealEnvelopeForDifferentPayload({
        ...handover,
        payload: { ...handover.payload, toLocation: 'LAB-SH-B' },
    });
    assert.equal((await app.sync.apply(divergent)).result, 'CONFLICT');
    assert.equal(container.currentLocation, 'LAB-SH-A');
});
test('receive replay after a crash that persisted the record but skipped aggregate effects repairs them once', async () => {
    const app = freshApp();
    const containerId = await sealedContainer(app, { barcode: 'BC-RCV-1' }, { operationId: 'rcv-op-0', clientSequence: 1 });
    await app.sync.apply(transferEnvelope(containerId, {}, { operationId: 'rcv-op-1', clientSequence: 2 }));
    const receive = receiveEnvelope(containerId, {}, { operationId: 'rcv-op-2', clientSequence: 3 });
    await app.sync.apply(receive);
    // Simulate process death after the receiving record was committed but before
    // container/sample effects were durable: revert only those aggregate fields.
    const container = app.store.containers.get(containerId);
    const sample = app.store.samples.get(container.sampleId);
    container.custodyStatus = 'HANDED_OVER';
    sample.status = 'SEALED';
    delete sample.receivedAt;
    container.temperatureLog = container.temperatureLog.filter((reading) => reading.source !== 'LAB_RECEIPT');
    app.store.audit.splice(0, app.store.audit.length, ...app.store.audit.filter((record) => record.action !== 'sample.received'));
    app.store.outbox.splice(0, app.store.outbox.length, ...app.store.outbox.filter((message) => message.topic !== 'sample.received'));
    const replay = await app.sync.apply(receive);
    assert.equal(replay.result, 'DUPLICATE');
    assert.equal(container.custodyStatus, 'RELEASED_TO_LAB');
    assert.equal(sample.status, 'RECEIVED');
    assert.equal(container.temperatureLog.filter((reading) => reading.source === 'LAB_RECEIPT').length, 1);
    assert.equal(app.store.audit.filter((record) => record.action === 'sample.received').length, 1);
    assert.equal(app.store.outbox.filter((message) => message.topic === 'sample.received').length, 1);
    const again = await app.sync.apply(receive);
    assert.equal(again.result, 'DUPLICATE');
    assert.equal(container.temperatureLog.filter((reading) => reading.source === 'LAB_RECEIPT').length, 1);
});
test('aliquot creation is idempotent end-to-end: one batch, one volume deduction, even across retries', async () => {
    const app = freshApp();
    const containerId = await sealedContainer(app, { barcode: 'BC-ALQ-1', volume: 100 }, { operationId: 'alq-op-0', clientSequence: 1 });
    await app.sync.apply(transferEnvelope(containerId, {}, { operationId: 'alq-op-1', clientSequence: 2 }));
    await app.sync.apply(receiveEnvelope(containerId, {}, { operationId: 'alq-op-2', clientSequence: 3 }));
    const aliquot = aliquotEnvelope(containerId, [
        { barcode: 'ALQ-1', volumeMl: 20 },
        { barcode: 'ALQ-2', volumeMl: 30 },
    ], { operationId: 'alq-op-3', clientSequence: 4 });
    const first = await app.sync.apply(aliquot);
    assert.equal(first.result, 'APPLIED');
    assert.equal(first.resultReference.split(',').length, 2);
    for (let i = 0; i < 3; i += 1) {
        const replay = await app.sync.apply(aliquot);
        assert.equal(replay.result, 'DUPLICATE');
        assert.equal(replay.resultReference, first.resultReference);
    }
    assert.equal(app.store.aliquots.size, 2);
    const container = app.store.containers.get(containerId);
    assert.equal(container.availableVolumeMl, 50, 'volume is deducted exactly once across retries');
    assert.equal(app.store.audit.filter((record) => record.action === 'aliquot.created').length, 1);
    assert.equal(app.store.outbox.filter((message) => message.topic === 'aliquot.created').length, 1);
    // Divergent aliquot content for the same operation is conflicted.
    const divergent = resealEnvelopeForDifferentPayload({
        ...aliquot,
        payload: { ...aliquot.payload, items: [{ barcode: 'ALQ-1', volumeMl: 25, unit: 'ML' }] },
    });
    assert.equal((await app.sync.apply(divergent)).result, 'CONFLICT');
    assert.equal(container.availableVolumeMl, 50);
});
test('concurrent duplicate deliveries are serialized: the loser sees a stable DUPLICATE', async () => {
    const app = freshApp();
    const env = sampleEnvelope({ barcode: 'BC-RACE-1' }, { operationId: 'race-op-1', clientSequence: 1 });
    const [first, second] = await Promise.all([app.sync.apply(env), app.sync.apply(env)]);
    const results = [first.result, second.result].sort();
    assert.deepEqual(results, ['APPLIED', 'DUPLICATE']);
    assert.equal(first.resultReference, second.resultReference);
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
});
test('crash after only the sample was written: retry completes the missing container and seals once', async () => {
    const app = freshApp();
    const env = sampleEnvelope({ barcode: 'BC-CRASH-2' }, { operationId: 'crash-op-2', clientSequence: 1 });
    app.sampling.crashPoint = 'after_sample_write';
    await expectHardCrash(app.sync.apply(env), 'sample.create.after_sample_write');
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 0, 'the half-written state has an explicit gap, not a fake container');
    const retry = await app.sync.apply(env);
    assert.equal(retry.result, 'APPLIED');
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    const sample = [...app.store.samples.values()][0];
    const container = [...app.store.containers.values()][0];
    assert.equal(sample.containerId, container.id);
    assert.equal(container.sampleId, sample.id);
    assert.equal(container.sealStatus, 'INTACT');
    assert.equal(app.store.audit.filter((record) => record.action === 'sample.sealed').length, 1);
    assert.equal((await app.sync.apply(env)).result, 'DUPLICATE');
});
test('a divergent payload arriving against an APPLYING claim is conflicted without poisoning resume', async () => {
    const app = freshApp();
    const env = sampleEnvelope({ barcode: 'BC-CRASH-3', sealCode: 'SEAL-A' }, { operationId: 'crash-op-3', clientSequence: 1 });
    app.sampling.crashPoint = 'after_container_write';
    await expectHardCrash(app.sync.apply(env), 'sample.create.after_container_write');
    // A misbehaving gateway resends the operation with different content.
    const divergent = resealEnvelopeForDifferentPayload({
        ...env,
        payload: { ...env.payload, sealCode: 'SEAL-B' },
    });
    const conflict = await app.sync.apply(divergent);
    assert.equal(conflict.result, 'CONFLICT');
    // The original content can still resume and complete.
    const resumed = await app.sync.apply(env);
    assert.equal(resumed.result, 'APPLIED');
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    const container = [...app.store.containers.values()][0];
    assert.equal(container.sealCode, 'SEAL-A');
});
