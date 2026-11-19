import { writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { Worker } from "bullmq";
import { pino } from "pino";
import { loadEnv } from "@ledgerline/config";
import { createDb } from "@ledgerline/db";
import {
  MAINTENANCE_QUEUE,
  createDlqQueues,
  createRedis,
  createStageQueues,
  createTokenBucket,
} from "@ledgerline/queues";
import { Queue } from "bullmq";
import { createStorage } from "@ledgerline/storage";
import type { WorkerDeps } from "./deps.js";
import { createStageWorker } from "./stage-worker.js";
import { createExtractProcessor } from "./processors/extract.js";
import { createClassifyProcessor } from "./processors/classify.js";
import { createValidateProcessor } from "./processors/validate.js";
import { createMatchProcessor } from "./processors/match.js";
import { startOutboxPublisher } from "./outbox.js";
import { reconcile } from "./reconciler.js";

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, base: { service: "ledgerline-worker" } });
const redis = createRedis(env.REDIS_URL);
redis.on("error", (err) => log.warn({ err: err.message }, "redis connection error"));
const dbHandle = createDb(env.DATABASE_URL);

const deps: WorkerDeps = {
  db: dbHandle.db,
  pool: dbHandle.pool,
  redis,
  storage: createStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  }),
  // maxRetries: 0 because BullMQ owns retries; two retry layers would multiply attempts.
  anthropic: new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY ?? "missing",
    maxRetries: 0,
    timeout: 120_000,
  }),
  queues: createStageQueues(redis),
  dlqs: createDlqQueues(redis),
  tokenBucket: createTokenBucket(redis, "ll:itpm", env.ANTHROPIC_ITPM_BUDGET),
  log,
  extractionModel: env.EXTRACTION_MODEL,
  classifyModel: env.CLASSIFY_MODEL,
  webhookSecret: env.WEBHOOK_SIGNING_SECRET,
};

const workers = [
  createStageWorker("classify", createClassifyProcessor(deps), deps),
  createStageWorker("extract", createExtractProcessor(deps), deps, { concurrency: 8 }),
  createStageWorker("validate", createValidateProcessor(deps), deps),
  createStageWorker("match", createMatchProcessor(deps), deps),
];

const maintenance = new Queue(MAINTENANCE_QUEUE, { connection: redis });
await maintenance.upsertJobScheduler("reconcile", { every: 60_000 }, { name: "reconcile" });
const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => (job.name === "reconcile" ? reconcile(deps) : undefined),
  { connection: redis, concurrency: 1 },
);
const stopOutbox = startOutboxPublisher(deps);

log.info({ stages: workers.map((w) => w.name) }, "worker started");

// Liveness for the container HEALTHCHECK: the worker has no HTTP port, so it touches a file while
// its Redis connection is usable. A hung event loop or a dead connection lets the file go stale.
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/ledgerline-worker-heartbeat";
const heartbeat = setInterval(() => {
  redis
    .ping()
    .then(() => writeFile(HEARTBEAT_FILE, String(Date.now())))
    .catch((err: unknown) => log.warn({ err: (err as Error).message }, "heartbeat failed"));
}, 10_000);
heartbeat.unref();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down: no new jobs, waiting up to 30s for in-flight work");
  const timeout = new Promise((r) => setTimeout(r, 30_000));
  await Promise.race([
    Promise.all([...workers, maintenanceWorker].map((w) => w.close()).concat(stopOutbox())),
    timeout,
  ]);
  await Promise.allSettled([maintenance.close(), dbHandle.close()]);
  redis.disconnect();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
