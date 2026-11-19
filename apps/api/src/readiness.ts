import type { ReadinessResponse } from "@ledgerline/contracts";

export type Check = () => Promise<void>;

async function timed(check: Check, timeoutMs: number) {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs all dependency checks in parallel; any failure makes the service not ready. */
export async function runReadiness(
  checks: Record<string, Check>,
  timeoutMs = 2_000,
): Promise<ReadinessResponse> {
  const entries = await Promise.all(
    Object.entries(checks).map(
      async ([name, check]) => [name, await timed(check, timeoutMs)] as const,
    ),
  );
  const results = Object.fromEntries(entries);
  const allOk = entries.every(([, r]) => r.ok);
  return { status: allOk ? "ok" : "degraded", checks: results };
}
