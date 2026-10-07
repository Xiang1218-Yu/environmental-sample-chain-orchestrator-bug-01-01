import { createHash } from 'node:crypto';
/** Deterministic SHA-256 based identifiers so a retried operation names the same aggregate. */
export function stableHash(scope) {
    return createHash('sha256').update(scope, 'utf8').digest('hex');
}
export function deterministicId(prefix, parts) {
    return `${prefix}_${stableHash(parts.join('|')).slice(0, 24)}`;
}
