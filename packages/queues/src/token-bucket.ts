import type { Redis } from "ioredis";

/**
 * Distributed token bucket in Redis, shared by every worker process. Used to keep the whole fleet
 * under the Anthropic input-tokens-per-minute (ITPM) budget, which is the limit PDF extraction hits
 * first (a scanned page costs ~1.5-3k input tokens; requests-per-minute is rarely the constraint).
 *
 * KEYS[1] bucket key; ARGV: capacity, refillPerMs, cost, nowMs
 * Returns 0 when granted, otherwise milliseconds until enough tokens will exist.
 */
const LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)
local wait = 0
if cost > capacity then cost = capacity end
if tokens >= cost then
  tokens = tokens - cost
else
  wait = math.ceil((cost - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate) * 2)
return wait
`;

export interface TokenBucket {
  /** 0 = granted now; otherwise how long to wait before trying again. */
  tryAcquire(cost: number): Promise<number>;
}

export function createTokenBucket(
  redis: Redis,
  key: string,
  capacityPerMinute: number,
  now: () => number = Date.now,
): TokenBucket {
  const refillPerMs = capacityPerMinute / 60_000;
  return {
    async tryAcquire(cost) {
      const wait = await redis.eval(LUA, 1, key, capacityPerMinute, refillPerMs, cost, now());
      return Number(wait);
    },
  };
}
