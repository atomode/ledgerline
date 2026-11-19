/**
 * Extraction eval harness: runs the golden set through the real classify + extract code and the
 * real deterministic gate, scores it, writes a report, and exits non-zero on any threshold breach.
 *
 *   pnpm eval                                  full set, claude-sonnet-5-5 (needs ANTHROPIC_API_KEY)
 *   pnpm eval --subset 0.3                     stratified 30% sample (PR CI)
 *   pnpm eval --model claude-opus-5-5          compare models; cache keys include the model
 *   pnpm eval --backend simulate               no API calls: a label-derived fake with injected
 *                                              errors, to exercise scoring and reporting only.
 *                                              Its numbers say nothing about model quality.
 *
 * Responses are cached in evals/.cache by (pdf hash, models, prompt versions): a re-run with no
 * prompt or model change costs nothing; any prompt edit changes PROMPT_VERSION and misses the cache.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { InvoiceExtraction } from "@ledgerline/contracts";
import {
  CLASSIFY_PROMPT_VERSION,
  ExtractionContentError,
  PROMPT_VERSION,
  classifyDocument,
  extractInvoice,
} from "@ledgerline/extraction";
import { decide } from "./decide.js";
import type { DocumentKind, GoldenDoc } from "./golden-types.js";
import {
  HEADER_FIELDS,
  compareHeader,
  f1,
  matchLines,
  percentile,
  stratifiedSubset,
  wilson,
  type HeaderField,
} from "./metrics.js";
import { simulate } from "./simulate.js";

const { values: args } = parseArgs({
  options: {
    subset: { type: "string", default: "1" },
    model: { type: "string", default: process.env.EXTRACTION_MODEL ?? "claude-sonnet-5-5" },
    "classify-model": { type: "string", default: process.env.CLASSIFY_MODEL ?? "claude-haiku-5-5" },
    backend: { type: "string", default: "live" },
    concurrency: { type: "string", default: "4" },
    "no-cache": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const ROOT = new URL("../", import.meta.url);
const backend = args.backend as "live" | "simulate";

// --- load golden set -------------------------------------------------------------------------
interface Loaded {
  id: string;
  doc: GoldenDoc;
  pdf: Buffer;
}
async function loadGolden(): Promise<Loaded[]> {
  const out: Loaded[] = [];
  for (const dir of ["synthetic", "adversarial", "real"]) {
    const base = new URL(`golden/${dir}/`, ROOT);
    const files = await readdir(base).catch(() => [] as string[]);
    for (const f of files.filter((x) => x.endsWith(".json")).sort()) {
      const doc = JSON.parse(await readFile(new URL(f, base), "utf8")) as GoldenDoc;
      const pdf = await readFile(new URL(f.replace(/\.json$/, ".pdf"), base));
      out.push({ id: doc.id, doc, pdf });
    }
  }
  return out;
}

// --- run one document through the pipeline ----------------------------------------------------
export interface Prediction {
  kind: DocumentKind;
  extraction: InvoiceExtraction | null;
  warnings: string[];
  contentError: string | null;
  costMicros: number;
  classifyLatencyMs: number;
  extractLatencyMs: number | null;
}

const cacheKey = (pdf: Buffer) =>
  createHash("sha256")
    .update(createHash("sha256").update(pdf).digest("hex"))
    .update(`|${args.model}|${args["classify-model"]}|${PROMPT_VERSION}|${CLASSIFY_PROMPT_VERSION}`)
    .digest("hex");

async function runLive(client: Anthropic, pdf: Buffer): Promise<Prediction> {
  let t = performance.now();
  const c = await classifyDocument(client, pdf, { model: args["classify-model"]! });
  const classifyLatencyMs = performance.now() - t;
  const base = { kind: c.kind, classifyLatencyMs, costMicros: c.costMicros };
  if (c.kind !== "invoice" && c.kind !== "credit_note") {
    return { ...base, extraction: null, warnings: [], contentError: null, extractLatencyMs: null };
  }
  t = performance.now();
  try {
    const x = await extractInvoice(client, pdf, { model: args.model! });
    return {
      ...base,
      kind: x.data.documentType,
      extraction: x.data,
      warnings: x.warnings,
      contentError: null,
      costMicros: base.costMicros + x.costMicros,
      extractLatencyMs: performance.now() - t,
    };
  } catch (err) {
    if (!(err instanceof ExtractionContentError)) throw err;
    return {
      ...base,
      extraction: null,
      warnings: [],
      contentError: err.reason,
      extractLatencyMs: performance.now() - t,
    };
  }
}

async function predict(client: Anthropic | null, item: Loaded): Promise<Prediction> {
  if (backend === "simulate") return simulate(item.doc);
  const key = cacheKey(item.pdf);
  const file = new URL(`.cache/${key}.json`, ROOT);
  if (!args["no-cache"]) {
    const hit = await readFile(file, "utf8").catch(() => null);
    if (hit) return JSON.parse(hit) as Prediction;
  }
  const pred = await runLive(client!, item.pdf);
  await mkdir(new URL(".cache/", ROOT), { recursive: true });
  await writeFile(file, JSON.stringify(pred));
  return pred;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// --- score -------------------------------------------------------------------------------------
interface DocScore {
  id: string;
  tags: GoldenDoc["tags"];
  kindCorrect: boolean;
  fields: Record<HeaderField, boolean> | null;
  totalExact: boolean | null;
  lines: { matched: number; predicted: number; expected: number } | null;
  expectedDecision: GoldenDoc["expected"]["decision"];
  decision: "approved" | "needs_review" | "not_extracted";
  flagsCorrect: boolean;
  costMicros: number;
  pred: Prediction;
}

function score(item: Loaded, pred: Prediction): DocScore {
  const { doc } = item;
  const flags = pred.warnings;
  const decision = pred.extraction
    ? decide(pred.extraction, doc.context, flags).decision
    : "not_extracted";
  const fields = doc.labels ? compareHeader(doc.labels, pred.extraction) : null;
  return {
    id: doc.id,
    tags: doc.tags,
    kindCorrect: pred.kind === doc.expected.kind,
    fields,
    totalExact: fields ? fields.total : null,
    lines: doc.labels ? matchLines(doc.labels, pred.extraction) : null,
    expectedDecision: doc.expected.decision,
    decision,
    flagsCorrect: [...flags].sort().join() === [...doc.expected.flags].sort().join(),
    costMicros: pred.costMicros,
    pred,
  };
}

interface Rate {
  value: number;
  successes: number;
  n: number;
  ci: [number, number];
}
const rate = (successes: number, n: number): Rate => ({
  value: n ? successes / n : 1,
  successes,
  n,
  ci: wilson(successes, n),
});

function aggregate(scores: DocScore[]) {
  const labelled = scores.filter((s) => s.fields);
  const fieldHits = labelled.reduce(
    (a, s) => a + HEADER_FIELDS.filter((f) => s.fields![f]).length,
    0,
  );
  const lines = labelled.reduce(
    (a, s) => ({
      matched: a.matched + s.lines!.matched,
      predicted: a.predicted + s.lines!.predicted,
      expected: a.expected + s.lines!.expected,
    }),
    { matched: 0, predicted: 0, expected: 0 },
  );
  const approved = scores.filter((s) => s.decision === "approved");
  const wrongApproved = approved.filter(
    (s) => !s.fields || HEADER_FIELDS.some((f) => !s.fields![f]),
  );
  const shouldApprove = scores.filter((s) => s.expectedDecision === "approved");
  const injection = scores.filter((s) => s.tags.scenario === "injection");
  const injectionOk = injection.filter((s) => s.totalExact === true && s.decision !== "approved");
  const costs = scores.map((s) => s.costMicros / 1e6);
  const extractLat = scores
    .map((s) => s.pred.extractLatencyMs)
    .filter((x): x is number => x !== null);
  const classifyLat = scores.map((s) => s.pred.classifyLatencyMs);
  return {
    docs: scores.length,
    headerFieldAccuracy: rate(fieldHits, labelled.length * HEADER_FIELDS.length),
    totalExactMatch: rate(labelled.filter((s) => s.totalExact).length, labelled.length),
    lineItemF1: {
      value: f1(lines.matched, lines.predicted, lines.expected),
      precision: rate(lines.matched, lines.predicted),
      recall: rate(lines.matched, lines.expected),
    },
    autoApproveErrorRate: rate(wrongApproved.length, approved.length),
    autoApproveCoverage: rate(
      shouldApprove.filter((s) => s.decision === "approved").length,
      shouldApprove.length,
    ),
    approvedAgainstExpectation: rate(
      approved.filter((s) => s.expectedDecision !== "approved").length,
      approved.length,
    ),
    injectionResistance: rate(injectionOk.length, injection.length),
    classificationAccuracy: rate(scores.filter((s) => s.kindCorrect).length, scores.length),
    flagAccuracy: rate(scores.filter((s) => s.flagsCorrect).length, scores.length),
    meanCostUsd: costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length),
    p95CostUsd: percentile(costs, 95),
    p50ExtractLatencyMs: percentile(extractLat, 50),
    p95ExtractLatencyMs: percentile(extractLat, 95),
    p50ClassifyLatencyMs: percentile(classifyLat, 50),
    p95ClassifyLatencyMs: percentile(classifyLat, 95),
  };
}
type Summary = ReturnType<typeof aggregate>;

function checkThresholds(s: Summary, t: Record<string, { min?: number; max?: number }>) {
  const valueOf = (k: string): number => {
    const v = (s as unknown as Record<string, unknown>)[k];
    return typeof v === "number" ? v : (v as { value: number }).value;
  };
  return Object.entries(t)
    .filter(([k]) => !k.startsWith("$"))
    .map(([k, { min, max }]) => {
      const v = valueOf(k);
      const n = (s as unknown as Record<string, { n?: number }>)[k]?.n;
      // A rate with no observations (e.g. nothing auto-approved) is not evidence either way.
      const skipped = n === 0;
      const ok = skipped || ((min === undefined || v >= min) && (max === undefined || v <= max));
      return { metric: k, value: v, min, max, ok, skipped };
    });
}

// --- report ------------------------------------------------------------------------------------
const pct = (r: Rate) =>
  `${(r.value * 100).toFixed(1)}% [${(r.ci[0] * 100).toFixed(1)}, ${(r.ci[1] * 100).toFixed(1)}] (${r.successes}/${r.n})`;

function breakdown(scores: DocScore[], by: (s: DocScore) => string) {
  const groups = new Map<string, DocScore[]>();
  for (const s of scores) groups.set(by(s), [...(groups.get(by(s)) ?? []), s]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, g]) => {
      const a = aggregate(g);
      return `| ${k} | ${a.docs} | ${pct(a.headerFieldAccuracy)} | ${pct(a.totalExactMatch)} | ${a.lineItemF1.value.toFixed(3)} |`;
    })
    .join("\n");
}

function worst(scores: DocScore[], items: Map<string, Loaded>) {
  return scores
    .filter((s) => s.fields)
    .map((s) => ({ s, wrong: HEADER_FIELDS.filter((f) => !s.fields![f]) }))
    .filter((x) => x.wrong.length > 0 || x.s.lines!.matched < x.s.lines!.expected)
    .sort((a, b) => b.wrong.length - a.wrong.length)
    .slice(0, 10)
    .map(({ s, wrong }) => {
      const label = items.get(s.id)!.doc.labels!;
      const pred = s.pred.extraction;
      const get = (x: InvoiceExtraction | null, f: HeaderField) =>
        x === null ? "∅" : f === "vendor" ? x.vendor.name : String(x[f] ?? "null");
      const diffs = wrong
        .map((f) => `  - \`${f}\`: expected \`${get(label, f)}\`, got \`${get(pred, f)}\``)
        .join("\n");
      return `- **${s.id}** (${s.tags.layout}${s.tags.degraded ? ", degraded" : ""}, ${s.tags.scenario}): ${wrong.length} wrong fields, lines ${s.lines!.matched}/${s.lines!.expected}${s.pred.contentError ? `, content error: ${s.pred.contentError}` : ""}\n${diffs}`;
    })
    .join("\n");
}

function markdown(
  s: Summary,
  checks: ReturnType<typeof checkThresholds>,
  scores: DocScore[],
  items: Map<string, Loaded>,
  meta: Record<string, string>,
) {
  const simulated =
    backend === "simulate"
      ? "\n> **SIMULATED RUN.** Predictions came from a label-derived fake with injected errors, not from Claude. Use it to check the harness, never to judge a model or prompt.\n"
      : "";
  return `# Ledgerline extraction eval
${simulated}
| | |
|---|---|
${Object.entries(meta)
  .map(([k, v]) => `| ${k} | \`${v}\` |`)
  .join("\n")}

## Gates

| Metric | Value | Threshold | |
|---|---|---|---|
${checks.map((c) => `| ${c.metric} | ${c.metric.includes("Cost") ? `$${c.value.toFixed(4)}` : c.metric.includes("Latency") ? `${Math.round(c.value)} ms` : c.value.toFixed(4)} | ${c.min !== undefined ? `≥ ${c.min}` : `≤ ${c.max}`} | ${c.skipped ? "n/a (no samples)" : c.ok ? "pass" : "**FAIL**"} |`).join("\n")}

## Rates with 95% Wilson intervals

| Metric | Value [95% CI] (k/n) |
|---|---|
| Header field accuracy | ${pct(s.headerFieldAccuracy)} |
| Total exact match | ${pct(s.totalExactMatch)} |
| Line-item precision | ${pct(s.lineItemF1.precision)} |
| Line-item recall | ${pct(s.lineItemF1.recall)} |
| Auto-approve error rate | ${pct(s.autoApproveErrorRate)} |
| Auto-approve coverage | ${pct(s.autoApproveCoverage)} |
| Approved but expected review | ${pct(s.approvedAgainstExpectation)} |
| Injection resistance | ${pct(s.injectionResistance)} |
| Classification accuracy | ${pct(s.classificationAccuracy)} |
| Review-flag accuracy | ${pct(s.flagAccuracy)} |

Line-item F1: **${s.lineItemF1.value.toFixed(3)}**. Cost per document: mean $${s.meanCostUsd.toFixed(4)}, p95 $${s.p95CostUsd.toFixed(4)}. Latency: extract p50 ${Math.round(s.p50ExtractLatencyMs)} ms, p95 ${Math.round(s.p95ExtractLatencyMs)} ms; classify p50 ${Math.round(s.p50ClassifyLatencyMs)} ms, p95 ${Math.round(s.p95ClassifyLatencyMs)} ms.

## By source

| Group | Docs | Header accuracy | Total exact | Line F1 |
|---|---|---|---|---|
${breakdown(scores, (x) => x.tags.source)}

## By layout

| Group | Docs | Header accuracy | Total exact | Line F1 |
|---|---|---|---|---|
${breakdown(scores, (x) => x.tags.layout)}

## Clean vs degraded scans

| Group | Docs | Header accuracy | Total exact | Line F1 |
|---|---|---|---|---|
${breakdown(scores, (x) => (x.tags.degraded ? "degraded" : "clean"))}

## Worst documents

${worst(scores, items) || "None: every labelled document was extracted exactly."}
`;
}

// --- main --------------------------------------------------------------------------------------
const all = await loadGolden();
const fraction = Number(args.subset);
const chosen = stratifiedSubset(
  all,
  fraction,
  (x) =>
    `${x.doc.tags.source}|${x.doc.tags.degraded}|${x.doc.tags.source === "adversarial" ? x.id : x.doc.tags.layout}`,
);
if (backend === "live" && !process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. Use --backend simulate to exercise the harness without the API.",
  );
  process.exit(2);
}
// One retry policy for this call site: the SDK's own (no queue here).
const client = backend === "live" ? new Anthropic({ maxRetries: 4, timeout: 120_000 }) : null;

const started = Date.now();
const preds = await pool(chosen, Number(args.concurrency), (item) => predict(client, item));
const scores = chosen.map((item, i) => score(item, preds[i]!));
const summary = aggregate(scores);
const thresholds = JSON.parse(await readFile(new URL("thresholds.json", ROOT), "utf8"));
const checks = checkThresholds(summary, thresholds);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const meta = {
  backend,
  model: args.model!,
  classifyModel: args["classify-model"]!,
  promptVersion: PROMPT_VERSION,
  classifyPromptVersion: CLASSIFY_PROMPT_VERSION,
  documents: `${chosen.length} of ${all.length} (subset ${fraction})`,
  wallClock: `${((Date.now() - started) / 1000).toFixed(1)}s`,
};
const md = markdown(summary, checks, scores, new Map(chosen.map((c) => [c.id, c])), meta);
const outBase = args.out ?? `reports/${stamp}`;
await mkdir(new URL(outBase.split("/").slice(0, -1).join("/") + "/", ROOT), { recursive: true });
await writeFile(new URL(`${outBase}.md`, ROOT), md);
await writeFile(
  new URL(`${outBase}.json`, ROOT),
  JSON.stringify(
    {
      meta,
      summary,
      checks,
      documents: scores.map(({ pred, ...s }) => ({ ...s, contentError: pred.contentError })),
    },
    null,
    2,
  ),
);

console.log(md);
console.log(`report: evals/${outBase}.md`);
const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`EVAL FAILED: ${failed.map((c) => c.metric).join(", ")}`);
  process.exit(1);
}
