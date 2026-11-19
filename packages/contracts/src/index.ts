import { z } from "zod";

/** Zod schemas are the source of truth; OpenAPI and the typed client are generated from them (step 2). */
export const HealthResponse = z.object({ status: z.literal("ok") });
export const ReadinessResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  checks: z.record(
    z.string(),
    z.object({ ok: z.boolean(), latencyMs: z.number(), error: z.string().optional() }),
  ),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
