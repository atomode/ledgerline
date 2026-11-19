import type { Queue } from "bullmq";
import type { Db } from "@ledgerline/db";
import type { AdmissionDecision, Stage, StageJobData } from "@ledgerline/queues";
import type { Authenticate } from "./auth.js";
import type { Check } from "./readiness.js";
import type { UploadService } from "./services/uploads.js";
import type { InvoiceService } from "./services/invoices.js";

export interface ApiDeps {
  readinessChecks: Record<string, Check>;
  authenticate: Authenticate;
  /** Backpressure gate for new uploads (extract queue depth and age). */
  admission: () => Promise<AdmissionDecision>;
  db: Db;
  queues: Record<Stage, Queue<StageJobData>>;
  dlqs: Record<Stage, Queue>;
  cursorSecret: string;
  uploads: UploadService;
  invoices: InvoiceService;
  logLevel?: string;
}
