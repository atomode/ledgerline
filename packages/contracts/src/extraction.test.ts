import { describe, expect, it } from "vitest";
import { InvoiceExtraction } from "./extraction.js";

const valid: InvoiceExtraction = {
  documentType: "invoice",
  vendor: { name: "Acme Supplies Ltd", taxId: "GB123456789", address: null },
  invoiceNumber: "INV-1042",
  invoiceDate: "2026-10-01",
  dueDate: "2026-10-31",
  currency: "USD",
  poNumber: "PO-7781",
  subtotal: "200.00",
  tax: "20.00",
  discount: null,
  total: "220.00",
  lineItems: [
    { description: "Widget", sku: "W-1", quantity: "4", unitPrice: "50.00", amount: "200.00" },
  ],
};

describe("InvoiceExtraction", () => {
  it("accepts a well-formed extraction", () => {
    expect(InvoiceExtraction.safeParse(valid).success).toBe(true);
  });

  it("rejects a negative or zero quantity", () => {
    for (const quantity of ["-1", "0"]) {
      const [line] = valid.lineItems;
      const bad = { ...valid, lineItems: [{ ...line, quantity }] };
      const r = InvoiceExtraction.safeParse(bad);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(["lineItems", 0, "quantity"]);
    }
  });

  it("rejects an unknown currency", () => {
    const r = InvoiceExtraction.safeParse({ ...valid, currency: "XYZ" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain("ISO 4217");
  });

  it("rejects formatted amounts the model should have normalized", () => {
    for (const total of ["1,234.50", "$220.00", "220,00", "1e3"]) {
      expect(InvoiceExtraction.safeParse({ ...valid, total }).success).toBe(false);
    }
  });

  it("allows negative amounts for credit notes", () => {
    const credit = { ...valid, documentType: "credit_note" as const, total: "-220.00" };
    expect(InvoiceExtraction.safeParse(credit).success).toBe(true);
  });
});
