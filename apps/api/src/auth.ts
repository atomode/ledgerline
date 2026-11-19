import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db } from "@ledgerline/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sendProblem } from "./problem.js";

export interface Principal {
  tenantId: string;
  apiKeyId: string;
}

export type Authenticate = (token: string) => Promise<Principal | null>;

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}

/** API keys are stored as sha256 hashes; lookup is by hash, so the plaintext never touches the DB. */
export function dbAuthenticator(db: Db): Authenticate {
  return async (token) => {
    const keyHash = createHash("sha256").update(token).digest("hex");
    const [row] = await db
      .select({ id: schema.apiKeys.id, tenantId: schema.apiKeys.tenantId })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, keyHash), isNull(schema.apiKeys.revokedAt)));
    return row ? { tenantId: row.tenantId, apiKeyId: row.id } : null;
  };
}

const PUBLIC_PATHS = new Set(["/healthz", "/readyz"]);

export function registerAuth(app: FastifyInstance, authenticate: Authenticate): void {
  app.decorateRequest("principal", null as unknown as Principal);
  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    if (PUBLIC_PATHS.has(req.routeOptions.url ?? "")) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const principal = token ? await authenticate(token) : null;
    if (!principal) {
      reply.header("www-authenticate", 'Bearer realm="ledgerline"');
      return sendProblem(reply, { type: "about:blank", title: "Unauthorized", status: 401 });
    }
    req.principal = principal;
  });
}
