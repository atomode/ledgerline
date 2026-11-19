/**
 * A misbehaving stand-in for the Anthropic Messages API, for chaos tests. Point the SDK at it with
 * ANTHROPIC_BASE_URL. Behaviour per request:
 *  - documents whose sha256 is in `hardFail` always get 529 overloaded (until removed)
 *  - `rate429` of requests get 429 with Retry-After: 1
 *  - on the first turn, `badJson` get truncated JSON and `badSchema` get a schema-violating value,
 *    which exercises the extractor's single repair turn
 *  - everything else gets a valid extraction
 */
import { createHash } from "node:crypto";
import Fastify from "fastify";

export interface FakeOptions {
  rate429?: number;
  badJson?: number;
  badSchema?: number;
  seed?: number;
  port?: number;
}

export function validExtraction(n: number) {
  return {
    documentType: "invoice",
    vendor: { name: "Chaos Supplies Ltd", taxId: null, address: null },
    invoiceNumber: `CHAOS-${n}`,
    invoiceDate: "2026-10-01",
    dueDate: "2026-10-31",
    currency: "USD",
    poNumber: null,
    subtotal: "100.00",
    tax: "10.00",
    discount: null,
    total: "110.00",
    lineItems: [
      { description: "Widget", sku: null, quantity: "2", unitPrice: "50.00", amount: "100.00" },
    ],
  };
}

const message = (model: string, text: string, n: number) => ({
  id: `msg_fake_${n}`,
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: model.includes("haiku") ? 1500 : 4200,
    output_tokens: model.includes("haiku") ? 8 : 650,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});

export async function startFakeAnthropic(opts: FakeOptions = {}) {
  const rate429 = opts.rate429 ?? 0.3;
  const badJson = opts.badJson ?? 0.05;
  const badSchema = opts.badSchema ?? 0.05;
  // Small deterministic PRNG so runs are reproducible.
  let s = opts.seed ?? 42;
  const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

  const hardFail = new Set<string>();
  const stats = { requests: 0, r429: 0, r529: 0, badJson: 0, badSchema: 0, ok: 0, repairs: 0 };
  let counter = 0;

  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  app.post("/v1/messages", async (req, reply) => {
    stats.requests++;
    const body = req.body as { model: string; messages: { role: string; content: unknown }[] };
    const first = body.messages[0]?.content as { type: string; source?: { data?: string } }[];
    const data = first?.find((b) => b.type === "document")?.source?.data ?? "";
    const docHash = createHash("sha256").update(data).digest("hex");
    const isRepair = body.messages.length > 1;
    if (isRepair) stats.repairs++;

    if (hardFail.has(docHash)) {
      stats.r529++;
      return reply
        .code(529)
        .send({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    }
    if (rand() < rate429) {
      stats.r429++;
      return reply
        .code(429)
        .header("retry-after", "1")
        .send({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } });
    }
    if (body.model.includes("haiku")) {
      // Classification call: always an invoice in the chaos run.
      stats.ok++;
      return message(body.model, JSON.stringify({ kind: "invoice" }), ++counter);
    }
    let text = JSON.stringify(validExtraction(++counter));
    const r = rand();
    if (!isRepair && r < badJson) {
      stats.badJson++;
      text = text.slice(0, 40);
    } else if (!isRepair && r < badJson + badSchema) {
      stats.badSchema++;
      text = JSON.stringify({ ...validExtraction(counter), currency: "XYZ", total: "$110.00" });
    } else {
      stats.ok++;
    }
    return message(body.model, text, counter);
  });

  const url = await app.listen({ host: "127.0.0.1", port: opts.port ?? 0 });
  return { url, hardFail, stats, close: () => app.close() };
}
