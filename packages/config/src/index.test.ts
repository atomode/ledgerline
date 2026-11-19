import { describe, expect, it } from "vitest";
import { ConfigError, loadEnv } from "./index.js";

const valid = {
  DATABASE_URL: "postgres://ledgerline:ledgerline@localhost:5432/ledgerline",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "invoices",
  S3_ACCESS_KEY_ID: "ledgerline",
  S3_SECRET_ACCESS_KEY: "local-secret",
  WEBHOOK_SIGNING_SECRET: "0123456789abcdef",
};

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(3000);
    expect(env.EXTRACTION_MODEL).toBe("claude-sonnet-5-5");
  });

  it("treats empty strings as unset", () => {
    const env = loadEnv({ ...valid, ANTHROPIC_API_KEY: "", API_PORT: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.API_PORT).toBe(3000);
  });

  it("fails fast and names every bad variable", () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: "nope", API_PORT: "70000" })).toThrowError(
      ConfigError,
    );
    try {
      loadEnv({ ...valid, DATABASE_URL: "nope", API_PORT: "70000" });
    } catch (e) {
      expect((e as Error).message).toContain("DATABASE_URL");
      expect((e as Error).message).toContain("API_PORT");
    }
  });
});
