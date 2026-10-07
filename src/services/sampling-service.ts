import type { SampleContainer, SamplingRecord } from '../domain/types.js';
import { assertCondition, assertFound, DomainError, HardCrashError } from '../domain/errors.js';
import { deterministicId } from '../domain/ids.js';
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
  clientOperationId: string;
  containerBarcode: string;
  sealCode: string;
  totalVolumeMl: number;
}

export class SamplingService {
  /**
   * Test hook: when set, the next createSealedSample call dies at the named point
   * without transaction rollback, emulating a process crash mid-application.
   */
  crashPoint?: 'after_sample_write' | 'after_container_write' | undefined;

  constructor(private readonly store: Store) {}

  createSealedSample(input: CreateSampleInput): { sample: SamplingRecord; container: SampleContainer } {
    assertCondition(input.totalVolumeMl > 0, 'sample.invalid_volume', 'sample volume must be positive');
    assertCondition(input.preservation.temperatureCelsius >= -80 && input.preservation.temperatureCelsius <= 40, 'sample.invalid_temperature', 'sample preservation temperature is outside supported range');

    const sampleId = deterministicId('sample', [input.tenantId, input.projectId, input.clientDeviceId, input.clientOperationId]);
    const containerId = deterministicId('container', [input.tenantId, input.projectId, input.clientDeviceId, input.clientOperationId]);

    const existing = [...this.store.samples.values()].find(
      (sample) => sample.tenantId === input.tenantId && sample.projectId === input.projectId && sample.clientOperationId === input.clientOperationId,
    );
    const expected = existing ?? this.store.samples.get(sampleId);
    if (expected) {
      const container = this.store.containers.get(expected.containerId ?? containerId) ?? this.store.containers.get(containerId);
      // Replay after a crash that left only the sample: complete the missing half.
      if (!container) {
        if (expected.id !== sampleId) throw new DomainError('sample.orphan_sample', 'sealed sample exists without its container and the id cannot be derived');
        const healed = this.writeContainer(expected, containerId, input);
        this.emitCompletion(expected, healed, input);
        return { sample: expected, container: healed };
      }
      this.assertSameContent(expected, container, input);
      // Both entities exist but a crash may have skipped the completion notifications.
      this.emitCompletion(expected, container, input);
      return { sample: expected, container: container };
    }

    // Crash after the sample was written but before the container existed.
    const orphanContainer = this.store.containers.get(containerId);
    if (orphanContainer) {
      const healed = this.writeSample(containerId, input);
      return { sample: healed, container: orphanContainer };
    }

    // A different sample in the same tenant/project already owns the physical barcode.
    const barcodeConflict = [...this.store.containers.values()].find(
      (item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.barcode === input.containerBarcode && item.id !== containerId,
    );
    assertCondition(!barcodeConflict, 'sample.barcode_conflict', 'container barcode already belongs to another sample in this project');

    const sample: SamplingRecord = {
      id: sampleId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      collectorId: input.collectorId,
      protocolVersion: input.protocolVersion,
      medium: input.medium,
      collectedAt: input.collectedAt,
      location: structuredClone(input.location),
      preservation: structuredClone(input.preservation),
      status: 'SEALED',
      clientDeviceId: input.clientDeviceId,
      clientSequence: input.clientSequence,
      clientOperationId: input.clientOperationId,
      barcode: input.containerBarcode,
      containerId,
      version: 1,
    };
    this.store.samples.set(sample.id, sample);

    if (this.crashPoint === 'after_sample_write') {
      this.crashPoint = undefined;
      throw new HardCrashError('sample.create.after_sample_write');
    }

    const container = this.writeContainer(sample, containerId, input);

    if (this.crashPoint === 'after_container_write') {
      this.crashPoint = undefined;
      throw new HardCrashError('sample.create.after_container_write');
    }

    this.emitCompletion(sample, container, input);
    return { sample, container };
  }

  private writeSample(containerId: string, input: CreateSampleInput): SamplingRecord {
    const sampleId = deterministicId('sample', [input.tenantId, input.projectId, input.clientDeviceId, input.clientOperationId]);
    const sample: SamplingRecord = {
      id: sampleId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      collectorId: input.collectorId,
      protocolVersion: input.protocolVersion,
      medium: input.medium,
      collectedAt: input.collectedAt,
      location: structuredClone(input.location),
      preservation: structuredClone(input.preservation),
      status: 'SEALED',
      clientDeviceId: input.clientDeviceId,
      clientSequence: input.clientSequence,
      clientOperationId: input.clientOperationId,
      barcode: input.containerBarcode,
      containerId,
      version: 1,
    };
    this.store.samples.set(sample.id, sample);
    const container = assertFound(this.store.containers.get(containerId), 'sample.container_missing', 'sample container missing');
    this.emitCompletion(sample, container, input);
    return sample;
  }

  private writeContainer(sample: SamplingRecord, containerId: string, input: CreateSampleInput): SampleContainer {
    const container: SampleContainer = {
      id: containerId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      sampleId: sample.id,
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
    this.store.containers.set(container.id, container);
    return container;
  }

  private emitCompletion(sample: SamplingRecord, container: SampleContainer, input: CreateSampleInput): void {
    if (!this.store.hasAudit('sample.sealed', (metadata) => metadata.sampleId === sample.id)) {
      this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'sample.sealed', entity: 'sample', entityId: sample.id, metadata: { sampleId: sample.id, containerId: container.id, protocolVersion: input.protocolVersion } });
    }
    if (!this.store.hasOutbox('sample.sealed', sample.id)) {
      this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'sample.sealed', aggregateId: sample.id, payload: JSON.stringify({ sampleId: sample.id, containerId: container.id, protocolVersion: input.protocolVersion }) });
    }
  }

  private assertSameContent(sample: SamplingRecord, container: SampleContainer, input: CreateSampleInput): void {
    const same = sample.projectId === input.projectId
      && sample.clientDeviceId === input.clientDeviceId
      && sample.clientSequence === input.clientSequence
      && sample.collectorId === input.collectorId
      && sample.protocolVersion === input.protocolVersion
      && sample.medium === input.medium
      && sample.collectedAt === input.collectedAt
      && sample.location.latitude === input.location.latitude
      && sample.location.longitude === input.location.longitude
      && sample.location.siteCode === input.location.siteCode
      && sample.preservation.temperatureCelsius === input.preservation.temperatureCelsius
      && sample.preservation.method === input.preservation.method
      && sample.preservation.maxTransitHours === input.preservation.maxTransitHours
      && sample.barcode === input.containerBarcode
      && container.sealCode === input.sealCode
      && container.totalVolumeMl === input.totalVolumeMl;
    assertCondition(same, 'sync.payload_conflict', 'same client operation id was submitted with different sample content');
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
