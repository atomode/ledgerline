import { describe, expect, it } from "vitest";
import { createAdmissionController } from "./admission.js";

const fakeQueue = (waiting: number, oldestTs: number | null) => ({
  getWaitingCount: async () => waiting,
  getJobs: async () => (oldestTs === null ? [] : [{ timestamp: oldestTs }]),
});

describe("admission control", () => {
  const now = () => 1_000_000_000;
  it("admits under both limits", async () => {
    const check = createAdmissionController(fakeQueue(10, now() - 1_000) as never, { now });
    expect((await check()).admit).toBe(true);
  });
  it("rejects on depth or on age, with a Retry-After hint", async () => {
    const deep = await createAdmissionController(fakeQueue(5_001, now()) as never, { now })();
    expect(deep.admit).toBe(false);
    const old = await createAdmissionController(fakeQueue(3, now() - 16 * 60_000) as never, {
      now,
    })();
    expect(old.admit).toBe(false);
    expect(old.retryAfterSeconds).toBeGreaterThanOrEqual(30);
  });
  it("caches the decision briefly", async () => {
    let calls = 0;
    const q = { getWaitingCount: async () => (calls++, 0), getJobs: async () => [] };
    const check = createAdmissionController(q as never, { now, cacheMs: 1_000 });
    await check();
    await check();
    expect(calls).toBe(1);
  });
});
