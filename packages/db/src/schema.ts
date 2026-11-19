import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

// ---------------------------------------------------------------------------------------------
// Conventions
// - uuid v7 primary keys: time-ordered, so B-tree inserts stay append-mostly and ids sort by age.
// - every tenant-owned row carries tenant_id; every query filters on it.
// - money from documents is numeric(18,4) in v1; migration 0002 expands to *_minor bigint.
// ---------------------------------------------------------------------------------------------

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id);

const decimal = (name: string) => numeric(name, { precision: 18, scale: 4 });

// --- enums ------------------------------------------------------------------------------------

export const invoiceStatus = pgEnum("invoice_status", [
  "received",
  "classified",
  "extracted",
  "needs_review",
  "approved",
  "rejected",
  "failed",
]);
export const documentType = pgEnum("document_type", ["invoice", "credit_note"]);
export const fileStatus = pgEnum("file_status", ["pending", "accepted", "duplicate", "rejected"]);
export const poStatus = pgEnum("po_status", ["open", "closed", "cancelled"]);
export const matchOutcome = pgEnum("match_outcome", [
  "matched",
  "within_tolerance",
  "mismatch",
  "no_po",
  "no_receipt",
]);
export const reviewActionType = pgEnum("review_action_type", ["approve", "reject", "correct"]);

// --- tenancy ----------------------------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  /** Where invoice lifecycle events are POSTed. Null = events are recorded but not delivered. */
  webhookUrl: text("webhook_url"),
  ...timestamps,
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    tenantId: tenantId(),
    /** sha256 of the full key; the plaintext is shown once and never stored. */
    keyHash: char("key_hash", { length: 64 }).notNull(),
    prefix: text("prefix").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("api_keys_key_hash_uq").on(t.keyHash)],
);

// --- master data: vendors, purchase orders, goods receipts --------------------------------------

export const vendors = pgTable(
  "vendors",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    /** lowercased, punctuation and legal suffixes (Ltd, Inc, GmbH) stripped; used for fuzzy match */
    normalizedName: text("normalized_name").notNull(),
    taxId: text("tax_id"),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("vendors_tenant_normalized_name_uq").on(t.tenantId, t.normalizedName),
    index("vendors_normalized_name_trgm_idx").using("gin", sql`${t.normalizedName} gin_trgm_ops`),
    index("vendors_tenant_tax_id_idx").on(t.tenantId, t.taxId),
  ],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    tenantId: tenantId(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    poNumber: text("po_number").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: poStatus("status").notNull().default("open"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("purchase_orders_tenant_po_number_uq").on(t.tenantId, t.poNumber)],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: id(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNo: smallint("line_no").notNull(),
    sku: text("sku"),
    description: text("description").notNull(),
    quantity: decimal("quantity").notNull(),
    unitPrice: decimal("unit_price").notNull(),
  },
  (t) => [uniqueIndex("purchase_order_lines_po_line_uq").on(t.purchaseOrderId, t.lineNo)],
);

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: id(),
    tenantId: tenantId(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("goods_receipts_po_idx").on(t.purchaseOrderId)],
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    id: id(),
    goodsReceiptId: uuid("goods_receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    purchaseOrderLineId: uuid("purchase_order_line_id")
      .notNull()
      .references(() => purchaseOrderLines.id),
    quantityReceived: decimal("quantity_received").notNull(),
  },
  (t) => [index("goods_receipt_lines_po_line_idx").on(t.purchaseOrderLineId)],
);

// --- ingestion ----------------------------------------------------------------------------------

export const uploadSessions = pgTable("upload_sessions", {
  id: id(),
  tenantId: tenantId(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
});

export const files = pgTable(
  "files",
  {
    id: id(),
    tenantId: tenantId(),
    uploadSessionId: uuid("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id),
    clientRef: text("client_ref").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    storageKey: text("storage_key").notNull(),
    status: fileStatus("status").notNull().default("pending"),
    /** not_uploaded | checksum_mismatch | too_large | not_pdf; set when status = rejected */
    rejectionReason: text("rejection_reason"),
    ...timestamps,
  },
  (t) => [
    // Content dedupe. Partial so the same PDF can sit in several *pending* sessions; the second
    // one to complete hits this index and is reported as `duplicate` instead of re-extracted.
    uniqueIndex("files_tenant_sha256_accepted_uq")
      .on(t.tenantId, t.sha256)
      .where(sql`${t.status} = 'accepted'`),
    index("files_session_idx").on(t.uploadSessionId),
  ],
);

// --- invoices -------------------------------------------------------------------------------------

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    tenantId: tenantId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id),
    status: invoiceStatus("status").notNull().default("received"),
    documentType: documentType("document_type"),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    vendorNameRaw: text("vendor_name_raw"),
    /** Supplier tax id as extracted; the strongest key for vendor resolution. */
    vendorTaxIdRaw: text("vendor_tax_id_raw"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    currency: char("currency", { length: 3 }),
    poNumber: text("po_number"),
    subtotal: decimal("subtotal"),
    tax: decimal("tax"),
    discount: decimal("discount"),
    /** v1 total as printed. Being replaced by total_minor (migration 0002, expand/contract). */
    amount: decimal("amount"),
    // --- migration 0002 (expand): integer minor units. Nullable until the backfill finishes;
    // writers dual-write both representations until the contract migration drops the numerics.
    subtotalMinor: bigint("subtotal_minor", { mode: "number" }),
    taxMinor: bigint("tax_minor", { mode: "number" }),
    discountMinor: bigint("discount_minor", { mode: "number" }),
    totalMinor: bigint("total_minor", { mode: "number" }),
    missingFields: text("missing_fields")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * Conditions that force human review even when every check passes, e.g.
     * classified_as_statement, multiple_documents_in_file. Codes, never document text.
     */
    reviewFlags: text("review_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    extractionSchemaVersion: smallint("extraction_schema_version"),
    promptVersion: text("prompt_version"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    /** optimistic concurrency; exposed as the ETag */
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invoices_file_uq").on(t.fileId),
    // Keyset pagination: WHERE tenant_id = $1 AND (received_at, id) < ($2, $3)
    //                    ORDER BY received_at DESC, id DESC
    // Ascending on purpose: Postgres uses the row comparison as an index condition only when the
    // column directions agree, and walks the index backward to serve ORDER BY ... DESC.
    index("invoices_tenant_received_keyset_idx").on(t.tenantId, t.receivedAt, t.id),
    index("invoices_tenant_status_idx").on(t.tenantId, t.status),
    // Lets the backfill find remaining rows cheaply and shrinks to nothing once it is done.
    index("invoices_minor_backfill_idx")
      .on(t.id)
      .where(sql`${t.totalMinor} IS NULL AND ${t.amount} IS NOT NULL`),
    // Duplicate-payment guard: same vendor + invoice number arriving as a different PDF.
    index("invoices_tenant_vendor_number_idx").on(t.tenantId, t.vendorId, t.invoiceNumber),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    lineNo: smallint("line_no").notNull(),
    description: text("description").notNull(),
    sku: text("sku"),
    quantity: decimal("quantity").notNull(),
    unitPrice: decimal("unit_price").notNull(),
    amount: decimal("amount").notNull(),
  },
  (t) => [uniqueIndex("invoice_lines_invoice_line_uq").on(t.invoiceId, t.lineNo)],
);

export const validationResults = pgTable(
  "validation_results",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    passed: boolean("passed").notNull(),
    detail: text("detail"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("validation_results_invoice_idx").on(t.invoiceId)],
);

export const matchResults = pgTable(
  "match_results",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    outcome: matchOutcome("outcome").notNull(),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id),
    discrepancies: jsonb("discrepancies")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("match_results_invoice_uq").on(t.invoiceId)],
);

/** Append-only audit trail of human decisions. */
export const reviewActions = pgTable(
  "review_actions",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    action: reviewActionType("action").notNull(),
    actor: text("actor").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("review_actions_invoice_idx").on(t.invoiceId)],
);

// --- reliability plumbing --------------------------------------------------------------------------

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    tenantId: tenantId(),
    key: text("key").notNull(),
    /** sha256 of method + path + body; same key with a different hash is a 422 */
    requestHash: char("request_hash", { length: 64 }).notNull(),
    statusCode: smallint("status_code"),
    responseBody: jsonb("response_body"),
    createdAt: timestamps.createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.key] }),
    index("idempotency_keys_expires_idx").on(t.expiresAt),
  ],
);

/** Transactional outbox: written in the same transaction as the state change it announces. */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    tenantId: tenantId(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    attempts: smallint("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deliveryFailedAt: timestamp("delivery_failed_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    // The publisher only ever scans undelivered rows; keep that index tiny.
    index("outbox_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.publishedAt} IS NULL AND ${t.deliveryFailedAt} IS NULL`),
  ],
);

export const jobFailures = pgTable(
  "job_failures",
  {
    id: id(),
    queue: text("queue").notNull(),
    jobId: text("job_id").notNull(),
    payload: jsonb("payload").notNull(),
    errorChain: jsonb("error_chain").notNull(),
    attemptsMade: smallint("attempts_made").notNull(),
    failedAt: timestamp("failed_at", { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
  },
  (t) => [
    index("job_failures_queue_failed_idx").on(t.queue, t.failedAt.desc()),
    uniqueIndex("job_failures_queue_job_uq").on(t.queue, t.jobId),
  ],
);
