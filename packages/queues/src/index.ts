import { Queue, type DefaultJobOptions, type JobsOptions } from "bullmq";
import { SpanKind, inSpan, injectTraceContext } from "@ledgerline/observability";
import { Redis } from "ioredis";
import { STAGES, dlqName, queueName, type Stage, type StageJobData } from "./names.js";

export * from "./names.js";
export * from "./backoff.js";
export * from "./token-bucket.js";
export * from "./admission.js";

export const DEFAULT_ATTEMPTS = 5;

export const defaultJobOptions: DefaultJobOptions = {
  attempts: DEFAULT_ATTEMPTS,
  backoff: { type: "jitter" },
  // Completed jobs are removed so a deterministic job id can be enqueued again later.
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** BullMQ requires maxRetriesPerRequest: null for blocking connections. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

/**
 * A stage queue that carries W3C trace context in the job data. Every enqueue, wherever it
 * happens (API upload, a processor handing off, the reconciler, a DLQ replay), opens a PRODUCER
 * span and stores its context in `data._trace`; the stage worker continues the trace from there,
 * so one upload is one trace across processes and Redis hops.
 */
export class StageQueue extends Queue<StageJobData> {
  constructor(
    readonly stage: Stage,
    connection: Redis,
  ) {
    super(queueName(stage), { connection, defaultJobOptions });
  }

  override add(name: string, data: StageJobData, opts?: JobsOptions) {
    return inSpan(
      `${this.name} publish`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          "messaging.system": "bullmq",
          "messaging.operation.type": "send",
          "messaging.destination.name": this.name,
          ...(opts?.jobId ? { "messaging.message.id": opts.jobId } : {}),
          "ledgerline.invoice_id": data.invoiceId,
        },
      },
      () => super.add(name, { ...data, _trace: injectTraceContext() }, opts),
    );
  }
}

export type StageQueues = Record<Stage, StageQueue>;

export function createStageQueues(connection: Redis): StageQueues {
  return Object.fromEntries(STAGES.map((s) => [s, new StageQueue(s, connection)])) as StageQueues;
}

export function createDlqQueues(connection: Redis): Record<Stage, Queue> {
  return Object.fromEntries(
    STAGES.map((s) => [
      s,
      new Queue(dlqName(s), { connection, defaultJobOptions: { removeOnComplete: true } }),
    ]),
  ) as Record<Stage, Queue>;
}
