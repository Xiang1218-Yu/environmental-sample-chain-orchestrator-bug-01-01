import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import { computePayloadHash } from '../src/services/sync-protocol.js';
import { HardCrashError } from '../src/domain/errors.js';
export { assert };
export function freshApp() {
    return new SampleChainApplication();
}
let sequence = 0;
export function nextSequence() {
    sequence += 1;
    return sequence;
}
function envelope(type, payload, options = {}) {
    const draft = { type, payload };
    return {
        tenantId: options.tenantId ?? 'tenant_a',
        projectId: options.projectId ?? 'project_alpha',
        deviceId: options.deviceId ?? 'device_field_1',
        operationId: options.operationId ?? `op-${nextSequence()}`,
        clientSequence: options.clientSequence ?? nextSequence(),
        entityId: options.entityId ?? '',
        baseVersion: options.baseVersion ?? 0,
        type,
        payload,
        payloadHash: computePayloadHash(draft),
        occurredAt: options.occurredAt ?? '2026-10-07T08:00:00.000Z',
    };
}
export function sampleEnvelope(overrides = {}, options = {}) {
    return envelope('CREATE_SAMPLE', {
        collectorId: overrides.collectorId ?? 'collector_1',
        protocolVersion: 'water-v3',
        medium: 'WATER',
        collectedAt: overrides.collectedAt ?? '2026-10-07T08:00:00.000Z',
        location: { longitude: 121.47, latitude: 31.23, siteCode: 'SITE-SH-01' },
        preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
        containerBarcode: overrides.barcode ?? `BC-${nextSequence()}`,
        sealCode: overrides.sealCode ?? 'SEAL-1',
        totalVolumeMl: overrides.volume ?? 100,
    }, options);
}
export function transferEnvelope(sampleContainerId, overrides = {}, options = {}) {
    return envelope('CUSTODY_TRANSFER', {
        containerId: sampleContainerId,
        fromHolderId: overrides.from ?? 'collector_1',
        toHolderId: overrides.to ?? 'courier_1',
        fromLocation: 'SITE-SH-01',
        toLocation: 'LAB-SH-A',
        handedOverAt: '2026-10-07T09:00:00.000Z',
        temperatureCelsius: 5,
        sealStatus: overrides.sealStatus ?? 'INTACT',
    }, options);
}
export function receiveEnvelope(sampleContainerId, overrides = {}, options = {}) {
    return envelope('RECEIVE_CONTAINER', {
        containerId: sampleContainerId,
        receivedBy: overrides.receivedBy ?? 'lab_receiver_1',
        receivedAt: '2026-10-07T10:00:00.000Z',
        temperatureCelsius: 5,
        sealStatus: 'INTACT',
        decision: overrides.decision ?? 'ACCEPTED',
    }, options);
}
export function aliquotEnvelope(sampleContainerId, items, options = {}) {
    return envelope('CREATE_ALIQUOT', {
        parentContainerId: sampleContainerId,
        protocolVersion: 'water-v3',
        createdBy: 'analyst_1',
        items: items.map((item) => ({ barcode: item.barcode, volumeMl: item.volumeMl, unit: item.unit ?? 'ML' })),
    }, options);
}
export function resealEnvelopeForDifferentPayload(env) {
    return { ...env, payloadHash: computePayloadHash(env) };
}
/** Rebuild an envelope with a tampered payload but keep the original (now wrong) hash. */
export function tamperPayload(env, patch) {
    return { ...env, payload: { ...env.payload, ...patch } };
}
export async function expectHardCrash(promise, code) {
    await assert.rejects(promise, (error) => error instanceof HardCrashError && error.code === code);
}
export function counts(app) {
    return {
        samples: app.store.samples.size,
        containers: app.store.containers.size,
        transfers: app.store.transfers.size,
        receiving: app.store.receiving.size,
        aliquots: app.store.aliquots.size,
        syncRecords: app.store.syncRecords.size,
        audit: app.store.audit.length,
        outbox: app.store.outbox.length,
    };
}
