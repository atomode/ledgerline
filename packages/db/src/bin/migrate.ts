/** Entry point of the `migrate` container image: apply migrations, then exit. */
import { loadEnv } from "@ledgerline/config";
import { MIGRATIONS_FOLDER, runMigrations } from "../migrate.js";

const env = loadEnv();
await runMigrations(env.DATABASE_URL, MIGRATIONS_FOLDER);
process.stdout.write(JSON.stringify({ msg: "migrations applied" }) + "\n");
