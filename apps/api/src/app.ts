import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { WebhookEvent } from "@ledgerline/contracts";
import { traceLogMixin } from "@ledgerline/observability";
import type { ApiDeps } from "./deps.js";
import { registerAuth } from "./auth.js";
import { registerIdempotency } from "./idempotency.js";
import { registerProblemHandlers } from "./problem.js";
import { healthRoutes } from "./routes/health.js";
import { uploadRoutes } from "./routes/uploads.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { adminRoutes } from "./routes/admin.js";

export type { ApiDeps } from "./deps.js";

export async function buildApp(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.logLevel ?? "info", mixin: traceLogMixin },
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerProblemHandlers(app);
  registerAuth(app, deps.authenticate);
  registerIdempotency(app, () => deps.db);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Ledgerline API",
        version: "0.1.0",
        license: { name: "MIT", identifier: "MIT" },
        description:
          "Accounts-payable invoice ingestion, extraction and 3-way matching. " +
          "Errors are RFC 9457 problem+json. Lists use opaque keyset cursors.",
      },
      servers: [{ url: "http://localhost:3000", description: "Local development" }],
      components: {
        securitySchemes: {
          apiKey: {
            type: "http",
            scheme: "bearer",
            description: "Per-tenant API key. Every request is scoped to the key's tenant.",
          },
        },
      },
      security: [{ apiKey: [] }],
      tags: [
        { name: "uploads", description: "Bulk invoice upload via presigned URLs" },
        { name: "invoices", description: "Extracted invoices and the human review queue" },
        { name: "admin", description: "Dead-letter inspection and replay" },
        { name: "ops", description: "Health probes (unauthenticated)" },
      ],
      webhooks: {
        invoiceEvent: {
          post: {
            operationId: "invoiceEvent",
            summary: "Invoice lifecycle event",
            security: [],
            description:
              "Signed with the `ledgerline-signature` header: `t=<unix>,v1=<hex HMAC-SHA256 of " +
              '"<t>.<raw body>">`. Reject if older than 300s. Dedupe on `id`.',
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } },
              },
            },
            responses: { "2XX": { description: "Acknowledged" } },
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  // Make sure webhook-only schemas are in the registry even though no route references them.
  void WebhookEvent;

  await app.register(healthRoutes(deps.readinessChecks));
  await app.register(uploadRoutes(deps));
  await app.register(invoiceRoutes(deps.invoices));
  await app.register(adminRoutes(deps));

  return app;
}
