import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IsoDateTime, Money, Uuid } from "./common.js";
import { InvoiceStatus } from "./invoices.js";

export const WEBHOOK_SIGNATURE_HEADER = "ledgerline-signature";
/** Reject signatures older than this to stop replay attacks. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const WebhookEvent = z
  .object({
    id: Uuid.meta({ description: "Unique per event. Consumers dedupe on this." }),
    type: z.enum(["invoice.approved", "invoice.needs_review", "invoice.rejected"]),
    createdAt: IsoDateTime,
    data: z.object({
      invoiceId: Uuid,
      status: InvoiceStatus,
      vendorId: Uuid.nullable(),
      invoiceNumber: z.string().nullable(),
      total: Money.nullable(),
    }),
  })
  .meta({ id: "WebhookEvent" });
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/**
 * Signature header format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * Same scheme as most payment providers, so consumers already know how to verify it.
 */
export function signWebhook(secret: string, rawBody: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhook(
  secret: string,
  rawBody: string,
  header: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || typeof v1 !== "string") return false;
  if (Math.abs(nowSeconds - t) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signWebhook(secret, rawBody, t).split("v1=")[1] ?? "", "hex");
  const actual = Buffer.from(v1, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
