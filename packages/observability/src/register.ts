/**
 * `node --import @ledgerline/observability/register dist/main.js`
 *
 * Installs the import-in-the-middle hook so ESM imports of pg/ioredis/fastify can be patched, then
 * starts the SDK. Must run before the application's first import, which is what --import does.
 * Set OTEL_SDK_DISABLED=true to turn everything off.
 */
import { register } from "node:module";
import { startTelemetry } from "./sdk.js";

if (process.env.OTEL_SDK_DISABLED !== "true") {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const telemetry = startTelemetry({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "ledgerline",
    serviceVersion: process.env.SERVICE_VERSION,
    environment: process.env.NODE_ENV,
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
  // Flush on the way out; the app's own SIGTERM handler calls process.exit after draining.
  const shutdown = () => telemetry.shutdown();
  process.once("beforeExit", () => void shutdown());
  (globalThis as { __ledgerlineOtelShutdown?: () => Promise<void> }).__ledgerlineOtelShutdown =
    shutdown;
}
