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

/** A Redis connection on its own logical DB, flushed at start. BullMQ needs maxRetriesPerRequest null. */
let nextDb = 1;
export async function freshRedis(): Promise<Redis> {
  const url = new URL(inject("redisUrl"));
  // vitest runs files in separate workers; mix in the worker id so DB numbers don't collide.
  const worker = Number(process.env.VITEST_POOL_ID ?? "1");
  url.pathname = `/${((worker - 1) * 3 + nextDb++) % 16}`;
  const r = new Redis(url.toString(), { maxRetriesPerRequest: null });
  await r.flushdb();
  return r;
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
