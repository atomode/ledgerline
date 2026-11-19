/**
 * Transactional outbox publisher on real Postgres: concurrent publishers must not double-deliver,
 * failed deliveries back off on the schedule, and every request is signed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { eq, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { verifyWebhook, WEBHOOK_SIGNATURE_HEADER } from "@ledgerline/contracts";
import { DELIVERY_SCHEDULE_MS, publishOutboxBatch } from "../../src/outbox.js";
import type { WorkerDeps } from "../../src/deps.js";
import { TENANT_A, TENANT_B, freshDatabase } from "../../../../test/support.js";

let dbh: Awaited<ReturnType<typeof freshDatabase>>;
const received: { id: string; body: string; signature: string }[] = [];
let failNext = 0;

const deps = (): WorkerDeps =>
  ({
    db: dbh.db,
    pool: dbh.pool,
    log: pino({ level: "silent" }),
    webhookSecret: "whsec_outbox_test",
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      // Simulate network latency so concurrent publishers genuinely overlap.
      await new Promise((r) => setTimeout(r, 20));
      if (failNext > 0) {
        failNext--;
        return new Response("boom", { status: 503 });
      }
      const headers = new Headers(init?.headers);
      received.push({
        id: headers.get("ledgerline-event-id")!,
        body: String(init?.body),
        signature: headers.get(WEBHOOK_SIGNATURE_HEADER)!,
      });
      return new Response(null, { status: 204 });
    },
  }) as unknown as WorkerDeps;

beforeAll(async () => {
  dbh = await freshDatabase();
  await dbh.db.insert(schema.tenants).values([
    { id: TENANT_A, name: "A", webhookUrl: "https://hooks.example.test/a" },
    { id: TENANT_B, name: "B", webhookUrl: null },
  ]);
});
afterAll(async () => dbh?.drop());
beforeEach(async () => {
  received.length = 0;
  failNext = 0;
  await dbh.db.delete(schema.outbox);
});

const enqueue = (n: number, tenantId = TENANT_A) =>
  dbh.db
    .insert(schema.outbox)
    .values(
      Array.from({ length: n }, (_, i) => ({
        tenantId,
        aggregateId: "0190d000-0000-7000-8000-000000000001",
        eventType: "invoice.approved",
        payload: { n: i },
      })),
    )
    .returning({ id: schema.outbox.id });

describe("outbox publisher", () => {
  it("4 concurrent publishers deliver 100 events exactly once each", async () => {
    const rows = await enqueue(100);
    const drain = async () => {
      while ((await publishOutboxBatch(deps(), 10)) > 0);
    };
    await Promise.all([drain(), drain(), drain(), drain()]);

    const ids = received.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.id)));
    const [{ pending }] = (
      await dbh.db.execute<{ pending: number }>(
        sql`select count(*)::int pending from outbox where published_at is null`,
      )
    ).rows as [{ pending: number }];
    expect(pending).toBe(0);
  });

  it("signs every delivery so the consumer can verify it", async () => {
    await enqueue(1);
    await publishOutboxBatch(deps());
    const [hit] = received;
    expect(verifyWebhook("whsec_outbox_test", hit!.body, hit!.signature)).toBe(true);
    expect(verifyWebhook("wrong-secret", hit!.body, hit!.signature)).toBe(false);
  });

  it("a failed delivery is rescheduled on the backoff schedule, not retried hot", async () => {
    const [row] = await enqueue(1);
    failNext = 1;
    await publishOutboxBatch(deps());
    expect(received).toHaveLength(0);
    const [after] = await dbh.db.select().from(schema.outbox).where(eq(schema.outbox.id, row!.id));
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toBe("HTTP 503");
    const delayMs = after!.nextAttemptAt.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(DELIVERY_SCHEDULE_MS[0]! - 5_000);

    // Not due yet: another pass delivers nothing.
    expect(await publishOutboxBatch(deps())).toBe(0);
    // Once due, it goes out.
    await dbh.db.update(schema.outbox).set({ nextAttemptAt: new Date(0) });
    await publishOutboxBatch(deps());
    expect(received.map((r) => r.id)).toEqual([row!.id]);
  });

  it("tenants without a webhook URL have events marked published without a request", async () => {
    await enqueue(3, TENANT_B);
    await publishOutboxBatch(deps());
    expect(received).toHaveLength(0);
    const rows = await dbh.db.select().from(schema.outbox);
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });
});
