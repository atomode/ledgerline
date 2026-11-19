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
