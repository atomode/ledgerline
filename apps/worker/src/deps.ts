import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import type { Redis } from "ioredis";
import type { Db } from "@ledgerline/db";
import type { Pool } from "pg";
import type { StageQueues, TokenBucket } from "@ledgerline/queues";
import type { Storage } from "@ledgerline/storage";
import type { Queue } from "bullmq";
import type { Stage } from "@ledgerline/queues";

export interface WorkerDeps {
  db: Db;
  /** Raw pool for SKIP LOCKED batches that need an explicit client-held transaction. */
  pool: Pool;
  redis: Redis;
  storage: Storage;
  anthropic: Anthropic;
  queues: StageQueues;
  dlqs: Record<Stage, Queue>;
  tokenBucket: TokenBucket;
  log: Logger;
  extractionModel: string;
  classifyModel: string;
  webhookSecret: string;
  fetch?: typeof fetch;
}
