import { lineTotalMinor } from "./decimal.js";

export interface MoneyLine {
  quantity: string;
  unitPriceMinor: number;
  amountMinor: number;
}

export interface Totals {
  lines: MoneyLine[];
  subtotalMinor: number;
  taxMinor: number;
  discountMinor: number | null;
  totalMinor: number;
}

export interface RuleResult {
  rule: string;
  passed: boolean;
  detail: string | null;
}

/** Rounding on printed invoices can drift by a cent; anything more is a real discrepancy. */
export const ROUNDING_TOLERANCE_MINOR = 1;

const within = (a: number, b: number, tol = ROUNDING_TOLERANCE_MINOR) => Math.abs(a - b) <= tol;

/**
 * Deterministic arithmetic checks on an extraction. These catch most extraction errors for free:
 * a misread digit almost never keeps all three identities true at once.
 */
export function checkArithmetic(t: Totals): RuleResult[] {
  const results: RuleResult[] = [];

  const badLines = t.lines
    .map((l, i) => ({
      i,
      expected: lineTotalMinor(l.quantity, l.unitPriceMinor),
      actual: l.amountMinor,
    }))
    .filter((x) => !within(x.expected, x.actual));
  results.push({
    rule: "line_qty_times_price",
    passed: badLines.length === 0,
    detail: badLines.length
      ? badLines.map((b) => `line ${b.i + 1}: expected ${b.expected}, got ${b.actual}`).join("; ")
      : null,
  });

  if (t.lines.length > 0) {
    const sum = t.lines.reduce((s, l) => s + l.amountMinor, 0);
    // Allow 1 minor unit of rounding per line, at least 1.
    const tol = Math.max(ROUNDING_TOLERANCE_MINOR, t.lines.length);
    results.push({
      rule: "lines_sum_to_subtotal",
      passed: within(sum, t.subtotalMinor, tol),
      detail: within(sum, t.subtotalMinor, tol)
        ? null
        : `lines sum ${sum}, subtotal ${t.subtotalMinor}`,
    });
  }

  const expectedTotal = t.subtotalMinor + t.taxMinor - (t.discountMinor ?? 0);
  results.push({
    rule: "subtotal_plus_tax_minus_discount_equals_total",
    passed: within(expectedTotal, t.totalMinor),
    detail: within(expectedTotal, t.totalMinor)
      ? null
      : `expected ${expectedTotal}, got ${t.totalMinor}`,
  });
  return results;
}
