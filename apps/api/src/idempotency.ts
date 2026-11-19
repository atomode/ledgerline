import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { schema, type Db } from "@ledgerline/db";
import { sendProblem } from "./problem.js";

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

declare module "fastify" {
  interface FastifyRequest {
    idempotencyKey?: string;
  }
}

const requestHash = (req: FastifyRequest) =>
  createHash("sha256")
    .update(
      // If-Match is part of the request: a retry after reloading the ETag is a different request.
      `${req.method} ${req.routeOptions.url}\n${JSON.stringify(req.params)}\n${req.headers["if-match"] ?? ""}\n${JSON.stringify(req.body ?? null)}`,
    )
    .digest("hex");

/**
 * Idempotency-Key support for every POST (Stripe-style semantics):
 * - first request claims the key (INSERT ... ON CONFLICT DO NOTHING) before the handler runs
 * - a retry with the same key and body gets the stored status + body, with `idempotent-replayed: true`
 * - the same key with a different body is a 422; a retry while the first is still running is a 409
 * - 5xx and 429 release the key so the client can retry for real (a backpressure 429 must not
 *   be cached as the permanent answer for that key)
 */
export function registerIdempotency(app: FastifyInstance, db: () => Db): void {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers["idempotency-key"];
    if (req.method !== "POST" || typeof key !== "string" || !req.principal) return;
    const hash = requestHash(req);
    const tenantId = req.principal.tenantId;
    const claimed = await db()
      .insert(schema.idempotencyKeys)
      .values({
        tenantId,
        key,
        requestHash: hash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing()
      .returning({ key: schema.idempotencyKeys.key });
    if (claimed.length > 0) {
      req.idempotencyKey = key;
      return;
    }
    const [existing] = await db()
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(eq(schema.idempotencyKeys.tenantId, tenantId), eq(schema.idempotencyKeys.key, key)),
      );
    if (!existing) return; // expired and purged between the two statements; treat as new
    if (existing.requestHash !== hash) {
      return sendProblem(reply, {
        type: "https://ledgerline.dev/problems/idempotency-mismatch",
        title: "Idempotency-Key was already used with a different request",
        status: 422,
      });
    }
    if (existing.statusCode === null) {
      reply.header("retry-after", "2");
      return sendProblem(reply, {
        type: "about:blank",
        title: "Original request still in progress",
        status: 409,
      });
    }
    reply.header("idempotent-replayed", "true");
    return reply.code(existing.statusCode).send(existing.responseBody);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.idempotencyKey) return payload;
    const where = and(
      eq(schema.idempotencyKeys.tenantId, req.principal.tenantId),
      eq(schema.idempotencyKeys.key, req.idempotencyKey),
    );
    if (reply.statusCode >= 500 || reply.statusCode === 429) {
      await db().delete(schema.idempotencyKeys).where(where);
      return payload;
    }
    let body: unknown = null;
    try {
      body = typeof payload === "string" ? JSON.parse(payload) : null;
    } catch {
      body = null;
    }
    await db()
      .update(schema.idempotencyKeys)
      .set({ statusCode: reply.statusCode, responseBody: sql`${JSON.stringify(body)}::jsonb` })
      .where(where);
    return payload;
  });
}
