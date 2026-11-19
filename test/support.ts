/** Per-file helpers for integration tests. See global-setup.ts for the shared containers. */
import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import pg from "pg";
import { Redis } from "ioredis";
import { createDb, type DbHandle } from "@ledgerline/db";
import { TEMPLATE_DB } from "./global-setup.js";

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/** A fresh, fully migrated database cloned from the template. Dropped by the returned cleanup. */
export async function freshDatabase(): Promise<DbHandle & { url: string; drop(): Promise<void> }> {
  const adminUrl = inject("pgAdminUrl");
  const name = `it_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();
  const url = withDb(adminUrl, name);
  const handle = createDb(url, { max: 10 });
  return {
    ...handle,
    url,
    async drop() {
      await handle.close();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/**
 * Claims a logical DB only if nobody holds it, then wipes it. Atomic, so two test files starting
 * at once can never get the same DB (a shared DB means one file flushes or consumes the other's
 * jobs). VITEST_POOL_ID is not unique across concurrently running files, so it can't be used.
 */
const CLAIM_KEY = "ledgerline:it:claim";
const CLAIM = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('FLUSHDB')
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1`;
const CLAIM_TTL_MS = 30_000;

/** A Redis connection on its own logical DB, flushed at start. BullMQ needs maxRetriesPerRequest null. */
export async function freshRedis(): Promise<Redis> {
  const base = new URL(inject("redisUrl"));
  const owner = `${process.pid}:${randomBytes(4).toString("hex")}`;
  // Never DB 0: that is where a developer's local stack keeps its queues.
  for (let db = 1; db <= 15; db++) {
    base.pathname = `/${db}`;
    const r = new Redis(base.toString(), { maxRetriesPerRequest: null });
    if ((await r.eval(CLAIM, 1, CLAIM_KEY, owner, CLAIM_TTL_MS)) === 1) {
      // Keep the claim alive while this file runs; if the process dies it lapses in 30 s.
      const beat = setInterval(() => {
        r.pexpire(CLAIM_KEY, CLAIM_TTL_MS).catch(() => {});
      }, CLAIM_TTL_MS / 3);
      beat.unref();
      // Release on close, so the next file can reuse the DB right away.
      const release = async () => {
        clearInterval(beat);
        await r
          .eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
            1,
            CLAIM_KEY,
            owner,
          )
          .catch(() => {});
      };
      const disconnect = r.disconnect.bind(r);
      const quit = r.quit.bind(r);
      r.disconnect = (reconnect?: boolean) => {
        void release().finally(() => disconnect(reconnect));
      };
      r.quit = async () => {
        await release();
        return quit();
      };
      return r;
    }
    r.disconnect();
  }
  throw new Error("freshRedis: all 15 test Redis DBs are claimed; is another run still going?");
}

export const TENANT_A = "0190a000-0000-7000-8000-00000000000a";
export const TENANT_B = "0190b000-0000-7000-8000-00000000000b";

/** In-memory stand-in for the S3 wrapper: same interface, no network. */
export function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    bucket: "memory",
    async getObject(key: string) {
      const o = objects.get(key);
      if (!o) throw new Error(`no such key ${key}`);
      return o;
    },
    async putObject(key: string, body: Buffer) {
      objects.set(key, body);
    },
    async headObject(key: string) {
      const o = objects.get(key);
      return o ? { sizeBytes: o.length } : null;
    },
    async presignPut(key: string) {
      return `memory://${key}`;
    },
    destroy() {},
  };
}

export const tinyPdf = (tag: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%${tag}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
