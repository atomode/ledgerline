import { describe, expect, it } from "vitest";
import type { InvoiceExtraction } from "@ledgerline/contracts";
import {
  compareHeader,
  f1,
  matchLines,
  percentile,
  similarity,
  stratifiedSubset,
  wilson,
} from "./metrics.js";

const label: InvoiceExtraction = {
  documentType: "invoice",
  vendor: { name: "Acme Supplies Ltd", taxId: null, address: null },
  invoiceNumber: "INV-0042",
  invoiceDate: "2026-10-01",
  dueDate: "2026-10-31",
  currency: "EUR",
  poNumber: "PO-1",
  subtotal: "100.00",
  tax: "19.00",
  discount: null,
  total: "119.00",
  lineItems: [
    { description: "Hex bolt M8", sku: "HB8", quantity: "4", unitPrice: "25.00", amount: "100.00" },
  ],
};

describe("compareHeader", () => {
  it("normalizes formatting but not content", () => {
    const pred = {
      ...label,
      vendor: { ...label.vendor, name: "ACME SUPPLIES LIMITED" },
      invoiceNumber: "inv-0042",
      poNumber: " po-1",
      total: "119",
    };
    expect(Object.values(compareHeader(label, pred)).every(Boolean)).toBe(true);
  });
  it("a one-cent difference is wrong", () => {
    expect(compareHeader(label, { ...label, total: "119.01" }).total).toBe(false);
  });
  it("garbage amounts are wrong, not a crash", () => {
    expect(compareHeader(label, { ...label, tax: "nineteen" }).tax).toBe(false);
  });
  it("a missing prediction fails every field", () => {
    expect(Object.values(compareHeader(label, null)).some(Boolean)).toBe(false);
  });
});

describe("line matching", () => {
  it("accepts a near-identical description with exact qty and price", () => {
    const pred = { ...label, lineItems: [{ ...label.lineItems[0]!, description: "Hex bolt M8." }] };
    expect(matchLines(label, pred)).toEqual({ matched: 1, predicted: 1, expected: 1 });
  });
  it("rejects a wrong quantity even with the right description", () => {
    const pred = { ...label, lineItems: [{ ...label.lineItems[0]!, quantity: "5" }] };
    expect(matchLines(label, pred).matched).toBe(0);
  });
  it("f1 handles empty sets", () => {
    expect(f1(0, 0, 0)).toBe(1);
    expect(f1(0, 3, 0)).toBe(0);
    expect(f1(2, 2, 4)).toBeCloseTo(2 / 3);
  });
  it("similarity is 1 for equal and 0 for disjoint", () => {
    expect(similarity("abc", "ABC ")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });
});

describe("statistics", () => {
  it("wilson matches the textbook value for 0/60 and 57/60", () => {
    const [lo0, hi0] = wilson(0, 60);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.0602, 3);
    const [lo, hi] = wilson(57, 60);
    expect(lo).toBeCloseTo(0.8628, 3);
    expect(hi).toBeCloseTo(0.9829, 3);
  });
  it("nearest-rank percentile", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
  it("stratified subset is deterministic and keeps every stratum", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, g: i % 4 }));
    const a = stratifiedSubset(items, 0.3, (x) => String(x.g));
    const b = stratifiedSubset(items, 0.3, (x) => String(x.g));
    expect(a).toEqual(b);
    expect(new Set(a.map((x) => x.g))).toEqual(new Set([0, 1, 2, 3]));
    expect(a).toHaveLength(12);
  });
});
