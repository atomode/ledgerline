import { loadEnv } from "@ledgerline/config";
import { Redis } from "ioredis";
import { pino } from "pino";

/**
 * Worker entrypoint. Queues and processors (classify, extract, validate, match, notify)
 * are added in step 4. For now it proves config + Redis connectivity and shuts down cleanly.
 */
const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL, base: { service: "ledgerline-worker" } });
// BullMQ requires maxRetriesPerRequest: null on worker connections.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
// ioredis reconnects on its own; log instead of crashing on "Unhandled error event".
connection.on("error", (err) => log.warn({ err: err.message }, "redis connection error"));

await connection.ping();
log.info("worker started; no processors registered yet");

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await connection.quit();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
