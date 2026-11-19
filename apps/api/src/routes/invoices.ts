import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CursorQuery,
  IdempotencyHeaders,
  InvoiceDetail,
  InvoiceSummary,
  ListInvoicesQuery,
  Problem,
  ReviewRequest,
  Uuid,
  page,
} from "@ledgerline/contracts";
import { notImplemented } from "../problem.js";
import { problemResponses } from "./responses.js";

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/invoices",
    {
      schema: {
        operationId: "listInvoices",
        tags: ["invoices"],
        summary: "List invoices, newest first (keyset pagination)",
        querystring: ListInvoicesQuery.extend(CursorQuery.shape),
        response: { 200: page(InvoiceSummary), ...problemResponses },
      },
    },
    async (_req, reply) => notImplemented(reply, "GET /v1/invoices"),
  );

  app.get(
    "/v1/invoices/:id",
    {
      schema: {
        operationId: "getInvoice",
        tags: ["invoices"],
        summary: "Get an invoice with lines, validations, match result and extraction metadata",
        description: "The ETag header carries the row version for optimistic concurrency.",
        params: z.object({ id: Uuid }),
        response: { 200: InvoiceDetail, ...problemResponses },
      },
    },
    async (_req, reply) => notImplemented(reply, "GET /v1/invoices/:id"),
  );

  app.post(
    "/v1/invoices/:id/review",
    {
      schema: {
        operationId: "reviewInvoice",
        tags: ["invoices"],
        summary: "Approve, reject or correct an invoice in the review queue",
        headers: IdempotencyHeaders.extend({
          "if-match": z.string().meta({ description: "ETag from GET /v1/invoices/{id}" }),
        }),
        params: z.object({ id: Uuid }),
        body: ReviewRequest,
        response: {
          200: InvoiceDetail,
          ...problemResponses,
          409: Problem.describe("Invoice is not in a reviewable status"),
          412: Problem.describe("ETag is stale; reload and retry"),
          422: Problem.describe("Idempotency-Key reused with a different body"),
        },
      },
    },
    async (_req, reply) => notImplemented(reply, "POST /v1/invoices/:id/review"),
  );
};
