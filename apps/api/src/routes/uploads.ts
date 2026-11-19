import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  IdempotencyHeaders,
  UploadSession,
  Problem,
  Uuid,
} from "@ledgerline/contracts";
import { sendProblem } from "../problem.js";
import { SessionExpiredError, SessionNotFoundError } from "../services/uploads.js";
import type { ApiDeps } from "../deps.js";
import { problemResponses } from "./responses.js";

export const uploadRoutes =
  (deps: ApiDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      "/v1/upload-sessions",
      {
        // Backpressure: refuse new work while the extract stage is saturated.
        preHandler: async (_req, reply) => {
          const d = await deps.admission();
          if (!d.admit) {
            reply.header("retry-after", String(d.retryAfterSeconds));
            return sendProblem(reply, {
              type: "https://ledgerline.dev/problems/backlog",
              title: "Pipeline backlog; retry later",
              status: 429,
              detail: `extract queue has ${d.waiting} waiting jobs, oldest ${Math.round(d.oldestWaitMs / 1000)}s`,
            });
          }
        },
        schema: {
          operationId: "createUploadSession",
          tags: ["uploads"],
          summary: "Create an upload session with presigned PUT URLs (max 200 files)",
          headers: IdempotencyHeaders,
          body: CreateUploadSessionRequest,
          response: { 201: UploadSession, ...problemResponses },
        },
      },
      async (req, reply) =>
        reply.code(201).send(await deps.uploads.createSession(req.principal.tenantId, req.body)),
    );

    app.post(
      "/v1/upload-sessions/:id/complete",
      {
        schema: {
          operationId: "completeUploadSession",
          tags: ["uploads"],
          summary: "Finish a session; returns a per-file result (accepted, duplicate, rejected)",
          description:
            "Partial success is normal: the response is 202 when at least one file is accepted, " +
            "and each file carries its own status.",
          headers: IdempotencyHeaders,
          params: z.object({ id: Uuid }),
          response: {
            202: CompleteUploadSessionResponse,
            200: CompleteUploadSessionResponse.describe("No file was accepted"),
            410: Problem.describe("Session expired before completion"),
            ...problemResponses,
          },
        },
      },
      async (req, reply) => {
        try {
          const result = await deps.uploads.completeSession(req.principal.tenantId, req.params.id);
          return reply.code(result.counts.accepted > 0 ? 202 : 200).send(result);
        } catch (err) {
          if (err instanceof SessionNotFoundError) {
            return sendProblem(reply, { type: "about:blank", title: "Not Found", status: 404 });
          }
          if (err instanceof SessionExpiredError) {
            return sendProblem(reply, {
              type: "about:blank",
              title: "Upload session expired",
              status: 410,
            });
          }
          throw err;
        }
      },
    );
  };
