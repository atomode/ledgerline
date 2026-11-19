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

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const queues = createStageQueues(redis);

const app = await buildApp({
  logLevel: env.LOG_LEVEL,
  db: db.db,
  queues,
  dlqs: createDlqQueues(redis),
  authenticate: dbAuthenticator(db.db),
  admission: createAdmissionController(queues.extract),
  cursorSecret: env.CURSOR_SIGNING_SECRET,
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
  redis.disconnect();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
