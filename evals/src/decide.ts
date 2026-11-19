/**
 * The deterministic half of the pipeline, run without a database: the same functions the worker's
 * validate and match stages call (packages/matching), fed from the golden doc's context instead of
 * vendor/PO tables. Used to compute the expected decision from labels and the actual decision from
 * model output, so "auto-approve error rate" measures the system, not the model alone.
 */
import { toMinorUnits, type InvoiceExtraction } from "@ledgerline/contracts";
import {
  checkArithmetic,
  decideApproval,
  normalizeVendorName,
  resolveCurrency,
  threeWayMatch,
  type CurrencyDecision,
  type MatchOutcome,
  type RuleResult,
} from "@ledgerline/matching";
import type { GoldenContext } from "./golden-types.js";

const normTax = (t: string | null) => (t ? t.replace(/[\s.-]/g, "").toUpperCase() : null);

/** Mirrors resolveVendor's first two tiers (tax id, exact normalized name). No fuzzy tier offline. */
export function vendorResolves(extracted: InvoiceExtraction["vendor"], ctx: GoldenContext) {
  if (extracted.taxId && normTax(extracted.taxId) === normTax(ctx.vendor.taxId)) return true;
  return normalizeVendorName(extracted.name) === normalizeVendorName(ctx.vendor.name);
}

const sameRef = (a: string | null, b: string | null) =>
  !!a && !!b && a.replace(/\s/g, "").toUpperCase() === b.replace(/\s/g, "").toUpperCase();

/**
 * Mirrors the validate stage's currency step: the printed marker, then the matched PO, then the
 * resolved vendor's default. Returns the extraction as the system would store it.
 */
export function withResolvedCurrency(
  x: InvoiceExtraction,
  printed: string | null,
  ctx: GoldenContext,
): { x: InvoiceExtraction; currency: CurrencyDecision } {
  const po = ctx.po && sameRef(x.poNumber, ctx.po.poNumber) ? ctx.po : null;
  const currency = resolveCurrency({
    extracted: x.currency,
    printed,
    poCurrency: po?.currency ?? null,
    vendorDefault: vendorResolves(x.vendor, ctx) ? ctx.vendor.defaultCurrency : null,
  });
  return { x: { ...x, currency: currency.currency }, currency };
}

export interface Decision {
  decision: "approved" | "needs_review";
  failedRules: string[];
  match: MatchOutcome;
}

export function decide(
  x: InvoiceExtraction,
  ctx: GoldenContext,
  flags: string[],
  extraRules: RuleResult[] = [],
): Decision {
  const cur = x.currency;
  const m = (v: string) => toMinorUnits(v, cur);
  const rules = [
    ...checkArithmetic({
      lines: x.lineItems.map((l) => ({
        quantity: l.quantity,
        unitPriceMinor: m(l.unitPrice),
        amountMinor: m(l.amount),
      })),
      subtotalMinor: m(x.subtotal),
      taxMinor: m(x.tax),
      discountMinor: x.discount === null ? null : m(x.discount),
      totalMinor: m(x.total),
    }),
    { rule: "no_review_flags", passed: flags.length === 0, detail: null },
    ...extraRules,
  ];
  const po = ctx.po && sameRef(x.poNumber, ctx.po.poNumber) ? ctx.po : null;
  const match = threeWayMatch({
    invoice: {
      currency: cur,
      lines: x.lineItems.map((l, i) => ({
        lineNo: i + 1,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: m(l.unitPrice),
      })),
    },
    po: po
      ? {
          id: po.poNumber,
          currency: po.currency,
          lines: po.lines.map((l, i) => ({
            id: String(i),
            sku: l.sku,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: toMinorUnits(l.unitPrice, po.currency),
          })),
        }
      : null,
    received: po?.received ? new Map(po.received.map((q, i) => [String(i), q])) : null,
  });
  const vendorResolved = vendorResolves(x.vendor, ctx);
  return {
    decision: decideApproval({
      documentType: x.documentType,
      rules,
      match: match.outcome,
      vendorResolved,
    }),
    failedRules: [
      ...rules.filter((r) => !r.passed).map((r) => r.rule),
      ...(vendorResolved ? [] : ["vendor_resolved"]),
    ],
    match: match.outcome,
  };
}
