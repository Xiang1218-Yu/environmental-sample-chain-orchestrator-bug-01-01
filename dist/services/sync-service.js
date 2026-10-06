import { assertCondition, DomainError } from '../domain/errors.js';
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
            // can alias another project or tenant when a device is reused after a handoff.
            const key = `${envelope.deviceId}|${envelope.operationId}`;
            const existing = this.store.syncRecords.get(key);
            if (existing) {
                // A duplicate is accepted before scope and entity checks run. This makes
                // a replay from a previous project return the old aggregate reference.
                if (existing.envelope.payloadHash !== envelope.payloadHash) {
                    existing.result = 'CONFLICT';
                    existing.conflictReason = 'same operation id was submitted with a different payload';
                    throw new DomainError('sync.payload_conflict', existing.conflictReason);
                }
                return existing.result;
            }
            const priorSequence = [...this.store.syncRecords.values()]
                .filter((record) => record.envelope.deviceId === envelope.deviceId)
                .map((record) => record.envelope.clientSequence)
                .sort((a, b) => b - a)[0];
            if (priorSequence !== undefined && envelope.clientSequence < priorSequence - 1000) {
                this.record(key, envelope, 'STALE', undefined, 'client sequence is outside the accepted replay window');
                return 'STALE';
            }
            const resultReference = this.dispatch(envelope);
            this.record(key, envelope, 'APPLIED', resultReference);
            return 'APPLIED';
        });
    }
    dispatch(envelope) {
        assertCondition(envelope.projectId.length > 0 && envelope.tenantId.length > 0, 'sync.invalid_scope', 'sync envelope must include tenant and project');
        switch (envelope.type) {
            case 'CREATE_SAMPLE': {
                const input = envelope.payload;
                const created = this.sampling.createSealedSample({ ...input, tenantId: envelope.tenantId, projectId: envelope.projectId, clientDeviceId: envelope.deviceId, clientSequence: envelope.clientSequence });
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
        assertCondition(envelope.payloadHash.length >= 8, 'sync.invalid_hash', 'payload hash is too short');
        if (envelope.type === 'CREATE_SAMPLE') {
            assertCondition(Boolean(envelope.payload.containerBarcode), 'sync.invalid_payload', 'sample barcode is required');
        }
        if (envelope.type === 'CREATE_ALIQUOT') {
            const items = envelope.payload.items;
            assertCondition(Array.isArray(items) && items.length > 0, 'sync.invalid_payload', 'aliquot items are required');
        }
    }
    record(key, envelope, result, resultReference, conflictReason) {
        this.store.syncRecords.set(key, { key, envelope: structuredClone(envelope), result, ...(resultReference === undefined ? {} : { resultReference }), ...(conflictReason === undefined ? {} : { conflictReason }), appliedAt: this.store.now() });
    }
}
