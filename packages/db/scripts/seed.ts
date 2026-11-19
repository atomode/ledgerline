/**
 * Deterministic development seed. Running it twice produces byte-identical rows:
 * fixed Faker seed, fixed reference clock, explicit ids and timestamps everywhere.
 *
 * Invoices are inserted in the v1 shape (numeric money, *_minor NULL) on purpose, so
 * `pnpm db:backfill:money` has realistic work to do.
 *
 * Usage: pnpm db:seed
 */
import { createHash } from "node:crypto";
import { faker } from "@faker-js/faker";
import { sql } from "drizzle-orm";
import { loadEnv } from "@ledgerline/config";
import { normalizeVendorName } from "@ledgerline/matching";
import { createDb, schema } from "../src/index.js";

faker.seed(20261118);
const REF = new Date("2026-11-01T00:00:00Z").getTime();
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(REF - daysAgo * DAY);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const uuid = () => faker.string.uuid();
const pick = <T>(xs: readonly T[]) => faker.helpers.arrayElement(xs);
const money = (n: number) => n.toFixed(2);

const env = loadEnv();
if (env.NODE_ENV === "production") throw new Error("refusing to seed a production database");
const { db, close } = createDb(env.DATABASE_URL);

const CURRENCIES = ["USD", "USD", "USD", "USD", "EUR", "GBP", "JPY"] as const;
const PRODUCTS = [
  "Printer paper A4 (box)",
  "Nitrile gloves (100)",
  "USB-C dock",
  "Office chair",
  "Laptop stand",
  "Hazmat disposal service",
  "Pallet wrap 500mm",
  "Safety glasses",
  "Cloud hosting (monthly)",
  "Forklift maintenance",
  "Label printer ribbon",
  "Coffee beans 1kg",
];

// --- tenants + API keys --------------------------------------------------------------------
const tenantRows = ["Northwind Traders", "Globex Manufacturing"].map((name, i) => ({
  id: uuid(),
  name,
  createdAt: at(400 - i),
  updatedAt: at(400 - i),
}));
const apiKeyPlaintext = tenantRows.map((t, i) => `ll_dev_${i}_${faker.string.alphanumeric(32)}`);
const apiKeyRows = tenantRows.map((t, i) => ({
  id: uuid(),
  tenantId: t.id,
  keyHash: createHash("sha256")
    .update(apiKeyPlaintext[i] ?? "")
    .digest("hex"),
  prefix: (apiKeyPlaintext[i] ?? "").slice(0, 12),
  createdAt: at(399),
  updatedAt: at(399),
}));

// --- vendors (20 per tenant) ---------------------------------------------------------------
type Vendor = typeof schema.vendors.$inferInsert & { id: string; tenantId: string };
const vendorRows: Vendor[] = [];
for (const t of tenantRows) {
  const seen = new Set<string>();
  while (vendorRows.filter((v) => v.tenantId === t.id).length < 20) {
    const name = `${faker.company.name()} ${pick(["Ltd", "Inc.", "LLC", "GmbH", "Co."])}`;
    const normalizedName = normalizeVendorName(name);
    if (seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    vendorRows.push({
      id: uuid(),
      tenantId: t.id,
      name,
      normalizedName,
      taxId:
        faker.helpers.maybe(() => faker.string.alphanumeric({ length: 10, casing: "upper" }), {
          probability: 0.7,
        }) ?? null,
      aliases: faker.helpers.maybe(() => [name.toUpperCase()], { probability: 0.3 }) ?? [],
      createdAt: at(380),
      updatedAt: at(380),
    });
  }
}

// --- purchase orders, lines, goods receipts --------------------------------------------------
type Po = typeof schema.purchaseOrders.$inferInsert & {
  id: string;
  tenantId: string;
  currency: string;
};
type PoLine = typeof schema.purchaseOrderLines.$inferInsert & {
  id: string;
  quantity: string;
  unitPrice: string;
};
const poRows: Po[] = [];
const poLineRows: PoLine[] = [];
const grRows: (typeof schema.goodsReceipts.$inferInsert)[] = [];
const grLineRows: (typeof schema.goodsReceiptLines.$inferInsert)[] = [];
const receivedQty = new Map<string, number>(); // po line id -> qty received

for (let i = 0; i < 300; i++) {
  const tenant = tenantRows[i % 2]!;
  const vendor = pick(vendorRows.filter((v) => v.tenantId === tenant.id));
  const currency = pick(CURRENCIES);
  const issued = at(faker.number.int({ min: 20, max: 360 }));
  const po: Po = {
    id: uuid(),
    tenantId: tenant.id,
    vendorId: vendor.id,
    poNumber: `PO-${String(10000 + i)}`,
    currency,
    status: pick(["open", "open", "open", "closed"] as const),
    issuedAt: issued,
    createdAt: issued,
    updatedAt: issued,
  };
  poRows.push(po);
  // A vendor bills in the currency of its first PO. Set here, not drawn, so the seed sequence is unchanged.
  vendor.defaultCurrency ??= currency;

  const nLines = faker.number.int({ min: 1, max: 6 });
  const lines: PoLine[] = [];
  for (let l = 1; l <= nLines; l++) {
    const unit =
      currency === "JPY"
        ? faker.number.int({ min: 300, max: 90000 })
        : faker.number.float({ min: 2, max: 900, fractionDigits: 2 });
    lines.push({
      id: uuid(),
      purchaseOrderId: po.id,
      lineNo: l,
      sku: `SKU-${faker.string.alphanumeric({ length: 6, casing: "upper" })}`,
      description: pick(PRODUCTS),
      quantity: String(faker.number.int({ min: 1, max: 50 })),
      unitPrice: currency === "JPY" ? String(unit) : money(unit),
    });
  }
  poLineRows.push(...lines);

  // 80% of POs have a goods receipt; a quarter of those are partial deliveries.
  if (faker.datatype.boolean({ probability: 0.8 })) {
    const partial = faker.datatype.boolean({ probability: 0.25 });
    const gr = {
      id: uuid(),
      tenantId: tenant.id,
      purchaseOrderId: po.id,
      receivedAt: new Date(issued.getTime() + 7 * DAY),
    };
    grRows.push({ ...gr, createdAt: gr.receivedAt, updatedAt: gr.receivedAt });
    for (const line of lines) {
      const ordered = Number(line.quantity);
      const qty = partial && ordered > 1 ? faker.number.int({ min: 1, max: ordered - 1 }) : ordered;
      receivedQty.set(line.id, qty);
      grLineRows.push({
        id: uuid(),
        goodsReceiptId: gr.id,
        purchaseOrderLineId: line.id,
        quantityReceived: String(qty),
      });
    }
  }
}

// --- upload sessions, files, invoices ------------------------------------------------------
const STATUS_MIX = [
  ...Array(50).fill("approved"),
  ...Array(20).fill("needs_review"),
  ...Array(10).fill("extracted"),
  ...Array(5).fill("rejected"),
  ...Array(5).fill("received"),
  ...Array(5).fill("classified"),
  ...Array(5).fill("failed"),
] as (typeof schema.invoiceStatus.enumValues)[number][];

const sessionRows: (typeof schema.uploadSessions.$inferInsert)[] = [];
const fileRows: (typeof schema.files.$inferInsert)[] = [];
const invoiceRows: (typeof schema.invoices.$inferInsert)[] = [];
const invoiceLineRows: (typeof schema.invoiceLines.$inferInsert)[] = [];
const validationRows: (typeof schema.validationResults.$inferInsert)[] = [];
const matchRows: (typeof schema.matchResults.$inferInsert)[] = [];

for (let i = 0; i < 500; i++) {
  const tenant = tenantRows[i % 2]!;
  const receivedAt = at(180 - Math.floor(i / 3) + faker.number.float({ min: 0, max: 0.99 }));
  if (i % 25 < 2) {
    // one session per 25 invoices per tenant
    sessionRows.push({
      id: uuid(),
      tenantId: tenant.id,
      expiresAt: new Date(receivedAt.getTime() + DAY),
      completedAt: receivedAt,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    });
  }
  const session = sessionRows.filter((s) => s.tenantId === tenant.id).at(-1)!;
  const sha256 = createHash("sha256").update(`seed-invoice-${i}`).digest("hex");
  const file = {
    id: uuid(),
    tenantId: tenant.id,
    uploadSessionId: session.id!,
    clientRef: `scan-${i}`,
    filename: `invoice-${i}.pdf`,
    sizeBytes: faker.number.int({ min: 30_000, max: 900_000 }),
    sha256,
    storageKey: `${tenant.id}/${sha256}.pdf`,
    status: "accepted" as const,
    createdAt: receivedAt,
    updatedAt: receivedAt,
  };
  fileRows.push(file);

  const status = pick(STATUS_MIX);
  const base = {
    id: uuid(),
    tenantId: tenant.id,
    fileId: file.id,
    status,
    receivedAt,
    createdAt: receivedAt,
    updatedAt: receivedAt,
  };
  if (status === "received" || status === "failed") {
    invoiceRows.push(base);
    continue;
  }
  if (status === "classified") {
    invoiceRows.push({ ...base, documentType: "invoice" });
    continue;
  }

  // Extracted (or later): most reference a PO; 10% have none; 5% are credit notes.
  const tenantPos = poRows.filter((p) => p.tenantId === tenant.id);
  const po = faker.datatype.boolean({ probability: 0.9 }) ? pick(tenantPos) : null;
  const vendor = po
    ? vendorRows.find((v) => v.id === po.vendorId)!
    : pick(vendorRows.filter((v) => v.tenantId === tenant.id));
  const currency = po?.currency ?? "USD";
  const credit = faker.datatype.boolean({ probability: 0.05 });
  const sign = credit ? -1 : 1;
  const sourceLines = po ? poLineRows.filter((l) => l.purchaseOrderId === po.id) : [];
  const lines = (sourceLines.length ? sourceLines : [null]).map((pl, idx) => {
    const qty = pl
      ? (receivedQty.get(pl.id) ?? Number(pl.quantity))
      : faker.number.int({ min: 1, max: 10 });
    // needs_review invoices get a price variance outside tolerance on the first line
    const drift = status === "needs_review" && idx === 0 ? 1.05 : 1;
    const unit = pl
      ? Number(pl.unitPrice) * drift
      : faker.number.float({ min: 5, max: 400, fractionDigits: 2 });
    const fmt = (n: number) => (currency === "JPY" ? String(Math.round(n)) : money(n));
    return {
      id: uuid(),
      lineNo: idx + 1,
      description: pl?.description ?? pick(PRODUCTS),
      sku: pl?.sku ?? null,
      quantity: String(qty),
      unitPrice: fmt(unit),
      amount: fmt(sign * qty * Number(fmt(unit))),
    };
  });
  const subtotal = lines.reduce((s, l) => s + Number(l.amount), 0);
  const taxRate = pick([0, 0.05, 0.08, 0.2]);
  const fmt = (n: number) => (currency === "JPY" ? String(Math.round(n)) : money(n));
  const tax = Number(fmt(subtotal * taxRate));
  const invoiceDate = new Date(receivedAt.getTime() - faker.number.int({ min: 1, max: 10 }) * DAY);
  const inputTokens = faker.number.int({ min: 3500, max: 14000 });
  const outputTokens = faker.number.int({ min: 400, max: 1600 });

  invoiceRows.push({
    ...base,
    documentType: credit ? "credit_note" : "invoice",
    vendorId: vendor.id,
    vendorNameRaw: vendor.name,
    invoiceNumber: `${credit ? "CN" : "INV"}-${faker.string.numeric(6)}`,
    invoiceDate: isoDate(invoiceDate),
    dueDate: credit ? null : isoDate(new Date(invoiceDate.getTime() + 30 * DAY)),
    currency,
    poNumber: po?.poNumber ?? null,
    subtotal: fmt(subtotal),
    tax: fmt(tax),
    discount: null,
    amount: fmt(subtotal + tax),
    extractionSchemaVersion: 1,
    promptVersion: "seed-v1",
    model: "claude-sonnet-5-5",
    inputTokens,
    outputTokens,
    // $2/M input, $10/M output -> micros
    costMicros: inputTokens * 2 + outputTokens * 10,
    extractedAt: new Date(receivedAt.getTime() + faker.number.int({ min: 4000, max: 30000 })),
  });
  for (const l of lines) invoiceLineRows.push({ ...l, invoiceId: base.id });
  validationRows.push(
    {
      id: uuid(),
      invoiceId: base.id,
      rule: "lines_sum_to_subtotal",
      passed: true,
      detail: null,
      createdAt: receivedAt,
    },
    {
      id: uuid(),
      invoiceId: base.id,
      rule: "subtotal_plus_tax_equals_total",
      passed: true,
      detail: null,
      createdAt: receivedAt,
    },
  );
  matchRows.push({
    id: uuid(),
    invoiceId: base.id,
    purchaseOrderId: po?.id ?? null,
    outcome: !po ? "no_po" : status === "needs_review" ? "mismatch" : "matched",
    discrepancies:
      status === "needs_review" && po
        ? [
            {
              kind: "price",
              lineRef: "1",
              expected: sourceLines[0]?.unitPrice ?? null,
              actual: lines[0]?.unitPrice ?? null,
            },
          ]
        : [],
    createdAt: receivedAt,
  });
}

// --- write -----------------------------------------------------------------------------------
const chunks = <T>(xs: T[], n = 500) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

await db.transaction(async (tx) => {
  await tx.execute(sql`TRUNCATE tenants, api_keys, vendors, purchase_orders, purchase_order_lines,
    goods_receipts, goods_receipt_lines, upload_sessions, files, invoices, invoice_lines,
    validation_results, match_results, review_actions, idempotency_keys, outbox, job_failures CASCADE`);
  const ins = async <T extends object>(table: Parameters<typeof tx.insert>[0], rows: T[]) => {
    for (const c of chunks(rows)) if (c.length) await tx.insert(table).values(c as never);
  };
  await ins(schema.tenants, tenantRows);
  await ins(schema.apiKeys, apiKeyRows);
  await ins(schema.vendors, vendorRows);
  await ins(schema.purchaseOrders, poRows);
  await ins(schema.purchaseOrderLines, poLineRows);
  await ins(schema.goodsReceipts, grRows);
  await ins(schema.goodsReceiptLines, grLineRows);
  await ins(schema.uploadSessions, sessionRows);
  await ins(schema.files, fileRows);
  await ins(schema.invoices, invoiceRows);
  await ins(schema.invoiceLines, invoiceLineRows);
  await ins(schema.validationResults, validationRows);
  await ins(schema.matchResults, matchRows);
});
await close();

console.log(
  JSON.stringify({
    tenants: tenantRows.length,
    vendors: vendorRows.length,
    purchaseOrders: poRows.length,
    goodsReceipts: grRows.length,
    invoices: invoiceRows.length,
    invoiceLines: invoiceLineRows.length,
  }),
);
console.log("Dev API keys (shown once):");
tenantRows.forEach((t, i) => console.log(`  ${t.name}: ${apiKeyPlaintext[i]}`));
