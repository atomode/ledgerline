import { describe, expect, it } from "vitest";
import { normalizeVendorName } from "./vendor.js";

describe("normalizeVendorName", () => {
  it.each([
    ["ACME Supplies, Ltd.", "acme supplies"],
    ["Acme Supplies Limited", "acme supplies"],
    ["Müller & Söhne GmbH", "muller and sohne"],
    ["Smith Co. Inc.", "smith"],
    ["Ltd", "ltd"],
  ])("%s -> %s", (input, out) => expect(normalizeVendorName(input)).toBe(out));
});
