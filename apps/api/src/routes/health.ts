import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { HealthResponse, ReadinessResponse } from "@ledgerline/contracts";
import { runReadiness, type Check } from "../readiness.js";

export const healthRoutes =
  (checks: Record<string, Check>): FastifyPluginAsyncZod =>
  async (app) => {
    // Liveness: the process is up. Never touches dependencies, so a DB outage
    // doesn't make the orchestrator restart otherwise-healthy pods.
    app.get(
      "/healthz",
      {
        schema: {
          tags: ["ops"],
          operationId: "getLiveness",
          summary: "Liveness probe",
          security: [],
          response: { 200: HealthResponse },
        },
      },
      async () => ({ status: "ok" as const }),
    );

    // Readiness: can this instance serve traffic right now?
    app.get(
      "/readyz",
      {
        schema: {
          tags: ["ops"],
          operationId: "getReadiness",
          summary: "Readiness probe (checks Postgres and Redis)",
          security: [],
          response: { 200: ReadinessResponse, 503: ReadinessResponse },
        },
      },
      async (_req, reply) => {
        const result = await runReadiness(checks);
        return reply.code(result.status === "ok" ? 200 : 503).send(result);
      },
    );
  };
