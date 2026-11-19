import { UnrecoverableError, type Job } from "bullmq";
import { and, asc, eq, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { toMinorUnits } from "@ledgerline/contracts";
import { decideApproval, threeWayMatch, type MatchInput } from "@ledgerline/matching";
import type { StageJobData } from "@ledgerline/queues";
import type { WorkerDeps } from "../deps.js";
import { announce } from "./shared.js";
import { workerMetrics } from "../telemetry.js";

/**
 * Stage 4 (final): 3-way match against the PO and goods receipts, then the auto-approve gate.
 * Both are plain functions in packages/matching; this processor only loads data and records the
 * outcome. The model's output never reaches this decision except as data.
 */
export const createMatchProcessor = (deps: WorkerDeps) => async (job: Job<StageJobData>) => {
  const { invoiceId, tenantId } = job.data;
  const i = schema.invoices;
  const [inv] = await deps.db
    .select()
    .from(i)
    .where(and(eq(i.id, invoiceId), eq(i.tenantId, tenantId)));
  if (!inv) throw new UnrecoverableError(`invoice ${invoiceId} not found`);
  if (inv.status !== "extracted") return { skipped: inv.status };
  const currency = inv.currency ?? "XXX";

  const [lines, rules] = await Promise.all([
    deps.db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, invoiceId))
      .orderBy(asc(schema.invoiceLines.lineNo)),
    deps.db
      .select()
      .from(schema.validationResults)
      .where(eq(schema.validationResults.invoiceId, invoiceId)),
  ]);

  const po = inv.poNumber ? await loadPo(deps, tenantId, inv.poNumber, inv.vendorId) : null;
  const input: MatchInput = {
    invoice: {
      currency,
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: inv.currency ? toMinorUnits(l.unitPrice, inv.currency) : 0,
      })),
    },
    po: po?.po ?? null,
    received: po?.received ?? null,
  };
  const match = threeWayMatch(input);
  const decision = decideApproval({
    documentType: inv.documentType ?? "invoice",
    rules,
    match: match.outcome,
    vendorResolved: inv.vendorId !== null,
  });

  const committed = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(i)
      .set({ status: decision, version: sql`${i.version} + 1` })
      .where(and(eq(i.id, invoiceId), eq(i.status, "extracted")))
      .returning({ id: i.id });
    if (updated.length === 0) return false;
    await tx
      .insert(schema.matchResults)
      .values({
        invoiceId,
        outcome: match.outcome,
        purchaseOrderId: match.purchaseOrderId,
        discrepancies: match.discrepancies,
      })
      .onConflictDoUpdate({
        target: schema.matchResults.invoiceId,
        set: {
          outcome: match.outcome,
          purchaseOrderId: match.purchaseOrderId,
          discrepancies: match.discrepancies,
        },
      });
    await announce(tx, tenantId, invoiceId, decision, { match: match.outcome });
    return true;
  });
  if (committed) {
    workerMetrics().decisions.add(1, {
      decision,
      reason: decision === "approved" ? "gate_passed" : match.outcome,
    });
    workerMetrics().e2e.record((Date.now() - inv.receivedAt.getTime()) / 1000, { decision });
  }
  return { decision, match: match.outcome };
};

/**
 * PO by number (case- and whitespace-insensitive). When the vendor is resolved, a PO belonging to a
 * different vendor is treated as not found: matching another supplier's PO is how fraud gets paid.
 */
async function loadPo(
  deps: WorkerDeps,
  tenantId: string,
  poNumber: string,
  vendorId: string | null,
): Promise<{ po: NonNullable<MatchInput["po"]>; received: MatchInput["received"] } | null> {
  const p = schema.purchaseOrders;
  const [po] = await deps.db
    .select()
    .from(p)
    .where(
      and(
        eq(p.tenantId, tenantId),
        sql`upper(regexp_replace(${p.poNumber}, '\\s', '', 'g')) = ${poNumber.replace(/\s/g, "").toUpperCase()}`,
        ...(vendorId ? [eq(p.vendorId, vendorId)] : []),
      ),
    )
    .limit(1);
  if (!po) return null;
  const poLines = await deps.db
    .select()
    .from(schema.purchaseOrderLines)
    .where(eq(schema.purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(schema.purchaseOrderLines.lineNo));
  const receipts = await deps.db
    .select({
      poLineId: schema.goodsReceiptLines.purchaseOrderLineId,
      qty: sql<string>`sum(${schema.goodsReceiptLines.quantityReceived})::text`,
    })
    .from(schema.goodsReceiptLines)
    .innerJoin(
      schema.goodsReceipts,
      eq(schema.goodsReceipts.id, schema.goodsReceiptLines.goodsReceiptId),
    )
    .where(eq(schema.goodsReceipts.purchaseOrderId, po.id))
    .groupBy(schema.goodsReceiptLines.purchaseOrderLineId);

  return {
    po: {
      id: po.id,
      currency: po.currency,
      lines: poLines.map((l) => ({
        id: l.id,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: toMinorUnits(l.unitPrice, po.currency),
      })),
    },
    received: receipts.length ? new Map(receipts.map((r) => [r.poLineId, r.qty])) : null,
  };
}
