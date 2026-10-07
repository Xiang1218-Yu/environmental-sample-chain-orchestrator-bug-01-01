import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { DomainError } from '../src/domain/errors.js';
const TENANT = 'tenant_1';
const PROJECT_A = 'project_a';
const PROJECT_B = 'project_b';
function samplePayload(barcode, overrides = {}) {
    return {
        collectorId: 'collector_01',
        protocolVersion: 'water-v3',
        medium: 'WATER',
        collectedAt: '2026-10-06T08:00:00.000Z',
        location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
        preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
        containerBarcode: barcode,
        sealCode: `SEAL-${barcode}`,
        totalVolumeMl: 100,
        ...overrides,
    };
}
function envelope(options) {
    const operationId = options.operationId ?? 'op-1';
    return {
        tenantId: options.tenantId ?? TENANT,
        projectId: options.projectId ?? PROJECT_A,
        deviceId: options.deviceId ?? 'device_1',
        clientSequence: options.clientSequence ?? 1,
        operationId,
        entityId: operationId,
        baseVersion: 0,
        type: options.type ?? 'CREATE_SAMPLE',
        payloadHash: `payload-hash:${JSON.stringify(options.payload)}`,
        payload: options.payload,
        occurredAt: '2026-10-06T08:00:00.000Z',
    };
}
function counts(app) {
    return {
        samples: app.store.samples.size,
        containers: app.store.containers.size,
        transfers: app.store.transfers.size,
        syncRecords: app.store.syncRecords.size,
        audit: app.store.audit.length,
        outbox: app.store.outbox.length,
    };
}
async function assertDomainError(promise, code) {
    await assert.rejects(promise, (error) => error instanceof DomainError && error.code === code);
}
test('重复请求：同内容重试返回稳定结果，不产生重复样本', async () => {
    const app = new SampleChainApplication();
    const env = envelope({ payload: samplePayload('CNT-0001') });
    assert.equal(await app.sync.apply(env), 'APPLIED');
    // Gateway retries deliver the identical envelope again.
    assert.equal(await app.sync.apply(structuredClone(env)), 'APPLIED');
    assert.equal(await app.sync.apply(structuredClone(env)), 'APPLIED');
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    assert.equal(app.store.syncRecords.size, 1);
    assert.equal(app.store.audit.length, 1);
    assert.equal(app.store.outbox.length, 1);
    // The sample is actually sealed, not stuck in a half-registered state.
    const [sample] = [...app.store.samples.values()];
    const [container] = [...app.store.containers.values()];
    assert.equal(sample?.status, 'SEALED');
    assert.equal(container?.sealStatus, 'INTACT');
    assert.equal(sample?.containerId, container?.id);
    const [record] = [...app.store.syncRecords.values()];
    assert.equal(record?.result, 'APPLIED');
    assert.equal(record?.resultReference, sample?.id);
});
test('冲突处理：同操作号不同内容进入 CONFLICT，原始记录保持稳定', async () => {
    const app = new SampleChainApplication();
    const original = envelope({ operationId: 'op-1', payload: samplePayload('CNT-0001') });
    const conflicting = envelope({ operationId: 'op-1', payload: samplePayload('CNT-9999') });
    assert.equal(await app.sync.apply(original), 'APPLIED');
    assert.equal(await app.sync.apply(conflicting), 'CONFLICT');
    // The original operation still returns its stable result.
    assert.equal(await app.sync.apply(structuredClone(original)), 'APPLIED');
    // Redelivery of the conflicting payload is stable too.
    assert.equal(await app.sync.apply(structuredClone(conflicting)), 'CONFLICT');
    // The conflicting payload never created a second sample.
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    const records = [...app.store.syncRecords.values()];
    const main = records.find((record) => record.key === `${TENANT}|${PROJECT_A}|device_1|op-1`);
    assert.equal(main?.result, 'APPLIED');
    assert.equal(main?.conflictReason, undefined);
    const conflicts = records.filter((record) => record.result === 'CONFLICT');
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0]?.conflictReason ?? '', /different payload/);
});
test('跨项目同号：同一设备同一操作号在不同项目各自独立应用', async () => {
    const app = new SampleChainApplication();
    // Device is reused after a handoff: per-project operation numbering restarts.
    const inA = envelope({ projectId: PROJECT_A, operationId: 'op-1', clientSequence: 1, payload: samplePayload('CNT-A-001') });
    const inB = envelope({ projectId: PROJECT_B, operationId: 'op-1', clientSequence: 1, payload: samplePayload('CNT-B-001') });
    assert.equal(await app.sync.apply(inA), 'APPLIED');
    // Must not be skipped as a duplicate of project A's operation.
    assert.equal(await app.sync.apply(inB), 'APPLIED');
    assert.equal(app.store.samples.size, 2);
    const projects = [...app.store.samples.values()].map((sample) => sample.projectId).sort();
    assert.deepEqual(projects, [PROJECT_A, PROJECT_B]);
    // Retries in each project stay stable and independent.
    assert.equal(await app.sync.apply(structuredClone(inA)), 'APPLIED');
    assert.equal(await app.sync.apply(structuredClone(inB)), 'APPLIED');
    assert.equal(app.store.samples.size, 2);
});
test('跨项目同条码：一个物理容器不能登记出两个样本', async () => {
    const app = new SampleChainApplication();
    const inA = envelope({ projectId: PROJECT_A, operationId: 'op-1', payload: samplePayload('CNT-SHARED') });
    // Identical physical container uploaded into another project (even with the
    // same operation id and payload) must not alias project A's record.
    const inB = envelope({ projectId: PROJECT_B, operationId: 'op-1', payload: samplePayload('CNT-SHARED') });
    assert.equal(await app.sync.apply(inA), 'APPLIED');
    await assertDomainError(app.sync.apply(inB), 'sample.barcode_conflict');
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    // The failed attempt left no record, so it can never be mistaken for completed.
    assert.equal(app.store.syncRecords.size, 1);
    // Retrying the failed upload keeps failing loudly instead of a false success.
    await assertDomainError(app.sync.apply(structuredClone(inB)), 'sample.barcode_conflict');
    assert.equal(app.store.samples.size, 1);
});
test('两台设备：独立流水各自应用，同一物理容器仍然唯一', async () => {
    const app = new SampleChainApplication();
    const first = envelope({ deviceId: 'device_1', operationId: 'op-1', clientSequence: 1, payload: samplePayload('CNT-1001') });
    const second = envelope({ deviceId: 'device_2', operationId: 'op-1', clientSequence: 1, payload: samplePayload('CNT-1002') });
    assert.equal(await app.sync.apply(first), 'APPLIED');
    // Same operation id and sequence on another device is an independent stream.
    assert.equal(await app.sync.apply(second), 'APPLIED');
    assert.equal(app.store.samples.size, 2);
    // The second device re-scans a container the first device already registered.
    const rescanned = envelope({ deviceId: 'device_2', operationId: 'op-2', clientSequence: 2, payload: samplePayload('CNT-1001') });
    await assertDomainError(app.sync.apply(rescanned), 'sample.barcode_conflict');
    assert.equal(app.store.samples.size, 2);
    assert.equal(app.store.containers.size, 2);
});
test('批量上传中断：重传整批不产生重复，未完成的继续应用', async () => {
    const app = new SampleChainApplication();
    const batch = Array.from({ length: 5 }, (_, index) => envelope({ operationId: `op-${index + 1}`, clientSequence: index + 1, payload: samplePayload(`CNT-B${index + 1}`) }));
    // Connection drops after the first three envelopes were applied.
    for (const env of batch.slice(0, 3))
        assert.equal(await app.sync.apply(env), 'APPLIED');
    assert.equal(app.store.samples.size, 3);
    // The client re-uploads the whole batch after reconnecting.
    const results = [];
    for (const env of batch)
        results.push(await app.sync.apply(structuredClone(env)));
    assert.deepEqual(results, ['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
    assert.equal(app.store.samples.size, 5);
    assert.equal(app.store.containers.size, 5);
    assert.equal(app.store.syncRecords.size, 5);
    assert.equal(app.store.audit.length, 5);
    assert.equal(app.store.outbox.length, 5);
});
test('乱序补传：窗口内的迟到操作照常应用，窗口外的标记 STALE', async () => {
    const app = new SampleChainApplication();
    const make = (sequence) => envelope({ operationId: `op-${sequence}`, clientSequence: sequence, payload: samplePayload(`CNT-S${sequence}`) });
    assert.equal(await app.sync.apply(make(1)), 'APPLIED');
    assert.equal(await app.sync.apply(make(2)), 'APPLIED');
    assert.equal(await app.sync.apply(make(5)), 'APPLIED');
    // Late backfill inside the replay window still applies.
    assert.equal(await app.sync.apply(make(3)), 'APPLIED');
    assert.equal(await app.sync.apply(make(4)), 'APPLIED');
    assert.equal(app.store.samples.size, 5);
    // Far below the high-water mark the envelope is stale, and stays stale.
    assert.equal(await app.sync.apply(make(1500)), 'APPLIED');
    const stale = make(100);
    assert.equal(await app.sync.apply(stale), 'STALE');
    assert.equal(await app.sync.apply(structuredClone(stale)), 'STALE');
    assert.equal(app.store.samples.size, 6);
});
test('中途失败：校验失败后可安全重试，失败不留任何痕迹', async () => {
    const app = new SampleChainApplication();
    const before = counts(app);
    // First attempt is rejected during envelope validation (barcode missing).
    const invalid = envelope({ operationId: 'op-9', clientSequence: 9, payload: samplePayload('') });
    await assertDomainError(app.sync.apply(invalid), 'sync.invalid_payload');
    assert.deepEqual(counts(app), before);
    // The client fixes the payload and retries with the same operation id:
    // it must be applied, not skipped as completed and not flagged as conflict.
    const fixed = envelope({ operationId: 'op-9', clientSequence: 9, payload: samplePayload('CNT-0009') });
    assert.equal(await app.sync.apply(fixed), 'APPLIED');
    assert.equal(app.store.samples.size, 1);
});
test('中途失败：派发阶段失败整体回滚，修正后重试成功', async () => {
    const app = new SampleChainApplication();
    assert.equal(await app.sync.apply(envelope({ operationId: 'op-1', clientSequence: 1, payload: samplePayload('CNT-0001') })), 'APPLIED');
    const before = counts(app);
    // This operation fails inside dispatch because the barcode is taken.
    const clashing = envelope({ operationId: 'op-2', clientSequence: 2, payload: samplePayload('CNT-0001') });
    await assertDomainError(app.sync.apply(clashing), 'sample.barcode_conflict');
    // Rollback is complete: no sample, container, audit, outbox or sync record.
    assert.deepEqual(counts(app), before);
    // Same operation id with a corrected barcode applies cleanly.
    const corrected = envelope({ operationId: 'op-2', clientSequence: 2, payload: samplePayload('CNT-0002') });
    assert.equal(await app.sync.apply(corrected), 'APPLIED');
    assert.equal(app.store.samples.size, 2);
});
test('序列复用：同设备同序列不同内容按冲突拒绝而不是静默跳过', async () => {
    const app = new SampleChainApplication();
    assert.equal(await app.sync.apply(envelope({ operationId: 'op-1', clientSequence: 1, payload: samplePayload('CNT-0001') })), 'APPLIED');
    // Client bug reused sequence 1 for a different physical container.
    const reused = envelope({ operationId: 'op-2', clientSequence: 1, payload: samplePayload('CNT-0002') });
    await assertDomainError(app.sync.apply(reused), 'sample.sequence_conflict');
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    assert.equal(app.store.syncRecords.size, 1);
});
test('孤立容器防护：客户端预分配样本号冲突时拒绝覆盖', async () => {
    const app = new SampleChainApplication();
    const first = envelope({ operationId: 'op-1', clientSequence: 1, payload: samplePayload('CNT-0001', { sampleId: 'sample_client_1' }) });
    assert.equal(await app.sync.apply(first), 'APPLIED');
    const [original] = [...app.store.samples.values()];
    const originalContainerId = original?.containerId;
    // A different operation reuses the client-generated sample id.
    const hijack = envelope({ operationId: 'op-2', clientSequence: 2, payload: samplePayload('CNT-0002', { sampleId: 'sample_client_1' }) });
    await assertDomainError(app.sync.apply(hijack), 'sample.id_conflict');
    // The original sample still points at its original container; nothing orphaned.
    assert.equal(app.store.samples.size, 1);
    assert.equal(app.store.containers.size, 1);
    assert.equal(app.store.samples.get('sample_client_1')?.containerId, originalContainerId);
    const [container] = [...app.store.containers.values()];
    assert.equal(container?.sampleId, 'sample_client_1');
});
test('交接幂等：同一交接操作重放只登记一次，跨租户同号被拒绝', async () => {
    const app = new SampleChainApplication();
    const created = envelope({ operationId: 'op-create', clientSequence: 1, payload: samplePayload('CNT-0001') });
    assert.equal(await app.sync.apply(created), 'APPLIED');
    const [container] = [...app.store.containers.values()];
    assert.ok(container);
    const handover = envelope({
        operationId: 'op-handover',
        clientSequence: 2,
        type: 'CUSTODY_TRANSFER',
        payload: {
            containerId: container.id,
            fromHolderId: 'collector_01',
            toHolderId: 'courier_01',
            fromLocation: 'SITE-SH-01',
            toLocation: 'LAB-SH-A',
            handedOverAt: '2026-10-06T08:30:00.000Z',
            temperatureCelsius: 5,
            sealStatus: 'INTACT',
        },
    });
    assert.equal(await app.sync.apply(handover), 'APPLIED');
    assert.equal(await app.sync.apply(structuredClone(handover)), 'APPLIED');
    assert.equal(app.store.transfers.size, 1);
    // The same operation id replayed under another tenant must not alias it.
    const crossTenant = { ...structuredClone(handover), tenantId: 'tenant_2' };
    await assertDomainError(app.sync.apply(crossTenant), 'scope.forbidden');
    assert.equal(app.store.transfers.size, 1);
});
