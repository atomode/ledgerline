import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { checkArithmetic, type Totals } from "./arithmetic.js";
import { lineTotalMinor, parseScaled } from "./decimal.js";

const ok: Totals = {
  lines: [
    { quantity: "3", unitPriceMinor: 333, amountMinor: 999 },
    { quantity: "1.5", unitPriceMinor: 1001, amountMinor: 1502 }, // 1501.5 rounds half up
  ],
  subtotalMinor: 2501,
  taxMinor: 500,
  discountMinor: 100,
  totalMinor: 2901,
};
const failed = (t: Totals) =>
  checkArithmetic(t)
    .filter((r) => !r.passed)
    .map((r) => r.rule);

describe("checkArithmetic", () => {
  it("passes a consistent invoice, including half-up rounding on a line", () => {
    expect(failed(ok)).toEqual([]);
  });

  it("header identities are exact: a 1-minor-unit misread of the total or tax fails", () => {
    // The supplier computed these from printed values, so there is no rounding to forgive. A
    // tolerance here let one-cent misreads of the total sail through to auto-approval (found by
    // the eval harness).
    expect(failed({ ...ok, totalMinor: 2902 })).toEqual([
      "subtotal_plus_tax_minus_discount_equals_total",
    ]);
    expect(failed({ ...ok, taxMinor: 501 })).toEqual([
      "subtotal_plus_tax_minus_discount_equals_total",
    ]);
    expect(failed({ ...ok, subtotalMinor: 2502, totalMinor: 2902 })).toEqual([
      "lines_sum_to_subtotal",
    ]);
  });

  it("still forgives 1 minor unit on a line, where qty x rounded unit price drifts", () => {
    const lines = [ok.lines[0]!, { ...ok.lines[1]!, amountMinor: 1503 }];
    expect(failed({ ...ok, lines, subtotalMinor: 2502, totalMinor: 2902 })).toEqual([]);
  });

  it("catches a misread digit in one line", () => {
    const lines = [ok.lines[0]!, { ...ok.lines[1]!, amountMinor: 1802 }];
    expect(failed({ ...ok, lines })).toEqual(["line_qty_times_price", "lines_sum_to_subtotal"]);
  });

  it("handles credit notes (negative amounts)", () => {
    const credit: Totals = {
      lines: [{ quantity: "2", unitPriceMinor: -500, amountMinor: -1000 }],
      subtotalMinor: -1000,
      taxMinor: -200,
      discountMinor: null,
      totalMinor: -1200,
    };
    expect(failed(credit)).toEqual([]);
  });
});

describe("decimal helpers", () => {
  it("parses at 4dp", () => {
    expect(parseScaled("2.5")).toBe(25_000n);
    expect(parseScaled("-0.0001")).toBe(-1n);
    expect(() => parseScaled("1,5")).toThrow(RangeError);
  });

  it("lineTotalMinor equals exact rational rounding for any qty/price (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (q4, price) => {
          const qty = `${Math.floor(q4 / 10_000)}.${String(q4 % 10_000).padStart(4, "0")}`;
          const exact =
            (BigInt(q4) * BigInt(price) * 2n + (price >= 0 ? 10_000n : -10_000n)) / 20_000n;
          expect(lineTotalMinor(qty, price)).toBe(Number(exact));
        },
      ),
    );
  });
});
