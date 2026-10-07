import type { SampleContainer, SamplingRecord } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface CreateSampleInput {
  tenantId: string;
  projectId: string;
  collectorId: string;
  protocolVersion: string;
  medium: SamplingRecord['medium'];
  collectedAt: string;
  location: SamplingRecord['location'];
  preservation: SamplingRecord['preservation'];
  clientDeviceId: string;
  clientSequence: number;
  sampleId?: string;
  containerBarcode: string;
  sealCode: string;
  totalVolumeMl: number;
}

export class SamplingService {
  constructor(private readonly store: Store) {}

  createSealedSample(input: CreateSampleInput): { sample: SamplingRecord; container: SampleContainer } {
    const existing = [...this.store.samples.values()].find((sample) => sample.tenantId === input.tenantId && sample.projectId === input.projectId && sample.clientDeviceId === input.clientDeviceId && sample.clientSequence === input.clientSequence);
    if (existing) {
      const container = assertFound(existing.containerId ? this.store.containers.get(existing.containerId) : undefined, 'sample.container_missing', 'sample container missing');
      // Same client coordinates with different content is a conflict, not a replay:
      // silently returning the existing sample would drop the new physical container.
      assertCondition(container.barcode === input.containerBarcode, 'sample.sequence_conflict', 'client sequence was already used with a different container barcode');
      return { sample: existing, container };
    }
    assertCondition(input.totalVolumeMl > 0, 'sample.invalid_volume', 'sample volume must be positive');
    assertCondition(input.preservation.temperatureCelsius >= -80 && input.preservation.temperatureCelsius <= 40, 'sample.invalid_temperature', 'sample preservation temperature is outside supported range');
    const sampleId = input.sampleId ?? this.store.nextId('sample');
    // A client-supplied id must never overwrite an existing sample — that would
    // orphan the container the overwritten sample pointed to.
    assertCondition(!this.store.samples.has(sampleId), 'sample.id_conflict', 'sample id is already registered');
    const containerId = this.store.nextId('container');
    const sample: SamplingRecord = {
      id: sampleId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      collectorId: input.collectorId,
      protocolVersion: input.protocolVersion,
      medium: input.medium,
      collectedAt: input.collectedAt,
      location: input.location,
      preservation: input.preservation,
      status: 'SEALED',
      clientDeviceId: input.clientDeviceId,
      clientSequence: input.clientSequence,
      containerId,
      version: 1,
    };
    // A barcode identifies a physical container, so uniqueness is tenant-wide:
    // registering the same barcode in two projects would create two samples for
    // one physical container.
    const barcodeConflict = [...this.store.containers.values()].find((item) => item.tenantId === input.tenantId && item.barcode === input.containerBarcode);
    if (barcodeConflict) throw new DomainError('sample.barcode_conflict', 'container barcode already belongs to another sample in this tenant');
    const container: SampleContainer = {
      id: containerId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      sampleId,
      barcode: input.containerBarcode,
      sealCode: input.sealCode,
      sealStatus: 'INTACT',
      custodyStatus: 'SEALED',
      currentHolderId: input.collectorId,
      currentLocation: input.location.siteCode,
      temperatureLog: [{ recordedAt: input.collectedAt, celsius: input.preservation.temperatureCelsius, source: 'HANDHELD' }],
      availableVolumeMl: input.totalVolumeMl,
      totalVolumeMl: input.totalVolumeMl,
      version: 1,
    };
    this.store.samples.set(sample.id, sample);
    this.store.containers.set(container.id, container);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.sealed', entity: 'sample', entityId: sample.id, metadata: { containerId, protocolVersion: input.protocolVersion } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.sealed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId, protocolVersion: input.protocolVersion }) });
    return { sample, container };
  }

  markDisposed(sampleId: string, actorId: string): void {
    const sample = assertFound(this.store.samples.get(sampleId), 'sample.not_found', 'sample not found');
    const container = assertFound(sample.containerId ? this.store.containers.get(sample.containerId) : undefined, 'sample.container_missing', 'sample container missing');
    assertCondition(sample.status === 'RECEIVED' || sample.status === 'ISOLATED' || sample.status === 'CONSUMED', 'sample.invalid_dispose_state', 'sample cannot be disposed from its current state');
    sample.status = 'DISPOSED';
    sample.version += 1;
    container.custodyStatus = 'ISOLATED';
    container.version += 1;
    this.store.addAudit({ tenantId: sample.tenantId, projectId: sample.projectId, action: 'sample.disposed', entity: 'sample', entityId: sample.id, metadata: { actorId } });
    this.store.addOutbox({ tenantId: sample.tenantId, projectId: sample.projectId, topic: 'sample.disposed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, actorId }) });
  }
}
