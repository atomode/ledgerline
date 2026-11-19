import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadEnv } from "@ledgerline/config";
import { createDb } from "../src/index.js";

const env = loadEnv();
const handle = createDb(env.DATABASE_URL, { max: 1 });
await migrate(handle.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
await handle.close();
console.log("migrations applied");
