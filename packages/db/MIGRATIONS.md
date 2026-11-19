# Migrations

Drizzle Kit generates SQL from `src/schema.ts` into `drizzle/`. Generated SQL is committed and
reviewed like code. Custom SQL (extensions, data fixes) uses `drizzle-kit generate --custom`.

```bash
pnpm db:generate          # after editing src/schema.ts
pnpm db:migrate           # apply pending migrations
pnpm --filter @ledgerline/db exec drizzle-kit check   # CI: journal and snapshots are consistent
```

## Rules

1. **Expand/contract, never in-place.** A release that stops using a column never also drops it.
   Old pods are still running during a rolling deploy and will crash on a missing column.
2. **Data backfills are scripts, not migrations.** A migration runs inside the deploy and holds
   locks; a backfill over millions of rows belongs in a resumable batched job.
3. **Adding a nullable column without a default is free** in Postgres 11+ (metadata only, no
   table rewrite). Adding `NOT NULL` or a volatile default rewrites or scans the table: do it in
   the contract step, after the backfill, with `NOT VALID` + `VALIDATE CONSTRAINT`.
4. **Large indexes are built `CONCURRENTLY`** in a custom migration (not inside a transaction).

## Worked example: money as minor units (0002, in progress)

v1 stored document money as `numeric(18,4)` (`subtotal`, `tax`, `discount`, `amount`). The API
contract is integer minor units (`{ amountMinor, currency }`), and every read was converting. We
are moving storage to `bigint` minor units.

| Step            | Release | What happens                                                                                                                                                                                                                                           | Status                         |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1. Expand       | 0002    | Add nullable `subtotal_minor`, `tax_minor`, `discount_minor`, `total_minor` + a partial index over rows still to backfill. Metadata-only, no lock beyond a brief `ACCESS EXCLUSIVE` for the catalog change.                                            | done                           |
| 2. Dual-write   | app     | Writers set both representations (`toMinorUnits` from `@ledgerline/contracts`). Reads still use numerics.                                                                                                                                              | in the extract worker (step 4) |
| 3. Backfill     | script  | `pnpm db:backfill:money`: 10k-row batches, each its own transaction, `FOR UPDATE SKIP LOCKED`, resumable because the selector is `total_minor IS NULL`. Conversion runs in TypeScript because the scale depends on the currency (JPY 0, USD 2, BHD 3). | script ready                   |
| 4. Verify       | ops     | `remaining = 0`, and spot-check `total_minor = amount * 10^exponent`. Add `CHECK (total_minor IS NOT NULL OR amount IS NULL) NOT VALID`, then `VALIDATE CONSTRAINT` (no write lock while validating).                                                  | later                          |
| 5. Switch reads | app     | Reads use `*_minor`. Writers still dual-write so a rollback of this release is safe.                                                                                                                                                                   | later                          |
| 6. Contract     | 000N    | Stop writing numerics in release N, drop the numeric columns and the backfill index in release N+1.                                                                                                                                                    | later                          |

Why not one migration with `ALTER COLUMN ... TYPE bigint USING ...`? It rewrites the whole table
under an `ACCESS EXCLUSIVE` lock (all reads and writes block), it cannot know each row's currency
exponent in plain SQL without a lookup table that drifts from the app's, and it makes rollback
impossible once the old column is gone.
