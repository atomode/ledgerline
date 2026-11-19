/**
 * The extract stage end to end on real BullMQ + Postgres (Testcontainers), with the Anthropic API
 * mocked at the HTTP layer by msw, so the real SDK, error classification, retry and DLQ paths run.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { pino } from "pino";
import { eq, sql } from "drizzle-orm";
import type { Worker } from "bullmq";
import { schema } from "@ledgerline/db";
import {
  createDlqQueues,
  createStageQueues,
  createTokenBucket,
  stageJobId,
} from "@ledgerline/queues";
import type { Storage } from "@ledgerline/storage";
import { createStageWorker } from "../../src/stage-worker.js";
import { createExtractProcessor } from "../../src/processors/extract.js";
import type { WorkerDeps } from "../../src/deps.js";
import { validExtraction } from "../../scripts/fake-anthropic.js";
import {
  TENANT_A,
  freshDatabase,
  freshRedis,
  memoryStorage,
  tinyPdf,
} from "../../../../test/support.js";

const API = "https://anthropic.test";
const msw = setupServer();

const message = (text: string) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 4000,
    output_tokens: 600,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});
const apiError = (status: number, type: string, headers: Record<string, string> = {}) =>
  HttpResponse.json({ type: "error", error: { type, message: type } }, { status, headers });

let dbh: Awaited<ReturnType<typeof freshDatabase>>;
let deps: WorkerDeps;
let worker: Worker;
let calls = 0;

beforeAll(async () => {
  // Postgres and Redis are TCP, so any unexpected HTTP call is a bug: fail on it.
  msw.listen({ onUnhandledFrame: "error" });
  dbh = await freshDatabase();
  const redis = await freshRedis();
  await dbh.db.insert(schema.tenants).values({ id: TENANT_A, name: "Tenant A" });
  deps = {
    db: dbh.db,
    pool: dbh.pool,
    redis,
    storage: memoryStorage() as unknown as Storage,
    anthropic: new Anthropic({ apiKey: "test", baseURL: API, maxRetries: 0 }),
    queues: createStageQueues(redis),
    dlqs: createDlqQueues(redis),
    tokenBucket: createTokenBucket(redis, "ll:itpm:test", 10_000_000),
    log: pino({ level: "silent" }),
    extractionModel: "claude-sonnet-5-5",
    webhookSecret: "whsec_test",
  };
  worker = createStageWorker("extract", createExtractProcessor(deps), deps, { concurrency: 4 });
});

beforeEach(() => {
  calls = 0;
});
afterEach(() => msw.resetHandlers());

afterAll(async () => {
  msw.close();
  await worker?.close();
  await Promise.all(
    [...Object.values(deps.queues), ...Object.values(deps.dlqs)].map((q) => q.close()),
  );
  deps.redis.disconnect();
  await dbh?.drop();
});

/** Insert a classified invoice whose PDF is in storage, and enqueue its extract job. */
async function classifiedInvoice(tag: string, attempts?: number) {
  const pdf = tinyPdf(tag);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const key = `${TENANT_A}/${sha256}.pdf`;
  await deps.storage.putObject(key, pdf);
  const [session] = await dbh.db
    .insert(schema.uploadSessions)
    .values({ tenantId: TENANT_A, expiresAt: new Date(Date.now() + 3_600_000) })
    .returning();
  const [file] = await dbh.db
    .insert(schema.files)
    .values({
      tenantId: TENANT_A,
      uploadSessionId: session!.id,
      clientRef: tag,
      filename: `${tag}.pdf`,
      sizeBytes: pdf.length,
      sha256,
      storageKey: key,
      status: "accepted",
    })
    .returning();
  const [inv] = await dbh.db
    .insert(schema.invoices)
    .values({ tenantId: TENANT_A, fileId: file!.id, status: "classified" })
    .returning();
  const jobId = stageJobId(inv!.id, "extract");
  await deps.queues.extract.add(
    "extract",
    { invoiceId: inv!.id, tenantId: TENANT_A },
    { jobId, ...(attempts ? { attempts } : {}) },
  );
  return { id: inv!.id, jobId };
}

async function waitForStatus(id: string, statuses: string[], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await dbh.db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    if (row && statuses.includes(row.status)) return row;
    if (Date.now() > deadline) throw new Error(`invoice ${id} stuck at ${row?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const failuresFor = (jobId: string) =>
  dbh.db.select().from(schema.jobFailures).where(eq(schema.jobFailures.jobId, jobId));

describe("extract stage", () => {
  it("retries a 429 (honoring Retry-After) and then extracts, writing money in minor units", async () => {
    msw.use(
      http.post(`${API}/v1/messages`, () => {
        calls++;
        return calls === 1
          ? apiError(429, "rate_limit_error", { "retry-after": "1" })
          : HttpResponse.json(message(JSON.stringify(validExtraction(1))));
      }),
    );
    const started = Date.now();
    const { id } = await classifiedInvoice("retry-then-ok");
    const row = await waitForStatus(id, ["extracted", "failed", "needs_review"]);

    expect(row.status).toBe("extracted");
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000); // waited at least Retry-After
    expect(row.totalMinor).toBe(11000);
    expect(row.amount).toBe("110.0000");
    expect(row.costMicros).toBeGreaterThan(0);
    const lines = await dbh.db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, id));
    expect(lines).toHaveLength(1);
    // Next stage was enqueued after the commit.
    expect(await deps.queues.validate.getJob(stageJobId(id, "validate"))).toBeTruthy();
  });

  it("dead-letters after exhausting attempts on a persistent 529: job_failures row + DLQ + failed status", async () => {
    msw.use(
      http.post(`${API}/v1/messages`, () => {
        calls++;
        return apiError(529, "overloaded_error");
      }),
    );
    const { id, jobId } = await classifiedInvoice("always-529", 2);
    const row = await waitForStatus(id, ["failed"]);
    expect(row.status).toBe("failed");
    expect(calls).toBe(2);

    await expect.poll(() => failuresFor(jobId).then((r) => r.length)).toBe(1);
    const [failure] = await failuresFor(jobId);
    expect(failure?.attemptsMade).toBe(2);
    expect((failure?.errorChain as { message: string }[])[0]?.message).toContain("anthropic 529");
    await expect.poll(() => deps.dlqs.extract.getJob(jobId).then(Boolean)).toBe(true);
  });

  it("does not retry a 400: unrecoverable on the first attempt", async () => {
    msw.use(
      http.post(`${API}/v1/messages`, () => {
        calls++;
        return apiError(400, "invalid_request_error");
      }),
    );
    const { id, jobId } = await classifiedInvoice("bad-request");
    await waitForStatus(id, ["failed"]);
    expect(calls).toBe(1);
    await expect.poll(() => failuresFor(jobId).then((r) => r[0]?.attemptsMade)).toBe(1);
  });

  it("repairs one bad answer, and sends content that stays invalid to human review (not the DLQ)", async () => {
    const bad = JSON.stringify({ ...validExtraction(2), currency: "XYZ", total: "$110.00" });
    msw.use(
      http.post(`${API}/v1/messages`, () => {
        calls++;
        return HttpResponse.json(message(bad));
      }),
    );
    const { id, jobId } = await classifiedInvoice("always-invalid");
    const row = await waitForStatus(id, ["needs_review", "failed"]);
    expect(row.status).toBe("needs_review");
    expect(calls).toBe(2); // original + exactly one repair turn
    expect(row.missingFields.length).toBeGreaterThan(0);
    expect(await failuresFor(jobId)).toHaveLength(0);
    const events = await dbh.db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.aggregateId, id));
    expect(events.map((e) => e.eventType)).toEqual(["invoice.needs_review"]);
  });

  it("a duplicate job for already-extracted work is a no-op that never calls the model", async () => {
    msw.use(
      http.post(`${API}/v1/messages`, () => {
        calls++;
        return HttpResponse.json(message(JSON.stringify(validExtraction(3))));
      }),
    );
    const { id } = await classifiedInvoice("dup-job");
    await waitForStatus(id, ["extracted"]);
    const versionBefore = (await waitForStatus(id, ["extracted"])).version;

    // Replay the same stage (completed jobs are removed, so the deterministic id is free again).
    const replay = await deps.queues.extract.add(
      "extract",
      { invoiceId: id, tenantId: TENANT_A },
      { jobId: `${stageJobId(id, "extract")}__dup` },
    );
    // removeOnComplete: the job disappears once it has run.
    await expect
      .poll(() => deps.queues.extract.getJob(replay.id!).then((j) => j === undefined))
      .toBe(true);
    expect(calls).toBe(1);
    const after = await waitForStatus(id, ["extracted"]);
    expect(after.version).toBe(versionBefore);
  });

  it("counts every attempt: no invoice is left in a non-terminal state", async () => {
    let n = 0;
    msw.use(
      http.post(`${API}/v1/messages`, () => {
        n++;
        // Every third call is rate limited; the rest succeed.
        return n % 3 === 0
          ? apiError(429, "rate_limit_error", { "retry-after": "0" })
          : HttpResponse.json(message(JSON.stringify(validExtraction(n))));
      }),
    );
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, i) => classifiedInvoice(`batch-${i}`).then((r) => r.id)),
    );
    const rows = await Promise.all(ids.map((id) => waitForStatus(id, ["extracted", "failed"])));
    expect(rows.every((r) => r.status === "extracted")).toBe(true);
    const [{ n: stuck }] = (
      await dbh.db.execute<{ n: number }>(
        sql`select count(*)::int n from invoices where status = 'classified'`,
      )
    ).rows as [{ n: number }];
    expect(stuck).toBe(0);
  });
});
