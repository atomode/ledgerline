import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@ledgerline/db";
import { stageJobId, type StageQueues } from "@ledgerline/queues";
import type { Storage } from "@ledgerline/storage";
import type { z } from "zod";
import type {
  CompleteUploadSessionResponse,
  CreateUploadSessionRequest,
  FileResult,
} from "@ledgerline/contracts";

export const SESSION_TTL_MS = 60 * 60_000;
type FileResultT = z.infer<typeof FileResult>;
type RejectReason = Extract<FileResultT, { status: "rejected" }>["reason"];

export class SessionNotFoundError extends Error {}
export class SessionExpiredError extends Error {}

const PG_UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (err: unknown) =>
  (err as { code?: string; cause?: { code?: string } }).code === PG_UNIQUE_VIOLATION ||
  (err as { cause?: { code?: string } }).cause?.code === PG_UNIQUE_VIOLATION;

export function createUploadService(deps: { db: Db; storage: Storage; queues: StageQueues }) {
  const { db, storage, queues } = deps;

  async function createSession(tenantId: string, req: z.infer<typeof CreateUploadSessionRequest>) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    return db.transaction(async (tx) => {
      const [session] = await tx
        .insert(schema.uploadSessions)
        .values({ tenantId, expiresAt })
        .returning();
      if (!session) throw new Error("failed to create session");
      const rows = await tx
        .insert(schema.files)
        .values(
          req.files.map((f) => ({
            tenantId,
            uploadSessionId: session.id,
            clientRef: f.clientRef,
            filename: f.filename,
            sizeBytes: f.sizeBytes,
            sha256: f.sha256,
            storageKey: `${tenantId}/${session.id}/${f.sha256}.pdf`,
          })),
        )
        .returning();
      const files = await Promise.all(
        rows.map(async (r) => ({
          fileId: r.id,
          clientRef: r.clientRef,
          uploadUrl: await storage.presignPut(
            r.storageKey,
            "application/pdf",
            SESSION_TTL_MS / 1000,
          ),
        })),
      );
      return { id: session.id, expiresAt: expiresAt.toISOString(), files };
    });
  }

  /** Check one uploaded object against what the client declared. Downloads to verify the hash. */
  async function verify(
    file: typeof schema.files.$inferSelect,
  ): Promise<"accepted" | RejectReason> {
    const head = await storage.headObject(file.storageKey);
    if (!head) return "not_uploaded";
    if (head.sizeBytes !== file.sizeBytes) return "checksum_mismatch";
    const body = await storage.getObject(file.storageKey);
    if (body.subarray(0, 5).toString("latin1") !== "%PDF-") return "not_pdf";
    if (createHash("sha256").update(body).digest("hex") !== file.sha256) return "checksum_mismatch";
    return "accepted";
  }

  /**
   * Finish a session. Partial success is the normal case: every file gets its own outcome.
   * Safe to call repeatedly: only `pending` files are processed, and the response is rebuilt
   * from file state, so a retry returns the same answer without re-enqueueing anything.
   */
  async function completeSession(
    tenantId: string,
    sessionId: string,
  ): Promise<z.infer<typeof CompleteUploadSessionResponse>> {
    const [session] = await db
      .select()
      .from(schema.uploadSessions)
      .where(
        and(eq(schema.uploadSessions.id, sessionId), eq(schema.uploadSessions.tenantId, tenantId)),
      );
    if (!session) throw new SessionNotFoundError(sessionId);
    if (!session.completedAt && session.expiresAt < new Date())
      throw new SessionExpiredError(sessionId);

    const files = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.uploadSessionId, sessionId));
    const toEnqueue: string[] = [];

    // Verify in parallel (bounded) but commit one file per transaction, so one duplicate can't
    // roll back its neighbours.
    const pending = files.filter((f) => f.status === "pending");
    for (let i = 0; i < pending.length; i += 8) {
      await Promise.all(
        pending.slice(i, i + 8).map(async (file) => {
          const verdict = await verify(file);
          if (verdict !== "accepted") {
            await db
              .update(schema.files)
              .set({ status: "rejected", rejectionReason: verdict })
              .where(eq(schema.files.id, file.id));
            return;
          }
          try {
            const invoiceId = await db.transaction(async (tx) => {
              await tx
                .update(schema.files)
                .set({ status: "accepted" })
                .where(eq(schema.files.id, file.id));
              const [inv] = await tx
                .insert(schema.invoices)
                .values({ tenantId, fileId: file.id, status: "received" })
                .returning({ id: schema.invoices.id });
              return inv?.id;
            });
            if (invoiceId) toEnqueue.push(invoiceId);
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            // Same bytes already accepted for this tenant: report the existing invoice.
            await db
              .update(schema.files)
              .set({ status: "duplicate" })
              .where(eq(schema.files.id, file.id));
          }
        }),
      );
    }

    await db
      .update(schema.uploadSessions)
      .set({ completedAt: session.completedAt ?? new Date() })
      .where(eq(schema.uploadSessions.id, sessionId));

    // Enqueue after commit; the reconciler covers a crash between the two.
    for (const invoiceId of toEnqueue) {
      await queues.classify.add(
        "classify",
        { invoiceId, tenantId },
        { jobId: stageJobId(invoiceId, "classify") },
      );
    }

    // Rebuild the full answer from durable state.
    const finalFiles = await db
      .select()
      .from(schema.files)
      .where(eq(schema.files.uploadSessionId, sessionId));
    const shas = finalFiles
      .filter((f) => f.status === "accepted" || f.status === "duplicate")
      .map((f) => f.sha256);
    const owners = shas.length
      ? await db
          .select({ sha256: schema.files.sha256, invoiceId: schema.invoices.id })
          .from(schema.files)
          .innerJoin(schema.invoices, eq(schema.invoices.fileId, schema.files.id))
          .where(
            and(
              eq(schema.files.tenantId, tenantId),
              eq(schema.files.status, "accepted"),
              inArray(schema.files.sha256, shas),
            ),
          )
      : [];
    const invoiceBySha = new Map(owners.map((o) => [o.sha256, o.invoiceId]));

    const results: FileResultT[] = finalFiles.map((f) => {
      const base = { fileId: f.id, clientRef: f.clientRef };
      const invoiceId = invoiceBySha.get(f.sha256);
      if (f.status === "accepted" && invoiceId) return { ...base, status: "accepted", invoiceId };
      if (f.status === "duplicate" && invoiceId) return { ...base, status: "duplicate", invoiceId };
      return {
        ...base,
        status: "rejected",
        reason: (f.rejectionReason as RejectReason | null) ?? "not_uploaded",
      };
    });
    const count = (s: FileResultT["status"]) => results.filter((r) => r.status === s).length;
    return {
      sessionId,
      results,
      counts: {
        accepted: count("accepted"),
        duplicate: count("duplicate"),
        rejected: count("rejected"),
      },
    };
  }

  return { createSession, completeSession };
}
export type UploadService = ReturnType<typeof createUploadService>;
