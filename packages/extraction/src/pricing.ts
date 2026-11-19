/**
 * USD list prices per million tokens (Anthropic first-party API, cached 2026-11-03).
 * Stored as micro-dollars per token so cost math stays in integers until the final round.
 * Cache writes (5-minute TTL) bill at 1.25x input.
 */
type Price = { input: number; output: number; cacheRead: number };
const OPUS: Price = { input: 4, output: 20, cacheRead: 0.2 };

export const PRICING: Record<string, Price> = {
  "claude-opus-5-5": OPUS,
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Cost in USD micros (1e-6 dollars). Unknown models price as Opus so cost is never under-reported. */
export function costMicros(model: string, u: TokenUsage): number {
  const p = PRICING[model] ?? OPUS;
  return Math.round(
    u.inputTokens * p.input +
      u.cacheWriteTokens * p.input * 1.25 +
      u.cacheReadTokens * p.cacheRead +
      u.outputTokens * p.output,
  );
}
