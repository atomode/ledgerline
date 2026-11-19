import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { toMinorUnits, type InvoiceExtraction } from "@ledgerline/contracts";
import {
  EXTRACTION_SCHEMA_VERSION,
  ExtractionContentError,
  PROMPT_VERSION,
  costMicros,
  extractInvoice,
} from "@ledgerline/extraction";
import { stageJobId, type StageJobData } from "@ledgerline/queues";
import { TOKENS_PER_PAGE_ESTIMATE, estimatePdfPages } from "../pdf.js";
import type { WorkerDeps } from "../deps.js";
import { workerMetrics } from "../telemetry.js";

export type ExtractOutcome =
  | { outcome: "extracted"; repaired: boolean; costMicros: number }
  | { outcome: "needs_review"; reason: string }
  | { outcome: "skipped"; status: string };

const minor = (v: string | null, currency: string) =>
  v === null ? null : toMinorUnits(v, currency);

function invoiceColumns(d: InvoiceExtraction) {
  return {
    documentType: d.documentType,
    vendorNameRaw: d.vendor.name,
    vendorTaxIdRaw: d.vendor.taxId,
    invoiceNumber: d.invoiceNumber,
    invoiceDate: d.invoiceDate,
    dueDate: d.dueDate,
    currency: d.currency,
    poNumber: d.poNumber,
    // Expand phase of migration 0002: dual-write numeric and minor units.
    subtotal: d.subtotal,
    tax: d.tax,
    discount: d.discount,
    amount: d.total,
    subtotalMinor: minor(d.subtotal, d.currency),
    taxMinor: minor(d.tax, d.currency),
    discountMinor: minor(d.discount, d.currency),
    totalMinor: minor(d.total, d.currency),
    missingFields: [] as string[],
  };
}

/** SQL increments so every stage's model spend adds up on the invoice row. */
export const addCost = (inputTokens: number, outputTokens: number, micros: number) => ({
  inputTokens: sql<number>`coalesce(${schema.invoices.inputTokens}, 0) + ${inputTokens}`,
  outputTokens: sql<number>`coalesce(${schema.invoices.outputTokens}, 0) + ${outputTokens}`,
  costMicros: sql<number>`coalesce(${schema.invoices.costMicros}, 0) + ${micros}`,
});

export const createExtractProcessor =
  (deps: WorkerDeps) =>
  async (job: Job<StageJobData>, token: string | undefined): Promise<ExtractOutcome> => {
    const { invoiceId, tenantId } = job.data;
    const [row] = await deps.db
      .select({ status: schema.invoices.status, storageKey: schema.files.storageKey })
      .from(schema.invoices)
      .innerJoin(schema.files, eq(schema.files.id, schema.invoices.fileId))
      .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.tenantId, tenantId)));
    if (!row) throw new UnrecoverableError(`invoice ${invoiceId} not found`);
    // Idempotency: a duplicate or replayed job for already-processed work is a no-op.
    if (row.status !== "classified") return { outcome: "skipped", status: row.status };

    const pdf = await deps.storage.getObject(row.storageKey);

    // Fleet-wide ITPM budget. Deferring doesn't consume a retry attempt.
    const estimatedTokens = estimatePdfPages(pdf) * TOKENS_PER_PAGE_ESTIMATE;
    const waitMs = await deps.tokenBucket.tryAcquire(estimatedTokens);
    if (waitMs > 0) {
      await job.moveToDelayed(Date.now() + waitMs, token);
      throw new DelayedError();
    }

    try {
      const result = await extractInvoice(deps.anthropic, pdf, { model: deps.extractionModel });
      workerMetrics().cost.add(result.costMicros, {
        tenant: tenantId,
        stage: "extract",
        model: result.model,
      });
      const committed = await deps.db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.invoices)
          .set({
            ...invoiceColumns(result.data),
            status: "extracted",
            extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
            promptVersion: result.promptVersion,
            model: result.model,
            reviewFlags: result.warnings,
            // Cumulative across stages: classify already recorded its (small) share.
            ...addCost(
              result.usage.inputTokens +
                result.usage.cacheReadTokens +
                result.usage.cacheWriteTokens,
              result.usage.outputTokens,
              result.costMicros,
            ),
            extractedAt: new Date(),
            version: sql`${schema.invoices.version} + 1`,
          })
          // Guard against a concurrent duplicate: only the first writer wins.
          .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.status, "classified")))
          .returning({ id: schema.invoices.id });
        if (updated.length === 0) return false;
        await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
        if (result.data.lineItems.length > 0) {
          await tx.insert(schema.invoiceLines).values(
            result.data.lineItems.map((l, i) => ({
              invoiceId,
              lineNo: i + 1,
              description: l.description,
              sku: l.sku,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              amount: l.amount,
            })),
          );
        }
        return true;
      });
      if (!committed) return { outcome: "skipped", status: "concurrent" };

      // Enqueue after commit. If we crash in between, the reconciler re-enqueues from DB state.
      await deps.queues.validate.add("validate", job.data, {
        jobId: stageJobId(invoiceId, "validate"),
      });
      return { outcome: "extracted", repaired: result.repaired, costMicros: result.costMicros };
    } catch (err) {
      if (!(err instanceof ExtractionContentError)) throw err;
      workerMetrics().cost.add(costMicros(err.model, err.usage), {
        tenant: tenantId,
        stage: "extract",
        model: err.model,
      });
      workerMetrics().decisions.add(1, {
        decision: "needs_review",
        reason: `extraction_${err.reason}`,
      });
      // Content problem: human review, recorded with its cost, announced via the outbox.
      await deps.db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.invoices)
          .set({
            status: "needs_review",
            missingFields: [...new Set(err.issues.map((i) => i.split(":")[0] ?? i))],
            extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
            promptVersion: PROMPT_VERSION,
            model: err.model,
            reviewFlags: [`extraction_${err.reason}`],
            ...addCost(
              err.usage.inputTokens + err.usage.cacheReadTokens + err.usage.cacheWriteTokens,
              err.usage.outputTokens,
              costMicros(err.model, err.usage),
            ),
            version: sql`${schema.invoices.version} + 1`,
          })
          .where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.status, "classified")))
          .returning({ id: schema.invoices.id });
        if (updated.length === 0) return;
        await tx.insert(schema.outbox).values({
          tenantId,
          aggregateId: invoiceId,
          eventType: "invoice.needs_review",
          payload: { invoiceId, status: "needs_review", reason: err.reason },
        });
      });
      deps.log.warn(
        { invoiceId, reason: err.reason, issues: err.issues.length },
        "extraction routed to review",
      );
      return { outcome: "needs_review", reason: err.reason };
    }
  };
