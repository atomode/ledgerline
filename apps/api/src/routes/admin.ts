import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { CursorQuery, DlqItem, ReplayResponse, page } from "@ledgerline/contracts";
import { schema } from "@ledgerline/db";
import { STAGES, queueName, type Stage } from "@ledgerline/queues";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../cursor.js";
import { sendProblem } from "../problem.js";
import type { ApiDeps } from "../deps.js";
import { problemResponses } from "./responses.js";

/** The status an invoice must be in for a stage to pick it up again after a replay. */
const ENTRY_STATUS: Record<Stage, "received" | "classified" | "extracted"> = {
  classify: "received",
  extract: "classified",
  validate: "extracted",
  match: "extracted",
};

const stageOfQueue = (q: string) => STAGES.find((s) => queueName(s) === q);

export const adminRoutes =
  (deps: ApiDeps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      "/v1/admin/dlq",
      {
        schema: {
          operationId: "listDeadLetters",
          tags: ["admin"],
          summary: "List dead-lettered jobs for your tenant, newest first",
          querystring: CursorQuery.extend({ queue: z.string().optional() }),
          response: { 200: page(DlqItem), ...problemResponses },
        },
      },
      async (req, reply) => {
        const { cursor, limit, queue } = req.query;
        let after: string | undefined;
        try {
          after = cursor ? decodeCursor(deps.cursorSecret, cursor).id : undefined;
        } catch (err) {
          if (err instanceof InvalidCursorError) {
            return sendProblem(reply, {
              type: "about:blank",
              title: "Invalid cursor",
              status: 400,
            });
          }
          throw err;
        }
        const f = schema.jobFailures;
        const rows = await deps.db
          .select()
          .from(f)
          .where(
            and(
              sql`${f.payload}->>'tenantId' = ${req.principal.tenantId}`,
              queue ? eq(f.queue, queue) : undefined,
              after ? lt(f.id, after) : undefined,
            ),
          )
          // uuid v7 ids are time-ordered, so id alone is a stable keyset for "newest first".
          .orderBy(desc(f.id))
          .limit(limit + 1);
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
          data: pageRows.map((r) => ({
            jobId: r.jobId,
            queue: r.queue,
            failedAt: r.failedAt.toISOString(),
            attemptsMade: r.attemptsMade,
            errorChain: r.errorChain as { name: string; message: string }[],
            replayedAt: r.replayedAt?.toISOString() ?? null,
          })),
          nextCursor:
            rows.length > limit && last ? encodeCursor(deps.cursorSecret, { id: last.id }) : null,
        };
      },
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
      async (req, reply) => {
        const f = schema.jobFailures;
        const [failure] = await deps.db
          .select()
          .from(f)
          .where(
            and(
              eq(f.jobId, req.params.jobId),
              sql`${f.payload}->>'tenantId' = ${req.principal.tenantId}`,
            ),
          )
          .orderBy(desc(f.failedAt))
          .limit(1);
        const stage = failure ? stageOfQueue(failure.queue) : undefined;
        if (!failure || !stage) {
          return sendProblem(reply, { type: "about:blank", title: "Not Found", status: 404 });
        }
        const data = failure.payload as { invoiceId: string; tenantId: string };
        // Fresh job id: the failed original is retained for inspection and would block a same-id add.
        const newJobId = `${failure.jobId}__replay_${Date.now()}`;

        await deps.db.transaction(async (tx) => {
          await tx
            .update(schema.invoices)
            .set({ status: ENTRY_STATUS[stage], version: sql`${schema.invoices.version} + 1` })
            .where(
              and(eq(schema.invoices.id, data.invoiceId), eq(schema.invoices.status, "failed")),
            );
          await tx.update(f).set({ replayedAt: new Date() }).where(eq(f.id, failure.id));
        });
        await deps.queues[stage].add(
          stage,
          { invoiceId: data.invoiceId, tenantId: data.tenantId },
          { jobId: newJobId },
        );
        await deps.dlqs[stage].remove(failure.jobId).catch(() => 0);

        return reply.code(202).send({ jobId: failure.jobId, newJobId, queue: failure.queue });
      },
    );
  };
