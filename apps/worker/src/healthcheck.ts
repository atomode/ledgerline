/** Container HEALTHCHECK for the worker: healthy if the heartbeat file was touched in the last 45s. */
import { readFile } from "node:fs/promises";

const file = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/ledgerline-worker-heartbeat";
const last = Number(await readFile(file, "utf8").catch(() => "0"));
process.exit(Date.now() - last < 45_000 ? 0 : 1);
