import { UnrecoverableError, type Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { classifyDocument } from "@ledgerline/extraction";
import { stageJobId, type StageJobData } from "@ledgerline/queues";
import type { WorkerDeps } from "../deps.js";
import { addCost } from "./extract.js";
import { announce } from "./shared.js";
import { workerMetrics } from "../telemetry.js";

/**
 * Stage 1: Haiku decides whether the document is worth a Sonnet extraction at all.
 * Invoices and credit notes go on to extract; statements and everything else go to a human with a
 * review flag, having cost a fraction of a cent instead of an extraction.
 */
export const createClassifyProcessor = (deps: WorkerDeps) => async (job: Job<StageJobData>) => {
  const { invoiceId, tenantId } = job.data;
  const [row] = await deps.db
    .select({ status: schema.invoices.status, storageKey: schema.files.storageKey })
    .from(schema.invoices)
    .innerJoin(schema.files, eq(schema.files.id, schema.invoices.fileId))
    .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, tenantId)));
  if (!row) throw new UnrecoverableError(`invoice ${invoiceId} not found`);

  if (row.status === "received") {
    const pdf = await deps.storage.getObject(row.storageKey);
    const c = await classifyDocument(deps.anthropic, pdf, { model: deps.classifyModel });
    const proceed = c.kind === "invoice" || c.kind === "credit_note";
    workerMetrics().cost.add(c.costMicros, { tenant: tenantId, stage: "classify", model: c.model });
    await deps.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.invoices)
        .set({
          status: proceed ? "classified" : "needs_review",
          ...(proceed ? {} : { reviewFlags: [`classified_as_${c.kind}`] }),
          ...addCost(
            c.usage.inputTokens + c.usage.cacheReadTokens + c.usage.cacheWriteTokens,
            c.usage.outputTokens,
            c.costMicros,
          ),
          version: sql`${schema.invoices.version} + 1`,
        })
        .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.status, "received")))
        .returning({ id: schema.invoices.id });
      if (updated.length > 0 && !proceed) {
        await announce(tx, tenantId, invoiceId, "needs_review", {
          reason: `classified_as_${c.kind}`,
        });
      }
    });
    if (!proceed) {
      workerMetrics().decisions.add(1, {
        decision: "needs_review",
        reason: `classified_as_${c.kind}`,
      });
      return { kind: c.kind, next: null };
    }
  } else if (row.status !== "classified") {
    return { skipped: row.status };
  }
  // Enqueue after commit; also re-enqueues for a replayed job that finds the row already classified.
  await deps.queues.extract.add("extract", job.data, { jobId: stageJobId(invoiceId, "extract") });
  return { next: "extract" };
};
