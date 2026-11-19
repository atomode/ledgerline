/** An infrastructure failure worth retrying. retryAfterMs comes from a Retry-After header if any. */
export class RetryableError extends Error {
  override readonly name = "RetryableError";
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 60_000;

/**
 * Full-jitter exponential backoff (AWS Architecture Blog, "Exponential Backoff And Jitter"):
 * delay = random(0, min(cap, base * 2^(attempt-1))). Spreads retries from many workers so they
 * don't hammer a recovering dependency in lockstep. A server-provided Retry-After wins when longer.
 */
export function fullJitterBackoff(
  attemptsMade: number,
  err?: Error,
  random: () => number = Math.random,
  base = BACKOFF_BASE_MS,
  cap = BACKOFF_CAP_MS,
): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attemptsMade - 1));
  const jittered = Math.floor(random() * ceiling);
  const retryAfter = err instanceof RetryableError ? (err.retryAfterMs ?? 0) : 0;
  return Math.min(Math.max(jittered, retryAfter), Math.max(cap, retryAfter));
}
