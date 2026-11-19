# Ledgerline

Accounts-payable invoice extraction and 3-way matching. Claude reads invoices; deterministic code
decides what gets paid.

> Status: work in progress. See `CLAUDE.md` for design rules.

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm infra:up        # Postgres, Redis, SeaweedFS (S3), OTel Collector, Jaeger
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
