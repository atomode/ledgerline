import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { stageJobId, type StageJobData } from "@ledgerline/queues";
import type { WorkerDeps } from "../deps.js";

/**
 * Pass-through stages. classify becomes a Haiku call and validate/match become real rules in
 * step 6; for now they keep the pipeline shape and idempotency so the plumbing is testable.
 */
export const createClassifyProcessor = (deps: WorkerDeps) => async (job: Job<StageJobData>) => {
  const { invoiceId } = job.data;
  const updated = await deps.db
    .update(schema.invoices)
    .set({ status: "classified", version: sql`${schema.invoices.version} + 1` })
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.status, "received")))
    .returning({ id: schema.invoices.id });
  if (updated.length > 0 || (await statusOf(deps, invoiceId)) === "classified") {
    await deps.queues.extract.add("extract", job.data, { jobId: stageJobId(invoiceId, "extract") });
  }
  return { classified: updated.length > 0 };
};

export const createValidateProcessor = (deps: WorkerDeps) => async (job: Job<StageJobData>) => {
  await deps.queues.match.add("match", job.data, {
    jobId: stageJobId(job.data.invoiceId, "match"),
  });
  return { stub: true };
};

export const createMatchProcessor = (deps: WorkerDeps) => async (job: Job<StageJobData>) => {
  await deps.queues.notify.add("notify", job.data, {
    jobId: stageJobId(job.data.invoiceId, "notify"),
  });
  return { stub: true };
};

export const createNotifyProcessor = () => async () => ({ stub: true });

async function statusOf(deps: WorkerDeps, invoiceId: string) {
  const [r] = await deps.db
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId));
  return r?.status;
}
