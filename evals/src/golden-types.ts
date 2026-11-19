import type { InvoiceExtraction } from "@ledgerline/contracts";

export type Layout =
  "classic" | "minimal" | "eu" | "compact" | "banner" | "ledger" | "nordic" | "japanese";

export const LAYOUTS: Layout[] = [
  "classic",
  "minimal",
  "eu",
  "compact",
  "banner",
  "ledger",
  "nordic",
  "japanese",
];

export type DocumentKind = "invoice" | "credit_note" | "statement" | "not_invoice";

/** Master data the deterministic stages need, so the eval can score approval without a database. */
export interface GoldenContext {
  /** defaultCurrency: what the vendor master says it bills in (settles a bare "$"). */
  vendor: { name: string; taxId: string | null; defaultCurrency: string | null };
  po: {
    poNumber: string;
    currency: string;
    lines: { sku: string | null; description: string; quantity: string; unitPrice: string }[];
    /** Received quantity per PO line index; null = nothing received yet. */
    received: string[] | null;
  } | null;
}

export interface GoldenDoc {
  id: string;
  tags: {
    source: "synthetic" | "adversarial" | "real";
    layout: Layout | "mixed";
    degraded: boolean;
    pages: number;
    lineCount: number;
    /** e.g. injection, credit_note, multi_currency, long, two_in_one, price_drift, over_billed */
    scenario: string;
  };
  /** Ground truth for the extraction. null for documents that must not be extracted. */
  labels: InvoiceExtraction | null;
  expected: {
    kind: DocumentKind;
    /** Review flags code must raise (e.g. multiple_documents_in_file). */
    flags: string[];
    /** What a perfect extraction + the deterministic gate should decide. */
    decision: "approved" | "needs_review" | null;
  };
  context: GoldenContext;
}
