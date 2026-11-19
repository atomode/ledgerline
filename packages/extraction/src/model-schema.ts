import { z } from "zod";

/**
 * The schema sent to Claude as the structured-output format.
 *
 * Deliberately looser than the contract schema (InvoiceExtraction in @ledgerline/contracts):
 * plain strings with descriptions instead of regexes and refinements. Constrained decoding
 * guarantees this shape; the strict contract schema then checks the business rules, and a
 * single repair turn feeds any violations back to the model. Two schemas, one job each.
 */
const decimal = (what: string) =>
  z
    .string()
    .describe(
      `${what}. Plain decimal string: digits, optional leading "-", "." as decimal separator, ` +
        `no thousands separators, no currency symbol. "1.234,50 €" becomes "1234.50".`,
    );

export const ModelInvoice = z.object({
  documentType: z
    .enum(["invoice", "credit_note"])
    .describe("credit_note if the document credits/refunds the buyer"),
  vendor: z.object({
    name: z.string().describe("Supplier's legal or trading name as printed"),
    taxId: z.string().nullable().describe("VAT/GST/EIN/tax number if printed, else null"),
    address: z.string().nullable().describe("Supplier address on one line, else null"),
  }),
  invoiceNumber: z.string().describe("Invoice or credit note number exactly as printed"),
  invoiceDate: z.string().describe("Issue date as YYYY-MM-DD"),
  dueDate: z.string().nullable().describe("Payment due date as YYYY-MM-DD, or null if absent"),
  currency: z.string().describe("ISO 4217 code, e.g. USD, EUR, GBP, JPY"),
  poNumber: z
    .string()
    .nullable()
    .describe("Buyer's purchase order number (may be labeled PO, Order ref, Your reference)"),
  subtotal: decimal("Total before tax and discounts"),
  tax: decimal('Total tax (VAT/GST/sales tax). "0" if none'),
  discount: decimal("Total discount as a positive number").nullable(),
  total: decimal("Amount due including tax"),
  lineItems: z
    .array(
      z.object({
        description: z.string(),
        sku: z.string().nullable(),
        quantity: decimal("Quantity"),
        unitPrice: decimal("Unit price"),
        amount: decimal("Line total"),
      }),
    )
    .describe("Every billable line, in document order"),
  otherDocumentsInFile: z
    .boolean()
    .describe("true if the file contains more than one invoice or credit note"),
});
