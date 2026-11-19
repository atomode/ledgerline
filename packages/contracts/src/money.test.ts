import { describe, expect, it } from "vitest";
import { currencyExponent, fromMinorUnits, toMinorUnits } from "./money.js";

describe("money", () => {
  it("knows currency exponents", () => {
    expect([currencyExponent("USD"), currencyExponent("JPY"), currencyExponent("BHD")]).toEqual([
      2, 0, 3,
    ]);
  });

  it.each([
    ["1234.50", "USD", 123450],
    ["1234.5", "USD", 123450],
    ["1234", "USD", 123400],
    ["0.1", "USD", 10],
    ["-220.00", "USD", -22000],
    ["1200", "JPY", 1200],
    ["1.234", "BHD", 1234],
    ["10.005", "USD", 1001],
    ["10.004", "USD", 1000],
    ["-10.005", "USD", -1001],
    ["0.004", "USD", 0],
  ])("toMinorUnits(%s, %s) = %d", (dec, cur, minor) => {
    expect(toMinorUnits(dec, cur)).toBe(minor);
  });

  it("rejects formatted strings", () => {
    for (const bad of ["1,234.50", "$1", "1e3", "", "."]) {
      expect(() => toMinorUnits(bad, "USD")).toThrow(RangeError);
    }
  });

  it("round-trips", () => {
    for (const [minor, cur] of [
      [123450, "USD"],
      [-5, "USD"],
      [7, "JPY"],
      [1, "BHD"],
    ] as const) {
      expect(toMinorUnits(fromMinorUnits(minor, cur), cur)).toBe(minor);
    }
    expect(fromMinorUnits(-5, "USD")).toBe("-0.05");
  });
});
