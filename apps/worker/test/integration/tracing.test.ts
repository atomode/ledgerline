/**
 * One upload must be one trace: the producer span of each enqueue is the parent of the next
 * stage's consumer span, across Redis, through all four stages. Also checks the GenAI span
 * attributes and that no document content leaks into span attributes.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { pino } from "pino";
import { eq } from "drizzle-orm";
import type { Worker } from "bullmq";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { startTelemetry, type Telemetry } from "@ledgerline/observability/sdk";
import { SpanKind, inSpan } from "@ledgerline/observability";
import { schema } from "@ledgerline/db";
import {
  createDlqQueues,
  createStageQueues,
  createTokenBucket,
  stageJobId,
} from "@ledgerline/queues";
import type { Storage } from "@ledgerline/storage";
import { createStageWorker } from "../../src/stage-worker.js";
import { createClassifyProcessor } from "../../src/processors/classify.js";
import { createExtractProcessor } from "../../src/processors/extract.js";
import { createValidateProcessor } from "../../src/processors/validate.js";
import { createMatchProcessor } from "../../src/processors/match.js";
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
const VENDOR_TEXT = "Chaos Supplies Ltd"; // appears in the model output; must never reach a span
const exporter = new InMemorySpanExporter();
let telemetry: Telemetry;
const msw = setupServer(
  http.post(`${API}/v1/messages`, async ({ request }) => {
    const { model } = (await request.json()) as { model: string };
    const text = model.includes("haiku")
      ? JSON.stringify({ kind: "invoice" })
      : JSON.stringify(validExtraction(1));
    return HttpResponse.json({
      id: `msg_${model}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 4000,
        output_tokens: 500,
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 0,
      },
    });
  }),
);

let dbh: Awaited<ReturnType<typeof freshDatabase>>;
let deps: WorkerDeps;
let workers: Worker[] = [];

beforeAll(async () => {
  telemetry = startTelemetry({
    serviceName: "ledgerline-test",
    spanExporter: exporter,
    metrics: false,
  });
  msw.listen({ onUnhandledFrame: "bypass" });
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
    tokenBucket: createTokenBucket(redis, "ll:itpm:trace", 10_000_000),
    log: pino({ level: "silent" }),
    extractionModel: "claude-sonnet-5-5",
    classifyModel: "claude-haiku-5-5",
    webhookSecret: "whsec",
  };
  workers = [
    createStageWorker("classify", createClassifyProcessor(deps), deps),
    createStageWorker("extract", createExtractProcessor(deps), deps),
    createStageWorker("validate", createValidateProcessor(deps), deps),
    createStageWorker("match", createMatchProcessor(deps), deps),
  ];
});

afterAll(async () => {
  msw.close();
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(
    [...Object.values(deps.queues), ...Object.values(deps.dlqs)].map((q) => q.close()),
  );
  deps.redis.disconnect();
  await dbh?.drop();
  await telemetry.shutdown();
});

it("one upload is one trace through classify, extract, validate and match", async () => {
  const pdf = tinyPdf("trace");
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  await deps.storage.putObject(`k/${sha256}`, pdf);
  const [session] = await dbh.db
    .insert(schema.uploadSessions)
    .values({ tenantId: TENANT_A, expiresAt: new Date(Date.now() + 3_600_000) })
    .returning();
  const [file] = await dbh.db
    .insert(schema.files)
    .values({
      tenantId: TENANT_A,
      uploadSessionId: session!.id,
      clientRef: "t",
      filename: "t.pdf",
      sizeBytes: pdf.length,
      sha256,
      storageKey: `k/${sha256}`,
      status: "accepted",
    })
    .returning();
  const [inv] = await dbh.db
    .insert(schema.invoices)
    .values({ tenantId: TENANT_A, fileId: file!.id, status: "received" })
    .returning();

  // Stands in for the API request span that completes an upload session.
  const rootTraceId = await inSpan(
    "POST /v1/upload-sessions/:id/complete",
    { kind: SpanKind.SERVER },
    async (span) => {
      await deps.queues.classify.add(
        "classify",
        { invoiceId: inv!.id, tenantId: TENANT_A },
        { jobId: stageJobId(inv!.id, "classify") },
      );
      return span.spanContext().traceId;
    },
  );

  await expect
    .poll(
      async () =>
        (await dbh.db.select().from(schema.invoices).where(eq(schema.invoices.id, inv!.id)))[0]
          ?.status,
      { timeout: 20_000 },
    )
    .toBe("needs_review");
  await telemetry.flush();

  const spans = exporter.getFinishedSpans();
  const byName = (n: string) => spans.filter((s) => s.name === n);
  const consumers = ["ll-classify", "ll-extract", "ll-validate", "ll-match"].map((q) => {
    const [s] = byName(`${q} process`);
    expect(s, `${q} consumer span`).toBeDefined();
    return s!;
  });
  // Every consumer span is in the request's trace...
  for (const s of consumers) expect(s.spanContext().traceId).toBe(rootTraceId);
  // ...and is the child of the producer span that enqueued it (no orphan restarts).
  const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;
  for (const [i, q] of ["ll-classify", "ll-extract", "ll-validate", "ll-match"].entries()) {
    const producer = byName(`${q} publish`).find((p) => p.spanContext().traceId === rootTraceId);
    expect(producer, `${q} producer span`).toBeDefined();
    expect(parentOf(consumers[i]!)).toBe(producer!.spanContext().spanId);
  }

  const chat = spans.filter((s) => s.name.startsWith("chat "));
  expect(chat.map((s) => s.attributes["gen_ai.request.model"]).sort()).toEqual([
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
  ]);
  const sonnet = chat.find((s) => s.name === "chat claude-sonnet-5-5")!;
  expect(sonnet.kind).toBe(SpanKind.CLIENT);
  expect(sonnet.spanContext().traceId).toBe(rootTraceId);
  expect(sonnet.attributes).toMatchObject({
    "gen_ai.provider.name": "anthropic",
    "gen_ai.usage.input_tokens": 4000,
    "gen_ai.usage.output_tokens": 500,
    "ledgerline.cache_read_tokens": 1200,
  });
  expect(sonnet.attributes["ledgerline.cost_micros"]).toBeGreaterThan(0);
  expect(typeof sonnet.attributes["ledgerline.prompt_version"]).toBe("string");

  // Rule 8: no document content in telemetry.
  const allValues = JSON.stringify(spans.map((s) => s.attributes));
  expect(allValues).not.toContain(VENDOR_TEXT);
  expect(allValues).not.toContain("CHAOS-1");
});
