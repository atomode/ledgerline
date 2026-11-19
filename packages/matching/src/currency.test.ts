import { describe, expect, it } from "vitest";
import { classifyCurrencyMarker, resolveCurrency } from "./currency.js";

describe("classifyCurrencyMarker", () => {
  it("reads an ISO code anywhere in the marker", () => {
    expect(classifyCurrencyMarker("AUD")).toEqual({ kind: "code", currency: "AUD" });
    expect(classifyCurrencyMarker("CHF 1'200.00")).toEqual({ kind: "code", currency: "CHF" });
    expect(classifyCurrencyMarker("usd")).toEqual({ kind: "code", currency: "USD" });
  });

  it("maps unambiguous symbols", () => {
    expect(classifyCurrencyMarker("€")).toEqual({ kind: "code", currency: "EUR" });
    expect(classifyCurrencyMarker("£")).toEqual({ kind: "code", currency: "GBP" });
    expect(classifyCurrencyMarker("A$")).toEqual({ kind: "code", currency: "AUD" });
    expect(classifyCurrencyMarker("CA$")).toEqual({ kind: "code", currency: "CAD" });
    expect(classifyCurrencyMarker("US$")).toEqual({ kind: "code", currency: "USD" });
    expect(classifyCurrencyMarker("R$")).toEqual({ kind: "code", currency: "BRL" });
    expect(classifyCurrencyMarker("円")).toEqual({ kind: "code", currency: "JPY" });
  });

  it("treats shared symbols as ambiguous with their candidate set", () => {
    const dollar = classifyCurrencyMarker("$");
    expect(dollar.kind).toBe("ambiguous");
    expect(dollar.kind === "ambiguous" && dollar.candidates).toEqual(
      expect.arrayContaining(["USD", "CAD", "AUD", "NZD"]),
    );
    expect(classifyCurrencyMarker("¥")).toEqual({ kind: "ambiguous", candidates: ["JPY", "CNY"] });
    expect(classifyCurrencyMarker("kr").kind).toBe("ambiguous");
  });

  it("does not read words that merely contain three capitals as codes", () => {
    expect(classifyCurrencyMarker("TOTAL").kind).toBe("none");
    expect(classifyCurrencyMarker("GST")).toEqual({ kind: "none" });
  });

  it("returns none for an empty or missing marker", () => {
    expect(classifyCurrencyMarker(null)).toEqual({ kind: "none" });
    expect(classifyCurrencyMarker("  ")).toEqual({ kind: "none" });
  });
});

describe("resolveCurrency", () => {
  const base = { extracted: "USD", poCurrency: null, vendorDefault: null };

  it("trusts a printed code over the model's normalization", () => {
    expect(resolveCurrency({ ...base, printed: "AUD" })).toEqual({
      currency: "AUD",
      source: "document",
      ambiguous: false,
    });
  });

  it("resolves a bare $ from the PO before the vendor default", () => {
    expect(
      resolveCurrency({ ...base, printed: "$", poCurrency: "CAD", vendorDefault: "AUD" }),
    ).toEqual({ currency: "CAD", source: "purchase_order", ambiguous: false });
  });

  it("resolves a bare $ from the vendor default when there is no PO", () => {
    expect(resolveCurrency({ ...base, printed: "$", vendorDefault: "AUD" })).toEqual({
      currency: "AUD",
      source: "vendor_default",
      ambiguous: false,
    });
  });

  it("ignores master data that the printed symbol rules out", () => {
    // A "$" can't be EUR: fall through to the model and flag it, rather than silently re-label.
    expect(resolveCurrency({ ...base, printed: "$", vendorDefault: "EUR" })).toEqual({
      currency: "USD",
      source: "model_inferred",
      ambiguous: true,
    });
  });

  it("flags a bare symbol with no master data as ambiguous", () => {
    expect(resolveCurrency({ ...base, printed: "$" })).toEqual({
      currency: "USD",
      source: "model_inferred",
      ambiguous: true,
    });
  });

  it("uses master data when nothing is printed, and flags when there is none", () => {
    expect(resolveCurrency({ ...base, printed: null, vendorDefault: "NZD" })).toEqual({
      currency: "NZD",
      source: "vendor_default",
      ambiguous: false,
    });
    expect(resolveCurrency({ ...base, printed: null })).toMatchObject({ ambiguous: true });
  });

  it("separates JPY from CNY on ¥ using the vendor", () => {
    expect(
      resolveCurrency({ extracted: "JPY", printed: "¥", poCurrency: null, vendorDefault: "CNY" }),
    ).toEqual({ currency: "CNY", source: "vendor_default", ambiguous: false });
  });
});
