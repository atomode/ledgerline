/**
 * A stand-in "model" for exercising the harness without API access. It returns the labels with
 * deterministic, realistic mistakes (digit slips on degraded scans, a dropped line on long
 * documents, swapped day/month on some dates). It exists to test scoring, gates and reports;
 * a report produced with it is stamped SIMULATED and says nothing about Claude.
 */
import type { InvoiceExtraction } from "@ledgerline/contracts";
import type { GoldenDoc } from "./golden-types.js";
import type { Prediction } from "./run.js";

const hash = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h / 2 ** 32;
};

/** Flip one digit of a decimal string. */
const slip = (v: string) => v.replace(/(\d)(?=[^\d]*$)/, (d) => String((Number(d) + 1) % 10));

export function simulate(doc: GoldenDoc): Prediction {
  const r = (salt: string) => hash(`${doc.id}:${salt}`);
  const pages = doc.tags.pages;
  const classifyLatencyMs = 600 + r("cl") * 900;
  const classifyCost = 1_600 * 0.1 + 8 * 0.5;
  const kind = doc.expected.kind;
  if (!doc.labels) {
    return {
      kind,
      extraction: null,
      warnings: [],
      contentError: null,
      costMicros: Math.round(classifyCost),
      classifyLatencyMs,
      extractLatencyMs: null,
    };
  }
  const x: InvoiceExtraction = structuredClone(doc.labels);
  const errRate = doc.tags.degraded ? 0.25 : 0.04;
  if (r("total") < errRate / 2) x.total = slip(x.total);
  if (r("tax") < errRate) x.tax = slip(x.tax);
  if (r("num") < errRate) x.invoiceNumber = x.invoiceNumber.replace(/0/, "O");
  if (x.dueDate && r("due") < errRate / 2) {
    const [y, m, d] = x.dueDate.split("-");
    if (Number(d) <= 12 && d !== m) x.dueDate = `${y}-${d}-${m}`;
  }
  if (pages > 3 && r("lines") < 0.5) x.lineItems = x.lineItems.slice(0, -2);
  const inputTokens = 1_200 + pages * 2_500;
  const outputTokens = 120 + x.lineItems.length * 45;
  const extractCost = inputTokens * 2 + outputTokens * 10 + 3_000 * 0.1; // Sonnet, cached system prompt
  return {
    kind,
    extraction: x,
    currencyAsPrinted: null,
    warnings: doc.expected.flags,
    contentError: null,
    costMicros: Math.round(classifyCost + extractCost),
    classifyLatencyMs,
    extractLatencyMs: 4_000 + pages * 2_200 + x.lineItems.length * 120 + r("lat") * 3_000,
  };
}
