/** Pipeline stages in order. Each has its own queue so a slow stage can't starve the others. */
export const STAGES = ["classify", "extract", "validate", "match", "notify"] as const;
export type Stage = (typeof STAGES)[number];

export const queueName = (stage: Stage) => `ll-${stage}`;
export const dlqName = (stage: Stage) => `ll-${stage}-dlq`;
export const MAINTENANCE_QUEUE = "ll-maintenance";

export interface StageJobData {
  invoiceId: string;
  tenantId: string;
}

/**
 * Deterministic job ids make enqueueing idempotent: adding a job whose id already exists in the
 * queue is a no-op. Completed jobs are removed, so a later re-enqueue (reconciler) still works.
 */
// BullMQ reserves ":" in custom job ids (it is the Redis key separator), hence "__".
export const stageJobId = (invoiceId: string, stage: Stage) => `${invoiceId}__${stage}`;
