import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor.js";

const secret = "cursor-secret-0123456789";

describe("signed cursors", () => {
  it("round-trips", () => {
    const payload = {
      receivedAt: "2026-11-01T00:00:00.000Z",
      id: "0194f0b2-0000-7000-8000-000000000000",
    };
    expect(decodeCursor(secret, encodeCursor(secret, payload))).toEqual(payload);
  });

  it("rejects edited payloads, foreign secrets and garbage", () => {
    const c = encodeCursor(secret, { id: "a" });
    const [, mac] = c.split(".");
    const forged = `${Buffer.from(JSON.stringify({ id: "z" })).toString("base64url")}.${mac}`;
    expect(() => decodeCursor(secret, forged)).toThrow(InvalidCursorError);
    expect(() => decodeCursor("another-secret-000000", c)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(secret, "nonsense")).toThrow(InvalidCursorError);
  });
});
