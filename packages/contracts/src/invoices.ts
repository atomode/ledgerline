import { z } from "zod";
import { CurrencyCode, IsoDate, IsoDateTime, Money, Uuid } from "./common.js";
import { DocumentType } from "./extraction.js";

export const InvoiceStatus = z
  .enum(["received", "classified", "extracted", "needs_review", "approved", "rejected", "failed"])
  .meta({ id: "InvoiceStatus" });

export const InvoiceSummary = z
  .object({
    id: Uuid,
    status: InvoiceStatus,
    documentType: DocumentType.nullable(),
    vendorId: Uuid.nullable(),
    vendorName: z.string().nullable(),
    invoiceNumber: z.string().nullable(),
    invoiceDate: IsoDate.nullable(),
    total: Money.nullable(),
    receivedAt: IsoDateTime,
  })
  .meta({ id: "InvoiceSummary" });

export const LineItem = z
  .object({
    id: Uuid,
    description: z.string(),
    sku: z.string().nullable(),
    quantity: z.string().meta({ description: "Decimal string" }),
    unitPrice: Money,
    amount: Money,
  })
  .meta({ id: "LineItem" });

export const ValidationResult = z
  .object({
    rule: z.string().meta({ example: "lines_sum_to_subtotal" }),
    passed: z.boolean(),
    detail: z.string().nullable(),
  })
  .meta({ id: "ValidationResult" });

export const MatchResult = z
  .object({
    outcome: z.enum(["matched", "within_tolerance", "mismatch", "no_po", "no_receipt"]),
    purchaseOrderId: Uuid.nullable(),
    discrepancies: z.array(
      z.object({
        kind: z.enum(["price", "quantity", "currency", "missing_line", "unexpected_line"]),
        lineRef: z.string().nullable(),
        expected: z.string().nullable(),
        actual: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: "MatchResult" });

export const ExtractionMetadata = z
  .object({
    model: z.string(),
    promptVersion: z.string(),
    extractionSchemaVersion: z.int(),
    inputTokens: z.int(),
    outputTokens: z.int(),
    costMicros: z.int().meta({ description: "USD millionths" }),
    extractedAt: IsoDateTime,
  })
  .meta({ id: "ExtractionMetadata" });

export const InvoiceDetail = InvoiceSummary.extend({
  dueDate: IsoDate.nullable(),
  currency: CurrencyCode.nullable(),
  poNumber: z.string().nullable(),
  subtotal: Money.nullable(),
  tax: Money.nullable(),
  discount: Money.nullable(),
  lineItems: z.array(LineItem),
  validations: z.array(ValidationResult),
  match: MatchResult.nullable(),
  missingFields: z.array(z.string()),
  reviewFlags: z.array(z.string()).meta({
    description:
      "Why a human must look regardless of checks, e.g. classified_as_statement, multiple_documents_in_file",
  }),
  extraction: ExtractionMetadata.nullable(),
}).meta({ id: "InvoiceDetail" });

export const ListInvoicesQuery = z.object({
  status: InvoiceStatus.optional(),
  vendorId: Uuid.optional(),
  receivedFrom: IsoDateTime.optional(),
  receivedTo: IsoDateTime.optional(),
});

export const FieldCorrection = z.object({
  field: z.string().meta({ example: "total" }),
  value: z.string(),
});

export const ReviewRequest = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("approve"), note: z.string().max(2000).optional() }),
    z.object({ action: z.literal("reject"), reason: z.string().min(1).max(2000) }),
    z.object({
      action: z.literal("correct"),
      corrections: z.array(FieldCorrection).min(1),
      note: z.string().max(2000).optional(),
    }),
  ])
  .meta({ id: "ReviewRequest" });
export type ReviewRequest = z.infer<typeof ReviewRequest>;
