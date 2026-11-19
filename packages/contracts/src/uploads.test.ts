import { describe, expect, it } from "vitest";
import {
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SESSION,
} from "./uploads.js";
import { DlqItem } from "./admin.js";
import { ReadinessResponse } from "./health.js";

const file = (over: Record<string, unknown> = {}) => ({
  clientRef: "r1",
  filename: "a.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
  sha256: "a".repeat(64),
  ...over,
});

describe("CreateUploadSessionRequest", () => {
  it("accepts a well-formed batch", () => {
    expect(CreateUploadSessionRequest.safeParse({ files: [file()] }).success).toBe(true);
  });

  it.each([
    ["empty batch", { files: [] }],
    ["too many files", { files: Array.from({ length: MAX_FILES_PER_SESSION + 1 }, () => file()) }],
    ["file over the size cap", { files: [file({ sizeBytes: MAX_FILE_BYTES + 1 })] }],
    ["uppercase / short sha256", { files: [file({ sha256: "ABC" })] }],
    ["non-PDF content type", { files: [file({ contentType: "image/png" })] }],
  ])("rejects %s", (_name, body) => {
    expect(CreateUploadSessionRequest.safeParse(body).success).toBe(false);
  });
});

describe("response schemas", () => {
  it("a rejected file must carry a reason, an accepted one an invoiceId", () => {
    const base = {
      sessionId: "0190a000-0000-7000-8000-000000000001",
      counts: { accepted: 0, duplicate: 0, rejected: 1 },
    };
    const fileId = "0190a000-0000-7000-8000-000000000002";
    expect(
      CompleteUploadSessionResponse.safeParse({
        ...base,
        results: [{ fileId, clientRef: "x", status: "rejected" }],
      }).success,
    ).toBe(false);
    expect(
      CompleteUploadSessionResponse.safeParse({
        ...base,
        results: [{ fileId, clientRef: "x", status: "rejected", reason: "not_pdf" }],
      }).success,
    ).toBe(true);
  });

  it("readiness reports per-dependency checks and only ok/degraded", () => {
    const check = { ok: false, latencyMs: 3, error: "ECONNREFUSED" };
    expect(
      ReadinessResponse.safeParse({ status: "degraded", checks: { redis: check } }).success,
    ).toBe(true);
    expect(ReadinessResponse.safeParse({ status: "down", checks: {} }).success).toBe(false);
  });

  it("a DLQ item without its job id is invalid", () => {
    expect(DlqItem.safeParse({}).success).toBe(false);
  });
});
