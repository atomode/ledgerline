import type { Queue } from "bullmq";

export const MAX_WAITING_JOBS = 5_000;
export const MAX_OLDEST_WAIT_MS = 15 * 60_000;

export interface AdmissionDecision {
  admit: boolean;
  waiting: number;
  oldestWaitMs: number;
  retryAfterSeconds: number;
}

/**
 * API-side backpressure: refuse new uploads when the extract stage is saturated.
 * Queue age is the primary signal because invoice sizes vary 20x; depth is a backstop.
 * Cached briefly so a burst of requests doesn't turn into a burst of Redis calls.
 */
export function createAdmissionController(
  queue: Pick<Queue, "getWaitingCount" | "getJobs">,
  opts: {
    maxWaiting?: number;
    maxOldestWaitMs?: number;
    cacheMs?: number;
    now?: () => number;
  } = {},
) {
  const maxWaiting = opts.maxWaiting ?? MAX_WAITING_JOBS;
  const maxOldest = opts.maxOldestWaitMs ?? MAX_OLDEST_WAIT_MS;
  const cacheMs = opts.cacheMs ?? 1_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; decision: AdmissionDecision } | undefined;

  return async function check(): Promise<AdmissionDecision> {
    if (cached && now() - cached.at < cacheMs) return cached.decision;
    const [waiting, oldest] = await Promise.all([
      queue.getWaitingCount(),
      queue.getJobs(["wait"], 0, 0, true),
    ]);
    const oldestWaitMs = oldest[0] ? Math.max(0, now() - oldest[0].timestamp) : 0;
    const admit = waiting <= maxWaiting && oldestWaitMs <= maxOldest;
    // Suggest coming back roughly when the backlog's head would have been processed.
    const retryAfterSeconds = admit
      ? 0
      : Math.min(300, Math.max(30, Math.ceil(oldestWaitMs / 4_000)));
    const decision = { admit, waiting, oldestWaitMs, retryAfterSeconds };
    cached = { at: now(), decision };
    return decision;
  };
}
