import { z } from "zod";
import { CurrencyCode, IsoDate } from "./common.js";

/**
 * The exact shape Claude must return when extracting an invoice.
 *
 * Amounts are decimal strings, not minor units: the model reads "1.234,50 €" or "¥1,200" and
 * normalizes to "1234.50" / "1200". Converting to minor units needs the currency's exponent,
 * which is deterministic code's job (see toMinorUnits), not the model's.
 */
export const Decimal = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, "must be a plain decimal like 1234.50")
  .meta({ id: "Decimal" });

export const PositiveDecimal = Decimal.refine((v) => Number(v) > 0, {
  message: "must be greater than zero",
});

export const DocumentType = z.enum(["invoice", "credit_note"]);

export const ExtractedLineItem = z
  .object({
    description: z.string().min(1),
    sku: z.string().nullable(),
    quantity: PositiveDecimal,
    unitPrice: Decimal,
    amount: Decimal.meta({ description: "Line total as printed. Negative only on credit notes." }),
  })
  .meta({ id: "ExtractedLineItem" });

export const InvoiceExtraction = z
  .object({
    documentType: DocumentType,
    vendor: z.object({
      name: z.string().min(1),
      taxId: z.string().nullable(),
      address: z.string().nullable(),
    }),
    invoiceNumber: z.string().min(1),
    invoiceDate: IsoDate,
    dueDate: IsoDate.nullable(),
    currency: CurrencyCode,
    poNumber: z.string().nullable(),
    subtotal: Decimal,
    tax: Decimal,
    discount: Decimal.nullable(),
    total: Decimal,
    lineItems: z.array(ExtractedLineItem),
  })
  .meta({ id: "InvoiceExtraction" });
export type InvoiceExtraction = z.infer<typeof InvoiceExtraction>;
