import { and, inArray, lt, sql } from "drizzle-orm";
import { schema } from "@ledgerline/db";
import { stageJobId, type Stage } from "@ledgerline/queues";
import type { WorkerDeps } from "./deps.js";

/** Which stage picks up an invoice sitting in each non-terminal status. */
// "extracted" restarts at validate: validate is idempotent and always enqueues match after it.
const NEXT_STAGE = {
  received: "classify",
  classified: "extract",
  extracted: "validate",
} as const satisfies Record<string, Stage>;
export const STUCK_AFTER_MS = 10 * 60_000;

/**
 * Postgres is the source of truth; Redis only holds in-flight work. Every minute, find invoices
 * that have sat in a non-terminal status too long (Redis flushed, crash between commit and enqueue,
 * lost job) and enqueue them again. Deterministic job ids make this a no-op for work already queued.
 */
export async function reconcile(deps: WorkerDeps, limit = 1_000): Promise<number> {
  const stuck = await deps.db
    .select({
      id: schema.invoices.id,
      tenantId: schema.invoices.tenantId,
      status: schema.invoices.status,
    })
    .from(schema.invoices)
    .where(
      and(
        inArray(schema.invoices.status, Object.keys(NEXT_STAGE) as (keyof typeof NEXT_STAGE)[]),
        lt(
          schema.invoices.updatedAt,
          sql`now() - (${STUCK_AFTER_MS} || ' milliseconds')::interval`,
        ),
      ),
    )
    .limit(limit);

  for (const inv of stuck) {
    const stage = NEXT_STAGE[inv.status as keyof typeof NEXT_STAGE];
    await deps.queues[stage].add(
      stage,
      { invoiceId: inv.id, tenantId: inv.tenantId },
      { jobId: stageJobId(inv.id, stage) },
    );
  }
  if (stuck.length > 0)
    deps.log.info({ count: stuck.length }, "reconciler re-enqueued stuck invoices");
  return stuck.length;
}
