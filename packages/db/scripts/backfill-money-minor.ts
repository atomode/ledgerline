/**
 * Backfill for migration 0002 (expand): numeric money columns -> *_minor bigint.
 *
 * Safe to kill and re-run at any point:
 * - Work is selected by `total_minor IS NULL`, so finished rows are never revisited. No progress
 *   table is needed; the data itself is the checkpoint.
 * - Each batch is its own short transaction (default 10,000 rows), so locks are held briefly and
 *   a kill loses at most one uncommitted batch.
 * - FOR UPDATE SKIP LOCKED lets two copies run concurrently without double work.
 * - Conversion happens in TypeScript, not SQL, because the scale depends on the currency's ISO 4217
 *   exponent (JPY 0, USD 2, BHD 3) and must use the same code the live writers use.
 *
 * Usage: pnpm db:backfill:money [--batch-size 10000] [--max-batches N]
 */
import { parseArgs } from "node:util";
import { toMinorUnits } from "@ledgerline/contracts";
import { loadEnv } from "@ledgerline/config";
import { createDb } from "../src/index.js";

const { values } = parseArgs({
  // pnpm forwards a literal "--" separator; drop it.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "batch-size": { type: "string", default: "10000" },
    "max-batches": { type: "string" },
  },
});
const batchSize = Number(values["batch-size"]);
const maxBatches = values["max-batches"] ? Number(values["max-batches"]) : Infinity;

interface Row {
  id: string;
  currency: string;
  subtotal: string | null;
  tax: string | null;
  discount: string | null;
  amount: string;
}

const conv = (v: string | null, cur: string) => (v === null ? null : toMinorUnits(v, cur));

const env = loadEnv();
const { pool, close } = createDb(env.DATABASE_URL, { max: 1 });
const client = await pool.connect();

let batches = 0;
let total = 0;
const started = Date.now();
try {
  while (batches < maxBatches) {
    await client.query("BEGIN");
    const { rows } = await client.query<Row>(
      `SELECT id, currency, subtotal, tax, discount, amount
         FROM invoices
        WHERE total_minor IS NULL AND amount IS NOT NULL AND currency IS NOT NULL
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      break;
    }

    const ids: string[] = [];
    const sub: (number | null)[] = [];
    const tax: (number | null)[] = [];
    const disc: (number | null)[] = [];
    const tot: number[] = [];
    for (const r of rows) {
      ids.push(r.id);
      sub.push(conv(r.subtotal, r.currency));
      tax.push(conv(r.tax, r.currency));
      disc.push(conv(r.discount, r.currency));
      tot.push(toMinorUnits(r.amount, r.currency));
    }

    // One UPDATE per batch via unnest: a single round trip instead of 10,000.
    await client.query(
      `UPDATE invoices AS i
          SET subtotal_minor = v.subtotal_minor,
              tax_minor      = v.tax_minor,
              discount_minor = v.discount_minor,
              total_minor    = v.total_minor
         FROM unnest($1::uuid[], $2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[])
              AS v(id, subtotal_minor, tax_minor, discount_minor, total_minor)
        WHERE i.id = v.id`,
      [ids, sub, tax, disc, tot],
    );
    await client.query("COMMIT");

    batches += 1;
    total += rows.length;
    console.log(
      JSON.stringify({
        batch: batches,
        rows: rows.length,
        total,
        lastId: ids.at(-1),
        elapsedMs: Date.now() - started,
      }),
    );
  }

  const { rows: left } = await client.query<{ remaining: string; unconvertible: string }>(
    `SELECT count(*) FILTER (WHERE total_minor IS NULL AND amount IS NOT NULL AND currency IS NOT NULL) AS remaining,
            count(*) FILTER (WHERE total_minor IS NULL AND amount IS NOT NULL AND currency IS NULL)     AS unconvertible
       FROM invoices`,
  );
  console.log(JSON.stringify({ done: true, updated: total, ...left[0] }));
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  client.release();
  await close();
}
