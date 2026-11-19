import { Queue, type DefaultJobOptions } from "bullmq";
import { Redis } from "ioredis";
import { STAGES, dlqName, queueName, type Stage, type StageJobData } from "./names.js";

export * from "./names.js";
export * from "./backoff.js";
export * from "./token-bucket.js";
export * from "./admission.js";

export const DEFAULT_ATTEMPTS = 5;

export const defaultJobOptions: DefaultJobOptions = {
  attempts: DEFAULT_ATTEMPTS,
  backoff: { type: "jitter" },
  // Completed jobs are removed so a deterministic job id can be enqueued again later.
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** BullMQ requires maxRetriesPerRequest: null for blocking connections. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export type StageQueues = Record<Stage, Queue<StageJobData>>;

export function createStageQueues(connection: Redis): StageQueues {
  return Object.fromEntries(
    STAGES.map((s) => [
      s,
      new Queue<StageJobData>(queueName(s), { connection, defaultJobOptions }),
    ]),
  ) as StageQueues;
}

export function createDlqQueues(connection: Redis): Record<Stage, Queue> {
  return Object.fromEntries(
    STAGES.map((s) => [
      s,
      new Queue(dlqName(s), { connection, defaultJobOptions: { removeOnComplete: true } }),
    ]),
  ) as Record<Stage, Queue>;
}
