/**
 * All four stages (classify -> extract -> validate -> match) on real BullMQ + Postgres, with the
 * two model calls mocked at the HTTP layer. Each scenario checks where the invoice ends up and why.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { pino } from "pino";
import { eq } from "drizzle-orm";
import type { Worker } from "bullmq";
import { schema } from "@ledgerline/db";
import { normalizeVendorName } from "@ledgerline/matching";
import {
  createDlqQueues,
  createStageQueues,
  createTokenBucket,
  stageJobId,
} from "@ledgerline/queues";
import type { Storage } from "@ledgerline/storage";
import { createStageWorker } from "../../src/stage-worker.js";
import { createClassifyProcessor } from "../../src/processors/classify.js";
import { createExtractProcessor } from "../../src/processors/extract.js";
import { createValidateProcessor } from "../../src/processors/validate.js";
import { createMatchProcessor } from "../../src/processors/match.js";
import type { WorkerDeps } from "../../src/deps.js";
import {
  TENANT_A,
  freshDatabase,
  freshRedis,
  memoryStorage,
  tinyPdf,
} from "../../../../test/support.js";

const API = "https://anthropic.test";
const msw = setupServer();

let dbh: Awaited<ReturnType<typeof freshDatabase>>;
let deps: WorkerDeps;
let workers: Worker[] = [];
const modelCalls = { haiku: 0, sonnet: 0 };

const reply = (model: string, text: string) =>
  HttpResponse.json({
    id: "msg",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: model.includes("haiku") ? 1500 : 4000,
      output_tokens: model.includes("haiku") ? 8 : 600,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });

/** Script both model calls for the next invoice. */
function scriptModels(kind: string, extraction: Record<string, unknown>) {
  msw.use(
    http.post(`${API}/v1/messages`, async ({ request }) => {
      const body = (await request.json()) as { model: string };
      if (body.model.includes("haiku")) {
        modelCalls.haiku++;
        return reply(body.model, JSON.stringify({ kind }));
      }
      modelCalls.sonnet++;
      return reply(body.model, JSON.stringify(extraction));
    }),
  );
}

// --- master data: one vendor, one PO for 10 x 25.00 with 10 received ------------------------------
const VENDOR = { name: "Northwind Fasteners Ltd", taxId: "GB 123 4567 89" };
const PO_NUMBER = "PO-7001";

const extraction = (over: Record<string, unknown> = {}) => ({
  documentType: "invoice",
  vendor: { name: "NORTHWIND FASTENERS LIMITED", taxId: "GB123456789", address: null },
  invoiceNumber: `NW-${Math.random().toString(36).slice(2, 8)}`,
  invoiceDate: "2026-10-05",
  dueDate: "2026-11-04",
  currency: "GBP",
  poNumber: "po-7001",
  subtotal: "250.00",
  tax: "50.00",
  discount: null,
  total: "300.00",
  lineItems: [
    {
      description: "M8 hex bolt, box of 100",
      sku: "M8-100",
      quantity: "10",
      unitPrice: "25.00",
      amount: "250.00",
    },
  ],
  otherDocumentsInFile: false,
  ...over,
});

beforeAll(async () => {
  msw.listen({ onUnhandledFrame: "error" });
  dbh = await freshDatabase();
  const redis = await freshRedis();
  const db = dbh.db;
  await db.insert(schema.tenants).values({ id: TENANT_A, name: "Tenant A" });
  const [vendor] = await db
    .insert(schema.vendors)
    .values({
      tenantId: TENANT_A,
      name: VENDOR.name,
      normalizedName: normalizeVendorName(VENDOR.name),
      taxId: VENDOR.taxId,
    })
    .returning();
  const [po] = await db
    .insert(schema.purchaseOrders)
    .values({
      tenantId: TENANT_A,
      vendorId: vendor!.id,
      poNumber: PO_NUMBER,
      currency: "GBP",
      issuedAt: new Date("2026-09-20"),
    })
    .returning();
  const [poLine] = await db
    .insert(schema.purchaseOrderLines)
    .values({
      purchaseOrderId: po!.id,
      lineNo: 1,
      sku: "M8-100",
      description: "M8 hex bolt, box of 100",
      quantity: "10",
      unitPrice: "25.00",
    })
    .returning();
  const [gr] = await db
    .insert(schema.goodsReceipts)
    .values({ tenantId: TENANT_A, purchaseOrderId: po!.id, receivedAt: new Date("2026-10-01") })
    .returning();
  await db
    .insert(schema.goodsReceiptLines)
    .values({ goodsReceiptId: gr!.id, purchaseOrderLineId: poLine!.id, quantityReceived: "10" });

  deps = {
    db,
    pool: dbh.pool,
    redis,
    storage: memoryStorage() as unknown as Storage,
    anthropic: new Anthropic({ apiKey: "test", baseURL: API, maxRetries: 0 }),
    queues: createStageQueues(redis),
    dlqs: createDlqQueues(redis),
    tokenBucket: createTokenBucket(redis, "ll:itpm:pipeline", 10_000_000),
    log: pino({ level: "silent" }),
    extractionModel: "claude-sonnet-5-5",
    classifyModel: "claude-haiku-5-5",
    webhookSecret: "whsec",
  };
  workers = [
    createStageWorker("classify", createClassifyProcessor(deps), deps),
    createStageWorker("extract", createExtractProcessor(deps), deps),
    createStageWorker("validate", createValidateProcessor(deps), deps),
    createStageWorker("match", createMatchProcessor(deps), deps),
  ];
});

afterEach(() => {
  msw.resetHandlers();
  modelCalls.haiku = 0;
  modelCalls.sonnet = 0;
});

afterAll(async () => {
  msw.close();
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(
    [...Object.values(deps.queues), ...Object.values(deps.dlqs)].map((q) => q.close()),
  );
  deps.redis.disconnect();
  await dbh?.drop();
});

/** Upload-equivalent: a received invoice with its PDF in storage, enqueued at classify. */
async function submit(tag: string) {
  const pdf = tinyPdf(tag);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const key = `${TENANT_A}/${sha256}.pdf`;
  await deps.storage.putObject(key, pdf);
  const [session] = await dbh.db
    .insert(schema.uploadSessions)
    .values({ tenantId: TENANT_A, expiresAt: new Date(Date.now() + 3_600_000) })
    .returning();
  const [file] = await dbh.db
    .insert(schema.files)
    .values({
      tenantId: TENANT_A,
      uploadSessionId: session!.id,
      clientRef: tag,
      filename: `${tag}.pdf`,
      sizeBytes: pdf.length,
      sha256,
      storageKey: key,
      status: "accepted",
    })
    .returning();
  const [inv] = await dbh.db
    .insert(schema.invoices)
    .values({ tenantId: TENANT_A, fileId: file!.id, status: "received" })
    .returning();
  await deps.queues.classify.add(
    "classify",
    { invoiceId: inv!.id, tenantId: TENANT_A },
    { jobId: stageJobId(inv!.id, "classify") },
  );
  return inv!.id;
}

async function settle(id: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [row] = await dbh.db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    if (row && ["approved", "needs_review", "rejected", "failed"].includes(row.status)) {
      const rules = await dbh.db
        .select()
        .from(schema.validationResults)
        .where(eq(schema.validationResults.invoiceId, id));
      const [match] = await dbh.db
        .select()
        .from(schema.matchResults)
        .where(eq(schema.matchResults.invoiceId, id));
      const events = await dbh.db
        .select()
        .from(schema.outbox)
        .where(eq(schema.outbox.aggregateId, id));
      return {
        row,
        failed: rules
          .filter((r) => !r.passed)
          .map((r) => r.rule)
          .sort(),
        match,
        events: events.map((e) => e.eventType),
      };
    }
    if (Date.now() > deadline) throw new Error(`invoice ${id} stuck at ${row?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("full pipeline", () => {
  it("auto-approves a clean invoice: vendor by tax id, PO + receipt match, one approval event", async () => {
    scriptModels("invoice", extraction());
    const r = await settle(await submit("happy"));
    expect(r.row.status).toBe("approved");
    expect(r.failed).toEqual([]);
    expect(r.match?.outcome).toBe("matched");
    expect(r.row.vendorId).not.toBeNull();
    expect(r.events).toEqual(["invoice.approved"]);
    // Both model calls are billed to the invoice.
    expect(modelCalls).toEqual({ haiku: 1, sonnet: 1 });
    expect(r.row.inputTokens).toBe(1500 + 4000);
  });

  it("routes a statement to review after the cheap call only (no extraction spend)", async () => {
    scriptModels("statement", extraction());
    const r = await settle(await submit("statement"));
    expect(r.row.status).toBe("needs_review");
    expect(r.row.reviewFlags).toEqual(["classified_as_statement"]);
    expect(modelCalls).toEqual({ haiku: 1, sonnet: 0 });
    expect(r.events).toEqual(["invoice.needs_review"]);
  });

  it("price 4% over PO is a mismatch, routed to review with the discrepancy recorded", async () => {
    scriptModels(
      "invoice",
      extraction({
        subtotal: "260.00",
        tax: "52.00",
        total: "312.00",
        lineItems: [
          {
            description: "M8 hex bolt, box of 100",
            sku: "M8-100",
            quantity: "10",
            unitPrice: "26.00",
            amount: "260.00",
          },
        ],
      }),
    );
    const r = await settle(await submit("price-drift"));
    expect(r.row.status).toBe("needs_review");
    expect(r.match?.outcome).toBe("mismatch");
    expect(r.match?.discrepancies).toEqual([
      expect.objectContaining({ kind: "price", withinTolerance: false }),
    ]);
  });

  it("billing more than was received is never auto-approved", async () => {
    scriptModels(
      "invoice",
      extraction({
        subtotal: "300.00",
        tax: "60.00",
        total: "360.00",
        lineItems: [
          {
            description: "M8 hex bolt, box of 100",
            sku: "M8-100",
            quantity: "12",
            unitPrice: "25.00",
            amount: "300.00",
          },
        ],
      }),
    );
    const r = await settle(await submit("over-billed"));
    expect(r.row.status).toBe("needs_review");
    expect(r.match?.discrepancies).toEqual([expect.objectContaining({ kind: "quantity" })]);
  });

  it("a model answer with a manipulated total fails arithmetic and goes to review", async () => {
    // What a successful prompt injection would look like downstream: total set to 0.
    scriptModels("invoice", extraction({ total: "0.00" }));
    const r = await settle(await submit("injected-total"));
    expect(r.row.status).toBe("needs_review");
    expect(r.failed).toContain("subtotal_plus_tax_minus_discount_equals_total");
  });

  it("the same vendor + invoice number arriving as a different PDF is held as a duplicate", async () => {
    const e = extraction({ invoiceNumber: "NW-DUP-1" });
    scriptModels("invoice", e);
    const first = await settle(await submit("dup-a"));
    expect(first.row.status).toBe("approved");
    const second = await settle(await submit("dup-b"));
    expect(second.row.status).toBe("needs_review");
    expect(second.failed).toEqual(["not_duplicate"]);
  });

  it("two invoices in one file are flagged rather than half-paid", async () => {
    scriptModels("invoice", extraction({ otherDocumentsInFile: true }));
    const r = await settle(await submit("two-in-one"));
    expect(r.row.status).toBe("needs_review");
    expect(r.row.reviewFlags).toEqual(["multiple_documents_in_file"]);
    expect(r.failed).toEqual(["no_review_flags"]);
  });

  it("an unknown vendor blocks auto-approval even when everything else is clean", async () => {
    scriptModels(
      "invoice",
      extraction({
        vendor: { name: "Totally Different Supplies", taxId: null, address: null },
        poNumber: null,
      }),
    );
    const r = await settle(await submit("unknown-vendor"));
    expect(r.row.status).toBe("needs_review");
    // No marker printed, no PO, no vendor: nothing but the model's guess says it is GBP.
    expect(r.failed).toEqual(["currency_determined", "vendor_resolved"]);
    expect(r.match?.outcome).toBe("no_po");
  });

  describe("currency: the model reads the marker, code decides", () => {
    async function vendorWith(name: string, defaultCurrency: string | null) {
      await dbh.db.insert(schema.vendors).values({
        tenantId: TENANT_A,
        name,
        normalizedName: normalizeVendorName(name),
        defaultCurrency,
      });
      return { name, taxId: null, address: null };
    }
    const detail = async (id: string, rule: string) =>
      (
        await dbh.db
          .select()
          .from(schema.validationResults)
          .where(eq(schema.validationResults.invoiceId, id))
      ).find((r) => r.rule === rule);

    it("a bare $ is settled by the vendor's billing currency, not the model's guess", async () => {
      const vendor = await vendorWith("Kookaburra Supplies Pty Ltd", "AUD");
      scriptModels(
        "invoice",
        extraction({ vendor, currency: "USD", currencyAsPrinted: "$", poNumber: null }),
      );
      const id = await submit("aud-bare-dollar");
      const r = await settle(id);
      expect(r.row.currency).toBe("AUD");
      expect(r.failed).toEqual([]);
      expect((await detail(id, "currency_determined"))?.detail).toBe(
        'AUD from vendor_default (printed "$")',
      );
      // No PO, so still a human, but for the right reason.
      expect(r.match?.outcome).toBe("no_po");
    });

    it("a bare $ with nothing to settle it keeps the invoice out of auto-approval", async () => {
      scriptModels(
        "invoice",
        extraction({
          vendor: { name: "Unlisted Trading Co", taxId: null, address: null },
          currency: "USD",
          currencyAsPrinted: "$",
          poNumber: null,
        }),
      );
      const r = await settle(await submit("bare-dollar-unknown"));
      expect(r.row.status).toBe("needs_review");
      expect(r.failed).toEqual(["currency_determined", "vendor_resolved"]);
    });

    it("a printed ISO code beats the model's normalization and the invoice still approves", async () => {
      scriptModels("invoice", extraction({ currency: "USD", currencyAsPrinted: "GBP" }));
      const r = await settle(await submit("printed-code"));
      expect(r.row.currency).toBe("GBP");
      expect(r.row.status).toBe("approved");
    });

    it("re-derives minor units when the resolved currency has a different exponent", async () => {
      // ¥ read as JPY (exponent 0) by the model; the vendor bills in CNY (exponent 2).
      const vendor = await vendorWith("Shenzhen Precision Parts Co", "CNY");
      scriptModels(
        "invoice",
        extraction({ vendor, currency: "JPY", currencyAsPrinted: "¥", poNumber: null }),
      );
      const r = await settle(await submit("yen-or-yuan"));
      expect(r.row.currency).toBe("CNY");
      expect(r.row.totalMinor).toBe(30_000);
      expect(r.row.subtotalMinor).toBe(25_000);
      expect(r.failed).toEqual([]);
    });
  });

  it("credit notes always get a human", async () => {
    scriptModels("credit_note", extraction({ documentType: "credit_note" }));
    const r = await settle(await submit("credit"));
    expect(r.row.status).toBe("needs_review");
    expect(r.failed).toEqual([]);
  });
});
