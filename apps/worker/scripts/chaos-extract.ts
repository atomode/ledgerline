/**
 * Chaos test for the extraction pipeline (step 4 "done when").
 *
 * 1. Starts a fake Anthropic API: 30% 429s, 5% truncated JSON, 5% schema violations, and 3
 *    documents that always get 529.
 * 2. Uploads 50 PDFs to S3, inserts 50 invoices, enqueues them at the classify stage.
 * 3. Runs the real worker and API as child processes pointed at the fake.
 * 4. Waits for every invoice to reach a terminal state and checks that none are lost, that DLQ
 *    entries exist only for the 3 hard failures, and that replaying one through the API recovers it.
 *
 * Usage (with `pnpm infra:up`, migrations and seed applied, and `pnpm build`):
 *   pnpm --filter @ledgerline/worker chaos
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadEnv } from "@ledgerline/config";
import { createDb, schema } from "@ledgerline/db";
import { createRedis, createStageQueues, stageJobId } from "@ledgerline/queues";
import { createStorage } from "@ledgerline/storage";
import { startFakeAnthropic } from "./fake-anthropic.js";

const N = 50;
const HARD_FAIL = 3;
const TIMEOUT_MS = 5 * 60_000;
const API_PORT = 3999;

const env = loadEnv();
const root = new URL("../../../", import.meta.url);
const { db, close } = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const queues = createStageQueues(redis);
const storage = createStorage({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fake = await startFakeAnthropic({ rate429: 0.3, badJson: 0.05, badSchema: 0.05 });
log("fake anthropic listening", { url: fake.url });

// --- tenant + api key ------------------------------------------------------------------------
const [tenant] = await db.select().from(schema.tenants).limit(1);
if (!tenant) throw new Error("no tenant: run `pnpm db:seed` first");
const apiKey = `ll_chaos_${randomBytes(16).toString("hex")}`;
await db.insert(schema.apiKeys).values({
  tenantId: tenant.id,
  keyHash: createHash("sha256").update(apiKey).digest("hex"),
  prefix: apiKey.slice(0, 12),
});

// --- 50 unique PDFs in S3 --------------------------------------------------------------------
const goldenDir = new URL("evals/golden/synthetic/", root);
const sources = (await readdir(goldenDir)).filter((f) => f.endsWith(".pdf")).sort();
const runId = Date.now().toString(36);
const [session] = await db
  .insert(schema.uploadSessions)
  .values({
    tenantId: tenant.id,
    expiresAt: new Date(Date.now() + 3_600_000),
    completedAt: new Date(),
  })
  .returning();

const invoiceIds: string[] = [];
const hardFailInvoices: string[] = [];
for (let i = 0; i < N; i++) {
  // Append a PDF comment so each file is byte-unique (content dedupe would otherwise collapse them).
  const base = await readFile(new URL(sources[i % sources.length]!, goldenDir));
  const pdf = Buffer.concat([base, Buffer.from(`\n%chaos ${runId} ${i}\n`)]);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const storageKey = `${tenant.id}/${sha256}.pdf`;
  await storage.putObject(storageKey, pdf);
  const [file] = await db
    .insert(schema.files)
    .values({
      tenantId: tenant.id,
      uploadSessionId: session!.id,
      clientRef: `chaos-${runId}-${i}`,
      filename: `chaos-${i}.pdf`,
      sizeBytes: pdf.length,
      sha256,
      storageKey,
      status: "accepted",
    })
    .returning();
  const [inv] = await db
    .insert(schema.invoices)
    .values({ tenantId: tenant.id, fileId: file!.id, status: "received" })
    .returning();
  invoiceIds.push(inv!.id);
  if (i < HARD_FAIL) {
    fake.hardFail.add(createHash("sha256").update(pdf.toString("base64")).digest("hex"));
    hardFailInvoices.push(inv!.id);
  }
}
log("created invoices", { count: invoiceIds.length, hardFail: hardFailInvoices.length });

// --- run the real worker + API against the fake ----------------------------------------------
const childEnv = {
  ...process.env,
  ANTHROPIC_BASE_URL: fake.url,
  ANTHROPIC_API_KEY: "fake-key",
  LOG_LEVEL: "warn",
};
const children: ChildProcess[] = [
  spawn("node", ["--env-file-if-exists=.env", "apps/worker/dist/main.js"], {
    cwd: root,
    env: childEnv,
    stdio: "ignore",
  }),
  spawn("node", ["--env-file-if-exists=.env", "apps/api/dist/main.js"], {
    cwd: root,
    env: { ...childEnv, API_PORT: String(API_PORT) },
    stdio: "ignore",
  }),
];
const stopChildren = () => children.forEach((c) => c.kill("SIGTERM"));
process.on("exit", stopChildren);

for (const invoiceId of invoiceIds) {
  await queues.classify.add(
    "classify",
    { invoiceId, tenantId: tenant.id },
    { jobId: stageJobId(invoiceId, "classify") },
  );
}

const terminal = ["extracted", "needs_review", "failed"] as const;
const counts = async () => {
  const rows = await db
    .select({ status: schema.invoices.status, n: sql<number>`count(*)::int` })
    .from(schema.invoices)
    .where(inArray(schema.invoices.id, invoiceIds))
    .groupBy(schema.invoices.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
};

const started = Date.now();
let c: Record<string, number> = {};
while (Date.now() - started < TIMEOUT_MS) {
  c = await counts();
  const done = terminal.reduce((s, k) => s + (c[k] ?? 0), 0);
  if (done === N) break;
  await sleep(2_000);
}
log("pipeline settled", {
  elapsedS: Math.round((Date.now() - started) / 1000),
  statuses: c,
  fake: fake.stats,
});

const dlqRows = await db
  .select()
  .from(schema.jobFailures)
  .where(inArray(sql`${schema.jobFailures.payload}->>'invoiceId'`, invoiceIds));
const dlqInvoices = new Set(dlqRows.map((r) => (r.payload as { invoiceId: string }).invoiceId));

const failures: string[] = [];
const done = terminal.reduce((s, k) => s + (c[k] ?? 0), 0);
if (done !== N) failures.push(`${N - done} invoices never reached a terminal state (lost work)`);
if ((c.failed ?? 0) !== HARD_FAIL)
  failures.push(`expected ${HARD_FAIL} failed, got ${c.failed ?? 0}`);
if (dlqInvoices.size !== HARD_FAIL || !hardFailInvoices.every((id) => dlqInvoices.has(id))) {
  failures.push(
    `DLQ should hold exactly the ${HARD_FAIL} hard failures, holds ${dlqInvoices.size}`,
  );
}

// --- replay one dead letter through the API once the upstream "recovers" --------------------
const target = dlqRows.find(
  (r) => (r.payload as { invoiceId: string }).invoiceId === hardFailInvoices[0],
);
if (target) {
  fake.hardFail.clear();
  const res = await fetch(
    `http://127.0.0.1:${API_PORT}/v1/admin/dlq/${encodeURIComponent(target.jobId)}/replay`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    },
  );
  log("replay requested", { status: res.status, body: await res.json() });
  const replayed = hardFailInvoices[0]!;
  let status = "";
  for (let i = 0; i < 60; i++) {
    const [row] = await db
      .select({ status: schema.invoices.status })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, replayed)));
    status = row?.status ?? "";
    if (status === "extracted" || status === "needs_review") break;
    await sleep(1_000);
  }
  log("replayed invoice final status", { invoiceId: replayed, status });
  if (status !== "extracted" && status !== "needs_review")
    failures.push(`replayed invoice ended as ${status}`);
}

const [cost] = await db
  .select({ total: sql<number>`coalesce(sum(cost_micros),0)::int` })
  .from(schema.invoices)
  .where(inArray(schema.invoices.id, invoiceIds));
log("summary", {
  statuses: await counts(),
  dlqEntries: dlqRows.length,
  fakeStats: fake.stats,
  costMicros: cost?.total,
});

stopChildren();
await sleep(1_000);
await fake.close();
await Promise.all(Object.values(queues).map((q) => q.close()));
redis.disconnect();
await close();

if (failures.length) {
  console.error(`CHAOS TEST FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  "CHAOS TEST PASSED: no lost invoices, DLQ holds only hard failures, replay recovered one.",
);
