import { HardCrashError } from '../domain/errors.js';
class Mutex {
    tail = Promise.resolve();
    async runExclusive(work) {
        const previous = this.tail;
        let release;
        this.tail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            return await work();
        }
        finally {
            release();
        }
    }
}
export class Store {
    samples = new Map();
    containers = new Map();
    transfers = new Map();
    receiving = new Map();
    aliquots = new Map();
    batches = new Map();
    runs = new Map();
    results = new Map();
    quality = new Map();
    evidence = new Map();
    syncRecords = new Map();
    audit = [];
    outbox = [];
    files = new Map();
    lock = new Mutex();
    sequence = 0;
    now() { return new Date().toISOString(); }
    nextId(prefix) {
        this.sequence += 1;
        return `${prefix}_${this.sequence.toString().padStart(8, '0')}`;
    }
    addAudit(input) {
        const record = { ...input, id: this.nextId('audit'), createdAt: this.now() };
        this.audit.push(record);
        return record;
    }
    addOutbox(input) {
        const message = { ...input, id: this.nextId('outbox'), status: 'PENDING', createdAt: this.now() };
        this.outbox.push(message);
        return message;
    }
    /** Idempotency probe used when healing a partially applied operation. */
    hasAudit(action, predicate) {
        return this.audit.some((record) => record.action === action && predicate(record.metadata));
    }
    hasOutbox(topic, aggregateId) {
        return this.outbox.some((message) => message.topic === topic && message.aggregateId === aggregateId);
    }
    snapshot() {
        return {
            sequence: this.sequence,
            samples: structuredClone([...this.samples.values()]),
            containers: structuredClone([...this.containers.values()]),
            transfers: structuredClone([...this.transfers.values()]),
            receiving: structuredClone([...this.receiving.values()]),
            aliquots: structuredClone([...this.aliquots.values()]),
            batches: structuredClone([...this.batches.values()]),
            runs: structuredClone([...this.runs.values()]),
            results: structuredClone([...this.results.values()]),
            quality: structuredClone([...this.quality.values()]),
            evidence: structuredClone([...this.evidence.values()]),
            syncRecords: structuredClone([...this.syncRecords.values()]),
            audit: structuredClone(this.audit),
            outbox: structuredClone(this.outbox),
            files: structuredClone([...this.files.values()]),
        };
    }
    restore(snapshot) {
        this.sequence = snapshot.sequence;
        this.replaceMap(this.samples, snapshot.samples);
        this.replaceMap(this.containers, snapshot.containers);
        this.replaceMap(this.transfers, snapshot.transfers);
        this.replaceMap(this.receiving, snapshot.receiving);
        this.replaceMap(this.aliquots, snapshot.aliquots);
        this.replaceMap(this.batches, snapshot.batches);
        this.replaceMap(this.runs, snapshot.runs);
        this.replaceMap(this.results, snapshot.results);
        this.replaceMap(this.quality, snapshot.quality);
        this.replaceMap(this.evidence, snapshot.evidence);
        this.replaceMap(this.syncRecords, snapshot.syncRecords, (value) => value.key);
        this.replaceMap(this.files, snapshot.files, (value) => value.key);
        this.audit.splice(0, this.audit.length, ...snapshot.audit);
        this.outbox.splice(0, this.outbox.length, ...snapshot.outbox);
    }
    async transaction(work) {
        return this.lock.runExclusive(async () => {
            const before = this.snapshot();
            try {
                return await work();
            }
            catch (error) {
                // A simulated hard crash models process death: entities written so far stay
                // committed (no rollback) and the client retries the whole operation.
                if (error instanceof HardCrashError)
                    throw error;
                this.restore(before);
                throw error;
            }
        });
    }
    replaceMap(target, values, keyOf = (value) => value.id) {
        target.clear();
        for (const value of values)
            target.set(keyOf(value), value);
    }
}
