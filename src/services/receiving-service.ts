import type { ReceivingDecision, ReceivingRecord } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { deterministicId } from '../domain/ids.js';
import { Store } from '../store/store.js';

export interface ReceiveInput {
  tenantId: string;
  projectId: string;
  containerId: string;
  receivedBy: string;
  receivedAt: string;
  temperatureCelsius: number;
  sealStatus: 'INTACT' | 'BROKEN' | 'MISSING' | 'RESEALED';
  decision: ReceivingDecision;
  reason?: string;
  clientOperationId: string;
}

export class ReceivingService {
  constructor(private readonly store: Store) {}

  receive(input: ReceiveInput): ReceivingRecord {
    const id = deterministicId('receiving', [input.tenantId, input.projectId, input.clientOperationId]);
    const duplicate = [...this.store.receiving.values()].find(
      (item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.clientOperationId === input.clientOperationId,
    ) ?? this.store.receiving.get(id);
    if (duplicate) {
      this.assertSameContent(duplicate, input);
      return this.heal(duplicate, input);
    }

    const container = assertFound(this.store.containers.get(input.containerId), 'receiving.container_not_found', 'container not found', /* retryable */ true);
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    assertCondition(container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'HANDED_OVER', 'receiving.invalid_state', 'container is not ready for receiving', /* retryable */ true);
    const sample = assertFound(this.store.samples.get(container.sampleId), 'receiving.sample_not_found', 'sample not found', /* retryable */ true);

    const record: ReceivingRecord = {
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      containerId: input.containerId,
      decision: input.decision,
      receivedBy: input.receivedBy,
      receivedAt: input.receivedAt,
      temperatureCelsius: input.temperatureCelsius,
      sealStatus: input.sealStatus,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      clientOperationId: input.clientOperationId,
      version: 1,
    };
    this.store.receiving.set(id, record);
    this.applyEffects(record, container, sample);
    this.emitCompletion(record, container, sample, input);
    return record;
  }

  private heal(record: ReceivingRecord, input: ReceiveInput): ReceivingRecord {
    const container = this.store.containers.get(record.containerId);
    const sample = container ? this.store.samples.get(container.sampleId) : undefined;
    if (container && sample) {
      this.applyEffects(record, container, sample);
      this.emitCompletion(record, container, sample, input);
    }
    return record;
  }

  private applyEffects(record: ReceivingRecord, container: NonNullable<ReturnType<Store['containers']['get']>>, sample: NonNullable<ReturnType<Store['samples']['get']>>): void {
    container.custodyStatus = record.decision === 'ACCEPTED' ? 'RELEASED_TO_LAB' : 'ISOLATED';
    container.sealStatus = record.sealStatus;
    if (!container.temperatureLog.some((reading) => reading.recordedAt === record.receivedAt && reading.source === 'LAB_RECEIPT')) {
      container.temperatureLog.push({ recordedAt: record.receivedAt, celsius: record.temperatureCelsius, source: 'LAB_RECEIPT' });
    }
    container.version += 1;
    sample.status = record.decision === 'ACCEPTED' ? 'RECEIVED' : 'ISOLATED';
    sample.receivedAt = record.receivedAt;
    sample.version += 1;
  }

  private emitCompletion(record: ReceivingRecord, container: { id: string }, sample: { id: string }, input: ReceiveInput): void {
    if (!this.store.hasAudit('sample.received', (metadata) => metadata.receivingId === record.id)) {
      this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.received', entity: 'container', entityId: container.id, metadata: { decision: record.decision, sealStatus: record.sealStatus, receivingId: record.id } });
    }
    if (!this.store.hasOutbox('sample.received', sample.id)) {
      this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.received', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, decision: record.decision }) });
    }
  }

  private assertSameContent(record: ReceivingRecord, input: ReceiveInput): void {
    const same = record.containerId === input.containerId
      && record.receivedBy === input.receivedBy
      && record.receivedAt === input.receivedAt
      && record.temperatureCelsius === input.temperatureCelsius
      && record.sealStatus === input.sealStatus
      && record.decision === input.decision
      && record.reason === input.reason;
    assertCondition(same, 'sync.payload_conflict', 'same client operation id was submitted with a different receiving payload');
  }
}
