import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from "@ledgerline/contracts";
import type { WorkerDeps } from "./deps.js";

/**
 * Delay before attempt n+1 after n failed deliveries. 8 attempts spanning ~6 hours, then give up
 * and mark delivery_failed (visible to ops; replayable by clearing the flag).
 */
export const DELIVERY_SCHEDULE_MS = [
  30e3,
  2 * 60e3,
  10 * 60e3,
  30 * 60e3,
  60 * 60e3,
  90 * 60e3,
  120 * 60e3,
];
export const MAX_DELIVERY_ATTEMPTS = DELIVERY_SCHEDULE_MS.length + 1;

interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
  webhook_url: string | null;
}

/**
 * Transactional outbox publisher. Rows are claimed with FOR UPDATE SKIP LOCKED, so any number of
 * worker processes can run this loop without double-delivering a row concurrently.
 * Delivery is at-least-once; consumers dedupe on the event id (also sent as a header).
 */
export async function publishOutboxBatch(deps: WorkerDeps, batchSize = 20): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<OutboxRow>(
      `SELECT o.id, o.tenant_id, o.aggregate_id, o.event_type, o.payload, o.attempts, o.created_at, t.webhook_url
         FROM outbox o JOIN tenants t ON t.id = o.tenant_id
        WHERE o.published_at IS NULL AND o.delivery_failed_at IS NULL AND o.next_attempt_at <= now()
        ORDER BY o.next_attempt_at
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED`,
      [batchSize],
    );

    await Promise.all(
      rows.map(async (row) => {
        if (!row.webhook_url) {
          await client.query(
            `UPDATE outbox SET published_at = now(), last_error = 'no webhook endpoint configured' WHERE id = $1`,
            [row.id],
          );
          return;
        }
        const body = JSON.stringify({
          id: row.id,
          type: row.event_type,
          createdAt: row.created_at.toISOString(),
          data: row.payload,
        });
        const ts = Math.floor(Date.now() / 1000);
        let error: string | null = null;
        try {
          const res = await doFetch(row.webhook_url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "ledgerline-event-id": row.id,
              [WEBHOOK_SIGNATURE_HEADER]: signWebhook(deps.webhookSecret, body, ts),
            },
            body,
            signal: AbortSignal.timeout(5_000),
          });
          if (!res.ok) error = `HTTP ${res.status}`;
        } catch (err) {
          error = (err as Error).message;
        }

        if (error === null) {
          await client.query(
            `UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`,
            [row.id],
          );
          return;
        }
        const attempts = row.attempts + 1;
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          await client.query(
            `UPDATE outbox SET attempts = $2, last_error = $3, delivery_failed_at = now() WHERE id = $1`,
            [row.id, attempts, error],
          );
          deps.log.error({ outboxId: row.id, attempts }, "webhook delivery failed permanently");
        } else {
          const delay = DELIVERY_SCHEDULE_MS[attempts - 1] ?? 0;
          await client.query(
            `UPDATE outbox SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval WHERE id = $1`,
            [row.id, attempts, error, String(delay)],
          );
        }
      }),
    );
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function startOutboxPublisher(deps: WorkerDeps, intervalMs = 1_000): () => Promise<void> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const n = await publishOutboxBatch(deps);
        if (n > 0) continue; // drain quickly while there is work
      } catch (err) {
        deps.log.error({ err: (err as Error).message }, "outbox publish failed");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}
