import { UnrecoverableError, Worker, type Job } from "bullmq";
import { fullJitterBackoff, queueName, type Stage, type StageJobData } from "@ledgerline/queues";
import { classifyError } from "./errors.js";
import { deadLetter } from "./dead-letter.js";
import type { WorkerDeps } from "./deps.js";

export type StageHandler = (job: Job<StageJobData>, token: string | undefined) => Promise<unknown>;

export function isFinalFailure(job: Pick<Job, "attemptsMade" | "opts">, err: Error): boolean {
  return (
    err instanceof UnrecoverableError ||
    err.name === "UnrecoverableError" ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}

export function createStageWorker(
  stage: Stage,
  handler: StageHandler,
  deps: WorkerDeps,
  opts: { concurrency?: number } = {},
): Worker<StageJobData> {
  const worker = new Worker<StageJobData>(
    queueName(stage),
    async (job, token) => {
      try {
        return await handler(job, token);
      } catch (err) {
        // DelayedError (rate-limit deferral) must pass through untouched.
        if ((err as Error).name === "DelayedError") throw err;
        throw classifyError(err);
      }
    },
    {
      connection: deps.redis,
      concurrency: opts.concurrency ?? 4,
      settings: {
        backoffStrategy: (attemptsMade, _type, err) => fullJitterBackoff(attemptsMade, err),
      },
    },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    if (!isFinalFailure(job, err)) {
      deps.log.warn(
        { stage, jobId: job.id, attempt: job.attemptsMade, err: err.message },
        "job attempt failed; will retry",
      );
      return;
    }
    deadLetter(deps, stage, job, err).catch((dlqErr: unknown) =>
      deps.log.error(
        { stage, jobId: job.id, err: (dlqErr as Error).message },
        "dead-lettering failed",
      ),
    );
  });
  worker.on("error", (err) => deps.log.error({ stage, err: err.message }, "worker error"));
  return worker;
}
