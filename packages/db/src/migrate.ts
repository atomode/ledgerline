import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index.js";

/** The committed SQL migrations, resolved relative to this file so it works from src and dist. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Apply pending migrations. Drizzle takes a Postgres advisory lock for the duration, so two
 * deploys racing to migrate serialize instead of corrupting the journal.
 */
export async function runMigrations(databaseUrl: string, folder = MIGRATIONS_FOLDER) {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: folder });
  } finally {
    await handle.close();
  }
}
