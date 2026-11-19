/**
 * Worker metrics. Instruments are created on first use, after `--import .../register` has set the
 * global MeterProvider; in tests they are no-ops.
 */
import type { Queue } from "bullmq";
import { meter } from "@ledgerline/observability";
import { STAGES, type Stage } from "@ledgerline/queues";

let m: ReturnType<typeof create> | undefined;
function create() {
  const mt = meter();
  return {
    jobDuration: mt.createHistogram("ledgerline.job.duration", {
      unit: "s",
      description: "Stage processor wall time, by stage and outcome",
    }),
    retries: mt.createCounter("ledgerline.job.retries", {
      description: "Failed attempts that will be retried, by stage and error class",
    }),
    deadLettered: mt.createCounter("ledgerline.job.dead_lettered", {
      description: "Jobs moved to a DLQ, by stage",
    }),
    cost: mt.createCounter("ledgerline.model.cost", {
      unit: "{usd_micros}",
      description: "Model spend in USD micros, by tenant, stage and model",
    }),
    decisions: mt.createCounter("ledgerline.invoice.decisions", {
      description: "Final pipeline decisions; auto-approve ratio = approved / all",
    }),
    e2e: mt.createHistogram("ledgerline.invoice.pipeline_duration", {
      unit: "s",
      description: "Upload accepted to final decision",
    }),
  };
}
export const workerMetrics = () => (m ??= create());

/**
 * Queue depth, oldest-job age and DLQ size as observable gauges, read at collection time. Every
 * worker replica reports the same values, so dashboards aggregate with max(), not sum().
 */
export function observeQueues(queues: Record<Stage, Queue>, dlqs: Record<Stage, Queue>) {
  const mt = meter();
  const depth = mt.createObservableGauge("ledgerline.queue.depth", {
    description: "Jobs by queue and state",
  });
  const age = mt.createObservableGauge("ledgerline.queue.oldest_age", {
    unit: "s",
    description: "Age of the oldest waiting job",
  });
  const dlq = mt.createObservableGauge("ledgerline.dlq.size", {
    description: "Jobs parked in each DLQ",
  });
  mt.addBatchObservableCallback(
    async (obs) => {
      await Promise.all(
        STAGES.map(async (stage) => {
          const q = queues[stage];
          const counts = await q.getJobCounts("waiting", "active", "delayed", "prioritized");
          for (const [state, n] of Object.entries(counts))
            obs.observe(depth, n, { queue: q.name, state });
          const [oldest] = await q.getJobs(["wait"], 0, 0, true);
          obs.observe(age, oldest ? (Date.now() - oldest.timestamp) / 1000 : 0, { queue: q.name });
          obs.observe(dlq, await dlqs[stage].count(), { queue: dlqs[stage].name });
        }),
      );
    },
    [depth, age, dlq],
  );
}
