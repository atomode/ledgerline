import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "./webhooks.js";

const secret = "whsec_test_0123456789";
const body = JSON.stringify({ id: "evt_1", type: "invoice.approved" });
const now = 1_800_000_000;

describe("webhook signatures", () => {
  it("round-trips", () => {
    expect(verifyWebhook(secret, body, signWebhook(secret, body, now), now)).toBe(true);
  });

  it("rejects a tampered body, wrong secret, or garbage header", () => {
    const sig = signWebhook(secret, body, now);
    expect(verifyWebhook(secret, body + " ", sig, now)).toBe(false);
    expect(verifyWebhook("other-secret-000000", body, sig, now)).toBe(false);
    expect(verifyWebhook(secret, body, "nonsense", now)).toBe(false);
    expect(verifyWebhook(secret, body, "t=abc,v1=zz", now)).toBe(false);
  });

  it("rejects replays outside the 5-minute window", () => {
    const sig = signWebhook(secret, body, now);
    expect(verifyWebhook(secret, body, sig, now + 301)).toBe(false);
    expect(verifyWebhook(secret, body, sig, now + 299)).toBe(true);
  });
});
