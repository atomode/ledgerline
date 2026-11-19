import { loadEnv } from "@ledgerline/config";
import { createDb } from "@ledgerline/db";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });

const app = buildApp({
  logLevel: env.LOG_LEVEL,
  readinessChecks: {
    postgres: async () => {
      await db.pool.query("select 1");
    },
    redis: async () => {
      await redis.ping();
    },
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await Promise.allSettled([db.close(), redis.quit()]);
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// ioredis reconnects on its own; /readyz reports the outage, so just log it.
redis.on("error", (err) => app.log.warn({ err: err.message }, "redis connection error"));
db.pool.on("error", (err) => app.log.warn({ err: err.message }, "postgres pool error"));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
