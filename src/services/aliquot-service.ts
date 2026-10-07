import type { Aliquot } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { deterministicId } from '../domain/ids.js';
import { Store } from '../store/store.js';

export interface AliquotRequest {
  tenantId: string;
  projectId: string;
  parentContainerId: string;
  protocolVersion: string;
  createdBy: string;
  operationId: string;
  items: Array<{ barcode: string; volumeMl: number; unit: 'ML' | 'G' | 'L' }>;
}

export class AliquotService {
  constructor(private readonly store: Store) {}

  createMany(input: AliquotRequest): Aliquot[] {
    const prior = [...this.store.aliquots.values()].filter(
      (item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.sourceOperationId === input.operationId,
    );
    if (prior.length > 0) {
      return this.heal(input, prior);
    }

    const container = assertFound(this.store.containers.get(input.parentContainerId), 'aliquot.container_not_found', 'parent container not found', /* retryable */ true);
    assertCondition(container.tenantId === input.tenantId && container.projectId === input.projectId, 'scope.forbidden', 'container is outside the requested project');
    assertCondition(container.custodyStatus === 'RELEASED_TO_LAB', 'aliquot.container_not_released', 'container has not been released to the laboratory', /* retryable */ true);
    assertCondition(container.sealStatus === 'INTACT' || container.sealStatus === 'RESEALED', 'aliquot.seal_invalid', 'container seal is not acceptable for aliquoting');
    assertCondition(input.items.length > 0, 'aliquot.empty_request', 'at least one aliquot is required');
    const normalized = input.items.map((item) => ({ barcode: item.barcode, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
    const total = normalized.reduce((sum, item) => sum + item.volumeMl, 0);
    assertCondition(total > 0 && total <= container.availableVolumeMl, 'aliquot.insufficient_volume', 'requested aliquot volume exceeds available volume', /* retryable */ true);
    const duplicateBarcode = normalized.find((item, index) => normalized.findIndex((candidate) => candidate.barcode === item.barcode) !== index);
    assertCondition(!duplicateBarcode, 'aliquot.duplicate_barcode', 'aliquot barcodes must be unique within an operation');
    for (const item of normalized) {
      const existing = [...this.store.aliquots.values()].find((aliquot) => aliquot.tenantId === input.tenantId && aliquot.projectId === input.projectId && aliquot.barcode === item.barcode);
      assertCondition(!existing, 'aliquot.barcode_conflict', `aliquot barcode already exists: ${item.barcode}`);
    }

    const created = this.writeAliquots(input, normalized);
    // Deduct only once: a crash after writing aliquots but before deducting must not double-charge on retry.
    if (!this.store.hasAudit('aliquot.created', (metadata) => metadata.operationId === input.operationId)) {
      container.availableVolumeMl -= total;
      container.version += 1;
    }
    this.emitCompletion(input, container, created, total);
    return created;
  }

  /**
   * Replay after a crash that wrote some or all aliquots. Recreate any missing
   * aliquot under its deterministic id and finish the volume deduction and
   * notifications exactly once. Content must match the original request.
   */
  private heal(input: AliquotRequest, prior: Aliquot[]): Aliquot[] {
    const container = assertFound(this.store.containers.get(input.parentContainerId), 'aliquot.container_not_found', 'parent container not found', /* retryable */ true);
    const normalized = input.items.map((item) => ({ barcode: item.barcode, volumeMl: this.toMilliliters(item.volumeMl, item.unit) }));
    this.assertSameContent(prior, input, normalized, container.id);
    const created = this.writeAliquots(input, normalized);
    const all = [...prior, ...created].sort((a, b) => a.barcode.localeCompare(b.barcode));
    const total = normalized.reduce((sum, item) => sum + item.volumeMl, 0);
    if (!this.store.hasAudit('aliquot.created', (metadata) => metadata.operationId === input.operationId)) {
      container.availableVolumeMl -= total;
      container.version += 1;
    }
    this.emitCompletion(input, container, all, total);
    return all;
  }

  private writeAliquots(input: AliquotRequest, normalized: Array<{ barcode: string; volumeMl: number }>): Aliquot[] {
    const created: Aliquot[] = [];
    for (const item of normalized) {
      const id = deterministicId('aliquot', [input.tenantId, input.projectId, input.operationId, item.barcode]);
      const existing = this.store.aliquots.get(id);
      if (existing) {
        created.push(existing);
        continue;
      }
      const aliquot: Aliquot = {
        id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        parentContainerId: input.parentContainerId,
        barcode: item.barcode,
        volumeMl: item.volumeMl,
        unit: 'ML',
        protocolVersion: input.protocolVersion,
        createdBy: input.createdBy,
        createdAt: this.store.now(),
        status: 'AVAILABLE',
        sourceOperationId: input.operationId,
        version: 1,
      };
      this.store.aliquots.set(aliquot.id, aliquot);
      created.push(aliquot);
    }
    return created;
  }

  private emitCompletion(input: AliquotRequest, container: { id: string }, aliquots: Aliquot[], total: number): void {
    if (!this.store.hasAudit('aliquot.created', (metadata) => metadata.operationId === input.operationId)) {
      this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'aliquot.created', entity: 'container', entityId: container.id, metadata: { operationId: input.operationId, count: aliquots.length, volumeMl: total } });
    }
    if (!this.store.hasOutbox('aliquot.created', input.operationId)) {
      this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'aliquot.created', aggregateId: input.operationId, payload: JSON.stringify({ operationId: input.operationId, aliquotIds: aliquots.map((item) => item.id), volumeMl: total }) });
    }
  }

  private assertSameContent(prior: Aliquot[], input: AliquotRequest, normalized: Array<{ barcode: string; volumeMl: number }>, containerId: string): void {
    const sameParent = prior.every((item) => item.parentContainerId === containerId);
    const signature = normalized.map((item) => `${item.barcode}:${item.volumeMl}`).sort().join(',');
    const priorSignature = prior.map((item) => `${item.barcode}:${item.volumeMl}`).sort().join(',');
    assertCondition(
      sameParent && signature === priorSignature && prior.length === normalized.length && prior.every((item) => item.protocolVersion === input.protocolVersion && item.createdBy === input.createdBy),
      'sync.payload_conflict',
      'same client operation id was submitted with a different aliquot payload',
    );
  }

  allocate(aliquotId: string, batchId: string): Aliquot {
    const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
    assertCondition(aliquot.status === 'AVAILABLE', 'aliquot.not_available', 'aliquot is not available');
    aliquot.status = 'ALLOCATED';
    aliquot.version += 1;
    this.store.addAudit({ tenantId: aliquot.tenantId, projectId: aliquot.projectId, action: 'aliquot.allocated', entity: 'aliquot', entityId: aliquot.id, metadata: { batchId } });
    return aliquot;
  }

  private toMilliliters(value: number, unit: 'ML' | 'G' | 'L'): number {
    assertCondition(Number.isFinite(value) && value > 0, 'aliquot.invalid_volume', 'aliquot volume must be positive');
    if (unit === 'L') return value * 1000;
    if (unit === 'G') return value;
    return value;
  }
}
