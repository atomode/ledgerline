import { describe, expect, it } from "vitest";
import { runReadiness } from "./readiness.js";

describe("runReadiness", () => {
  it("is ok when every check passes", async () => {
    const r = await runReadiness({ a: async () => {}, b: async () => {} });
    expect(r.status).toBe("ok");
  });

  it("is degraded when a check throws or hangs, and reports which", async () => {
    const r = await runReadiness(
      {
        good: async () => {},
        broken: async () => {
          throw new Error("connection refused");
        },
        hung: () => new Promise(() => {}),
      },
      50,
    );
    expect(r.status).toBe("degraded");
    expect(r.checks.broken?.error).toBe("connection refused");
    expect(r.checks.hung?.error).toContain("timed out");
    expect(r.checks.good?.ok).toBe(true);
  });
});
