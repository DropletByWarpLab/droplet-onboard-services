/**
 * WARP-1505 — the attachment row lifecycle.
 *
 * An in-memory Prisma fake that implements the one thing this service's
 * correctness hangs on — a conditional `updateMany` — plus REAL files in a temp
 * directory, so "the blob is gone" and "the blob is still there" are asserted on
 * disk, not on a mock. The database-level invariants (CHECK, cascades) are in
 * pm-attachment.pg.test.ts against a real Postgres.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PM_ATTACHMENT_ERRORS as E,
  SWEEP_BATCH,
  UPLOAD_STALE_MS,
  abortUpload,
  beginUpload,
  deleteAttachment,
  finalizeUpload,
  getServableAttachment,
  listAttachments,
  sweepAttachments,
} from "./pm-attachments.service.js";
import { blobPath } from "./pm-attachment-storage.js";
import { makeAttachmentFake as makeFake } from "../../__tests__/helpers/pm-attachment-fake.js";

type Row = Record<string, unknown>;

// ── fixtures ─────────────────────────────────────────────────────────────────

const PNG_HEAD = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)]);
const PE_HEAD = (() => {
  const b = Buffer.alloc(256);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  return b;
})();

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pm-attach-svc-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeBlob(key: string, bytes: Buffer | string = "bytes"): void {
  mkdirSync(join(root, key.slice(0, 2)), { recursive: true });
  writeFileSync(blobPath(root, key), bytes);
}
const blobExists = (key: string): boolean => existsSync(blobPath(root, key));

/** An UPLOADING row + its blob, as `beginUpload` and the engine leave them. */
async function startUpload(
  f: ReturnType<typeof makeFake>,
  opts: { actorId?: string | null; workItemId?: string; commentId?: string | null; write?: boolean } = {},
) {
  const ticket = await beginUpload(f.prisma, {
    actorId: opts.actorId === undefined ? "u-1" : opts.actorId,
    workItemId: opts.workItemId ?? "wi-1",
    commentId: opts.commentId,
  });
  if (opts.write !== false) writeBlob(ticket.storageKey, "uploaded bytes");
  return ticket;
}

const file = (over: Partial<{ originalname: string; mimetype: string; size: number; head: Buffer }> = {}) => ({
  originalname: "photo.png",
  mimetype: "image/png",
  size: 14,
  sha256: createHash("sha256").update("uploaded bytes").digest("hex"),
  head: PNG_HEAD,
  ...over,
});

// ── beginUpload ──────────────────────────────────────────────────────────────

describe("beginUpload", () => {
  it("records the intent BEFORE any byte exists: an UPLOADING row with placeholders", async () => {
    const f = makeFake();
    const ticket = await beginUpload(f.prisma, { actorId: "u-1", workItemId: "wi-1" });

    expect(ticket.storageKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(f.db.attachments).toHaveLength(1);
    expect(f.db.attachments[0]).toMatchObject({
      id: ticket.id,
      workItemId: "wi-1",
      commentId: null,
      status: "UPLOADING",
      storageKey: ticket.storageKey,
      uploadedById: "u-1",
      sha256: "",
      fileName: "",
    });
    expect(f.db.activity).toEqual([]); // nothing is "added" until it is READY
  });

  it("attaches to a comment of the SAME item", async () => {
    const f = makeFake();
    await beginUpload(f.prisma, { actorId: "u-1", workItemId: "wi-1", commentId: "c-1" });
    expect(f.db.attachments[0].commentId).toBe("c-1");
  });

  it("refuses a comment that belongs to another work item", async () => {
    const f = makeFake();
    await expect(
      beginUpload(f.prisma, { actorId: "u-1", workItemId: "wi-1", commentId: "c-2" }),
    ).rejects.toThrow(E.COMMENT_NOT_FOUND);
    expect(f.db.attachments).toEqual([]);
  });

  it("refuses a work item that does not exist, and writes nothing", async () => {
    const f = makeFake();
    await expect(beginUpload(f.prisma, { actorId: "u-1", workItemId: "nope" })).rejects.toThrow(
      E.WORK_ITEM_NOT_FOUND,
    );
    expect(f.db.attachments).toEqual([]);
  });

  it("maps an FK violation (the item was deleted between check and insert) to work_item_not_found", async () => {
    const f = makeFake();
    f.hooks.createError = Object.assign(new Error("fk"), { code: "P2003" });
    await expect(beginUpload(f.prisma, { actorId: "u-1", workItemId: "wi-1" })).rejects.toThrow(
      E.WORK_ITEM_NOT_FOUND,
    );
  });

  it("lets any other database error through untouched", async () => {
    const f = makeFake();
    f.hooks.createError = new Error("connection reset");
    await expect(beginUpload(f.prisma, { actorId: "u-1", workItemId: "wi-1" })).rejects.toThrow(
      "connection reset",
    );
  });
});

// ── finalizeUpload ───────────────────────────────────────────────────────────

describe("finalizeUpload", () => {
  it("publishes: UPLOADING -> READY with the VERIFIED type, and one attachment_added activity row", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);

    const out = await finalizeUpload(f.prisma, {
      ticket,
      workItemId: "wi-1",
      actorId: "u-1",
      file: file(),
      root,
    });

    expect(out).toMatchObject({
      id: ticket.id,
      workItemId: "wi-1",
      commentId: null,
      fileName: "photo.png",
      mimeType: "image/png",
      sizeBytes: 14,
      previewable: true,
      uploadedById: "u-1",
    });
    expect(typeof out.createdAt).toBe("string");
    expect(f.db.attachments[0]).toMatchObject({
      status: "READY",
      sizeBytes: BigInt(14),
      sha256: file().sha256,
      mimeType: "image/png",
    });
    expect(f.db.activity).toEqual([
      expect.objectContaining({
        workItemId: "wi-1",
        actorId: "u-1",
        verb: "attachment_added",
        field: "attachment",
        newValue: "photo.png",
      }),
    ]);
    expect(blobExists(ticket.storageKey)).toBe(true);
  });

  it("records what the SERVER verified, not what the client claimed", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    const out = await finalizeUpload(f.prisma, {
      ticket,
      workItemId: "wi-1",
      actorId: "u-1",
      file: file({ originalname: "blob", mimetype: "application/x-made-up", head: Buffer.from("plain text") }),
      root,
    });
    expect(out.mimeType).toBe("application/octet-stream");
    expect(out.previewable).toBe(false);
  });

  it("stores a CLEANED display name (path parts and bidi controls gone)", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    const out = await finalizeUpload(f.prisma, {
      ticket,
      workItemId: "wi-1",
      actorId: "u-1",
      file: file({ originalname: "../../etc/inv‮oice.png" }),
      root,
    });
    expect(out.fileName).toBe("invoice.png");
    expect(f.db.activity[0].newValue).toBe("invoice.png");
  });

  it.each([
    ["an executable by its bytes", { originalname: "photo.png", head: PE_HEAD }, E.TYPE_BLOCKED],
    ["an executable by its extension", { originalname: "setup.exe", head: Buffer.from("x"), mimetype: "text/plain" }, E.TYPE_BLOCKED],
    ["a name that lies about the bytes", { originalname: "evil.png", head: Buffer.from("%PDF-1.4 ......"), mimetype: "image/png" }, E.TYPE_MISMATCH],
    ["an empty file", { size: 0, head: Buffer.alloc(0) }, E.EMPTY],
  ])("refuses %s — and leaves neither a row nor a blob behind", async (_n, over, code) => {
    const f = makeFake();
    const ticket = await startUpload(f);

    await expect(
      finalizeUpload(f.prisma, { ticket, workItemId: "wi-1", actorId: "u-1", file: file(over), root }),
    ).rejects.toThrow(code);

    expect(f.db.attachments).toEqual([]);
    expect(f.db.activity).toEqual([]);
    expect(blobExists(ticket.storageKey)).toBe(false);
  });

  it("when the work item vanished mid-upload (the row is gone) it reports not-found and removes the blob", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    f.db.attachments = []; // the cascade took the row

    await expect(
      finalizeUpload(f.prisma, { ticket, workItemId: "wi-1", actorId: "u-1", file: file(), root }),
    ).rejects.toThrow(E.NOT_FOUND);
    expect(blobExists(ticket.storageKey)).toBe(false);
    expect(f.db.activity).toEqual([]);
  });

  it("an ambiguous commit error AFTER the READY flip leaves the published file alone", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    // The flip commits, then the connection dies before the client hears about it.
    const db = f.prisma as unknown as { $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    const commit = db.$transaction.bind(db);
    db.$transaction = async (fn) => {
      await commit(fn);
      throw new Error("connection lost at commit");
    };

    await expect(
      finalizeUpload(f.prisma, { ticket, workItemId: "wi-1", actorId: "u-1", file: file(), root }),
    ).rejects.toThrow("connection lost at commit");

    expect(f.db.attachments[0].status).toBe("READY"); // it DID publish...
    expect(blobExists(ticket.storageKey)).toBe(true); // ...so its file must still be there
  });

  it("never flips a row that is not UPLOADING (a sweep already claimed it)", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    f.db.attachments[0].status = "FAILED";

    await expect(
      finalizeUpload(f.prisma, { ticket, workItemId: "wi-1", actorId: "u-1", file: file(), root }),
    ).rejects.toThrow(E.NOT_FOUND);
    expect(f.db.attachments).toEqual([]); // abort finished the sweep's job
  });
});

// ── abortUpload ──────────────────────────────────────────────────────────────

describe("abortUpload", () => {
  it("marks the row FAILED, unlinks the blob, deletes the row", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    await abortUpload(f.prisma, ticket, root);
    expect(f.db.attachments).toEqual([]);
    expect(blobExists(ticket.storageKey)).toBe(false);
  });

  it("is idempotent", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    await abortUpload(f.prisma, ticket, root);
    await expect(abortUpload(f.prisma, ticket, root)).resolves.toBeUndefined();
  });

  it("never throws when the database is down — and touches NOTHING: the row's state is unknown, and the sweep reaps it", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    f.hooks.updateManyError = new Error("db down");
    await expect(abortUpload(f.prisma, ticket, root)).resolves.toBeUndefined();
    // It cannot tell UPLOADING from "published a moment ago", so the blob stays:
    // the row is still UPLOADING and the sweep takes both after an hour.
    expect(blobExists(ticket.storageKey)).toBe(true);
    expect(f.db.attachments).toHaveLength(1);
    expect(f.db.attachments[0].status).toBe("UPLOADING");
  });

  it("NEVER deletes a READY row or its blob (a late abort cannot take a published file)", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    f.db.attachments[0].status = "READY";
    await abortUpload(f.prisma, ticket, root);
    expect(f.db.attachments).toHaveLength(1);
    expect(f.db.attachments[0].status).toBe("READY");
    expect(blobExists(ticket.storageKey)).toBe(true); // the file a download will ask for
  });

  it("still removes the blob when the row is already gone (the cascade took it)", async () => {
    const f = makeFake();
    const ticket = await startUpload(f);
    f.db.attachments = [];
    await abortUpload(f.prisma, ticket, root);
    expect(blobExists(ticket.storageKey)).toBe(false);
  });

  it.each(["FAILED", "DELETED"])("still removes the blob of a row that is already %s (garbage the sweep would take)", async (status) => {
    const f = makeFake();
    const ticket = await startUpload(f);
    f.db.attachments[0].status = status;
    await abortUpload(f.prisma, ticket, root);
    expect(blobExists(ticket.storageKey)).toBe(false);
  });
});

// ── reads ────────────────────────────────────────────────────────────────────

function seedReady(f: ReturnType<typeof makeFake>, over: Row = {}): Row {
  const key = randomUUID();
  const row: Row = {
    id: `att-${f.db.attachments.length + 100}`,
    workItemId: "wi-1",
    commentId: null,
    fileName: "a.txt",
    mimeType: "text/plain",
    sizeBytes: BigInt(5),
    sha256: "a".repeat(64),
    storageKey: key,
    status: "READY",
    uploadedById: "u-1",
    createdAt: new Date("2026-10-04T10:00:00Z"),
    ...over,
  };
  f.db.attachments.push(row);
  return row;
}

describe("listAttachments", () => {
  it("lists READY attachments of the item — item-level and comment-level — oldest first", async () => {
    const f = makeFake();
    seedReady(f, { id: "b", fileName: "second.txt", createdAt: new Date("2026-10-04T11:00:00Z"), commentId: "c-1" });
    seedReady(f, { id: "a", fileName: "first.txt", createdAt: new Date("2026-10-04T10:00:00Z") });
    seedReady(f, { id: "x", workItemId: "wi-2", fileName: "other-item.txt" });

    const out = await listAttachments(f.prisma, "wi-1");

    expect(out.map((a) => [a.id, a.fileName, a.commentId])).toEqual([
      ["a", "first.txt", null],
      ["b", "second.txt", "c-1"],
    ]);
    expect(out[0].sizeBytes).toBe(5); // a number: BigInt does not survive JSON
  });

  it("never lists UPLOADING, FAILED or DELETED rows", async () => {
    const f = makeFake();
    for (const status of ["UPLOADING", "FAILED", "DELETED"]) seedReady(f, { status });
    seedReady(f, { id: "ok" });
    expect((await listAttachments(f.prisma, "wi-1")).map((a) => a.id)).toEqual(["ok"]);
  });

  it("404s a work item that does not exist", async () => {
    const f = makeFake();
    await expect(listAttachments(f.prisma, "nope")).rejects.toThrow(E.WORK_ITEM_NOT_FOUND);
  });

  it("marks only a verified raster image as previewable", async () => {
    const f = makeFake();
    seedReady(f, { id: "png", mimeType: "image/png", createdAt: new Date("2026-10-04T10:00:00Z") });
    seedReady(f, { id: "svg", mimeType: "application/octet-stream", fileName: "d.svg", createdAt: new Date("2026-10-04T10:01:00Z") });
    seedReady(f, { id: "pdf", mimeType: "application/pdf", createdAt: new Date("2026-10-04T10:02:00Z") });
    const out = await listAttachments(f.prisma, "wi-1");
    expect(Object.fromEntries(out.map((a) => [a.id, a.previewable]))).toEqual({ png: true, svg: false, pdf: false });
  });
});

describe("getServableAttachment", () => {
  it("returns a READY attachment", async () => {
    const f = makeFake();
    const row = seedReady(f, { id: "a" });
    expect(await getServableAttachment(f.prisma, "a")).toMatchObject({
      id: "a",
      fileName: "a.txt",
      storageKey: row.storageKey,
      sizeBytes: 5,
    });
  });

  it.each(["UPLOADING", "FAILED", "DELETED"])("an attachment that is %s does not exist", async (status) => {
    const f = makeFake();
    seedReady(f, { id: "a", status });
    await expect(getServableAttachment(f.prisma, "a")).rejects.toThrow(E.NOT_FOUND);
  });

  it("404s an unknown id", async () => {
    await expect(getServableAttachment(makeFake().prisma, "nope")).rejects.toThrow(E.NOT_FOUND);
  });
});

// ── deleteAttachment ─────────────────────────────────────────────────────────

describe("deleteAttachment", () => {
  function ready(f: ReturnType<typeof makeFake>, over: Row = {}) {
    const row = seedReady(f, { id: "a", fileName: "plan.pdf", uploadedById: "u-1", ...over });
    writeBlob(row.storageKey as string);
    return row;
  }

  it("lets the uploader remove it: row gone, blob gone, one attachment_removed row", async () => {
    const f = makeFake();
    const row = ready(f);
    await deleteAttachment(f.prisma, { id: "u-1", isAdmin: false }, "a", root);

    expect(f.db.attachments).toEqual([]);
    expect(blobExists(row.storageKey as string)).toBe(false);
    expect(f.db.activity).toEqual([
      expect.objectContaining({
        workItemId: "wi-1",
        actorId: "u-1",
        verb: "attachment_removed",
        field: "attachment",
        oldValue: "plan.pdf",
      }),
    ]);
  });

  it("lets an owner or admin remove someone else's file", async () => {
    const f = makeFake();
    ready(f, { uploadedById: "u-1" });
    await deleteAttachment(f.prisma, { id: "u-admin", isAdmin: true }, "a", root);
    expect(f.db.attachments).toEqual([]);
  });

  it("refuses a member who is not the uploader — and changes nothing", async () => {
    const f = makeFake();
    const row = ready(f, { uploadedById: "u-1" });
    await expect(deleteAttachment(f.prisma, { id: "u-2", isAdmin: false }, "a", root)).rejects.toThrow(E.FORBIDDEN);
    expect(f.db.attachments[0].status).toBe("READY");
    expect(blobExists(row.storageKey as string)).toBe(true);
    expect(f.db.activity).toEqual([]);
  });

  it("refuses a non-admin when the file has no uploader on record", async () => {
    const f = makeFake();
    ready(f, { uploadedById: null });
    await expect(deleteAttachment(f.prisma, { id: null, isAdmin: false }, "a", root)).rejects.toThrow(E.FORBIDDEN);
    await expect(deleteAttachment(f.prisma, { id: "u-2", isAdmin: false }, "a", root)).rejects.toThrow(E.FORBIDDEN);
  });

  it.each(["UPLOADING", "FAILED", "DELETED"])("404s an attachment that is %s", async (status) => {
    const f = makeFake();
    ready(f, { status });
    await expect(deleteAttachment(f.prisma, { id: "u-1", isAdmin: true }, "a", root)).rejects.toThrow(E.NOT_FOUND);
  });

  it("two removals racing: exactly one wins, the other is not-found (the status is in the WHERE)", async () => {
    const f = makeFake();
    ready(f);
    const [a, b] = await Promise.allSettled([
      deleteAttachment(f.prisma, { id: "u-1", isAdmin: false }, "a", root),
      deleteAttachment(f.prisma, { id: "u-1", isAdmin: false }, "a", root),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(f.db.activity.filter((r) => r.verb === "attachment_removed")).toHaveLength(1);
  });

  it("when the blob will not unlink the user's delete still succeeds — the DELETED row is left for the sweep", async () => {
    const f = makeFake();
    const row = ready(f);
    // A directory where the file should be: rm({ force }) without recursive fails on it.
    rmSync(blobPath(root, row.storageKey as string));
    mkdirSync(blobPath(root, row.storageKey as string));

    await expect(deleteAttachment(f.prisma, { id: "u-1", isAdmin: false }, "a", root)).resolves.toBeUndefined();

    expect(f.db.attachments).toHaveLength(1);
    expect(f.db.attachments[0].status).toBe("DELETED"); // invisible, and the sweep's now
    expect(f.db.activity.map((r) => r.verb)).toEqual(["attachment_removed"]);
  });
});

// ── sweepAttachments ─────────────────────────────────────────────────────────

describe("sweepAttachments", () => {
  const NOW = new Date("2026-10-04T12:00:00Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  function seedWithBlob(f: ReturnType<typeof makeFake>, over: Row): Row {
    const row = seedReady(f, over);
    writeBlob(row.storageKey as string);
    return row;
  }

  it("reaps an UPLOADING row older than an hour — row and blob", async () => {
    const f = makeFake();
    const stale = seedWithBlob(f, { id: "stale", status: "UPLOADING", createdAt: ago(UPLOAD_STALE_MS + 1) });

    const out = await sweepAttachments(f.prisma, { root, now: NOW });

    expect(out).toEqual({ staleUploads: 1, reaped: 1, failed: 0 });
    expect(f.db.attachments).toEqual([]);
    expect(blobExists(stale.storageKey as string)).toBe(false);
  });

  it("leaves an UPLOADING row younger than an hour alone — a live upload may be streaming into it", async () => {
    const f = makeFake();
    const fresh = seedWithBlob(f, { id: "fresh", status: "UPLOADING", createdAt: ago(UPLOAD_STALE_MS - 60_000) });

    const out = await sweepAttachments(f.prisma, { root, now: NOW });

    expect(out).toEqual({ staleUploads: 0, reaped: 0, failed: 0 });
    expect(f.db.attachments).toHaveLength(1);
    expect(blobExists(fresh.storageKey as string)).toBe(true);
  });

  it("reaps FAILED and DELETED rows at any age, and never touches READY", async () => {
    const f = makeFake();
    const failed = seedWithBlob(f, { id: "f", status: "FAILED", createdAt: ago(1000) });
    const deleted = seedWithBlob(f, { id: "d", status: "DELETED", createdAt: ago(1000) });
    const ready = seedWithBlob(f, { id: "r", status: "READY", createdAt: ago(10 * UPLOAD_STALE_MS) });

    const out = await sweepAttachments(f.prisma, { root, now: NOW });

    expect(out).toEqual({ staleUploads: 0, reaped: 2, failed: 0 });
    expect(f.db.attachments.map((a) => a.id)).toEqual(["r"]);
    expect(blobExists(failed.storageKey as string)).toBe(false);
    expect(blobExists(deleted.storageKey as string)).toBe(false);
    expect(blobExists(ready.storageKey as string)).toBe(true);
  });

  it("reaps a row whose key this store never minted (pre-volume rows) without touching the file system", async () => {
    const f = makeFake();
    // a file OUTSIDE the root that a traversal key would name
    const outside = join(root, "..", "pm-attach-outside.txt");
    writeFileSync(outside, "keep me");
    try {
      seedReady(f, { id: "legacy", status: "FAILED", storageKey: "legacy-key-1" });
      seedReady(f, { id: "hostile", status: "FAILED", storageKey: "../pm-attach-outside.txt" });
      expect(await sweepAttachments(f.prisma, { root, now: NOW })).toEqual({ staleUploads: 0, reaped: 2, failed: 0 });
      expect(f.db.attachments).toEqual([]);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("finishes a row whose blob is already gone", async () => {
    const f = makeFake();
    seedReady(f, { id: "d", status: "DELETED" }); // no blob written
    expect(await sweepAttachments(f.prisma, { root, now: NOW })).toEqual({ staleUploads: 0, reaped: 1, failed: 0 });
    expect(f.db.attachments).toEqual([]);
  });

  it("keeps a row whose blob will not unlink, counts it, and carries on with the rest", async () => {
    const f = makeFake();
    const stuck = seedReady(f, { id: "a-stuck", status: "FAILED" });
    mkdirSync(blobPath(root, stuck.storageKey as string), { recursive: true }); // a directory: rm cannot remove it
    seedWithBlob(f, { id: "b-fine", status: "FAILED" });

    const out = await sweepAttachments(f.prisma, { root, now: NOW });

    expect(out).toEqual({ staleUploads: 0, reaped: 1, failed: 1 });
    expect(f.db.attachments.map((a) => a.id)).toEqual(["a-stuck"]);
  });

  it("is idempotent", async () => {
    const f = makeFake();
    seedWithBlob(f, { id: "f", status: "FAILED" });
    await sweepAttachments(f.prisma, { root, now: NOW });
    expect(await sweepAttachments(f.prisma, { root, now: NOW })).toEqual({ staleUploads: 0, reaped: 0, failed: 0 });
  });

  it("does bounded work per tick: batches of SWEEP_BATCH, ten at most, the remainder left for the next tick", async () => {
    const f = makeFake();
    const total = SWEEP_BATCH * 10 + 37;
    for (let i = 0; i < total; i += 1) {
      f.db.attachments.push({
        id: `id-${String(i).padStart(6, "0")}`,
        workItemId: "wi-1",
        status: "FAILED",
        storageKey: randomUUID(),
        createdAt: ago(1000),
      });
    }
    const first = await sweepAttachments(f.prisma, { root, now: NOW });
    expect(first.reaped).toBe(SWEEP_BATCH * 10);
    expect(f.db.attachments).toHaveLength(37);
    const second = await sweepAttachments(f.prisma, { root, now: NOW });
    expect(second.reaped).toBe(37);
    expect(f.db.attachments).toEqual([]);
    // ~2,000 unlinks: instant on Linux, but a loaded Windows disk needs more than the default 10 s
  }, 120_000);
});
