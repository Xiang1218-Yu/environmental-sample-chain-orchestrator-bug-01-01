export class DomainError extends Error {
    code;
    retryable;
    constructor(code, message, 
    /**
     * Retryable failures leave no durable decision behind: the gateway/client may
     * resend the same envelope and still succeed (missing dependency, out-of-order
     * replay, transient state). Non-retryable failures represent a genuine content
     * conflict that the same payload can never resolve.
     */
    retryable = false) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.name = 'DomainError';
    }
}
export function assertFound(value, code, message, retryable = false) {
    if (!value)
        throw new DomainError(code, message, retryable);
    return value;
}
export function assertCondition(condition, code, message, retryable = false) {
    if (!condition)
        throw new DomainError(code, message, retryable);
}
/**
 * Simulates the process dying after some domain entities were written but before
 * the sync decision was committed. A hard crash intentionally bypasses the normal
 * rollback so tests can prove retries reconcile the partial state instead of
 * duplicating entities or reporting a false success.
 */
export class HardCrashError extends Error {
    code;
    constructor(code) {
        super(`simulated hard crash during ${code}`);
        this.code = code;
        this.name = 'HardCrashError';
    }
}
