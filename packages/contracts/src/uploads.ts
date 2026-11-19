import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.js";

export const MAX_FILES_PER_SESSION = 200;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const CreateUploadSessionRequest = z
  .object({
    files: z
      .array(
        z.object({
          clientRef: z
            .string()
            .min(1)
            .max(200)
            .meta({ description: "Caller's own id for the file" }),
          filename: z.string().min(1).max(255),
          contentType: z.literal("application/pdf"),
          sizeBytes: z.int().min(1).max(MAX_FILE_BYTES),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(MAX_FILES_PER_SESSION),
  })
  .meta({ id: "CreateUploadSessionRequest" });

export const UploadSession = z
  .object({
    id: Uuid,
    expiresAt: IsoDateTime,
    files: z.array(
      z.object({
        fileId: Uuid,
        clientRef: z.string(),
        uploadUrl: z.url().meta({ description: "Presigned PUT URL" }),
      }),
    ),
  })
  .meta({ id: "UploadSession" });

export const FileResult = z
  .discriminatedUnion("status", [
    z.object({
      fileId: Uuid,
      clientRef: z.string(),
      status: z.literal("accepted"),
      invoiceId: Uuid,
    }),
    z.object({
      fileId: Uuid,
      clientRef: z.string(),
      status: z.literal("duplicate"),
      invoiceId: Uuid,
    }),
    z.object({
      fileId: Uuid,
      clientRef: z.string(),
      status: z.literal("rejected"),
      reason: z.enum(["not_uploaded", "checksum_mismatch", "too_large", "not_pdf"]),
    }),
  ])
  .meta({ id: "FileResult" });

export const CompleteUploadSessionResponse = z
  .object({
    sessionId: Uuid,
    results: z.array(FileResult),
    counts: z.object({ accepted: z.int(), duplicate: z.int(), rejected: z.int() }),
  })
  .meta({ id: "CompleteUploadSessionResponse" });
