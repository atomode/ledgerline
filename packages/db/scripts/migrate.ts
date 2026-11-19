import { loadEnv } from "@ledgerline/config";
import { runMigrations } from "../src/migrate.js";

await runMigrations(loadEnv().DATABASE_URL);
console.log("migrations applied");
