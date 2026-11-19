import { schema } from "@ledgerline/db";
import type { WorkerDeps } from "../deps.js";

type Tx = Parameters<Parameters<WorkerDeps["db"]["transaction"]>[0]>[0];

/** Announce a terminal decision through the outbox, inside the caller's transaction. */
export async function announce(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  status: "approved" | "needs_review",
  extra: Record<string, unknown> = {},
) {
  await tx.insert(schema.outbox).values({
    tenantId,
    aggregateId: invoiceId,
    eventType: status === "approved" ? "invoice.approved" : "invoice.needs_review",
    payload: { invoiceId, status, ...extra },
  });
}
