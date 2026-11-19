import { z } from "zod";

export const HealthResponse = z.object({ status: z.literal("ok") }).meta({ id: "HealthResponse" });

export const ReadinessResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
    checks: z.record(
      z.string(),
      z.object({ ok: z.boolean(), latencyMs: z.number(), error: z.string().optional() }),
    ),
  })
  .meta({ id: "ReadinessResponse" });
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
