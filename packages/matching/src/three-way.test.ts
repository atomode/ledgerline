import { describe, expect, it } from "vitest";
import { decideApproval, threeWayMatch, type MatchInput } from "./three-way.js";

const po = {
  id: "po-1",
  currency: "USD",
  lines: [
    { id: "pl-1", sku: "W-1", description: "Widget", quantity: "10", unitPriceMinor: 1000 },
    {
      id: "pl-2",
      sku: null,
      description: "Installation service",
      quantity: "1",
      unitPriceMinor: 50000,
    },
  ],
};
const fullyReceived = new Map([
  ["pl-1", "10"],
  ["pl-2", "1"],
]);
const inv = (lines: MatchInput["invoice"]["lines"], currency = "USD") => ({ currency, lines });
const l1 = { lineNo: 1, sku: "W-1", description: "Widget", quantity: "10", unitPriceMinor: 1000 };
const l2 = {
  lineNo: 2,
  sku: null,
  description: "Installation Service",
  quantity: "1",
  unitPriceMinor: 50000,
};

describe("threeWayMatch", () => {
  it.each([
    ["exact match", [l1, l2], fullyReceived, "matched"],
    [
      "price +1.9% is within tolerance",
      [{ ...l1, unitPriceMinor: 1019 }],
      fullyReceived,
      "within_tolerance",
    ],
    [
      "price exactly +2% is within tolerance",
      [{ ...l1, unitPriceMinor: 1020 }],
      fullyReceived,
      "within_tolerance",
    ],
    ["price +2.1% is a mismatch", [{ ...l1, unitPriceMinor: 1021 }], fullyReceived, "mismatch"],
    ["price -2.1% is a mismatch too", [{ ...l1, unitPriceMinor: 979 }], fullyReceived, "mismatch"],
    [
      "partial receipt, billed for what arrived",
      [{ ...l1, quantity: "6" }],
      new Map([["pl-1", "6"]]),
      "matched",
    ],
    ["partial receipt, billed for everything", [l1], new Map([["pl-1", "6"]]), "mismatch"],
    ["over-billed quantity", [{ ...l1, quantity: "11" }], fullyReceived, "mismatch"],
    [
      "fractional quantities compare exactly",
      [{ ...l1, quantity: "2.5" }],
      new Map([["pl-1", "2.4999"]]),
      "mismatch",
    ],
    [
      "line not on the PO",
      [{ ...l1, sku: "X-9", description: "Gadget" }],
      fullyReceived,
      "mismatch",
    ],
  ] as const)("%s", (_name, lines, received, outcome) => {
    expect(
      threeWayMatch({ invoice: inv([...lines]), po, received: received as Map<string, string> })
        .outcome,
    ).toBe(outcome);
  });

  it("matches description-only lines case- and punctuation-insensitively", () => {
    const r = threeWayMatch({
      invoice: inv([{ ...l2, description: "installation  service." }]),
      po,
      received: fullyReceived,
    });
    expect(r.outcome).toBe("matched");
  });

  it("reports no_po and no_receipt", () => {
    expect(threeWayMatch({ invoice: inv([l1]), po: null, received: null }).outcome).toBe("no_po");
    expect(threeWayMatch({ invoice: inv([l1]), po, received: null }).outcome).toBe("no_receipt");
  });

  it("fails fast on currency mismatch", () => {
    const r = threeWayMatch({ invoice: inv([l1], "EUR"), po, received: fullyReceived });
    expect(r.outcome).toBe("mismatch");
    expect(r.discrepancies).toEqual([
      { kind: "currency", lineRef: null, expected: "USD", actual: "EUR", withinTolerance: false },
    ]);
  });

  it("describes each discrepancy", () => {
    const r = threeWayMatch({
      invoice: inv([{ ...l1, quantity: "12", unitPriceMinor: 1100 }]),
      po,
      received: fullyReceived,
    });
    expect(r.discrepancies.map((d) => [d.kind, d.withinTolerance])).toEqual([
      ["price", false],
      ["quantity", false],
    ]);
  });
});

describe("decideApproval", () => {
  const ok = {
    documentType: "invoice" as const,
    rules: [{ passed: true }],
    match: "matched" as const,
    vendorResolved: true,
  };
  it("approves only when every condition holds", () => {
    expect(decideApproval(ok)).toBe("approved");
    expect(decideApproval({ ...ok, match: "within_tolerance" })).toBe("approved");
    expect(decideApproval({ ...ok, match: "mismatch" })).toBe("needs_review");
    expect(decideApproval({ ...ok, match: "no_po" })).toBe("needs_review");
    expect(decideApproval({ ...ok, rules: [{ passed: true }, { passed: false }] })).toBe(
      "needs_review",
    );
    expect(decideApproval({ ...ok, vendorResolved: false })).toBe("needs_review");
  });
  it("always sends credit notes to a human", () => {
    expect(decideApproval({ ...ok, documentType: "credit_note" })).toBe("needs_review");
  });
});
