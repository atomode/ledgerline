/**
 * Scoring functions for the extraction eval. Pure: no I/O, unit-tested in metrics.test.ts.
 */
import { toMinorUnits, type InvoiceExtraction } from "@ledgerline/contracts";
import { normalizeVendorName } from "@ledgerline/matching";

export const HEADER_FIELDS = [
  "vendor",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "currency",
  "subtotal",
  "tax",
  "total",
  "poNumber",
] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

const ref = (s: string | null) => (s === null ? null : s.replace(/\s+/g, "").toUpperCase());
const minor = (v: string | null, currency: string) => {
  if (v === null) return null;
  try {
    return toMinorUnits(v, currency);
  } catch {
    return Number.NaN; // unparseable counts as wrong, never as equal
  }
};

/** Normalized exact match per header field. A missing prediction is wrong for every field. */
export function compareHeader(
  label: InvoiceExtraction,
  pred: InvoiceExtraction | null,
): Record<HeaderField, boolean> {
  const out = {} as Record<HeaderField, boolean>;
  for (const f of HEADER_FIELDS) out[f] = false;
  if (!pred) return out;
  const cur = label.currency;
  out.vendor = normalizeVendorName(pred.vendor.name) === normalizeVendorName(label.vendor.name);
  out.invoiceNumber = ref(pred.invoiceNumber) === ref(label.invoiceNumber);
  out.invoiceDate = pred.invoiceDate === label.invoiceDate;
  out.dueDate = pred.dueDate === label.dueDate;
  out.currency = pred.currency.toUpperCase() === label.currency;
  out.poNumber = ref(pred.poNumber) === ref(label.poNumber);
  // Money compares in the label's currency: a wrong currency already fails its own field.
  out.subtotal = minor(pred.subtotal, cur) === minor(label.subtotal, cur);
  out.tax = minor(pred.tax, cur) === minor(label.tax, cur);
  out.total = minor(pred.total, cur) === minor(label.total, cur);
  return out;
}

/** Levenshtein similarity in [0, 1] on lowercased, whitespace-collapsed strings. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/\s+/g, " ").trim();
  const y = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  let prev = Uint32Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Uint32Array(y.length + 1);
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1);
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub);
    }
    prev = cur;
  }
  return 1 - (prev[y.length] ?? 0) / Math.max(x.length, y.length);
}

export const LINE_DESC_SIMILARITY = 0.8;

/**
 * Greedy one-to-one line matching: a predicted line counts when its description is >= 0.8 similar
 * and quantity and unit price are exactly right. Returns counts for micro-averaged F1.
 */
export function matchLines(
  label: InvoiceExtraction,
  pred: InvoiceExtraction | null,
): { matched: number; predicted: number; expected: number } {
  const expected = label.lineItems.length;
  if (!pred) return { matched: 0, predicted: 0, expected };
  const cur = label.currency;
  const used = new Set<number>();
  let matched = 0;
  for (const p of pred.lineItems) {
    let best = -1;
    let bestSim = 0;
    label.lineItems.forEach((l, i) => {
      if (used.has(i)) return;
      if (Number(p.quantity) !== Number(l.quantity)) return;
      if (minor(p.unitPrice, cur) !== minor(l.unitPrice, cur)) return;
      const s = similarity(p.description, l.description);
      if (s >= LINE_DESC_SIMILARITY && s > bestSim) {
        best = i;
        bestSim = s;
      }
    });
    if (best >= 0) {
      used.add(best);
      matched++;
    }
  }
  return { matched, predicted: pred.lineItems.length, expected };
}

export function f1(matched: number, predicted: number, expected: number): number {
  if (predicted === 0 && expected === 0) return 1;
  const p = predicted ? matched / predicted : 0;
  const r = expected ? matched / expected : 0;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Wilson score interval for a binomial proportion (95% by default). Sound at small n and p near 0/1. */
export function wilson(successes: number, n: number, z = 1.959964): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

/**
 * Deterministic stratified sample: take ceil(fraction * n) from each stratum, choosing by a stable
 * hash of the id so the same subset runs every time (PR-to-PR comparisons stay apples to apples).
 */
export function stratifiedSubset<T extends { id: string }>(
  items: T[],
  fraction: number,
  stratum: (t: T) => string,
): T[] {
  if (fraction >= 1) return items;
  const groups = new Map<string, T[]>();
  for (const t of items) groups.set(stratum(t), [...(groups.get(stratum(t)) ?? []), t]);
  const hash = (s: string) => {
    let h = 2166136261;
    for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h;
  };
  const out: T[] = [];
  for (const g of groups.values()) {
    const k = Math.ceil(g.length * fraction);
    out.push(...[...g].sort((a, b) => hash(a.id) - hash(b.id)).slice(0, k));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
