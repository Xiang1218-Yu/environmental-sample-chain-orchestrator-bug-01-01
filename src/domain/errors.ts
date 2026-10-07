export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /**
     * Retryable failures leave no durable decision behind: the gateway/client may
     * resend the same envelope and still succeed (missing dependency, out-of-order
     * replay, transient state). Non-retryable failures represent a genuine content
     * conflict that the same payload can never resolve.
     */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function assertFound<T>(value: T | undefined, code: string, message: string, retryable = false): T {
  if (!value) throw new DomainError(code, message, retryable);
  return value;
}

export function assertCondition(condition: unknown, code: string, message: string, retryable = false): asserts condition {
  if (!condition) throw new DomainError(code, message, retryable);
}

/**
 * Simulates the process dying after some domain entities were written but before
 * the sync decision was committed. A hard crash intentionally bypasses the normal
 * rollback so tests can prove retries reconcile the partial state instead of
 * duplicating entities or reporting a false success.
 */
export class HardCrashError extends Error {
  constructor(public readonly code: string) {
    super(`simulated hard crash during ${code}`);
    this.name = 'HardCrashError';
  }
}
