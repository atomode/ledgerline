import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { InvoiceExtraction } from "@ledgerline/contracts";
import { ModelInvoice } from "./model-schema.js";
import { EXTRACTION_SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt.js";
import { addUsage, costMicros, emptyUsage, type TokenUsage } from "./pricing.js";

/**
 * The document itself is the problem (refused, truncated, or still invalid after one repair).
 * Retrying the same input won't help: route to human review, never to the DLQ.
 */
export class ExtractionContentError extends Error {
  override readonly name = "ExtractionContentError";
  constructor(
    message: string,
    readonly reason: "refusal" | "truncated" | "invalid_after_repair",
    readonly issues: string[],
    readonly usage: TokenUsage,
    readonly model: string,
  ) {
    super(message);
  }
}

export interface ExtractResult {
  data: InvoiceExtraction;
  model: string;
  promptVersion: string;
  usage: TokenUsage;
  costMicros: number;
  repaired: boolean;
}

export interface ExtractOptions {
  model: string;
  maxTokens?: number;
}

// Only the JSON schema is sent; the helper's client-side parse fn stays local.
const OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: betaZodOutputFormat(ModelInvoice).schema,
};
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function usageOf(msg: Anthropic.Beta.BetaMessage): TokenUsage {
  return {
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}

function textOf(msg: Anthropic.Beta.BetaMessage): string {
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Parse + strict-validate. Returns the issues instead of throwing so the caller can repair. */
export function validateModelOutput(
  text: string,
): { ok: true; data: InvoiceExtraction } | { ok: false; issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: [`response is not valid JSON: ${(err as Error).message}`] };
  }
  const parsed = InvoiceExtraction.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/**
 * One extraction call plus at most one repair turn.
 * API errors (429, 5xx, network) propagate untouched: the caller's queue owns retries,
 * and the client must be built with maxRetries: 0 so retries don't multiply.
 */
export async function extractInvoice(
  client: Anthropic,
  pdf: Buffer,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
        },
        { type: "text", text: "Extract this document." },
      ],
    },
  ];

  let usage = emptyUsage();
  let servedModel = opts.model;

  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await client.beta.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16_000,
      // System prompt + schema are identical on every call: cache them.
      system: [
        { type: "text", text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages,
      output_config: { effort: "low", format: OUTPUT_FORMAT },
      // Server-side fallback: if the primary model declines, the API retries on a model chosen
      // for the refusal category instead of failing the extraction.
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });
    usage = addUsage(usage, usageOf(msg));
    servedModel = msg.model;

    if (msg.stop_reason === "refusal") {
      throw new ExtractionContentError(
        "model declined to extract",
        "refusal",
        [],
        usage,
        servedModel,
      );
    }
    if (msg.stop_reason === "max_tokens") {
      throw new ExtractionContentError(
        "output truncated at max_tokens",
        "truncated",
        [],
        usage,
        servedModel,
      );
    }

    const text = textOf(msg);
    const result = validateModelOutput(text);
    if (result.ok) {
      return {
        data: result.data,
        model: servedModel,
        promptVersion: PROMPT_VERSION,
        usage,
        costMicros: costMicros(servedModel, usage),
        repaired: attempt > 0,
      };
    }
    if (attempt === 1) {
      throw new ExtractionContentError(
        "extraction still invalid after one repair",
        "invalid_after_repair",
        result.issues,
        usage,
        servedModel,
      );
    }
    messages.push(
      { role: "assistant", content: text },
      {
        role: "user",
        content:
          "Your output failed validation:\n" +
          result.issues.map((i) => `- ${i}`).join("\n") +
          "\nReturn the corrected JSON for the same document. Fix only what the errors name.",
      },
    );
  }
  throw new Error("unreachable");
}
