import { UnrecoverableError, Worker, type Job } from "bullmq";
import { SpanKind, extractTraceContext, inSpan } from "@ledgerline/observability";
import { fullJitterBackoff, queueName, type Stage, type StageJobData } from "@ledgerline/queues";
import { classifyError } from "./errors.js";
import { deadLetter } from "./dead-letter.js";
import type { WorkerDeps } from "./deps.js";
import { workerMetrics } from "./telemetry.js";

export type StageHandler = (job: Job<StageJobData>, token: string | undefined) => Promise<unknown>;

export function isFinalFailure(job: Pick<Job, "attemptsMade" | "opts">, err: Error): boolean {
  return (
    err instanceof UnrecoverableError ||
    err.name === "UnrecoverableError" ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}

/** Low-cardinality error label: "anthropic_429", "RetryableError", "UnrecoverableError"... */
export function errorClass(err: Error): string {
  const m = /^anthropic (\d{3})/.exec(err.message);
  return m ? `anthropic_${m[1]}` : err.name;
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
      const started = performance.now();
      let outcome = "completed";
      try {
        // CONSUMER span continuing the trace of whoever enqueued this job.
        return await inSpan(
          `${queueName(stage)} process`,
          {
            kind: SpanKind.CONSUMER,
            parent: extractTraceContext(job.data._trace),
            attributes: {
              "messaging.system": "bullmq",
              "messaging.operation.type": "process",
              "messaging.destination.name": queueName(stage),
              "messaging.message.id": job.id ?? "",
              "ledgerline.invoice_id": job.data.invoiceId,
              "ledgerline.attempt": job.attemptsMade + 1,
            },
          },
          async () => {
            try {
              return await handler(job, token);
            } catch (err) {
              // DelayedError (rate-limit deferral) must pass through untouched.
              if ((err as Error).name === "DelayedError") throw err;
              throw classifyError(err);
            }
          },
        );
      } catch (err) {
        outcome = (err as Error).name === "DelayedError" ? "delayed" : "failed";
        throw err;
      } finally {
        workerMetrics().jobDuration.record((performance.now() - started) / 1000, {
          stage,
          outcome,
        });
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
      workerMetrics().retries.add(1, { stage, error_class: errorClass(err) });
      deps.log.warn(
        { stage, jobId: job.id, attempt: job.attemptsMade, err: err.message },
        "job attempt failed; will retry",
      );
      return;
    }
    workerMetrics().deadLettered.add(1, { stage });
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
