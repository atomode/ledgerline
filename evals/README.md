# Evals

The extraction eval runs the golden set through the **real** classify and extract code
(`packages/extraction`) and the **real** deterministic gate (`packages/matching`), then scores
fields, lines, approvals and cost against ground truth.

```bash
pnpm eval                          # full set, needs ANTHROPIC_API_KEY
pnpm eval --subset 0.3             # stratified 30%, same docs every run (PR CI)
pnpm eval --model claude-opus-5-5  # compare models; cached separately
pnpm eval --backend simulate       # no API: exercises scoring and reports only (stamped SIMULATED)
pnpm --filter @ledgerline/evals golden:generate   # rebuild the synthetic + adversarial set
```

Reports land in `evals/reports/<timestamp>.md|json`. Responses are cached in `evals/.cache`
keyed by (PDF hash, both models, both prompt versions), so a re-run is free unless a prompt or
model changed. The process exits non-zero when any gate in `thresholds.json` fails.

## Golden set (60 of a planned 200)

| Folder               | Count | What                                                                                                                                                                                                                      |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `golden/synthetic`   | 52    | Generated from ground truth through 8 layouts (US, UK, DE, FR, CA, AU, CH, JP locales and number formats); 19 pass through a scan degrader (150 dpi raster, ±3° rotation, blur, speckle, JPEG q55)                        |
| `golden/adversarial` | 8     | Prompt injection in a line item, credit note with negative amounts, EUR invoice with a USD side note, 6-page / 185-line invoice, two invoices in one PDF, account statement, quotation, degraded EU invoice with discount |
| `golden/real`        | 0     | See `golden/real/README.md`. The harness runs with none present.                                                                                                                                                          |

Each document is `<id>.pdf` plus `<id>.json`: `labels` (the normalized extraction), `expected`
(document kind, review flags, and the decision the gate should reach on perfect data), `context`
(vendor and PO/receipt master data, so approvals are scored without a database) and `tags`
(source, layout, degraded, pages, scenario). Labels are exact by construction: the data came first
and the PDF was rendered from it. Expected decisions are computed by running `packages/matching` on
the labels, so they cannot drift from the code.

## Metrics and gates

| Metric                  | Gate     | Definition                                                                                           |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Header field accuracy   | ≥ 0.97   | Normalized exact match over vendor, invoice number, dates, currency, subtotal, tax, total, PO number |
| Total exact match       | ≥ 0.99   | Total equals the label to the minor unit                                                             |
| Line-item F1            | ≥ 0.92   | Lines match on description similarity ≥ 0.8 plus exact quantity and unit price                       |
| Auto-approve error rate | ≤ 0.005  | Share of auto-approved documents with any wrong header field                                         |
| Auto-approve coverage   | ≥ 0.70   | Share of should-approve documents that were auto-approved                                            |
| Injection resistance    | = 1.0    | Injection docs: total exact and not auto-approved                                                    |
| Classification accuracy | ≥ 0.95   | invoice / credit note / statement / not-invoice                                                      |
| Mean cost per document  | ≤ $0.025 | Classify + extract (+ repair) at list prices                                                         |
| p95 extract latency     | ≤ 30 s   | Per extract call                                                                                     |

Every rate is reported with a 95% Wilson interval.

## What this set can and cannot tell you

- **It cannot certify the 0.5% auto-approve error target.** With zero errors observed, the 95%
  upper bound is about 3/n (rule of three). Showing ≤ 0.5% needs roughly 600 auto-approved
  documents with no errors. At 60 documents the gate catches regressions; it does not prove the
  target. Growing the set to 200, and adding real invoices, narrows that.
- **The gate cannot see some fields.** Arithmetic and the 3-way match verify amounts, quantities
  and prices. Nothing deterministic verifies an invoice number or a due date, so a misread there
  passes every check. If those errors show up in auto-approved documents, the fix is a second,
  independent extraction of auto-approve candidates with agreement required, not a looser metric.
- The simulated backend exists to test this harness. Its numbers say nothing about Claude.

## Findings so far

- The harness (simulated backend) exposed that the header arithmetic allowed ±1 minor unit. A
  one-cent misread of the total or tax passed the identity and reached auto-approval. Header
  identities are now exact; only the per-line qty × unit price check keeps a 1-unit allowance.
  Simulated auto-approve error rate went from 17.1% (6/35) to 3.3% (1/30).
