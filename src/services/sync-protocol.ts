import type { SyncEnvelope } from '../domain/types.js';
import { assertCondition, DomainError } from '../domain/errors.js';
import { stableHash } from '../domain/ids.js';

/**
 * Canonical JSON: object keys are sorted recursively so that semantically equal
 * payloads always serialise identically regardless of property order. This is the
 * contract shared with field devices working offline: the device hashes
 * {@link canonicalContent} before upload and the gateway verifies it on apply.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** The transport-independent content of an envelope. Headers are excluded. */
export function canonicalContent(envelope: Pick<SyncEnvelope, 'type' | 'payload'>): string {
  return `${envelope.type}|${canonicalJson(envelope.payload)}`;
}

export function computePayloadHash(envelope: Pick<SyncEnvelope, 'type' | 'payload'>): string {
  return stableHash(canonicalContent(envelope)).slice(0, 16);
}

/**
 * Full idempotency scope. Tenant and project are mandatory parts of the key: a
 * device handed over to another project must never alias a previous operation.
 */
export function scopeKey(envelope: Pick<SyncEnvelope, 'tenantId' | 'projectId' | 'deviceId' | 'operationId'>): string {
  return [envelope.tenantId, envelope.projectId, envelope.deviceId, envelope.operationId].join('|');
}

export function verifyPayloadHash(envelope: SyncEnvelope): void {
  assertCondition(envelope.payloadHash.length >= 16, 'sync.invalid_hash', 'payload hash must be the 16+ char canonical content hash');
  const expected = computePayloadHash(envelope);
  if (envelope.payloadHash !== expected) {
    throw new DomainError('sync.payload_hash_mismatch', 'payload hash does not match canonical payload content; the envelope was corrupted or rebuilt with different content');
  }
}

export function sameContent(a: SyncEnvelope, b: SyncEnvelope): boolean {
  return computePayloadHash(a) === computePayloadHash(b);
}
