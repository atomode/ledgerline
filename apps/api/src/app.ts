import Fastify, { type FastifyInstance } from "fastify";
import { runReadiness, type Check } from "./readiness.js";

export interface AppDeps {
  readinessChecks: Record<string, Check>;
  logLevel?: string;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.logLevel ?? "info" },
    genReqId: () => crypto.randomUUID(),
  });

  // Liveness: the process is up. Never touches dependencies, so a DB outage
  // doesn't make the orchestrator restart healthy pods.
  app.get("/healthz", async () => ({ status: "ok" as const }));

  // Readiness: can this instance serve traffic right now?
  app.get("/readyz", async (_req, reply) => {
    const result = await runReadiness(deps.readinessChecks);
    return reply.code(result.status === "ok" ? 200 : 503).send(result);
  });

  return app;
}
