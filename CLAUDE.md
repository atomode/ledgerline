# Ledgerline: rules for every Claude Code session

Ledgerline ingests supplier invoice PDFs, extracts structured data with Claude, runs a deterministic
3-way match (invoice vs purchase order vs goods receipt), auto-approves safe invoices and routes the
rest to human review.

## Non-negotiable design rules

1. **Models extract, code decides.** Claude only turns documents into data. Approval, tolerances and
   matching are plain functions in `packages/matching` that an auditor can read. Never let a model
   output decide whether an invoice is paid.
2. **Postgres is the system of record; Redis only holds in-flight work.** If Redis is wiped, the
   reconciler rebuilds the queues from invoice status in Postgres.
3. **Every POST accepts `Idempotency-Key`.** Same key + same body returns the stored response; same
   key + different body is 422.
4. **List endpoints use keyset cursors, never offset.** Opaque base64 cursor over the sort key + id.
5. **One retry policy per call site.** Where BullMQ retries, the Anthropic SDK runs with
   `maxRetries: 0` so retries don't multiply.
6. **Every queue has a DLQ** (`<queue>.dlq`) plus a `job_failures` row. Content problems (model output
   that fails validation after one repair) go to human review, not the DLQ.
7. **Migrations are expand/contract.** No destructive change in the same release that stops using a
   column. Generated SQL is committed and reviewed.
8. **No document content or PII in logs or span attributes.**

## Layout

- `apps/api`: Fastify HTTP API
- `apps/worker`: BullMQ processors
- `packages/config`: env parsing (fail fast)
- `packages/contracts`: Zod schemas (source of truth), OpenAPI, typed client
- `packages/db`: Drizzle schema, migrations, seeds
- `packages/extraction`: Claude calls, prompts, prompt versions
- `packages/matching`: pure 3-way match, no I/O
- `packages/observability`: OpenTelemetry
- `evals`: golden set + harness

## Conventions

- TypeScript strict, ESM, NodeNext resolution: relative imports end in `.js`.
- Unit tests: `src/**/*.test.ts`, no network or Docker. Integration tests: `test/integration/**`,
  Testcontainers.
- Models: `claude-sonnet-5-5` for extraction, `claude-haiku-5-5` for classification. Use only exact
  model IDs.

## Queues and workers

- Stage queues `ll-<stage>` (classify, extract, validate, match, notify), DLQs `ll-<stage>-dlq`.
- Job ids are deterministic: `<invoiceId>__<stage>` (BullMQ forbids ":" in custom ids). Completed
  jobs are removed so the reconciler can enqueue the same id again.
- Processors check invoice status first and update with a status guard (`WHERE status = ...`), so
  duplicate or replayed jobs are no-ops. Enqueue the next stage only after the DB commit.
- Retry policy: `fullJitterBackoff` (base 2s, cap 60s, honors Retry-After), 5 attempts.
  `classifyError` decides retryable vs `UnrecoverableError`.
- Chaos test: `pnpm --filter @ledgerline/worker chaos` (needs infra up, migrations, seed, build).

## Contracts

- Zod schemas in `packages/contracts/src` are the source of truth. Routes in `apps/api` use them via
  `fastify-type-provider-zod`; `openapi.yaml` is generated from the live routes, and the typed client
  (`@ledgerline/contracts/client`, openapi-fetch) from `openapi.yaml`.
- After changing a schema or route: `pnpm contracts:generate` and commit. CI runs `pnpm contracts:check`.
- Money in the API is `{ amountMinor, currency }`. Money from the model is a decimal string; converting
  to minor units is code's job because it depends on the currency's exponent.
- No GraphQL: the API is job submission + list/detail reads; REST + OpenAPI covers it. Revisit only if
  a UI needs flexible nested reads.

## Commands

`pnpm infra:up`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`,
`pnpm contracts:generate`, `pnpm contracts:check`, `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm eval`, `pnpm dev`.
