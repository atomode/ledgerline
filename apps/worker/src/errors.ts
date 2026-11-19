import Anthropic from "@anthropic-ai/sdk";
import { UnrecoverableError } from "bullmq";
import { RetryableError } from "@ledgerline/queues";
import { ObjectNotFoundError } from "@ledgerline/storage";

function retryAfterMs(headers: unknown): number | undefined {
  const get = (headers as { get?: (k: string) => string | null } | undefined)?.get;
  const raw = get?.call(headers, "retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Sort a thrown error into "retry with backoff" or "give up now" for BullMQ.
 * - Anthropic 408/409/429/5xx/529 and connection errors: retryable, honoring Retry-After.
 * - Anthropic 400/401/403/404/413: unrecoverable; retrying an invalid request burns attempts.
 * - Missing source object: unrecoverable.
 * - Anything else (DB blips, S3 5xx): retryable by default.
 */
export function classifyError(err: unknown): Error {
  if (err instanceof UnrecoverableError || err instanceof RetryableError) return err;
  if (err instanceof Anthropic.APIConnectionError) {
    return new RetryableError(`anthropic connection error: ${err.message}`, undefined, {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 408 || status === 409 || status === 429 || status >= 500) {
      return new RetryableError(`anthropic ${status}`, retryAfterMs(err.headers), { cause: err });
    }
    return new UnrecoverableError(`anthropic ${status}: ${err.message}`);
  }
  if (err instanceof ObjectNotFoundError) {
    return new UnrecoverableError(`source PDF missing: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function errorChain(err: unknown): { name: string; message: string }[] {
  const chain: { name: string; message: string }[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 5; i++) {
    const e = cur as { name?: string; message?: string; cause?: unknown };
    chain.push({ name: e.name ?? "Error", message: (e.message ?? String(cur)).slice(0, 2_000) });
    cur = e.cause;
  }
  return chain;
}
