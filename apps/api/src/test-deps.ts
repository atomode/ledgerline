import type { ApiDeps } from "./deps.js";

/**
 * Inert dependencies for spec generation and route-level unit tests. Anything that would touch
 * Postgres or Redis throws, so a test that accidentally needs real I/O fails loudly.
 */
export function testDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const unavailable = new Proxy(
    {},
    {
      get: () => {
        throw new Error("real I/O dependency used in a unit test");
      },
    },
  );
  return {
    readinessChecks: {},
    logLevel: "silent",
    authenticate: async (token) =>
      token === "test-key"
        ? { tenantId: "00000000-0000-7000-8000-000000000001", apiKeyId: "k" }
        : null,
    admission: async () => ({ admit: true, waiting: 0, oldestWaitMs: 0, retryAfterSeconds: 0 }),
    db: unavailable as ApiDeps["db"],
    queues: unavailable as ApiDeps["queues"],
    dlqs: unavailable as ApiDeps["dlqs"],
    cursorSecret: "test-cursor-secret-0123",
    uploads: unavailable as ApiDeps["uploads"],
    invoices: unavailable as ApiDeps["invoices"],
    ...overrides,
  };
}
