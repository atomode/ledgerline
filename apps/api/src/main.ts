import { loadEnv } from "@ledgerline/config";
import { createDb } from "@ledgerline/db";
import {
  createAdmissionController,
  createDlqQueues,
  createRedis,
  createStageQueues,
} from "@ledgerline/queues";
import { buildApp } from "./app.js";
import { dbAuthenticator } from "./auth.js";
import { createStorage } from "@ledgerline/storage";
import { createUploadService } from "./services/uploads.js";
import { createInvoiceService } from "./services/invoices.js";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const queues = createStageQueues(redis);
const storage = createStorage({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});

const app = await buildApp({
  logLevel: env.LOG_LEVEL,
  db: db.db,
  queues,
  dlqs: createDlqQueues(redis),
  authenticate: dbAuthenticator(db.db),
  admission: createAdmissionController(queues.extract),
  cursorSecret: env.CURSOR_SIGNING_SECRET,
  uploads: createUploadService({ db: db.db, storage, queues }),
  invoices: createInvoiceService({ db: db.db, cursorSecret: env.CURSOR_SIGNING_SECRET }),
  readinessChecks: {
    postgres: async () => {
      await db.pool.query("select 1");
    },
    redis: async () => {
      await redis.ping();
    },
  },
});

// ioredis reconnects on its own; /readyz reports the outage, so just log it.
redis.on("error", (err) => app.log.warn({ err: err.message }, "redis connection error"));
db.pool.on("error", (err) => app.log.warn({ err: err.message }, "postgres pool error"));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await Promise.allSettled([db.close(), ...Object.values(queues).map((q) => q.close())]);
  await (
    globalThis as { __ledgerlineOtelShutdown?: () => Promise<void> }
  ).__ledgerlineOtelShutdown?.();
  redis.disconnect();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
