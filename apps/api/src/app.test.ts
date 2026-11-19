import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { testDeps } from "./test-deps.js";

const auth = { authorization: "Bearer test-key" };

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(testDeps());
});
afterAll(() => app.close());

describe("API contract enforcement", () => {
  it("rejects an invalid body with problem+json listing each bad field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers: auth,
      payload: {
        files: [
          {
            clientRef: "a",
            filename: "a.pdf",
            contentType: "image/png",
            sizeBytes: 0,
            sha256: "x",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    const paths = res.json().errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "body/files/0/contentType",
        "body/files/0/sizeBytes",
        "body/files/0/sha256",
      ]),
    );
  });

  it("rejects a limit above 200 on list endpoints", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/invoices?limit=500", headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it("returns 501 problem for stubbed handlers that pass validation", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/invoices?limit=10", headers: auth });
    expect(res.statusCode).toBe(501);
    expect(res.json().title).toBe("Not Implemented");
  });

  it("requires an API key everywhere except health probes", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/invoices" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    const bad = await app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("returns problem+json for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});

describe("upload backpressure", () => {
  it("returns 429 with Retry-After when the extract queue is saturated", async () => {
    const saturated = await buildApp(
      testDeps({
        admission: async () => ({
          admit: false,
          waiting: 6200,
          oldestWaitMs: 1_200_000,
          retryAfterSeconds: 300,
        }),
      }),
    );
    const res = await saturated.inject({
      method: "POST",
      url: "/v1/upload-sessions",
      headers: auth,
      payload: {
        files: [
          {
            clientRef: "a",
            filename: "a.pdf",
            contentType: "application/pdf",
            sizeBytes: 10,
            sha256: "a".repeat(64),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("300");
    expect(res.json().detail).toContain("6200 waiting");
    await saturated.close();
  });
});
