import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  IdempotencyHeaders,
  UploadSession,
  Uuid,
} from "@ledgerline/contracts";
import { notImplemented, sendProblem } from "../problem.js";
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
      async (_req, reply) => notImplemented(reply, "POST /v1/upload-sessions"),
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
            ...problemResponses,
          },
        },
      },
      async (_req, reply) => notImplemented(reply, "POST /v1/upload-sessions/:id/complete"),
    );
  };
