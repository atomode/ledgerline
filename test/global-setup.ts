/**
 * Integration-test infrastructure, started once per `pnpm test:integration` run:
 * - Postgres 16 (same image as prod/compose) with every migration applied to a template database.
 *   Each test file clones the template (CREATE DATABASE ... TEMPLATE), so files are isolated and
 *   can run in parallel without truncation games.
 * - Redis 7, one container; each test file uses its own logical DB number / key prefix.
 *
 * Set LEDGERLINE_IT_PG_URL / LEDGERLINE_IT_REDIS_URL to reuse running services instead (faster
 * local loops against `pnpm infra:up`; CI always uses fresh containers).
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { TestProject } from "vitest/node";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export const TEMPLATE_DB = "ledgerline_it_template";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    redisUrl: string;
  }
}

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

export default async function setup(project: TestProject) {
  let pgc: StartedPostgreSqlContainer | undefined;
  let rc: StartedRedisContainer | undefined;

  const pgAdminUrl =
    process.env.LEDGERLINE_IT_PG_URL ??
    (pgc = await new PostgreSqlContainer("pgvector/pgvector:pg16")
      .withDatabase("postgres")
      .withUsername("ledgerline")
      .withPassword("ledgerline")
      .start()).getConnectionUri();
  const redisUrl =
    process.env.LEDGERLINE_IT_REDIS_URL ??
    (rc = await new RedisContainer("redis:7-alpine")
      .withCommand(["redis-server", "--maxmemory-policy", "noeviction"])
      .start()).getConnectionUrl();

  const admin = new pg.Client({ connectionString: pgAdminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();

  // Migrating from an empty database is itself a test: a broken migration fails the whole run.
  const pool = new pg.Pool({ connectionString: withDb(pgAdminUrl, TEMPLATE_DB), max: 1 });
  await migrate(drizzle(pool), {
    migrationsFolder: new URL("../packages/db/drizzle", import.meta.url).pathname,
  });
  await pool.end();

  project.provide("pgAdminUrl", pgAdminUrl);
  project.provide("redisUrl", redisUrl);

  return async () => {
    await Promise.all([pgc?.stop(), rc?.stop()]);
  };
}
