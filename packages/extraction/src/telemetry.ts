/**
 * OpenTelemetry GenAI semantic conventions for every Claude call: one CLIENT span per request plus
 * the standard duration and token-usage histograms. Attributes carry ids, models, counts and cost.
 * Never prompt text, document content or extracted values (CLAUDE.md rule 8).
 */
import { SpanKind, SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import type Anthropic from "@anthropic-ai/sdk";
import { costMicros, type TokenUsage } from "./pricing.js";

const SCOPE = "ledgerline.extraction";

export async function genAiCall(
  meta: {
    model: string;
    maxTokens: number;
    promptVersion: string;
    attempt?: number;
    purpose: string;
  },
  call: () => Promise<Anthropic.Beta.BetaMessage>,
): Promise<Anthropic.Beta.BetaMessage> {
  const tracer = trace.getTracer(SCOPE);
  const meter = metrics.getMeter(SCOPE);
  const base = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "anthropic",
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": meta.model,
  };
  return tracer.startActiveSpan(
    `chat ${meta.model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        ...base,
        "gen_ai.request.max_tokens": meta.maxTokens,
        "ledgerline.prompt_version": meta.promptVersion,
        "ledgerline.purpose": meta.purpose,
        "ledgerline.attempt": meta.attempt ?? 0,
      },
    },
    async (span) => {
      const started = performance.now();
      try {
        const msg = await call();
        const usage: TokenUsage = {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
        };
        span.setAttributes({
          "gen_ai.response.model": msg.model,
          "gen_ai.response.id": msg.id,
          "gen_ai.response.finish_reasons": [msg.stop_reason ?? "unknown"],
          "gen_ai.usage.input_tokens": usage.inputTokens,
          "gen_ai.usage.output_tokens": usage.outputTokens,
          "ledgerline.cache_read_tokens": usage.cacheReadTokens,
          "ledgerline.cache_write_tokens": usage.cacheWriteTokens,
          "ledgerline.cost_micros": costMicros(msg.model, usage),
        });
        const attrs = { ...base, "gen_ai.response.model": msg.model };
        meter
          .createHistogram("gen_ai.client.operation.duration", { unit: "s" })
          .record((performance.now() - started) / 1000, attrs);
        const tokens = meter.createHistogram("gen_ai.client.token.usage", { unit: "{token}" });
        tokens.record(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, {
          ...attrs,
          "gen_ai.token.type": "input",
        });
        tokens.record(usage.outputTokens, { ...attrs, "gen_ai.token.type": "output" });
        return msg;
      } catch (err) {
        const status = (err as { status?: number }).status;
        span.setAttribute("error.type", status ? String(status) : (err as Error).name);
        span.setStatus({ code: SpanStatusCode.ERROR });
        meter
          .createHistogram("gen_ai.client.operation.duration", { unit: "s" })
          .record((performance.now() - started) / 1000, {
            ...base,
            "error.type": status ? String(status) : (err as Error).name,
          });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
