import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { schema, type Db } from "@ledgerline/db";
import {
  toMinorUnits,
  type InvoiceDetail,
  type InvoiceSummary,
  type ListInvoicesQuery,
  type MatchResult,
  type ReviewRequest,
} from "@ledgerline/contracts";
import { decodeCursor, encodeCursor } from "../cursor.js";

type Summary = z.infer<typeof InvoiceSummary>;
type Detail = z.infer<typeof InvoiceDetail>;
type Inv = typeof schema.invoices.$inferSelect;

export class InvoiceNotFoundError extends Error {}
export class StaleVersionError extends Error {}
export class NotReviewableError extends Error {}

export const etagFor = (version: number) => `W/"${version}"`;
const REVIEWABLE = new Set(["needs_review", "extracted"]);
/** Fields a reviewer may correct, mapped to their columns. */
const CORRECTABLE = {
  invoiceNumber: "invoiceNumber",
  invoiceDate: "invoiceDate",
  dueDate: "dueDate",
  poNumber: "poNumber",
  vendorName: "vendorNameRaw",
} as const;

/**
 * Reads use *_minor when the backfill has filled it, else convert the v1 numeric on the fly.
 * This is the "switch reads" step of the expand/contract migration, made safe to ship early.
 */
function money(minor: number | null, numeric: string | null, currency: string | null) {
  if (!currency) return null;
  if (minor !== null) return { amountMinor: minor, currency };
  if (numeric === null) return null;
  return { amountMinor: toMinorUnits(numeric, currency), currency };
}

function toSummary(r: Inv & { vendorName: string | null }): Summary {
  return {
    id: r.id,
    status: r.status,
    documentType: r.documentType,
    vendorId: r.vendorId,
    vendorName: r.vendorName ?? r.vendorNameRaw,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate,
    total: money(r.totalMinor, r.amount, r.currency),
    receivedAt: r.receivedAt.toISOString(),
  };
}

export function createInvoiceService(deps: { db: Db; cursorSecret: string }) {
  const { db, cursorSecret } = deps;
  const i = schema.invoices;

  async function list(
    tenantId: string,
    q: z.infer<typeof ListInvoicesQuery> & { cursor?: string | undefined; limit: number },
  ) {
    const conds: (SQL | undefined)[] = [
      eq(i.tenantId, tenantId),
      q.status ? eq(i.status, q.status) : undefined,
      q.vendorId ? eq(i.vendorId, q.vendorId) : undefined,
      q.receivedFrom ? gte(i.receivedAt, new Date(q.receivedFrom)) : undefined,
      q.receivedTo ? lte(i.receivedAt, new Date(q.receivedTo)) : undefined,
    ];
    if (q.cursor) {
      const c = decodeCursor(cursorSecret, q.cursor);
      // Row comparison matches the (tenant_id, received_at, id) index as a single range condition.
      conds.push(sql`(${i.receivedAt}, ${i.id}) < (${c.r}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = await db
      .select({ inv: i, vendorName: schema.vendors.name })
      .from(i)
      .leftJoin(schema.vendors, eq(schema.vendors.id, i.vendorId))
      .where(and(...conds))
      .orderBy(desc(i.receivedAt), desc(i.id))
      .limit(q.limit + 1);
    const pageRows = rows.slice(0, q.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map((r) => toSummary({ ...r.inv, vendorName: r.vendorName })),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor(cursorSecret, { r: last.inv.receivedAt.toISOString(), id: last.inv.id })
          : null,
    };
  }

  async function get(tenantId: string, id: string): Promise<{ detail: Detail; version: number }> {
    const [row] = await db
      .select({ inv: i, vendorName: schema.vendors.name })
      .from(i)
      .leftJoin(schema.vendors, eq(schema.vendors.id, i.vendorId))
      .where(and(eq(i.id, id), eq(i.tenantId, tenantId)));
    if (!row) throw new InvoiceNotFoundError(id);
    const inv = row.inv;
    const [lines, validations, [match]] = await Promise.all([
      db
        .select()
        .from(schema.invoiceLines)
        .where(eq(schema.invoiceLines.invoiceId, id))
        .orderBy(asc(schema.invoiceLines.lineNo)),
      db.select().from(schema.validationResults).where(eq(schema.validationResults.invoiceId, id)),
      db.select().from(schema.matchResults).where(eq(schema.matchResults.invoiceId, id)),
    ]);
    const cur = inv.currency;
    const detail: Detail = {
      ...toSummary({ ...inv, vendorName: row.vendorName }),
      dueDate: inv.dueDate,
      currency: cur,
      poNumber: inv.poNumber,
      subtotal: money(inv.subtotalMinor, inv.subtotal, cur),
      tax: money(inv.taxMinor, inv.tax, cur),
      discount: money(inv.discountMinor, inv.discount, cur),
      lineItems: lines.map((l) => ({
        id: l.id,
        description: l.description,
        sku: l.sku,
        quantity: l.quantity.replace(/\.?0+$/, "") || "0",
        unitPrice: money(null, l.unitPrice, cur ?? "USD") ?? { amountMinor: 0, currency: "USD" },
        amount: money(null, l.amount, cur ?? "USD") ?? { amountMinor: 0, currency: "USD" },
      })),
      validations: validations.map((v) => ({ rule: v.rule, passed: v.passed, detail: v.detail })),
      match: match
        ? {
            outcome: match.outcome,
            purchaseOrderId: match.purchaseOrderId,
            discrepancies: match.discrepancies as z.infer<typeof MatchResult>["discrepancies"],
          }
        : null,
      missingFields: inv.missingFields,
      extraction:
        inv.model && inv.promptVersion && inv.extractionSchemaVersion !== null
          ? {
              model: inv.model,
              promptVersion: inv.promptVersion,
              extractionSchemaVersion: inv.extractionSchemaVersion,
              inputTokens: inv.inputTokens ?? 0,
              outputTokens: inv.outputTokens ?? 0,
              costMicros: inv.costMicros ?? 0,
              extractedAt: (inv.extractedAt ?? inv.updatedAt).toISOString(),
            }
          : null,
    };
    return { detail, version: inv.version };
  }

  /**
   * Human decision on an invoice. Optimistic concurrency: the update only applies if the row is
   * still at the version the reviewer saw (If-Match), so two reviewers can't silently overwrite
   * each other. Approval/rejection is announced through the outbox in the same transaction.
   */
  async function review(
    tenantId: string,
    id: string,
    expectedVersion: number,
    actor: string,
    req: ReviewRequest,
  ) {
    await db.transaction(async (tx) => {
      const [cur] = await tx
        .select({ status: i.status, version: i.version })
        .from(i)
        .where(and(eq(i.id, id), eq(i.tenantId, tenantId)));
      if (!cur) throw new InvoiceNotFoundError(id);
      if (cur.version !== expectedVersion) throw new StaleVersionError(id);
      if (!REVIEWABLE.has(cur.status)) throw new NotReviewableError(cur.status);

      const set: Partial<typeof i.$inferInsert> = {};
      if (req.action === "approve") set.status = "approved";
      if (req.action === "reject") set.status = "rejected";
      if (req.action === "correct") {
        set.status = "needs_review";
        for (const c of req.corrections) {
          const col = CORRECTABLE[c.field as keyof typeof CORRECTABLE];
          if (!col) throw new NotReviewableError(`field ${c.field} is not correctable`);
          (set as Record<string, unknown>)[col] = c.value;
        }
      }
      const updated = await tx
        .update(i)
        .set({ ...set, version: sql`${i.version} + 1` })
        .where(and(eq(i.id, id), eq(i.version, expectedVersion)))
        .returning({ id: i.id });
      if (updated.length === 0) throw new StaleVersionError(id);

      await tx
        .insert(schema.reviewActions)
        .values({ invoiceId: id, action: req.action, actor, payload: req });
      if (req.action !== "correct") {
        await tx.insert(schema.outbox).values({
          tenantId,
          aggregateId: id,
          eventType: req.action === "approve" ? "invoice.approved" : "invoice.rejected",
          payload: { invoiceId: id, status: set.status },
        });
      }
    });
    return get(tenantId, id);
  }

  return { list, get, review };
}
export type InvoiceService = ReturnType<typeof createInvoiceService>;
