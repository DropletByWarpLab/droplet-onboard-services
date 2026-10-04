/**
 * WARP-1505 — attachments on work items and comments: the row's lifecycle.
 *
 * The bytes are `pm-attachment-storage`'s; what a file may be is
 * `pm-attachment-content`'s. This module owns the ROW — `PmAttachment.status`
 * and the activity trail — and the order in which row and blob change, because
 * that order is what makes a crash harmless:
 *
 *   upload    row UPLOADING (before a byte streams) → bytes → row READY
 *   delete    row DELETED (the user's intent, durably, at once) → blob → row gone
 *   refuse    row FAILED → blob → row gone
 *
 * Only READY rows are ever listed or served. A process that dies between any two
 * of those steps leaves a row in UPLOADING, FAILED or DELETED, and `sweep…`
 * finishes the job on its next tick; it never leaves a blob that nothing points
 * at, because the row is always written first. The one exception is the
 * work-item / project hard delete, where the database cascade removes the rows
 * in the same transaction as the item — see `pm.service` and the note on
 * `removeAttachmentBlobs`.
 *
 * Every state flip is a conditional `updateMany` with the expected status in the
 * WHERE (the droplet-pr-review-patterns P1 shape), never find → check → update:
 * two tabs, or a tab and the sweep, cannot both win.
 *
 * Errors are plain `Error(code)` with stable string codes the route maps to HTTP,
 * like pm.service.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { PM_ERRORS, isPrismaCode } from "./pm.service.js";
import {
  evaluateAttachment,
  isPreviewableType,
  sanitizeAttachmentFileName,
} from "./pm-attachment-content.js";
import { isStorageKey, removeBlob, type StoredAttachmentFile } from "./pm-attachment-storage.js";

const logger = createLogger("pm-attachments");

export const PM_ATTACHMENT_ERRORS = {
  WORK_ITEM_NOT_FOUND: PM_ERRORS.WORK_ITEM_NOT_FOUND,
  COMMENT_NOT_FOUND: PM_ERRORS.COMMENT_NOT_FOUND,
  /** Missing, or not READY: an attachment that is not READY does not exist. */
  NOT_FOUND: "attachment_not_found",
  /** Only the uploader or an owner/admin may remove a file. */
  FORBIDDEN: "attachment_forbidden",
  /** An executable, by magic bytes, extension or claimed type. */
  TYPE_BLOCKED: "attachment_type_blocked",
  /** The name, the claimed type and the bytes do not agree. */
  TYPE_MISMATCH: "attachment_type_mismatch",
  EMPTY: "attachment_empty",
  TOO_LARGE: "attachment_too_large",
  BAD_REQUEST: "attachment_bad_request",
  FILE_REQUIRED: "attachment_file_required",
  STORAGE_FULL: "attachment_storage_full",
} as const;

/** An UPLOADING row older than this has no live request behind it. */
export const UPLOAD_STALE_MS = 60 * 60 * 1000;

/** Rows reaped per batch, and batches per tick: bounded work, the rest drains on
 *  the next tick (activity-notify's BATCH discipline). */
export const SWEEP_BATCH = 200;
const SWEEP_MAX_BATCHES = 10;

// ── API shape ────────────────────────────────────────────────────────────────

export interface ApiAttachment {
  id: string;
  workItemId: string;
  /** Set when the file was attached through a comment. */
  commentId: string | null;
  /** Display name — already cleaned of path parts and control/bidi characters. */
  fileName: string;
  /** The type the SERVER verified, not the client's claim. */
  mimeType: string;
  sizeBytes: number;
  /** True only for a verified raster image: the one thing the route serves inline. */
  previewable: boolean;
  uploadedById: string | null;
  createdAt: string;
}

type AttachmentRow = Prisma.PmAttachmentGetPayload<object>;

function mapAttachment(row: AttachmentRow): ApiAttachment {
  return {
    id: row.id,
    workItemId: row.workItemId,
    commentId: row.commentId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    // BigInt on the wire is a JSON error; the cap is MiB, far inside 2^53.
    sizeBytes: Number(row.sizeBytes),
    previewable: isPreviewableType(row.mimeType),
    uploadedById: row.uploadedById,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

/** READY attachments of a work item (item-level and comment-level), oldest first. */
export async function listAttachments(
  prisma: PrismaClient,
  workItemId: string,
): Promise<ApiAttachment[]> {
  const item = await prisma.pmWorkItem.findUnique({ where: { id: workItemId }, select: { id: true } });
  if (!item) throw new Error(PM_ATTACHMENT_ERRORS.WORK_ITEM_NOT_FOUND);
  const rows = await prisma.pmAttachment.findMany({
    where: { workItemId, status: "READY" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(mapAttachment);
}

/** What the download route needs. READY only — anything else is a 404. */
export interface ServableAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

export async function getServableAttachment(
  prisma: PrismaClient,
  id: string,
): Promise<ServableAttachment> {
  const row = await prisma.pmAttachment.findFirst({ where: { id, status: "READY" } });
  if (!row) throw new Error(PM_ATTACHMENT_ERRORS.NOT_FOUND);
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    storageKey: row.storageKey,
  };
}

// ── upload ───────────────────────────────────────────────────────────────────

export interface UploadTicket {
  id: string;
  storageKey: string;
}

/**
 * Step one of an upload: check the target and record the intent. The row exists
 * BEFORE the first byte streams, so a crash mid-upload leaves an UPLOADING row
 * the sweep can see, instead of a blob nothing remembers.
 *
 * `fileName` / `mimeType` / `sizeBytes` / `sha256` are placeholders until
 * `finalizeUpload` — the file part has not arrived yet. UPLOADING rows are never
 * listed or served, so nobody can observe them.
 */
export async function beginUpload(
  prisma: PrismaClient,
  input: { actorId: string | null; workItemId: string; commentId?: string | null },
): Promise<UploadTicket> {
  const item = await prisma.pmWorkItem.findUnique({
    where: { id: input.workItemId },
    select: { id: true },
  });
  if (!item) throw new Error(PM_ATTACHMENT_ERRORS.WORK_ITEM_NOT_FOUND);
  if (input.commentId) {
    // "A comment of THIS item": a comment id from another item must not let a
    // file hang off the wrong thread.
    const comment = await prisma.pmComment.findFirst({
      where: { id: input.commentId, workItemId: input.workItemId },
      select: { id: true },
    });
    if (!comment) throw new Error(PM_ATTACHMENT_ERRORS.COMMENT_NOT_FOUND);
  }

  const storageKey = randomUUID();
  try {
    const row = await prisma.pmAttachment.create({
      data: {
        workItemId: input.workItemId,
        commentId: input.commentId ?? null,
        fileName: "",
        mimeType: "application/octet-stream",
        sizeBytes: BigInt(0),
        sha256: "",
        storageKey,
        status: "UPLOADING",
        uploadedById: input.actorId,
      },
      select: { id: true },
    });
    return { id: row.id, storageKey };
  } catch (err) {
    // The item (or the comment) was deleted between the check and the insert.
    if (isPrismaCode(err, "P2003")) throw new Error(PM_ATTACHMENT_ERRORS.WORK_ITEM_NOT_FOUND);
    throw err;
  }
}

/**
 * Throw away an upload that did not complete — refused, over the cap, aborted by
 * the client, or a failure after the bytes landed. Idempotent, and it never
 * throws: it runs on the failure path of something else, and whatever it cannot
 * finish (database down, unlink refused) is exactly what the sweep is for.
 *
 * It NEVER unlinks the blob of a READY row. This runs on the error path of
 * `finalizeUpload`, and an error after the READY flip (an ambiguous commit, a
 * throw once the upload is published) must not turn a published file into a row
 * whose download 404s forever. So the blob goes only when the conditional flip to
 * FAILED just claimed the row, or the row is already gone / already garbage. If
 * the row's state cannot be read at all (the database is down), nothing is
 * touched: the row stays UPLOADING and the sweep reaps it, blob included, after
 * an hour — safe whichever way the commit went.
 */
export async function abortUpload(
  prisma: PrismaClient,
  ticket: UploadTicket,
  root: string = config.PM_ATTACHMENTS_DIR,
): Promise<void> {
  try {
    const flipped = await prisma.pmAttachment.updateMany({
      where: { id: ticket.id, status: "UPLOADING" },
      data: { status: "FAILED" },
    });
    if (flipped.count === 0) {
      // Not UPLOADING any more: published, already garbage, or gone.
      const row = await prisma.pmAttachment.findUnique({
        where: { id: ticket.id },
        select: { status: true },
      });
      if (row?.status === "READY") return;
    }
    await removeBlob(root, ticket.storageKey);
    await prisma.pmAttachment.deleteMany({ where: { id: ticket.id, status: "FAILED" } });
  } catch (err) {
    logger.warn({ err, attachmentId: ticket.id }, "aborted upload left for the sweep");
  }
}

/**
 * The last step of an upload: the bytes are on disk, hashed. Decide what the
 * file is, and either publish it (UPLOADING → READY + an activity row, one
 * transaction) or throw it away.
 *
 * Any throw leaves nothing behind — the row and the blob are removed first.
 */
export async function finalizeUpload(
  prisma: PrismaClient,
  input: {
    ticket: UploadTicket;
    workItemId: string;
    actorId: string | null;
    file: { originalname: string; mimetype: string } & StoredAttachmentFile;
    root?: string;
  },
): Promise<ApiAttachment> {
  const { ticket, file } = input;
  try {
    // An empty file is a mistake worth naming, not a "doesn't match its name".
    if (file.size === 0) throw new Error(PM_ATTACHMENT_ERRORS.EMPTY);

    const fileName = sanitizeAttachmentFileName(file.originalname);
    const verdict = evaluateAttachment({
      fileName,
      claimedMime: file.mimetype,
      head: file.head,
    });
    if (!verdict.ok) {
      throw new Error(
        verdict.reason === "blocked"
          ? PM_ATTACHMENT_ERRORS.TYPE_BLOCKED
          : PM_ATTACHMENT_ERRORS.TYPE_MISMATCH,
      );
    }

    return await prisma.$transaction(async (tx) => {
      const flipped = await tx.pmAttachment.updateMany({
        where: { id: ticket.id, status: "UPLOADING" },
        data: {
          status: "READY",
          fileName,
          mimeType: verdict.mimeType,
          sizeBytes: BigInt(file.size),
          sha256: file.sha256,
        },
      });
      // Zero rows: the work item was deleted (the cascade took the row) or the
      // sweep reaped a stalled upload while this one was still streaming.
      if (flipped.count !== 1) throw new Error(PM_ATTACHMENT_ERRORS.NOT_FOUND);
      await tx.pmActivity.create({
        data: {
          workItemId: input.workItemId,
          actorId: input.actorId,
          verb: "attachment_added",
          field: "attachment",
          newValue: fileName,
        },
      });
      return mapAttachment(await tx.pmAttachment.findUniqueOrThrow({ where: { id: ticket.id } }));
    });
  } catch (err) {
    await abortUpload(prisma, ticket, input.root);
    throw err;
  }
}

// ── delete ───────────────────────────────────────────────────────────────────

/**
 * Remove one attachment. The uploader may; so may an owner or admin; nobody else.
 *
 * The row flips to DELETED first (invisible from that instant, and recorded in
 * the activity feed in the same transaction) and the blob goes AFTER it — so a
 * failure between the two never leaves a visible row pointing at a missing file.
 * A blob that will not unlink leaves a DELETED row; the sweep retries it.
 */
export async function deleteAttachment(
  prisma: PrismaClient,
  actor: { id: string | null; isAdmin: boolean },
  attachmentId: string,
  root: string = config.PM_ATTACHMENTS_DIR,
): Promise<void> {
  const row = await prisma.pmAttachment.findFirst({
    where: { id: attachmentId, status: "READY" },
    select: { id: true, workItemId: true, fileName: true, storageKey: true, uploadedById: true },
  });
  if (!row) throw new Error(PM_ATTACHMENT_ERRORS.NOT_FOUND);
  const isUploader = actor.id !== null && row.uploadedById === actor.id;
  if (!actor.isAdmin && !isUploader) throw new Error(PM_ATTACHMENT_ERRORS.FORBIDDEN);

  await prisma.$transaction(async (tx) => {
    const flipped = await tx.pmAttachment.updateMany({
      where: { id: row.id, status: "READY" },
      data: { status: "DELETED" },
    });
    // Someone removed it between the read above and this write.
    if (flipped.count !== 1) throw new Error(PM_ATTACHMENT_ERRORS.NOT_FOUND);
    await tx.pmActivity.create({
      data: {
        workItemId: row.workItemId,
        actorId: actor.id,
        verb: "attachment_removed",
        field: "attachment",
        oldValue: row.fileName,
      },
    });
  });

  // The user's intent is recorded. What remains is housekeeping: any failure
  // below is the sweep's to finish, and must not turn a successful delete into
  // an error the user would retry.
  try {
    await removeBlob(root, row.storageKey);
    await prisma.pmAttachment.deleteMany({ where: { id: row.id, status: "DELETED" } });
  } catch (err) {
    logger.error({ err, attachmentId: row.id }, "removed attachment left for the sweep");
  }
}

// ── sweep ────────────────────────────────────────────────────────────────────

export interface AttachmentSweepResult {
  /** UPLOADING rows older than the cutoff, now FAILED. */
  staleUploads: number;
  /** Rows whose blob is gone and which were deleted. */
  reaped: number;
  /** Rows left for the next tick (the blob would not unlink). */
  failed: number;
}

/**
 * Finish whatever a crash, a client that went away or a full disk left half done:
 * UPLOADING rows older than an hour become FAILED (no live request is still
 * streaming into them), then every FAILED and DELETED row has its blob unlinked
 * and is deleted. Idempotent, and every step tolerates a blob that is already
 * gone. Registered on `cron-runtime` in index.ts.
 */
export async function sweepAttachments(
  prisma: PrismaClient,
  opts: { root?: string; now?: Date } = {},
): Promise<AttachmentSweepResult> {
  const root = opts.root ?? config.PM_ATTACHMENTS_DIR;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - UPLOAD_STALE_MS);

  const stale = await prisma.pmAttachment.updateMany({
    where: { status: "UPLOADING", createdAt: { lt: cutoff } },
    data: { status: "FAILED" },
  });

  let reaped = 0;
  let failed = 0;
  let after: string | undefined;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const rows = await prisma.pmAttachment.findMany({
      where: { status: { in: ["FAILED", "DELETED"] }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, storageKey: true },
      orderBy: { id: "asc" },
      take: SWEEP_BATCH,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        // A key this store never minted (a row from before the volume existed —
        // the migration marks those FAILED) has no blob: there is nothing to
        // unlink, and the key is never joined onto the root.
        if (isStorageKey(row.storageKey)) await removeBlob(root, row.storageKey);
        await prisma.pmAttachment.deleteMany({
          where: { id: row.id, status: { in: ["FAILED", "DELETED"] } },
        });
        reaped += 1;
      } catch (err) {
        failed += 1;
        logger.error({ err, attachmentId: row.id }, "attachment sweep could not finish a row");
      }
    }
    after = rows[rows.length - 1].id;
    if (rows.length < SWEEP_BATCH) break;
  }
  return { staleUploads: stale.count, reaped, failed };
}
