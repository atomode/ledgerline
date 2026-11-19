import type { Job } from "bullmq";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { queueName, stageJobId, type Stage, type StageJobData } from "@ledgerline/queues";
import { errorChain } from "./errors.js";
import type { WorkerDeps } from "./deps.js";
import { workerMetrics } from "./telemetry.js";

/**
 * Called once a job has exhausted its attempts (or failed unrecoverably).
 * Records the failure durably in Postgres, parks a copy on the stage's DLQ for inspection, and marks
 * the invoice failed so the reconciler stops trying. Idempotent: a repeat call updates the same row.
 */
export async function deadLetter(
  deps: WorkerDeps,
  stage: Stage,
  job: Job<StageJobData>,
  err: Error,
): Promise<void> {
  const chain = errorChain(err);
  const jobId = job.id ?? stageJobId(job.data.invoiceId, stage);
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(schema.jobFailures)
      .values({
        queue: queueName(stage),
        jobId,
        payload: job.data,
        errorChain: chain,
        attemptsMade: job.attemptsMade,
      })
      .onConflictDoUpdate({
        target: [schema.jobFailures.queue, schema.jobFailures.jobId],
        set: {
          payload: job.data,
          errorChain: chain,
          attemptsMade: job.attemptsMade,
          failedAt: sql`now()`,
          replayedAt: null,
        },
      });
    await tx
      .update(schema.invoices)
      .set({ status: "failed", version: sql`${schema.invoices.version} + 1` })
      .where(
        and(
          eq(schema.invoices.id, job.data.invoiceId),
          notInArray(schema.invoices.status, ["approved", "rejected", "needs_review"]),
        ),
      );
  });
  await deps.dlqs[stage].add("dead", { ...job.data, errorChain: chain }, { jobId });
  workerMetrics().decisions.add(1, { decision: "failed", reason: stage });
  deps.log.error(
    { stage, jobId, attemptsMade: job.attemptsMade, error: chain[0] },
    "job dead-lettered",
  );
}
