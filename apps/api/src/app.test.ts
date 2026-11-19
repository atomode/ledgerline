import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ readinessChecks: {}, logLevel: "silent" });
});
afterAll(() => app.close());

describe("API contract enforcement", () => {
  it("rejects an invalid body with problem+json listing each bad field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/upload-sessions",
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
    const res = await app.inject({ method: "GET", url: "/v1/invoices?limit=500" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 501 problem for stubbed handlers that pass validation", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/invoices?limit=10" });
    expect(res.statusCode).toBe(501);
    expect(res.json().title).toBe("Not Implemented");
  });

  it("returns problem+json for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});
