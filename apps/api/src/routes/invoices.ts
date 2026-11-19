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
import { InvalidCursorError } from "../cursor.js";
import { sendProblem } from "../problem.js";
import {
  InvoiceNotFoundError,
  NotReviewableError,
  StaleVersionError,
  etagFor,
  type InvoiceService,
} from "../services/invoices.js";
import { problemResponses } from "./responses.js";

const notFound = { type: "about:blank", title: "Not Found", status: 404 } as const;

export const invoiceRoutes =
  (svc: InvoiceService): FastifyPluginAsyncZod =>
  async (app) => {
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
      async (req, reply) => {
        try {
          return await svc.list(req.principal.tenantId, req.query);
        } catch (err) {
          if (err instanceof InvalidCursorError || err instanceof SyntaxError) {
            return sendProblem(reply, {
              type: "about:blank",
              title: "Invalid cursor",
              status: 400,
            });
          }
          throw err;
        }
      },
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
      async (req, reply) => {
        try {
          const { detail, version } = await svc.get(req.principal.tenantId, req.params.id);
          reply.header("etag", etagFor(version));
          return detail;
        } catch (err) {
          if (err instanceof InvoiceNotFoundError) return sendProblem(reply, notFound);
          throw err;
        }
      },
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
      async (req, reply) => {
        const m = /^W\/"(\d+)"$/.exec(req.headers["if-match"]);
        if (!m)
          return sendProblem(reply, {
            type: "about:blank",
            title: "Malformed If-Match",
            status: 412,
          });
        try {
          const { detail, version } = await svc.review(
            req.principal.tenantId,
            req.params.id,
            Number(m[1]),
            req.principal.apiKeyId,
            req.body,
          );
          reply.header("etag", etagFor(version));
          return detail;
        } catch (err) {
          if (err instanceof InvoiceNotFoundError) return sendProblem(reply, notFound);
          if (err instanceof StaleVersionError) {
            return sendProblem(reply, {
              type: "about:blank",
              title: "Precondition Failed",
              status: 412,
              detail: "ETag is stale",
            });
          }
          if (err instanceof NotReviewableError) {
            return sendProblem(reply, {
              type: "about:blank",
              title: "Not reviewable",
              status: 409,
              detail: err.message,
            });
          }
          throw err;
        }
      },
    );
  };
