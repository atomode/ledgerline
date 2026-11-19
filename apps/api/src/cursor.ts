import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Opaque keyset cursor: base64url(JSON payload) + "." + HMAC. Clients can't decode-edit-replay a
 * cursor to jump into another tenant's keyspace or craft a pathological query.
 */
export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError";
}

export function encodeCursor(secret: string, payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function decodeCursor(secret: string, cursor: string): Record<string, string> {
  const [body, mac] = cursor.split(".");
  if (!body || !mac) throw new InvalidCursorError("malformed cursor");
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InvalidCursorError("cursor signature mismatch");
  }
  const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new InvalidCursorError("malformed cursor");
  return parsed as Record<string, string>;
}
