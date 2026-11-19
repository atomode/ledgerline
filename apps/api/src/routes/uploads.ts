import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  IdempotencyHeaders,
  UploadSession,
  Uuid,
} from "@ledgerline/contracts";
import { notImplemented } from "../problem.js";
import { problemResponses } from "./responses.js";

export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/v1/upload-sessions",
    {
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
