/**
 * Renders 20 seeded invoices to PDF through 3 layouts, writing ground truth next to each PDF:
 *   evals/golden/synthetic/<id>.pdf
 *   evals/golden/synthetic/<id>.json   { labels: InvoiceExtraction, tags: {...} }
 *
 * The PDF shows money and dates the way real suppliers print them (locale formats, symbols,
 * "VAT" vs "Tax"), while the labels are the normalized form the model must produce. That gap is
 * exactly what the extraction eval measures. Labels are free because the data came first.
 *
 * Deterministic: same seed DB -> same selection, same files. Usage: pnpm --filter @ledgerline/evals golden:render-seed
 */
import { mkdir, writeFile } from "node:fs/promises";
import { asc, inArray, isNotNull, and, eq } from "drizzle-orm";
import { chromium } from "playwright";
import { InvoiceExtraction } from "@ledgerline/contracts";
import { loadEnv } from "@ledgerline/config";
import { createDb, schema } from "@ledgerline/db";

const COUNT = 20;
const OUT = new URL("../golden/synthetic/", import.meta.url);

type Layout = "classic" | "minimal" | "eu";
const LAYOUTS: Layout[] = ["classic", "minimal", "eu"];

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

function fmtMoney(dec: string, currency: string, layout: Layout): string {
  const n = Number(dec);
  if (layout === "eu") {
    // 1.234,56 € style
    return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(n);
  }
  if (layout === "minimal") {
    return `${currency} ${new Intl.NumberFormat("en-US", { minimumFractionDigits: currency === "JPY" ? 0 : 2 }).format(n)}`;
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

function fmtDate(iso: string, layout: Layout): string {
  const [y, m, d] = iso.split("-");
  if (layout === "eu") return `${d}.${m}.${y}`;
  if (layout === "minimal")
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  return `${m}/${d}/${y}`;
}

function render(inv: InvoiceExtraction, layout: Layout): string {
  const money = (v: string) => esc(fmtMoney(v, inv.currency, layout));
  const date = (v: string) => esc(fmtDate(v, layout));
  const title =
    inv.documentType === "credit_note"
      ? "CREDIT NOTE"
      : layout === "eu"
        ? "RECHNUNG / INVOICE"
        : "INVOICE";
  const taxLabel = layout === "eu" ? "MwSt. / VAT" : layout === "minimal" ? "Sales tax" : "Tax";
  const rows = inv.lineItems
    .map(
      (l) =>
        `<tr><td>${esc(l.sku ?? "")}</td><td>${esc(l.description)}</td><td class="r">${esc(l.quantity)}</td><td class="r">${money(l.unitPrice)}</td><td class="r">${money(l.amount)}</td></tr>`,
    )
    .join("");
  const css = {
    classic: `body{font-family:Georgia,serif;margin:48px;color:#111} h1{letter-spacing:4px;border-bottom:3px double #000} table{width:100%;border-collapse:collapse} th,td{border:1px solid #444;padding:6px} th{background:#eee}`,
    minimal: `body{font-family:Helvetica,Arial,sans-serif;margin:56px;color:#222} h1{font-weight:300;font-size:40px;color:#2a6} table{width:100%;border-collapse:collapse} th{text-align:left;border-bottom:2px solid #2a6;padding:8px 4px} td{padding:8px 4px;border-bottom:1px solid #ddd}`,
    eu: `body{font-family:"DejaVu Sans",sans-serif;margin:40px;font-size:12px} h1{font-size:18px;background:#123;color:#fff;padding:8px} table{width:100%;border-collapse:collapse} th,td{padding:4px;border-bottom:1px dotted #999}`,
  }[layout];
  const meta = [
    [layout === "eu" ? "Rechnungsnr. / Invoice no." : "Invoice #", esc(inv.invoiceNumber)],
    [layout === "eu" ? "Datum / Date" : "Invoice date", date(inv.invoiceDate)],
    ...(inv.dueDate ? [[layout === "eu" ? "Fällig / Due" : "Due date", date(inv.dueDate)]] : []),
    ...(inv.poNumber
      ? [[layout === "minimal" ? "Your reference" : "PO number", esc(inv.poNumber)]]
      : []),
  ]
    .map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css} .r{text-align:right} .totals{margin-left:auto;width:45%;margin-top:16px} .totals td{border:none}</style></head><body>
    <h1>${title}</h1>
    <div style="display:flex;justify-content:space-between;margin-bottom:24px">
      <div><b>${esc(inv.vendor.name)}</b><br>${esc(inv.vendor.address ?? "")}${inv.vendor.taxId ? `<br>Tax ID: ${esc(inv.vendor.taxId)}` : ""}</div>
      <div>${meta}</div>
    </div>
    <table><thead><tr><th>SKU</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="totals">
      <tr><td>Subtotal</td><td class="r">${money(inv.subtotal)}</td></tr>
      <tr><td>${taxLabel}</td><td class="r">${money(inv.tax)}</td></tr>
      <tr><td><b>Total</b></td><td class="r"><b>${money(inv.total)}</b></td></tr>
    </table>
    <p style="margin-top:40px;font-size:11px;color:#666">Payment terms: net 30. Please quote the invoice number on remittance.</p>
  </body></html>`;
}

/** "4.0000" -> "4", "2.5000" -> "2.5", "100" -> "100" */
const strip = (n: string) => (n.includes(".") ? n.replace(/0+$/, "").replace(/\.$/, "") : n);
/** numeric(18,4) "200.0000" -> "200.00" style label with the currency's precision */
const dec = (n: string, currency: string) => Number(n).toFixed(currency === "JPY" ? 0 : 2);

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL);

const rows = await db
  .select({ inv: schema.invoices, vendor: schema.vendors })
  .from(schema.invoices)
  .innerJoin(schema.vendors, eq(schema.vendors.id, schema.invoices.vendorId))
  .where(
    and(
      inArray(schema.invoices.status, ["approved", "needs_review"]),
      isNotNull(schema.invoices.amount),
    ),
  )
  .orderBy(asc(schema.invoices.id))
  .limit(COUNT);

const lines = await db
  .select()
  .from(schema.invoiceLines)
  .where(
    inArray(
      schema.invoiceLines.invoiceId,
      rows.map((r) => r.inv.id),
    ),
  )
  .orderBy(asc(schema.invoiceLines.lineNo));

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
);
const page = await browser.newPage();

for (const [i, { inv, vendor }] of rows.entries()) {
  const currency = inv.currency ?? "USD";
  const labels = InvoiceExtraction.parse({
    documentType: inv.documentType ?? "invoice",
    vendor: { name: vendor.name, taxId: vendor.taxId, address: null },
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    currency,
    poNumber: inv.poNumber,
    subtotal: dec(inv.subtotal ?? "0", currency),
    tax: dec(inv.tax ?? "0", currency),
    discount: null,
    total: dec(inv.amount ?? "0", currency),
    lineItems: lines
      .filter((l) => l.invoiceId === inv.id)
      .map((l) => ({
        description: l.description,
        sku: l.sku,
        quantity: strip(l.quantity),
        unitPrice: dec(l.unitPrice, currency),
        amount: dec(l.amount, currency),
      })),
  });
  const layout = LAYOUTS[i % LAYOUTS.length] ?? "classic";
  await page.setContent(render(labels, layout), { waitUntil: "load" });
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  const id = `seed-${String(i + 1).padStart(3, "0")}`;
  await writeFile(new URL(`${id}.pdf`, OUT), pdf);
  await writeFile(
    new URL(`${id}.json`, OUT),
    JSON.stringify(
      {
        id,
        labels,
        tags: { source: "synthetic", layout, degraded: false, lineCount: labels.lineItems.length },
      },
      null,
      2,
    ) + "\n",
  );
}

await browser.close();
await close();
console.log(`rendered ${rows.length} invoices to ${OUT.pathname}`);
