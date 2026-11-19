import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, RetryableError, fullJitterBackoff } from "./backoff.js";

describe("fullJitterBackoff", () => {
  it("stays within [0, min(cap, base*2^(n-1))] for any attempt and random draw", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (n, r) => {
          const d = fullJitterBackoff(n, undefined, () => r);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1)));
        },
      ),
    );
  });

  it("grows the ceiling exponentially then caps", () => {
    const max = (n: number) => fullJitterBackoff(n, undefined, () => 0.999999);
    expect(max(1)).toBeLessThan(BACKOFF_BASE_MS);
    expect(max(2)).toBeGreaterThan(max(1));
    expect(max(30)).toBeLessThan(BACKOFF_CAP_MS);
  });

  it("never retries sooner than the server's Retry-After", () => {
    const err = new RetryableError("429", 45_000);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.double({ min: 0, max: 0.999999, noNaN: true }),
        (n, r) => {
          expect(fullJitterBackoff(n, err, () => r)).toBeGreaterThanOrEqual(45_000);
        },
      ),
    );
    // ...even beyond the cap, because the server knows better than our cap.
    expect(fullJitterBackoff(1, new RetryableError("429", 120_000), () => 0)).toBe(120_000);
  });
});
