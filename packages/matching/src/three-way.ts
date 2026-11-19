import { normalizeVendorName } from "./vendor.js";
import { parseScaled } from "./decimal.js";

export const DEFAULT_PRICE_TOLERANCE = 0.02;

export interface InvoiceLineIn {
  lineNo: number;
  sku: string | null;
  description: string;
  quantity: string;
  unitPriceMinor: number;
}
export interface PoLineIn {
  id: string;
  sku: string | null;
  description: string;
  quantity: string;
  unitPriceMinor: number;
}
export interface MatchInput {
  invoice: { currency: string; lines: InvoiceLineIn[] };
  po: { id: string; currency: string; lines: PoLineIn[] } | null;
  /** po line id -> quantity received (decimal string). null = no goods receipt at all. */
  received: Map<string, string> | null;
  priceTolerance?: number;
}

export type DiscrepancyKind =
  "price" | "quantity" | "currency" | "missing_line" | "unexpected_line";
export interface Discrepancy {
  kind: DiscrepancyKind;
  lineRef: string | null;
  expected: string | null;
  actual: string | null;
  withinTolerance: boolean;
}
export type MatchOutcome = "matched" | "within_tolerance" | "mismatch" | "no_po" | "no_receipt";
export interface MatchResultOut {
  outcome: MatchOutcome;
  purchaseOrderId: string | null;
  discrepancies: Discrepancy[];
}

const key = (sku: string | null, description: string) =>
  sku ? `sku:${sku.trim().toUpperCase()}` : `desc:${normalizeVendorName(description)}`;

/**
 * Deterministic 3-way match: invoice vs purchase order vs goods receipt.
 * - Lines pair by SKU, falling back to normalized description.
 * - Unit price may drift up to `priceTolerance` (default 2%) and still pass as within_tolerance.
 * - Billed quantity must not exceed received quantity (no tolerance: paying for undelivered goods
 *   is the failure this whole process exists to stop).
 */
export function threeWayMatch(input: MatchInput): MatchResultOut {
  const tol = input.priceTolerance ?? DEFAULT_PRICE_TOLERANCE;
  if (!input.po) return { outcome: "no_po", purchaseOrderId: null, discrepancies: [] };
  const po = input.po;
  const d: Discrepancy[] = [];

  if (po.currency !== input.invoice.currency) {
    d.push({
      kind: "currency",
      lineRef: null,
      expected: po.currency,
      actual: input.invoice.currency,
      withinTolerance: false,
    });
    return { outcome: "mismatch", purchaseOrderId: po.id, discrepancies: d };
  }
  if (!input.received) return { outcome: "no_receipt", purchaseOrderId: po.id, discrepancies: [] };

  const poByKey = new Map(po.lines.map((l) => [key(l.sku, l.description), l]));
  const used = new Set<string>();

  for (const line of input.invoice.lines) {
    const ref = String(line.lineNo);
    const poLine = poByKey.get(key(line.sku, line.description));
    if (!poLine) {
      d.push({
        kind: "unexpected_line",
        lineRef: ref,
        expected: null,
        actual: line.description,
        withinTolerance: false,
      });
      continue;
    }
    used.add(poLine.id);

    if (line.unitPriceMinor !== poLine.unitPriceMinor) {
      const variance =
        Math.abs(line.unitPriceMinor - poLine.unitPriceMinor) /
        Math.max(1, Math.abs(poLine.unitPriceMinor));
      d.push({
        kind: "price",
        lineRef: ref,
        expected: String(poLine.unitPriceMinor),
        actual: String(line.unitPriceMinor),
        // Small epsilon so exactly-2.00% counts as within tolerance despite float division.
        withinTolerance: variance <= tol + 1e-9,
      });
    }

    const billed = parseScaled(line.quantity);
    const received = parseScaled(input.received.get(poLine.id) ?? "0");
    if (billed > received) {
      d.push({
        kind: "quantity",
        lineRef: ref,
        expected: input.received.get(poLine.id) ?? "0",
        actual: line.quantity,
        withinTolerance: false,
      });
    }
  }

  const outcome: MatchOutcome = d.some((x) => !x.withinTolerance)
    ? "mismatch"
    : d.length > 0
      ? "within_tolerance"
      : "matched";
  return { outcome, purchaseOrderId: po.id, discrepancies: d };
}

export interface ApprovalInput {
  documentType: "invoice" | "credit_note";
  rules: { passed: boolean }[];
  match: MatchOutcome;
  vendorResolved: boolean;
}

/**
 * The auto-approve gate. Every condition must hold; anything else goes to a human.
 * Credit notes always get a human: they move money the other way and are rare enough to afford it.
 */
export function decideApproval(a: ApprovalInput): "approved" | "needs_review" {
  if (a.documentType === "credit_note") return "needs_review";
  if (!a.vendorResolved) return "needs_review";
  if (!a.rules.every((r) => r.passed)) return "needs_review";
  return a.match === "matched" || a.match === "within_tolerance" ? "approved" : "needs_review";
}
