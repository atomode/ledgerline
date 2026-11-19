import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { UnrecoverableError } from "bullmq";
import { RetryableError } from "@ledgerline/queues";
import { ObjectNotFoundError } from "@ledgerline/storage";
import { classifyError, errorChain } from "./errors.js";
import { isFinalFailure } from "./stage-worker.js";

const apiError = (status: number, headers: Record<string, string> = {}) =>
  Anthropic.APIError.generate(
    status,
    { type: "error", error: { type: "x", message: "x" } },
    "x",
    new Headers(headers),
  );

describe("classifyError", () => {
  it.each([408, 409, 429, 500, 503, 529])("Anthropic %i is retryable", (status) => {
    expect(classifyError(apiError(status))).toBeInstanceOf(RetryableError);
  });

  it.each([400, 401, 403, 404, 413])("Anthropic %i is unrecoverable", (status) => {
    expect(classifyError(apiError(status))).toBeInstanceOf(UnrecoverableError);
  });

  it("carries Retry-After seconds into the retry delay", () => {
    const err = classifyError(apiError(429, { "retry-after": "7" })) as RetryableError;
    expect(err.retryAfterMs).toBe(7_000);
  });

  it("treats connection errors as retryable", () => {
    const err = new Anthropic.APIConnectionError({ message: "socket hang up" });
    expect(classifyError(err)).toBeInstanceOf(RetryableError);
  });

  it("a missing source PDF is unrecoverable: retrying can't make it appear", () => {
    expect(classifyError(new ObjectNotFoundError("k"))).toBeInstanceOf(UnrecoverableError);
  });

  it("unknown errors default to retryable (plain Error passes through)", () => {
    const e = new Error("ECONNRESET");
    expect(classifyError(e)).toBe(e);
  });
});

describe("isFinalFailure", () => {
  const job = (attemptsMade: number, attempts = 5) => ({ attemptsMade, opts: { attempts } });
  it("is false while attempts remain", () => {
    expect(isFinalFailure(job(2), new Error("x"))).toBe(false);
  });
  it("is true once attempts are exhausted", () => {
    expect(isFinalFailure(job(5), new Error("x"))).toBe(true);
  });
  it("is true immediately for unrecoverable errors", () => {
    expect(isFinalFailure(job(1), new UnrecoverableError("x"))).toBe(true);
  });
});

describe("errorChain", () => {
  it("walks causes, capped at 5", () => {
    let e: Error = new Error("root");
    for (let i = 0; i < 10; i++) e = new Error(`wrap ${i}`, { cause: e });
    const chain = errorChain(e);
    expect(chain).toHaveLength(5);
    expect(chain[0]?.message).toBe("wrap 9");
  });
});
