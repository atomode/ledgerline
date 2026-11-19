/**
 * API against real Postgres + Redis (Testcontainers). Storage is in-memory; everything else is the
 * production wiring from main.ts.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { createDlqQueues, createStageQueues } from "@ledgerline/queues";
import type { Storage } from "@ledgerline/storage";
import { buildApp } from "../../src/app.js";
import { dbAuthenticator } from "../../src/auth.js";
import { createUploadService } from "../../src/services/uploads.js";
import { createInvoiceService } from "../../src/services/invoices.js";
import {
  TENANT_A,
  TENANT_B,
  freshDatabase,
  freshRedis,
  memoryStorage,
  tinyPdf,
} from "../../../../test/support.js";

const KEY_A = "ll_it_tenant_a_key";
const KEY_B = "ll_it_tenant_b_key";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const auth = (key = KEY_A) => ({ authorization: `Bearer ${key}` });

let dbh: Awaited<ReturnType<typeof freshDatabase>>;
let redis: Awaited<ReturnType<typeof freshRedis>>;
let app: FastifyInstance;
let queues: ReturnType<typeof createStageQueues>;
const storage = memoryStorage();
let admit = true;

beforeAll(async () => {
  dbh = await freshDatabase();
  redis = await freshRedis();
  queues = createStageQueues(redis);
  const db = dbh.db;
  await db.insert(schema.tenants).values([
    { id: TENANT_A, name: "Tenant A" },
    { id: TENANT_B, name: "Tenant B" },
  ]);
  await db.insert(schema.apiKeys).values([
    { tenantId: TENANT_A, keyHash: sha(Buffer.from(KEY_A)), prefix: KEY_A.slice(0, 12) },
    { tenantId: TENANT_B, keyHash: sha(Buffer.from(KEY_B)), prefix: KEY_B.slice(0, 12) },
  ]);
  app = await buildApp({
    logLevel: "silent",
    db,
    queues,
    dlqs: createDlqQueues(redis),
    authenticate: dbAuthenticator(db),
    admission: async () =>
      admit
        ? { admit: true, waiting: 0, oldestWaitMs: 0, retryAfterSeconds: 0 }
        : { admit: false, waiting: 9999, oldestWaitMs: 1_000_000, retryAfterSeconds: 30 },
    cursorSecret: "it-cursor-secret-0123456789",
    uploads: createUploadService({ db, storage: storage as unknown as Storage, queues }),
    invoices: createInvoiceService({ db, cursorSecret: "it-cursor-secret-0123456789" }),
    readinessChecks: {},
  });
});

afterAll(async () => {
  await app?.close();
  await Promise.all(Object.values(queues ?? {}).map((q) => q.close()));
  redis?.disconnect();
  await dbh?.drop();
});

/** Create a session for the given PDFs, "upload" them, and complete it. */
async function upload(pdfs: Buffer[], key = KEY_A) {
  const created = await app.inject({
    method: "POST",
    url: "/v1/upload-sessions",
    headers: auth(key),
    payload: {
      files: pdfs.map((b, i) => ({
        clientRef: `ref-${i}`,
        filename: `f${i}.pdf`,
        contentType: "application/pdf",
        sizeBytes: b.length,
        sha256: sha(b),
      })),
    },
  });
  expect(created.statusCode).toBe(201);
  const session = created.json<{ id: string; files: { fileId: string; clientRef: string }[] }>();
  const rows = await dbh.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.uploadSessionId, session.id));
  for (const r of rows) {
    const i = Number(r.clientRef.split("-")[1]);
    await storage.putObject(r.storageKey, pdfs[i]!);
  }
  return app.inject({
    method: "POST",
    url: `/v1/upload-sessions/${session.id}/complete`,
    headers: auth(key),
  });
}

describe("uploads", () => {
  it("dedupes identical bytes per tenant and reports the existing invoice", async () => {
    const pdf = tinyPdf("dup-check");
    const first = await upload([pdf]);
    expect(first.statusCode).toBe(202);
    const firstId = first.json().results[0].invoiceId as string;

    const second = await upload([pdf]);
    expect(second.statusCode).toBe(200); // nothing new accepted
    expect(second.json().results[0]).toMatchObject({ status: "duplicate", invoiceId: firstId });

    // Same bytes for another tenant are not a duplicate: dedupe is tenant-scoped.
    const other = await upload([pdf], KEY_B);
    expect(other.json().results[0].status).toBe("accepted");
    expect(other.json().results[0].invoiceId).not.toBe(firstId);
  });

  it("returns per-file outcomes for a partially bad batch and enqueues only accepted files", async () => {
    const good = tinyPdf("partial-good");
    const res = await upload([good, Buffer.from("not a pdf at all")]);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.counts).toEqual({ accepted: 1, duplicate: 0, rejected: 1 });
    expect(body.results.find((r: { clientRef: string }) => r.clientRef === "ref-1")).toMatchObject({
      status: "rejected",
      reason: "not_pdf",
    });
    const job = await queues.classify.getJob(`${body.results[0].invoiceId}__classify`);
    expect(job?.data.invoiceId).toBe(body.results[0].invoiceId);
  });

  it("completing twice returns the same answer and does not create a second invoice", async () => {
    const pdf = tinyPdf("complete-twice");
    const first = await upload([pdf]);
    const sessionId = first.json().sessionId as string;
    const again = await app.inject({
      method: "POST",
      url: `/v1/upload-sessions/${sessionId}/complete`,
      headers: auth(),
    });
    expect(again.json().results).toEqual(first.json().results);
    const [{ n }] = (
      await dbh.db.execute<{ n: number }>(
        sql`select count(*)::int n from invoices i join files f on f.id = i.file_id where f.sha256 = ${sha(pdf)}`,
      )
    ).rows as [{ n: number }];
    expect(n).toBe(1);
  });
});

describe("Idempotency-Key", () => {
  const body = {
    files: [
      {
        clientRef: "x",
        filename: "x.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        sha256: "a".repeat(64),
      },
    ],
  };

  it("replays the stored response for the same key and body", async () => {
    const headers = { ...auth(), "idempotency-key": "idem-replay-1" };
    const a = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers,
      payload: body,
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers,
      payload: body,
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json()).toEqual(a.json());
    const sessions = await dbh.db.select().from(schema.uploadSessions);
    expect(sessions.filter((s) => s.id === a.json().id)).toHaveLength(1);
  });

  it("rejects the same key with a different body (422)", async () => {
    const headers = { ...auth(), "idempotency-key": "idem-mismatch-1" };
    await app.inject({ method: "POST", url: "/v1/upload-sessions", headers, payload: body });
    const changed = structuredClone(body);
    changed.files[0]!.sizeBytes = 11;
    const res = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers,
      payload: changed,
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("keys are tenant-scoped", async () => {
    const key = "idem-shared-name";
    const a = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers: { ...auth(KEY_A), "idempotency-key": key },
      payload: body,
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers: { ...auth(KEY_B), "idempotency-key": key },
      payload: body,
    });
    expect(b.headers["idempotent-replayed"]).toBeUndefined();
    expect(b.json().id).not.toBe(a.json().id);
  });

  it("does not cache a backpressure 429 as the answer for the key", async () => {
    const headers = { ...auth(), "idempotency-key": "idem-after-429" };
    admit = false;
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers,
      payload: body,
    });
    admit = true;
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("30");
    const retried = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers,
      payload: body,
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.headers["idempotent-replayed"]).toBeUndefined();
  });
});

describe("GET /v1/invoices keyset pagination", () => {
  it("walks 250 invoices with 20 inserted mid-walk: no duplicates, no gaps", async () => {
    const tenant = "0190c000-0000-7000-8000-00000000000c";
    const key = "ll_it_tenant_c_key";
    await dbh.db.insert(schema.tenants).values({ id: tenant, name: "Tenant C" });
    await dbh.db
      .insert(schema.apiKeys)
      .values({ tenantId: tenant, keyHash: sha(Buffer.from(key)), prefix: key.slice(0, 12) });
    const base = Date.parse("2026-10-01T00:00:00Z");
    const [session] = await dbh.db
      .insert(schema.uploadSessions)
      .values({ tenantId: tenant, expiresAt: new Date(Date.now() + 3_600_000) })
      .returning();
    const seed = async (n: number, startMs: number, label: string) => {
      const files = await dbh.db
        .insert(schema.files)
        .values(
          Array.from({ length: n }, (_, i) => ({
            tenantId: tenant,
            uploadSessionId: session!.id,
            clientRef: `${label}-${i}`,
            filename: `${label}-${i}.pdf`,
            sizeBytes: 1,
            sha256: sha(Buffer.from(`${label}-${i}`)),
            storageKey: `${label}/${i}`,
            status: "accepted" as const,
          })),
        )
        .returning({ id: schema.files.id });
      // Several invoices share a timestamp on purpose: the id tiebreak must keep the order total.
      const rows = await dbh.db
        .insert(schema.invoices)
        .values(
          files.map((f, i) => ({
            tenantId: tenant,
            fileId: f.id,
            status: "received" as const,
            receivedAt: new Date(startMs + Math.floor(i / 3) * 60_000),
          })),
        )
        .returning({ id: schema.invoices.id });
      return rows.map((r) => r.id);
    };
    const original = await seed(250, base, "orig");

    const seen: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    type Page = { data: { id: string }[]; nextCursor: string | null };
    do {
      const res: { statusCode: number; json: () => Page } = await app.inject({
        method: "GET",
        url: `/v1/invoices?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        headers: auth(key),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      seen.push(...body.data.map((d) => d.id));
      cursor = body.nextCursor;
      // Concurrent writers: newer rows land ahead of the cursor and must not shift the walk.
      if (++page === 3) await seed(20, base + 365 * 86_400_000, "late");
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    for (const id of original) expect(seen).toContain(id); // no gaps
  });

  it("rejects a tampered cursor with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/invoices?cursor=eyJyIjoiMjAyNi0wMS0wMSIsImlkIjoieCJ9.deadbeef",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("review with optimistic concurrency", () => {
  async function reviewable() {
    const res = await upload([tinyPdf(`review-${Math.random()}`)]);
    const id = res.json().results[0].invoiceId as string;
    await dbh.db
      .update(schema.invoices)
      .set({ status: "needs_review", currency: "USD", amount: "100.00", totalMinor: 10000 })
      .where(eq(schema.invoices.id, id));
    return id;
  }

  it("applies with a fresh ETag and returns 412 for the stale one", async () => {
    const id = await reviewable();
    const got = await app.inject({ method: "GET", url: `/v1/invoices/${id}`, headers: auth() });
    const etag = got.headers.etag as string;
    expect(etag).toMatch(/^W\/"\d+"$/);

    const ok = await app.inject({
      method: "POST",
      url: `/v1/invoices/${id}/review`,
      headers: { ...auth(), "if-match": etag },
      payload: { action: "correct", corrections: [{ field: "poNumber", value: "PO-123" }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().poNumber).toBe("PO-123");
    expect(ok.headers.etag).not.toBe(etag);

    const stale = await app.inject({
      method: "POST",
      url: `/v1/invoices/${id}/review`,
      headers: { ...auth(), "if-match": etag },
      payload: { action: "approve" },
    });
    expect(stale.statusCode).toBe(412);
    const [inv] = await dbh.db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(inv?.status).toBe("needs_review");
  });

  it("approval writes exactly one outbox event in the same transaction", async () => {
    const id = await reviewable();
    const got = await app.inject({ method: "GET", url: `/v1/invoices/${id}`, headers: auth() });
    const res = await app.inject({
      method: "POST",
      url: `/v1/invoices/${id}/review`,
      headers: { ...auth(), "if-match": got.headers.etag as string },
      payload: { action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    const events = await dbh.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.aggregateId, id));
    expect(events.map((e) => e.eventType)).toEqual(["invoice.approved"]);
  });

  it("another tenant's invoice is a 404, not a 403", async () => {
    const id = await reviewable();
    const res = await app.inject({
      method: "GET",
      url: `/v1/invoices/${id}`,
      headers: auth(KEY_B),
    });
    expect(res.statusCode).toBe(404);
  });
});
