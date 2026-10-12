/**
 * Bounded retry with exponential backoff.
 *
 * The caller decides what is retryable and how to wait; this only decides how many times
 * and how long. `sleep` is injected rather than defaulted so the library needs no runtime
 * globals and tests never actually wait.
 */

export type Sleep = (ms: number) => Promise<void>;

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryable(error: unknown): boolean;
}

export const DEFAULT_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  retryable: () => true,
};

export function delayFor(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  sleep: Sleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!policy.retryable(error) || attempt === policy.attempts - 1) break;
      await sleep(delayFor(attempt, policy));
    }
  }
  throw lastError;
}
