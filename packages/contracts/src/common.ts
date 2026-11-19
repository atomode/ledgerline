import { z } from "zod";

const ISO_4217 = new Set(Intl.supportedValuesOf("currency"));

export const CurrencyCode = z
  .string()
  .length(3)
  .refine((c) => ISO_4217.has(c), { message: "must be an ISO 4217 currency code" })
  .meta({ id: "CurrencyCode", example: "USD" });

/** Money is always integer minor units + currency. Never floats. */
export const Money = z
  .object({
    amountMinor: z.int().meta({ description: "Amount in minor units (e.g. cents). Signed." }),
    currency: CurrencyCode,
  })
  .meta({ id: "Money" });
export type Money = z.infer<typeof Money>;

export const IsoDate = z.iso.date().meta({ example: "2026-11-18" });
export const IsoDateTime = z.iso.datetime({ offset: true });
export const Uuid = z.uuid();

/** RFC 9457 problem details. Every non-2xx response uses this shape. */
export const Problem = z
  .object({
    type: z.string().default("about:blank"),
    title: z.string(),
    status: z.int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .meta({ description: "Field-level validation errors" }),
  })
  .meta({ id: "Problem" });
export type Problem = z.infer<typeof Problem>;

export const CursorQuery = z.object({
  cursor: z
    .string()
    .optional()
    .meta({ description: "Opaque cursor from a previous page's nextCursor." }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function page<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable().meta({ description: "Null when there are no more pages." }),
  });
}

export const IdempotencyHeaders = z.object({
  "idempotency-key": z
    .string()
    .min(8)
    .max(255)
    .optional()
    .meta({ description: "Retries with the same key and body return the original response." }),
});
