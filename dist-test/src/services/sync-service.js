import { assertCondition, DomainError } from '../domain/errors.js';
import { computePayloadHash, sameContent, scopeKey, verifyPayloadHash } from './sync-protocol.js';
export class SyncService {
    store;
    sampling;
    custody;
    receiving;
    aliquots;
    constructor(store, sampling, custody, receiving, aliquots) {
        this.store = store;
        this.sampling = sampling;
        this.custody = custody;
        this.receiving = receiving;
        this.aliquots = aliquots;
    }
    async apply(envelope) {
        return this.store.transaction(() => {
            this.validateEnvelope(envelope);
            // The hash is recomputed from canonical payload content: a client cannot
            // claim idempotency for content it did not actually send.
            verifyPayloadHash(envelope);
            const key = scopeKey(envelope);
            const existing = this.store.syncRecords.get(key);
            if (existing)
                return this.replay(existing, envelope);
            return this.firstAttempt(key, envelope);
        });
    }
    firstAttempt(key, envelope) {
        // Claim the operation BEFORE running side effects. If the process dies during
        // dispatch, the claim survives as APPLYING and the next identical retry resumes
        // and heals the operation instead of creating anything twice.
        const claim = {
            key,
            envelope: structuredClone(envelope),
            state: 'APPLYING',
            attempts: 1,
            alternateAttempts: [],
            createdAt: this.store.now(),
        };
        this.store.syncRecords.set(key, claim);
        try {
            const resultReference = this.dispatch(envelope);
            claim.state = 'APPLIED';
            claim.result = 'APPLIED';
            claim.resultReference = resultReference;
            claim.appliedAt = this.store.now();
            return { result: 'APPLIED', resultReference, operationId: envelope.operationId, attempts: claim.attempts };
        }
        catch (error) {
            if (error instanceof DomainError && !error.retryable) {
                // A genuine content/logic conflict is a durable decision: retries with the
                // same payload keep returning CONFLICT instead of re-executing anything.
                claim.state = 'CONFLICT';
                claim.result = 'CONFLICT';
                claim.conflictReason = error.message;
                claim.appliedAt = this.store.now();
                return { result: 'CONFLICT', resultReference: '', operationId: envelope.operationId, attempts: claim.attempts, conflictReason: error.message };
            }
            // Retryable preconditions (missing dependency, out-of-order arrival, holder
            // mismatch while a transfer is in flight) leave no decision behind.
            throw error;
        }
    }
    /**
     * Replay path. Same content always yields the same stable result and reference;
     * different content is routed to conflict handling and never silently skipped.
     */
    replay(record, envelope) {
        record.attempts += 1;
        const identical = sameContent(record.envelope, envelope);
        if (record.state === 'APPLYING' && identical) {
            // Resume a claimed operation whose previous attempt crashed mid-dispatch.
            const resultReference = this.dispatch(envelope);
            if (!record.resultReference) {
                record.state = 'APPLIED';
                record.result = 'APPLIED';
                record.resultReference = resultReference;
                record.appliedAt = this.store.now();
                return { result: 'APPLIED', resultReference, operationId: envelope.operationId, attempts: record.attempts };
            }
            return { result: 'DUPLICATE', resultReference: record.resultReference, operationId: envelope.operationId, attempts: record.attempts };
        }
        if (identical && record.state === 'APPLIED') {
            // Idempotent replay of a completed operation: still dispatch so the services
            // can reconcile any effects a crash skipped (missing container, undeducted
            // volume, missing notifications). Dispatch is content-checked and idempotent;
            // the stable decision and reference never change.
            const healedReference = this.dispatch(envelope);
            return { result: 'DUPLICATE', resultReference: record.resultReference ?? healedReference, operationId: envelope.operationId, attempts: record.attempts };
        }
        if (identical && record.state === 'CONFLICT') {
            return {
                result: 'CONFLICT',
                resultReference: record.resultReference ?? '',
                operationId: envelope.operationId,
                attempts: record.attempts,
                ...(record.conflictReason === undefined ? {} : { conflictReason: record.conflictReason }),
            };
        }
        // Diverging content against an in-flight, applied or already-conflicted op.
        return this.registerAlternate(scopeKey(envelope), record, envelope);
    }
    registerAlternate(key, record, envelope) {
        const reason = this.describeConflict(record, envelope);
        if (record.alternateAttempts.length < 10) {
            record.alternateAttempts.push({ payloadHash: computePayloadHash(envelope), reason, at: this.store.now() });
        }
        // An APPLYING claim can still be resumed by its original content; do not flip
        // its state. An APPLIED op stays APPLIED. A divergent payload never mutates
        // either decision.
        const conflictRecord = {
            key: `${key}#conflict#${envelope.payloadHash}`,
            envelope: structuredClone(envelope),
            state: 'CONFLICT',
            result: 'CONFLICT',
            conflictReason: reason,
            attempts: 1,
            alternateAttempts: [],
            createdAt: this.store.now(),
            appliedAt: this.store.now(),
        };
        this.store.syncRecords.set(conflictRecord.key, conflictRecord);
        return { result: 'CONFLICT', resultReference: record.resultReference ?? '', operationId: envelope.operationId, attempts: record.attempts, conflictReason: reason };
    }
    describeConflict(record, envelope) {
        if (record.state === 'APPLYING')
            return 'operation is still in flight from an earlier attempt; wait for the original payload or resolve the divergent content';
        return `payload for operation ${envelope.operationId} differs from the ${record.state === 'CONFLICT' ? 'previously conflicted' : 'already applied'} request (hash ${record.envelope.payloadHash})`;
    }
    dispatch(envelope) {
        assertCondition(envelope.tenantId.trim().length > 0 && envelope.projectId.trim().length > 0, 'sync.invalid_scope', 'sync envelope must include tenant and project');
        switch (envelope.type) {
            case 'CREATE_SAMPLE': {
                const input = envelope.payload;
                const created = this.sampling.createSealedSample({
                    ...input,
                    tenantId: envelope.tenantId,
                    projectId: envelope.projectId,
                    clientDeviceId: envelope.deviceId,
                    clientSequence: envelope.clientSequence,
                    clientOperationId: envelope.operationId,
                });
                return created.sample.id;
            }
            case 'CUSTODY_TRANSFER': {
                const input = envelope.payload;
                return this.custody.handOver({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
            }
            case 'RECEIVE_CONTAINER': {
                const input = envelope.payload;
                return this.receiving.receive({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientOperationId: envelope.operationId }).id;
            }
            case 'CREATE_ALIQUOT': {
                const input = envelope.payload;
                return this.aliquots.createMany({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, operationId: envelope.operationId }).map((item) => item.id).join(',');
            }
        }
    }
    validateEnvelope(envelope) {
        assertCondition(envelope.deviceId.trim().length > 0, 'sync.invalid_device', 'device id is required');
        assertCondition(envelope.operationId.trim().length > 0, 'sync.invalid_operation', 'operation id is required');
        assertCondition(Number.isInteger(envelope.clientSequence) && envelope.clientSequence >= 0, 'sync.invalid_sequence', 'client sequence must be non-negative');
        assertCondition(envelope.baseVersion >= 0, 'sync.invalid_base_version', 'base version cannot be negative');
        assertCondition(envelope.occurredAt.length > 0, 'sync.invalid_time', 'occurred time is required');
        assertCondition(typeof envelope.payloadHash === 'string' && envelope.payloadHash.length >= 16, 'sync.invalid_hash', 'payload hash is too short');
        assertCondition(typeof envelope.payload === 'object' && envelope.payload !== null, 'sync.invalid_payload', 'payload is required');
        assertCondition(envelope.tenantId.trim().length > 0, 'sync.invalid_scope', 'tenant id is required');
        assertCondition(envelope.projectId.trim().length > 0, 'sync.invalid_scope', 'project id is required');
        switch (envelope.type) {
            case 'CREATE_SAMPLE':
                this.validateCreateSample(envelope.payload);
                break;
            case 'CUSTODY_TRANSFER':
                this.validateHandover(envelope.payload);
                break;
            case 'RECEIVE_CONTAINER':
                this.validateReceive(envelope.payload);
                break;
            case 'CREATE_ALIQUOT':
                this.validateAliquots(envelope.payload);
                break;
        }
    }
    validateCreateSample(payload) {
        const p = payload;
        assertCondition(typeof p.collectorId === 'string' && p.collectorId.length > 0, 'sync.invalid_payload', 'collectorId is required');
        assertCondition(typeof p.protocolVersion === 'string' && p.protocolVersion.length > 0, 'sync.invalid_payload', 'protocolVersion is required');
        assertCondition(['WATER', 'SOIL', 'AIR', 'SEDIMENT'].includes(String(p.medium)), 'sync.invalid_payload', 'medium is invalid');
        assertCondition(typeof p.collectedAt === 'string' && p.collectedAt.length > 0, 'sync.invalid_payload', 'collectedAt is required');
        assertCondition(this.isLocation(p.location), 'sync.invalid_payload', 'location is invalid');
        assertCondition(this.isPreservation(p.preservation), 'sync.invalid_payload', 'preservation is invalid');
        assertCondition(typeof p.containerBarcode === 'string' && p.containerBarcode.length > 0, 'sync.invalid_payload', 'containerBarcode is required');
        assertCondition(typeof p.sealCode === 'string' && p.sealCode.length > 0, 'sync.invalid_payload', 'sealCode is required');
        assertCondition(typeof p.totalVolumeMl === 'number' && p.totalVolumeMl > 0, 'sync.invalid_payload', 'totalVolumeMl must be positive');
    }
    validateHandover(payload) {
        const p = payload;
        for (const field of ['containerId', 'fromHolderId', 'toHolderId', 'fromLocation', 'toLocation', 'handedOverAt']) {
            assertCondition(typeof p[field] === 'string' && String(p[field]).length > 0, 'sync.invalid_payload', `${field} is required`);
        }
        assertCondition(['INTACT', 'BROKEN', 'MISSING', 'RESEALED'].includes(String(p.sealStatus)), 'sync.invalid_payload', 'sealStatus is invalid');
        assertCondition(typeof p.temperatureCelsius === 'number' && Number.isFinite(p.temperatureCelsius), 'sync.invalid_payload', 'temperatureCelsius is invalid');
    }
    validateReceive(payload) {
        const p = payload;
        for (const field of ['containerId', 'receivedBy', 'receivedAt']) {
            assertCondition(typeof p[field] === 'string' && String(p[field]).length > 0, 'sync.invalid_payload', `${field} is required`);
        }
        assertCondition(['ACCEPTED', 'ISOLATED', 'REJECTED'].includes(String(p.decision)), 'sync.invalid_payload', 'decision is invalid');
        assertCondition(['INTACT', 'BROKEN', 'MISSING', 'RESEALED'].includes(String(p.sealStatus)), 'sync.invalid_payload', 'sealStatus is invalid');
        assertCondition(typeof p.temperatureCelsius === 'number' && Number.isFinite(p.temperatureCelsius), 'sync.invalid_payload', 'temperatureCelsius is invalid');
        if (p.reason !== undefined)
            assertCondition(typeof p.reason === 'string', 'sync.invalid_payload', 'reason must be a string');
    }
    validateAliquots(payload) {
        const p = payload;
        assertCondition(typeof p.parentContainerId === 'string' && p.parentContainerId.length > 0, 'sync.invalid_payload', 'parentContainerId is required');
        assertCondition(typeof p.protocolVersion === 'string' && p.protocolVersion.length > 0, 'sync.invalid_payload', 'protocolVersion is required');
        assertCondition(typeof p.createdBy === 'string' && p.createdBy.length > 0, 'sync.invalid_payload', 'createdBy is required');
        assertCondition(Array.isArray(p.items) && p.items.length > 0, 'sync.invalid_payload', 'aliquot items are required');
        for (const item of p.items) {
            const i = item;
            assertCondition(typeof i.barcode === 'string' && i.barcode.length > 0, 'sync.invalid_payload', 'aliquot barcode is required');
            assertCondition(typeof i.volumeMl === 'number' && i.volumeMl > 0, 'sync.invalid_payload', 'aliquot volume must be positive');
            assertCondition(['ML', 'G', 'L'].includes(String(i.unit)), 'sync.invalid_payload', 'aliquot unit is invalid');
        }
    }
    isLocation(value) {
        if (typeof value !== 'object' || value === null)
            return false;
        const location = value;
        return typeof location.latitude === 'number' && typeof location.longitude === 'number' && typeof location.siteCode === 'string' && location.siteCode.length > 0;
    }
    isPreservation(value) {
        if (typeof value !== 'object' || value === null)
            return false;
        const preservation = value;
        return typeof preservation.temperatureCelsius === 'number'
            && typeof preservation.method === 'string' && preservation.method.length > 0
            && typeof preservation.maxTransitHours === 'number' && preservation.maxTransitHours > 0;
    }
}
