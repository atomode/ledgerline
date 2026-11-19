import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { CursorQuery, DlqItem, ReplayResponse, page } from "@ledgerline/contracts";
import { notImplemented } from "../problem.js";
import { problemResponses } from "./responses.js";

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/admin/dlq",
    {
      schema: {
        operationId: "listDeadLetters",
        tags: ["admin"],
        summary: "List dead-lettered jobs",
        querystring: CursorQuery.extend({ queue: z.string().optional() }),
        response: { 200: page(DlqItem), ...problemResponses },
      },
    },
    async (_req, reply) => notImplemented(reply, "GET /v1/admin/dlq"),
  );

  app.post(
    "/v1/admin/dlq/:jobId/replay",
    {
      schema: {
        operationId: "replayDeadLetter",
        tags: ["admin"],
        summary: "Re-enqueue a dead-lettered job with a fresh attempt budget",
        params: z.object({ jobId: z.string().min(1) }),
        response: { 202: ReplayResponse, ...problemResponses },
      },
    },
    async (_req, reply) => notImplemented(reply, "POST /v1/admin/dlq/:jobId/replay"),
  );
};
