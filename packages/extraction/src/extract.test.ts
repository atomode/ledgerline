import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ExtractionContentError, extractInvoice, validateModelOutput } from "./extract.js";
import { costMicros } from "./pricing.js";

const good = {
  documentType: "invoice",
  vendor: { name: "Acme GmbH", taxId: null, address: null },
  invoiceNumber: "INV-1",
  invoiceDate: "2026-10-01",
  dueDate: null,
  currency: "EUR",
  poNumber: null,
  subtotal: "100.00",
  tax: "19.00",
  discount: null,
  total: "119.00",
  lineItems: [
    { description: "Bolts", sku: null, quantity: "4", unitPrice: "25.00", amount: "100.00" },
  ],
};

type Reply = { text?: string; stop_reason?: string; model?: string };

/** A fake client that records requests and returns scripted replies in order. */
function fakeClient(replies: Reply[]) {
  const requests: Anthropic.Beta.MessageCreateParams[] = [];
  const client = {
    beta: {
      messages: {
        create: async (req: Anthropic.Beta.MessageCreateParams) => {
          requests.push(structuredClone(req));
          const r = replies.shift();
          if (!r) throw new Error("unexpected extra call");
          return {
            model: r.model ?? "claude-sonnet-5-5",
            stop_reason: r.stop_reason ?? "end_turn",
            content: [{ type: "text", text: r.text ?? "" }],
            usage: {
              input_tokens: 1000,
              output_tokens: 200,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 0,
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const pdf = Buffer.from("%PDF-1.4 test");
const opts = { model: "claude-sonnet-5-5" };

describe("extractInvoice", () => {
  it("returns validated data on the first try without a repair turn", async () => {
    const { client, requests } = fakeClient([{ text: JSON.stringify(good) }]);
    const res = await extractInvoice(client, pdf, opts);
    expect(res.repaired).toBe(false);
    expect(res.data.total).toBe("119.00");
    expect(requests).toHaveLength(1);
    expect(res.costMicros).toBe(costMicros("claude-sonnet-5-5", res.usage));
  });

  it("repairs once, quoting the validation issues back to the model", async () => {
    const { client, requests } = fakeClient([
      { text: JSON.stringify({ ...good, total: "€119.00" }) },
      { text: JSON.stringify(good) },
    ]);
    const res = await extractInvoice(client, pdf, opts);
    expect(res.repaired).toBe(true);
    expect(requests).toHaveLength(2);
    const repair = requests[1]!.messages.at(-1)!;
    expect(repair.role).toBe("user");
    expect(String(repair.content)).toContain("total");
    // Usage across both turns is billed.
    expect(res.usage.inputTokens).toBe(2000);
    expect(res.usage.cacheReadTokens).toBe(1000);
  });

  it("gives up after exactly one repair with a content error (human review, not retry)", async () => {
    const bad = JSON.stringify({ ...good, currency: "XYZ" });
    const { client, requests } = fakeClient([{ text: bad }, { text: bad }]);
    const err = await extractInvoice(client, pdf, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractionContentError);
    expect((err as ExtractionContentError).reason).toBe("invalid_after_repair");
    expect((err as ExtractionContentError).issues.join()).toContain("currency");
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["refusal", "refusal"],
    ["max_tokens", "truncated"],
  ] as const)(
    "stop_reason %s is a content error (%s) with no repair turn",
    async (stop, reason) => {
      const { client, requests } = fakeClient([{ stop_reason: stop }]);
      const err = (await extractInvoice(client, pdf, opts).catch(
        (e: unknown) => e,
      )) as ExtractionContentError;
      expect(err.reason).toBe(reason);
      expect(requests).toHaveLength(1);
    },
  );

  it("records the model that actually served the request (server-side fallback)", async () => {
    const { client } = fakeClient([{ text: JSON.stringify(good), model: "claude-opus-5-5" }]);
    const res = await extractInvoice(client, pdf, opts);
    expect(res.model).toBe("claude-opus-5-5");
    expect(res.costMicros).toBe(costMicros("claude-opus-5-5", res.usage));
  });

  it("caches the system prompt and asks for structured output", async () => {
    const { client, requests } = fakeClient([{ text: JSON.stringify(good) }]);
    await extractInvoice(client, pdf, opts);
    const req = requests[0] as unknown as {
      system: { cache_control?: unknown }[];
      output_config: { format: { type: string } };
    };
    expect(req.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(req.output_config.format.type).toBe("json_schema");
  });
});

describe("validateModelOutput", () => {
  it("reports JSON syntax errors as a single issue", () => {
    const r = validateModelOutput('{"documentType": "inv');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatch(/not valid JSON/);
  });
});
