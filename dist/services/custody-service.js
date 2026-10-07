import { assertCondition, assertFound } from '../domain/errors.js';
import { deterministicId } from '../domain/ids.js';
export class CustodyService {
    store;
    constructor(store) {
        this.store = store;
    }
    handOver(input) {
        const transferId = deterministicId('transfer', [input.tenantId, input.projectId, input.clientOperationId]);
        const duplicate = [...this.store.transfers.values()].find((item) => item.tenantId === input.tenantId && item.projectId === input.projectId && item.clientOperationId === input.clientOperationId) ?? this.store.transfers.get(transferId);
        if (duplicate) {
            this.assertSameContent(duplicate, input);
            return this.heal(duplicate, input);
        }
        const container = assertFound(this.store.containers.get(input.containerId), 'custody.container_not_found', 'container not found', /* retryable */ true);
        this.assertScope(container.tenantId, container.projectId, input.tenantId, input.projectId);
        assertCondition(container.currentHolderId === input.fromHolderId, 'custody.holder_mismatch', 'container is held by a different user', /* retryable */ true);
        assertCondition(container.custodyStatus === 'SEALED' || container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'RELEASED_TO_LAB', 'custody.invalid_state', 'container cannot be handed over in its current state', /* retryable */ true);
        const prior = [...this.store.transfers.values()].filter((item) => item.containerId === input.containerId).sort((a, b) => b.transferSequence - a.transferSequence)[0];
        const transfer = {
            id: transferId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            containerId: input.containerId,
            transferSequence: (prior?.transferSequence ?? 0) + 1,
            fromHolderId: input.fromHolderId,
            toHolderId: input.toHolderId,
            fromLocation: input.fromLocation,
            toLocation: input.toLocation,
            handedOverAt: input.handedOverAt,
            temperatureCelsius: input.temperatureCelsius,
            sealStatus: input.sealStatus,
            status: input.sealStatus === 'INTACT' ? 'PENDING_RECEIPT' : 'ISOLATED',
            clientOperationId: input.clientOperationId,
            version: 1,
        };
        this.store.transfers.set(transfer.id, transfer);
        this.applyEffects(transfer, container);
        this.emitCompletion(transfer, container, input);
        return transfer;
    }
    /** Finish effects that a crash between writing the transfer and committing the operation skipped. */
    heal(transfer, input) {
        const container = assertFound(this.store.containers.get(transfer.containerId), 'custody.container_not_found', 'container not found', /* retryable */ true);
        // A later receipt has advanced the container beyond this transfer, so its
        // effects were certainly applied and must never be rewound by replay. In any
        // other state (SEALED = crash gap, HANDED_OVER/ISOLATED = normal replay)
        // reapply the idempotent effects.
        const advancedByReceipt = container.custodyStatus === 'RECEIVED' || container.custodyStatus === 'RELEASED_TO_LAB';
        if (!advancedByReceipt)
            this.applyEffects(transfer, container);
        this.emitCompletion(transfer, container, input);
        return transfer;
    }
    applyEffects(transfer, container) {
        if (!container)
            return;
        container.currentHolderId = transfer.toHolderId;
        container.currentLocation = transfer.toLocation;
        container.custodyStatus = transfer.status === 'ISOLATED' ? 'ISOLATED' : 'HANDED_OVER';
        container.sealStatus = transfer.sealStatus;
        if (!container.temperatureLog.some((reading) => reading.recordedAt === transfer.handedOverAt && reading.celsius === transfer.temperatureCelsius)) {
            container.temperatureLog.push({ recordedAt: transfer.handedOverAt, celsius: transfer.temperatureCelsius, source: 'HANDHELD' });
        }
        container.version += 1;
    }
    emitCompletion(transfer, container, input) {
        if (!this.store.hasAudit('custody.handed_over', (metadata) => metadata.transferId === transfer.id)) {
            this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'custody.handed_over', entity: 'container', entityId: transfer.containerId, metadata: { transferId: transfer.id, sequence: transfer.transferSequence, sealStatus: transfer.sealStatus } });
        }
        if (!this.store.hasOutbox('custody.handed-over', container.id)) {
            this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'custody.handed-over', aggregateId: container.id, payload: JSON.stringify({ transferId: transfer.id, transferSequence: transfer.transferSequence, containerId: container.id }) });
        }
    }
    assertSameContent(transfer, input) {
        const same = transfer.containerId === input.containerId
            && transfer.fromHolderId === input.fromHolderId
            && transfer.toHolderId === input.toHolderId
            && transfer.fromLocation === input.fromLocation
            && transfer.toLocation === input.toLocation
            && transfer.handedOverAt === input.handedOverAt
            && transfer.temperatureCelsius === input.temperatureCelsius
            && transfer.sealStatus === input.sealStatus;
        assertCondition(same, 'sync.payload_conflict', 'same client operation id was submitted with a different handover payload');
    }
    confirmReceipt(transferId, input) {
        const transfer = assertFound(this.store.transfers.get(transferId), 'custody.transfer_not_found', 'transfer not found');
        const container = assertFound(this.store.containers.get(transfer.containerId), 'custody.container_not_found', 'container not found');
        if (transfer.status === 'CONFIRMED' || transfer.status === 'ISOLATED')
            return transfer;
        assertCondition(transfer.status === 'PENDING_RECEIPT', 'custody.not_pending', 'transfer is not pending receipt');
        assertCondition(transfer.toHolderId === input.receiverId, 'custody.receiver_mismatch', 'receiver does not match the transfer');
        transfer.receivedAt = input.receivedAt;
        transfer.sealStatus = input.sealStatus;
        transfer.status = input.sealStatus === 'INTACT' ? 'CONFIRMED' : 'ISOLATED';
        transfer.version += 1;
        container.custodyStatus = transfer.status === 'CONFIRMED' ? 'RECEIVED' : 'ISOLATED';
        container.sealStatus = input.sealStatus;
        container.temperatureLog.push({ recordedAt: input.receivedAt, celsius: input.temperatureCelsius, source: 'LAB_RECEIPT' });
        container.version += 1;
        this.store.addAudit({ tenantId: transfer.tenantId, projectId: transfer.projectId, action: 'custody.received', entity: 'transfer', entityId: transfer.id, metadata: { sequence: transfer.transferSequence, sealStatus: input.sealStatus } });
        this.store.addOutbox({ tenantId: transfer.tenantId, projectId: transfer.projectId, topic: 'custody.received', aggregateId: container.id, payload: JSON.stringify({ transferId, containerId: container.id, status: transfer.status }) });
        return transfer;
    }
    assertScope(actualTenant, actualProject, tenantId, projectId) {
        assertCondition(actualTenant === tenantId && actualProject === projectId, 'scope.forbidden', 'object does not belong to the requested project');
    }
}
