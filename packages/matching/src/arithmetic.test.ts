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

  it("tolerates 1 minor unit of rounding on the total", () => {
    expect(failed({ ...ok, totalMinor: 2902 })).toEqual([]);
    expect(failed({ ...ok, totalMinor: 2903 })).toEqual([
      "subtotal_plus_tax_minus_discount_equals_total",
    ]);
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
