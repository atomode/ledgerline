# Ledgerline

Accounts-payable invoice extraction and 3-way matching. Claude reads invoices; deterministic code
decides what gets paid.

> Status: work in progress. See `CLAUDE.md` for design rules.

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm infra:up        # Postgres, Redis, SeaweedFS (S3), OTel Collector, Jaeger, Prometheus, Grafana
pnpm build
pnpm dev             # API on :3000, worker
curl localhost:3000/readyz
```

## Tests

```bash
pnpm test               # unit: pure logic, no Docker (~1s)
pnpm test:integration   # Testcontainers Postgres 16 + Redis 7; needs Docker (~10s)
pnpm test:coverage      # both, with coverage gates
```

The integration suites cover the failure modes that matter in production: duplicate uploads,
Idempotency-Key replay and mismatch, a backpressure 429 that must not be cached, keyset
pagination while rows are being inserted, stale-ETag 412s, cross-tenant 404s, 429-then-success
and persistent-529-to-DLQ on the extract stage, the one-repair-then-human-review path, and
exactly-once outbox delivery under four concurrent publishers.

## Images and CI

```bash
docker build --target api     -t ledgerline-api .
docker build --target worker  -t ledgerline-worker .
docker build --target migrate -t ledgerline-migrate .   # run to completion before rolling apps
```

Distroless Node 22, non-root (uid 65532), production dependencies only. Filesystem size is
185 MB (api), 198 MB (worker) and 162 MB (migrate); 51 to 58 MB compressed. The api health check
calls `/healthz`; the worker has no port, so it touches a heartbeat file while Redis answers and
the check fails if the file is older than 45 s. Behind a TLS-intercepting proxy, pass its CA with
`--secret id=extra_ca,src=ca.pem`; it is mounted for the install step only and never stored in
a layer.

| Workflow           | Runs                     | Does                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`           | every PR, pushes to main | lint, typecheck, format, OpenAPI staleness, actionlint; unit; unit + integration with coverage gates against Postgres/Redis service containers; migrations from empty plus schema-drift check; 30% eval subset with a sticky PR comment (skipped without the API key) |
| `release.yml`      | main, `v*` tags          | api/worker/migrate images for amd64 + arm64 to GHCR, SBOM, provenance attestation                                                                                                                                                                                     |
| `nightly-eval.yml` | 03:00 UTC                | full golden set; uploads the report; opens or updates one `eval-regression` issue on failure                                                                                                                                                                          |

Third-party actions are pinned to full commit SHAs, with the version in a trailing comment.

## Observability

API and worker start with `--import @ledgerline/observability/register`, which loads OpenTelemetry
before anything else (set `OTEL_SDK_DISABLED=true` to turn it off). One upload is one trace: the
`POST .../complete` request span, a `ll-<stage> publish` producer span per enqueue (trace context
rides in the job's `_trace` field), a `ll-<stage> process` consumer span per stage, and a
`chat <model>` span per Claude call with `gen_ai.*` token counts, cache tokens and cost. No document
text or PII goes into span attributes or logs; logs carry `trace_id` and `span_id`.

- Jaeger: http://localhost:16686, service `ledgerline-api`, or `http://localhost:16686/trace/<traceId>`
  with the `trace_id` from an API log line.
- Prometheus: http://localhost:9090 (scrapes the collector). Alerts in `infra/prometheus/alerts.yml`:
  stale extract backlog (> 15 min), DLQ growth (> 10 in 10 min), auto-approve ratio collapse.
- Grafana: http://localhost:3001, dashboard "Ledgerline pipeline": queue depth and oldest age, DLQ size,
  stage p95 latency, retries by error class, model p95 latency, cost per tenant, decisions and
  auto-approve rate, end-to-end pipeline time.

`apps/worker/test/integration/tracing.test.ts` asserts the trace stays connected across the queue
hops and that no span attribute carries document text.
