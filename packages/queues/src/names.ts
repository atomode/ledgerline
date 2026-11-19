/**
 * Pipeline stages in order. Each has its own queue so a slow stage can't starve the others.
 * There is no notify stage: notifications leave through the transactional outbox, which is
 * written in the same transaction as the decision, so a queue hop would only add a failure mode.
 */
export const STAGES = ["classify", "extract", "validate", "match"] as const;
export type Stage = (typeof STAGES)[number];

export const queueName = (stage: Stage) => `ll-${stage}`;
export const dlqName = (stage: Stage) => `ll-${stage}-dlq`;
export const MAINTENANCE_QUEUE = "ll-maintenance";

export interface StageJobData {
  invoiceId: string;
  tenantId: string;
  /** W3C trace context of the enqueueing span (traceparent, tracestate). Set by StageQueue. */
  _trace?: Record<string, string>;
}

/**
 * Deterministic job ids make enqueueing idempotent: adding a job whose id already exists in the
 * queue is a no-op. Completed jobs are removed, so a later re-enqueue (reconciler) still works.
 */
// BullMQ reserves ":" in custom job ids (it is the Redis key separator), hence "__".
export const stageJobId = (invoiceId: string, stage: Stage) => `${invoiceId}__${stage}`;
