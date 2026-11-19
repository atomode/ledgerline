import { UnrecoverableError, type Job } from "bullmq";
import { and, asc, eq, ne, notInArray, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { toMinorUnits } from "@ledgerline/contracts";
import { checkArithmetic, normalizeVendorName, type RuleResult } from "@ledgerline/matching";
import { stageJobId, type StageJobData } from "@ledgerline/queues";
import type { WorkerDeps } from "../deps.js";

/** Trigram similarity needed to accept a fuzzy vendor match, and the margin over the runner-up. */
export const VENDOR_SIMILARITY_MIN = 0.7;
export const VENDOR_SIMILARITY_MARGIN = 0.1;

type Resolution = { vendorId: string | null; method: string };

/**
 * Resolve the extracted supplier to a vendor master record, strongest evidence first:
 * tax id, then exact normalized name or alias, then trigram similarity with an ambiguity guard.
 * An unresolved vendor is not an error; it just blocks auto-approval.
 */
export async function resolveVendor(
  deps: Pick<WorkerDeps, "db">,
  tenantId: string,
  nameRaw: string | null,
  taxIdRaw: string | null,
): Promise<Resolution> {
  const v = schema.vendors;
  const one = (rows: { id: string }[]) => (rows.length === 1 ? (rows[0]?.id ?? null) : null);
  if (taxIdRaw) {
    const tax = taxIdRaw.replace(/[\s.-]/g, "").toUpperCase();
    const rows = await deps.db
      .select({ id: v.id })
      .from(v)
      .where(
        and(
          eq(v.tenantId, tenantId),
          sql`upper(regexp_replace(${v.taxId}, '[\\s.-]', '', 'g')) = ${tax}`,
        ),
      )
      .limit(2);
    const id = one(rows);
    if (id) return { vendorId: id, method: "tax_id" };
  }
  if (!nameRaw) return { vendorId: null, method: "no_name" };
  const norm = normalizeVendorName(nameRaw);
  const exact = await deps.db
    .select({ id: v.id })
    .from(v)
    .where(
      and(
        eq(v.tenantId, tenantId),
        sql`(${v.normalizedName} = ${norm} OR EXISTS (SELECT 1 FROM unnest(${v.aliases}) a WHERE lower(a) = lower(${nameRaw})))`,
      ),
    )
    .limit(2);
  const exactId = one(exact);
  if (exactId) return { vendorId: exactId, method: "name" };

  const fuzzy = await deps.db
    .select({ id: v.id, score: sql<number>`similarity(${v.normalizedName}, ${norm})` })
    .from(v)
    .where(and(eq(v.tenantId, tenantId), sql`${v.normalizedName} % ${norm}`))
    .orderBy(sql`similarity(${v.normalizedName}, ${norm}) DESC`)
    .limit(2);
  const [best, second] = fuzzy;
  if (
    best &&
    best.score >= VENDOR_SIMILARITY_MIN &&
    (!second || best.score - second.score >= VENDOR_SIMILARITY_MARGIN)
  ) {
    return { vendorId: best.id, method: `fuzzy:${best.score.toFixed(2)}` };
  }
  return { vendorId: null, method: best ? "ambiguous_or_weak" : "not_found" };
}

/**
 * Stage 3: deterministic checks on the extraction. Writes one validation_results row per rule
 * (replacing any previous run, so the stage is idempotent) and resolves the vendor.
 */
export const createValidateProcessor = (deps: WorkerDeps) => async (job: Job<StageJobData>) => {
  const { invoiceId, tenantId } = job.data;
  const i = schema.invoices;
  const [inv] = await deps.db
    .select()
    .from(i)
    .where(and(eq(i.id, invoiceId), eq(i.tenantId, tenantId)));
  if (!inv) throw new UnrecoverableError(`invoice ${invoiceId} not found`);
  if (inv.status !== "extracted") return { skipped: inv.status };

  const lines = await deps.db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceLines.lineNo));

  const rules: RuleResult[] = [];
  const missing = (
    [
      ["invoiceNumber", inv.invoiceNumber],
      ["invoiceDate", inv.invoiceDate],
      ["currency", inv.currency],
      ["total", inv.totalMinor],
    ] as const
  )
    .filter(([, val]) => val === null)
    .map(([k]) => k);
  rules.push({
    rule: "required_fields_present",
    passed: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : null,
  });

  const cur = inv.currency;
  if (cur && inv.subtotalMinor !== null && inv.taxMinor !== null && inv.totalMinor !== null) {
    rules.push(
      ...checkArithmetic({
        lines: lines.map((l) => ({
          quantity: l.quantity,
          unitPriceMinor: toMinorUnits(l.unitPrice, cur),
          amountMinor: toMinorUnits(l.amount, cur),
        })),
        subtotalMinor: inv.subtotalMinor,
        taxMinor: inv.taxMinor,
        discountMinor: inv.discountMinor,
        totalMinor: inv.totalMinor,
      }),
    );
  }

  if (inv.invoiceDate && inv.dueDate) {
    rules.push({
      rule: "due_date_not_before_invoice_date",
      passed: inv.dueDate >= inv.invoiceDate,
      detail:
        inv.dueDate >= inv.invoiceDate ? null : `due ${inv.dueDate} < issued ${inv.invoiceDate}`,
    });
  }

  rules.push({
    rule: "no_review_flags",
    passed: inv.reviewFlags.length === 0,
    detail: inv.reviewFlags.length ? inv.reviewFlags.join(", ") : null,
  });

  const vendor = await resolveVendor(deps, tenantId, inv.vendorNameRaw, inv.vendorTaxIdRaw);
  rules.push({
    rule: "vendor_resolved",
    passed: vendor.vendorId !== null,
    detail: vendor.method,
  });

  // Duplicate-payment guard: same vendor + invoice number already in the system as another PDF.
  if (vendor.vendorId && inv.invoiceNumber) {
    const dups = await deps.db
      .select({ id: i.id })
      .from(i)
      .where(
        and(
          eq(i.tenantId, tenantId),
          eq(i.vendorId, vendor.vendorId),
          eq(i.invoiceNumber, inv.invoiceNumber),
          ne(i.id, invoiceId),
          notInArray(i.status, ["rejected", "failed"]),
        ),
      )
      .limit(1);
    rules.push({
      rule: "not_duplicate",
      passed: dups.length === 0,
      detail: dups[0] ? `same vendor and number as invoice ${dups[0].id}` : null,
    });
  }

  const committed = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(i)
      .set({ vendorId: vendor.vendorId, version: sql`${i.version} + 1` })
      .where(and(eq(i.id, invoiceId), eq(i.status, "extracted")))
      .returning({ id: i.id });
    if (updated.length === 0) return false;
    await tx
      .delete(schema.validationResults)
      .where(eq(schema.validationResults.invoiceId, invoiceId));
    await tx
      .insert(schema.validationResults)
      .values(rules.map((r) => ({ invoiceId, rule: r.rule, passed: r.passed, detail: r.detail })));
    return true;
  });
  if (!committed) return { skipped: "concurrent" };

  await deps.queues.match.add("match", job.data, { jobId: stageJobId(invoiceId, "match") });
  return { rules: rules.length, failed: rules.filter((r) => !r.passed).map((r) => r.rule) };
};
