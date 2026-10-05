/**
 * WARP-1505 — the guarantees that only a real database and a real disk can prove.
 *
 * Three of them are enforced NOWHERE in TypeScript:
 *
 *   * `PmAttachment_ready_has_sha256` is a CHECK that lives only in migration
 *     SQL. A mocked Prisma accepts the rows it rejects.
 *   * The FK cascades (work item, comment, project) are database behaviour — and
 *     they are exactly why `deleteWorkItem` / `deleteProject` have to unlink the
 *     files themselves: the database drops the ROWS and cannot reach the volume.
 *   * "A removed file is removed" is a statement about a directory.
 *
 * So the second half drives the REAL router and the REAL pm.service against a
 * real Postgres and a real temp directory, and asserts what is on disk.
 *
 * Gated the same way the other *.pg.test.ts files are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERIALIZABLE_TX } from "../lib/prisma-tx.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

// pm.service's hard-delete hooks unlink from `config.PM_ATTACHMENTS_DIR`; point it
// at a directory this file owns. The factory runs when config is first imported
// (in beforeAll, below), by which time ROOT is initialised.
const ROOT = mkdtempSync(join(tmpdir(), "pm-attach-pg-"));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, PM_ATTACHMENTS_DIR: ROOT } };
});

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const OURS = { startsWith: "warp1505-" } as const;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const HEX64 = createHash("sha256").update("x").digest("hex");
const MAX = 20_000;

describe.skipIf(!RUN)("PmAttachment — the database's own guarantees and the file cascades (WARP-1505)", () => {
  let prisma: PrismaClient;
  let pm: typeof import("../services/pm/pm.service.js");
  let svc: typeof import("../services/pm/pm-attachments.service.js");
  let storage: typeof import("../services/pm/pm-attachment-storage.js");
  let cleanup: typeof import("../services/pm/pm-attachment-cleanup.js");
  let routerFactory: typeof import("../routes/pm/attachments.js").createPmAttachmentsRouter;

  let projectA = "";
  let projectB = "";
  let seq = 0;
  const ownedStorageKeys = new Set<string>();
  async function clearOwnedIntents() {
    await prisma.systemFlag.deleteMany({
      where: { key: { in: [...ownedStorageKeys].map((key) => cleanup.ATTACHMENT_CLEANUP_PREFIX + key) } },
    });
    ownedStorageKeys.clear();
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    pm = await import("../services/pm/pm.service.js");
    svc = await import("../services/pm/pm-attachments.service.js");
    storage = await import("../services/pm/pm-attachment-storage.js");
    cleanup = await import("../services/pm/pm-attachment-cleanup.js");
    routerFactory = (await import("../routes/pm/attachments.js")).createPmAttachmentsRouter;
    // The service graph (pm.service pulls in config and the storage engine) is a
    // cold import on a loaded machine; the default 10 s hook budget is not for it.
  }, 60_000);

  afterAll(async () => {
    await clearOwnedIntents();
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
    await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  beforeEach(async () => {
    await clearOwnedIntents();
    // FK-ordered and scoped: projects cascade to items, comments, attachments.
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    mkdirSync(ROOT, { recursive: true });

    const ws = await prisma.pmWorkspace.create({ data: { slug: `warp1505-ws-${Date.now()}`, name: "warp1505-ws" } });
    projectA = (await prisma.pmProject.create({ data: { workspaceId: ws.id, name: "warp1505-alpha", identifier: "W15A" } })).id;
    projectB = (await prisma.pmProject.create({ data: { workspaceId: ws.id, name: "warp1505-bravo", identifier: "W15B" } })).id;
    seq = 0;
  });

  const item = (projectId = projectA) =>
    prisma.pmWorkItem.create({ data: { projectId, sequenceId: ++seq, name: `warp1505-item-${seq}` } });
  async function deleteArchivedProject(projectId: string) {
    const project = await prisma.pmProject.update({ where: { id: projectId }, data: { isArchived: true }, select: { identifier: true } });
    await pm.deleteProject(prisma, projectId, { confirmIdentifier: project.identifier, audit: async () => undefined });
  }
  const comment = (workItemId: string, authorId = "u-1") =>
    prisma.pmComment.create({ data: { workItemId, authorId, commentHtml: "<p>hi</p>" } });

  /** A row of the given state, with a blob on disk for it. */
  async function row(
    workItemId: string,
    over: { status?: "UPLOADING" | "READY" | "FAILED" | "DELETED"; commentId?: string | null; createdAt?: Date; sha256?: string } = {},
  ) {
    const status = over.status ?? "READY";
    const storageKey = randomUUID();
    ownedStorageKeys.add(storageKey);
    mkdirSync(join(ROOT, storageKey.slice(0, 2)), { recursive: true });
    writeFileSync(storage.blobPath(ROOT, storageKey), "bytes");
    return prisma.pmAttachment.create({
      data: {
        workItemId,
        commentId: over.commentId ?? null,
        fileName: "warp1505.txt",
        mimeType: "text/plain",
        sizeBytes: BigInt(5),
        sha256: over.sha256 ?? (status === "READY" ? HEX64 : ""),
        storageKey,
        status,
        uploadedById: "u-1",
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
      },
    });
  }
  const blob = (key: string) => existsSync(storage.blobPath(ROOT, key));
  const filesOnDisk = (): string[] =>
    readdirSync(ROOT, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? readdirSync(join(ROOT, d.name)).map((f) => `${d.name}/${f}`) : [d.name],
    );

  // ── the CHECK ──────────────────────────────────────────────────────────────

  describe("PmAttachment_ready_has_sha256", () => {
    const base = (workItemId: string) => ({
      workItemId,
      fileName: "f.txt",
      mimeType: "text/plain",
      sizeBytes: BigInt(1),
      storageKey: randomUUID(),
    });

    it.each([
      ["the empty string", ""],
      ["63 hex characters", "a".repeat(63)],
      ["65 hex characters", "a".repeat(65)],
      ["upper-case hex", "A".repeat(64)],
      ["non-hex characters", "g".repeat(64)],
    ])("rejects a READY row whose digest is %s", async (_n, sha256) => {
      const it1 = await item();
      await expect(
        prisma.pmAttachment.create({ data: { ...base(it1.id), status: "READY", sha256 } }),
      ).rejects.toThrow(/PmAttachment_ready_has_sha256/);
    });

    it("accepts a READY row with a real SHA-256", async () => {
      const it1 = await item();
      await expect(
        prisma.pmAttachment.create({ data: { ...base(it1.id), status: "READY", sha256: HEX64 } }),
      ).resolves.toBeTruthy();
    });

    it.each(["UPLOADING", "FAILED", "DELETED"] as const)("lets a %s row carry the empty digest", async (status) => {
      const it1 = await item();
      await expect(
        prisma.pmAttachment.create({ data: { ...base(it1.id), status, sha256: "" } }),
      ).resolves.toBeTruthy();
    });

    it("cannot be sidestepped by flipping an UPLOADING row to READY without a digest", async () => {
      const it1 = await item();
      const r = await prisma.pmAttachment.create({ data: { ...base(it1.id), status: "UPLOADING", sha256: "" } });
      await expect(
        prisma.pmAttachment.update({ where: { id: r.id }, data: { status: "READY" } }),
      ).rejects.toThrow(/PmAttachment_ready_has_sha256/);
    });
  });

  // ── the shape ──────────────────────────────────────────────────────────────

  describe("the table's shape", () => {
    it("a new row is UPLOADING by default", async () => {
      const it1 = await item();
      const r = await prisma.pmAttachment.create({
        data: { workItemId: it1.id, fileName: "", mimeType: "x", sizeBytes: BigInt(0), sha256: "", storageKey: randomUUID() },
      });
      expect(r.status).toBe("UPLOADING");
      expect(r.commentId).toBeNull();
    });

    it("rejects a status that is not one of the four", async () => {
      const it1 = await item();
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "PmAttachment" ("id","workItemId","fileName","mimeType","sizeBytes","sha256","storageKey","status")
           VALUES ('${randomUUID()}', '${it1.id}', 'f', 'x', 0, '', '${randomUUID()}', 'BOGUS')`,
        ),
      ).rejects.toThrow();
    });

    it("rejects a duplicate storageKey", async () => {
      const it1 = await item();
      const a = await row(it1.id);
      await expect(
        prisma.pmAttachment.create({
          data: { workItemId: it1.id, fileName: "x", mimeType: "x", sizeBytes: BigInt(1), sha256: HEX64, status: "READY", storageKey: a.storageKey },
        }),
      ).rejects.toThrow();
    });

    it("rejects a commentId that is not a comment", async () => {
      const it1 = await item();
      await expect(
        prisma.pmAttachment.create({
          data: { workItemId: it1.id, commentId: randomUUID(), fileName: "x", mimeType: "x", sizeBytes: BigInt(1), sha256: "", storageKey: randomUUID() },
        }),
      ).rejects.toThrow();
    });

    it("ships the two indexes and a CASCADE comment FK", async () => {
      const idx = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'PmAttachment'`;
      const names = idx.map((i) => i.indexname);
      expect(names).toContain("PmAttachment_commentId_idx");
      expect(names).toContain("PmAttachment_status_createdAt_idx");
      const fk = await prisma.$queryRaw<{ confdeltype: string }[]>`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'PmAttachment_commentId_fkey'`;
      expect(fk.map((f) => f.confdeltype)).toEqual(["c"]); // 'c' = ON DELETE CASCADE
    });

    it("accepts the two new activity verbs", async () => {
      const it1 = await item();
      for (const verb of ["attachment_added", "attachment_removed"] as const) {
        await expect(
          prisma.pmActivity.create({ data: { workItemId: it1.id, verb, field: "attachment", newValue: "f.txt" } }),
        ).resolves.toBeTruthy();
      }
    });
  });

  // ── the cascades are the database's — the files are ours ───────────────────

  describe("deleting things drops the ROWS (the database's job)", () => {
    it("a work item takes its attachments with it — item-level and comment-level", async () => {
      const it1 = await item();
      const c = await comment(it1.id);
      await row(it1.id);
      await row(it1.id, { commentId: c.id });
      await prisma.pmWorkItem.delete({ where: { id: it1.id } });
      expect(await prisma.pmAttachment.count({ where: { workItemId: it1.id } })).toBe(0);
    });

    it("a comment takes ITS attachments and leaves the item's own", async () => {
      const it1 = await item();
      const c = await comment(it1.id);
      const own = await row(it1.id);
      await row(it1.id, { commentId: c.id });
      await prisma.pmComment.delete({ where: { id: c.id } });
      const left = await prisma.pmAttachment.findMany({ where: { workItemId: it1.id } });
      expect(left.map((a) => a.id)).toEqual([own.id]);
    });
  });

  describe("deleteWorkItem / deleteProject remove the FILES (WARP-1505 AC)", () => {
    it("deleting a work item removes every one of its files, comment attachments included", async () => {
      const it1 = await item();
      const other = await item();
      const c = await comment(it1.id);
      const a = await row(it1.id);
      const b = await row(it1.id, { commentId: c.id });
      const keep = await row(other.id);
      expect(filesOnDisk()).toHaveLength(3);

      await pm.deleteWorkItem(prisma, "u-1", it1.id);

      expect(blob(a.storageKey)).toBe(false);
      expect(blob(b.storageKey)).toBe(false);
      expect(blob(keep.storageKey)).toBe(true); // somebody else's file is untouched
      expect(await prisma.pmAttachment.count({ where: { workItemId: it1.id } })).toBe(0);
    });

    it("also removes files in every state — an UPLOADING or FAILED one has a blob too", async () => {
      const it1 = await item();
      const rows = [await row(it1.id, { status: "UPLOADING" }), await row(it1.id, { status: "FAILED" }), await row(it1.id, { status: "DELETED" })];
      await pm.deleteWorkItem(prisma, "u-1", it1.id);
      for (const r of rows) expect(blob(r.storageKey)).toBe(false);
    });

    it("a delete that finds nothing to do leaves the volume alone", async () => {
      const it1 = await item();
      const other = await item();
      const keep = await row(other.id);
      await pm.deleteWorkItem(prisma, "u-1", it1.id);
      expect(blob(keep.storageKey)).toBe(true);
    });

    it("deleting a project removes the files of every item under it — and only those", async () => {
      const a1 = await item(projectA);
      const a2 = await item(projectA);
      const ca = await comment(a1.id);
      const b1 = await item(projectB);
      const files = [await row(a1.id), await row(a2.id), await row(a1.id, { commentId: ca.id })];
      const elsewhere = await row(b1.id);

      await deleteArchivedProject(projectA);

      for (const f of files) expect(blob(f.storageKey)).toBe(false);
      expect(blob(elsewhere.storageKey)).toBe(true);
      expect(await prisma.pmAttachment.count({ where: { workItem: { projectId: projectA } } })).toBe(0);
      expect(await prisma.pmAttachment.count({ where: { id: elsewhere.id } })).toBe(1);
    });
  });

  describe("durable cleanup after a hard cascade", () => {
    it("recovers a cascade committed before the process could unlink its blobs", async () => {
      const it1 = await item();
      const gone = await row(it1.id);
      const keep = await row((await item(projectB)).id);
      await prisma.$transaction(async (tx) => {
        await cleanup.queueAttachmentCleanup(tx, [gone.storageKey]);
        await tx.pmWorkItem.delete({ where: { id: it1.id } });
      }, SERIALIZABLE_TX);
      // The crash window: the commit exists; no after-commit drain ran.
      expect(await prisma.pmAttachment.count({ where: { id: gone.id } })).toBe(0);
      expect(blob(gone.storageKey)).toBe(true);
      await svc.sweepAttachments(prisma, { root: ROOT });
      expect(blob(gone.storageKey)).toBe(false);
      expect(blob(keep.storageKey)).toBe(true);
      expect(await prisma.systemFlag.count({ where: { key: cleanup.ATTACHMENT_CLEANUP_PREFIX + gone.storageKey } })).toBe(0);
    });

    it("rolls the cleanup marker back with an aborted SERIALIZABLE cascade", async () => {
      const it1 = await item();
      const keep = await row(it1.id);
      await expect(prisma.$transaction(async (tx) => {
        await cleanup.queueAttachmentCleanup(tx, [keep.storageKey]);
        await tx.pmWorkItem.delete({ where: { id: it1.id } });
        throw new Error("abort cascade");
      }, SERIALIZABLE_TX)).rejects.toThrow("abort cascade");
      expect(await prisma.pmAttachment.count({ where: { id: keep.id } })).toBe(1);
      expect(await prisma.systemFlag.count({ where: { key: cleanup.ATTACHMENT_CLEANUP_PREFIX + keep.storageKey } })).toBe(0);
      await svc.sweepAttachments(prisma, { root: ROOT });
      expect(blob(keep.storageKey)).toBe(true);
    });

    it.each(["item", "project"] as const)("a committed %s delete retains a failed unlink for the existing sweep", async (target) => {
      const it1 = await item();
      const stuck = await row(it1.id);
      const keep = await row((await item(projectB)).id);
      const path = storage.blobPath(ROOT, stuck.storageKey);
      rmSync(path);
      mkdirSync(path); // unlink refuses a directory on every platform
      if (target === "item") await pm.deleteWorkItem(prisma, "u-1", it1.id);
      else await deleteArchivedProject(projectA);
      expect(await prisma.pmAttachment.count({ where: { id: stuck.id } })).toBe(0);
      const markerKey = cleanup.ATTACHMENT_CLEANUP_PREFIX + stuck.storageKey;
      expect(await prisma.systemFlag.findUnique({ where: { key: markerKey } })).toMatchObject({ valueJson: { storageKey: stuck.storageKey } });
      expect(blob(stuck.storageKey)).toBe(true);
      rmSync(path, { recursive: true });
      writeFileSync(path, "repaired file");
      await svc.sweepAttachments(prisma, { root: ROOT });
      expect(await prisma.systemFlag.count({ where: { key: markerKey } })).toBe(0);
      expect(blob(stuck.storageKey)).toBe(false);
      expect(blob(keep.storageKey)).toBe(true);
    });
  });

  // ── hard delete vs an upload racing it ─────────────────────────────────────
  // Review probes A, B and C, made permanent. The invariant: whatever the
  // interleaving, never a blob on disk that no row refers to.

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }
  const plantBlob = (key: string) => {
    mkdirSync(join(ROOT, key.slice(0, 2)), { recursive: true });
    writeFileSync(storage.blobPath(ROOT, key), "bytes");
  };

  /**
   * The client pm.service is given, with its delete PARKED: `afterRead` fires
   * once the attachment keys have been read, and the delete itself waits for
   * `gate`. That is the window an upload has to land in.
   */
  function parkedDelete(model: "pmWorkItem" | "pmProject", gate: Promise<void>, afterRead: () => void) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapModel = (delegate: any, name: string) =>
      new Proxy(delegate, {
        get(t, m) {
          const v = t[m];
          if (typeof v !== "function") return v;
          if (name === "pmAttachment" && m === "findMany") {
            return async (...a: unknown[]) => {
              const r = await v.apply(t, a);
              afterRead();
              return r;
            };
          }
          if (name === model && (m === "delete" || m === "deleteMany")) {
            return async (...a: unknown[]) => {
              await gate;
              return v.apply(t, a);
            };
          }
          return v.bind(t);
        },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txClient = (tx: any) =>
      new Proxy(tx, {
        get(t, p) {
          if (p === "pmAttachment" || p === model) return wrapModel(t[p], String(p));
          const v = t[p];
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Proxy(prisma as any, {
      get(t, p) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (p === "$transaction") return (fn: any, o: unknown) => t.$transaction((tx: unknown) => fn(txClient(tx)), o);
        const v = t[p];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  }

  describe.each([
    ["work item", "pmWorkItem"],
    ["project", "pmProject"],
  ] as const)("hard delete of a %s racing an upload", (_label, model) => {
    /** A target with one work item in it, and how to delete it and see whether it survived. */
    async function target() {
      if (model === "pmWorkItem") {
        const it1 = await item();
        return {
          projectId: projectA,
          workItemId: it1.id,
          remove: (db: unknown) => pm.deleteWorkItem(db as never, "u1", it1.id),
          survives: async () => (await prisma.pmWorkItem.count({ where: { id: it1.id } })) === 1,
        };
      }
      const base = await prisma.pmProject.findUniqueOrThrow({ where: { id: projectA } });
      const proj = await prisma.pmProject.create({
        data: { workspaceId: base.workspaceId, name: `warp1505-race-${++seq}`, identifier: `W15R${seq}`, isArchived: true },
      });
      const it1 = await prisma.pmWorkItem.create({ data: { projectId: proj.id, sequenceId: 1, name: `warp1505-race-item-${seq}` } });
      return {
        projectId: proj.id,
        workItemId: it1.id,
        remove: (db: unknown) => pm.deleteProject(db as never, proj.id, { confirmIdentifier: proj.identifier, audit: async () => undefined }),
        survives: async () => (await prisma.pmProject.count({ where: { id: proj.id } })) === 1,
      };
    }

    it("an upload cannot cross the key read and cascade with its blob forgotten", async () => {
      const t = await target();
      const gate = deferred();
      const read = deferred();
      const outcome = t
        .remove(parkedDelete(model, gate.promise, read.resolve))
        .then(() => "deleted", (e: Error) => `rejected:${e.message}`);
      await read.promise;

      if (model === "pmProject") {
        let upload: Promise<unknown> | undefined;
        try {
          // FK insertion takes KEY SHARE; the parent's/item's UPDATE locks must
          // refuse it while the deletion holds its attachment-key snapshot.
          await expect(prisma.$queryRaw`SELECT "id" FROM "PmProject" WHERE "id" = ${t.projectId} FOR KEY SHARE NOWAIT`)
            .rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
          await expect(prisma.$queryRaw`SELECT "id" FROM "PmWorkItem" WHERE "id" = ${t.workItemId} FOR KEY SHARE NOWAIT`)
            .rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
          upload = svc.beginUpload(prisma, { actorId: "u2", workItemId: t.workItemId })
            .then((ticket) => { plantBlob(ticket.storageKey); return "uploaded"; }, (e: Error) => e.message);
        } finally {
          gate.resolve();
          await outcome;
        }
        expect(await outcome).toBe("deleted");
        expect(await upload).toBe(svc.PM_ATTACHMENT_ERRORS.WORK_ITEM_NOT_FOUND);
        expect(await t.survives()).toBe(false);
        expect(await prisma.pmAttachment.count({ where: { workItemId: t.workItemId } })).toBe(0);
        return;
      }

      const upload = await svc.beginUpload(prisma, { actorId: "u2", workItemId: t.workItemId }); // commits
      plantBlob(upload.storageKey);
      gate.resolve();

      expect(await outcome).toBe("rejected:concurrent_mutation");
      expect(await t.survives()).toBe(true);
      expect(await prisma.pmAttachment.count({ where: { id: upload.id } })).toBe(1);
      expect(blob(upload.storageKey)).toBe(true);
    });

    it("an upload row INSERTED but not yet committed when the delete runs never leaves a blob without a row", async () => {
      const t = await target();
      if (model === "pmProject") {
        const commit = deferred();
        const inserted = deferred();
        const key = randomUUID();
        const upload = prisma.$transaction(async (tx) => {
          const row = await tx.pmAttachment.create({
            data: {
              workItemId: t.workItemId, fileName: "", mimeType: "application/octet-stream",
              sizeBytes: BigInt(0), sha256: "", storageKey: key, status: "UPLOADING", uploadedById: "u2",
            },
          });
          inserted.resolve();
          await commit.promise;
          return row;
        });
        await inserted.promise;
        plantBlob(key);
        const removed = t.remove(prisma);
        // The item lock waits for the upload's FK lock; READ COMMITTED's later
        // key read must include that upload when its transaction finishes.
        commit.resolve();
        const row = await upload;
        await removed;
        expect(await t.survives()).toBe(false);
        expect(await prisma.pmAttachment.count({ where: { id: row.id } })).toBe(0);
        expect(blob(key)).toBe(false);
        return;
      }
      const gate = deferred();
      const read = deferred();
      const outcome = t
        .remove(parkedDelete(model, gate.promise, read.resolve))
        .then(() => "deleted", (e: Error) => `rejected:${e.message}`);
      await read.promise;

      // an upload's begin: the row is inserted, and the transaction is held open
      const commit = deferred();
      const inserted = deferred();
      const key = randomUUID();
      const upload = prisma.$transaction(async (tx) => {
        const row = await tx.pmAttachment.create({
          data: {
            workItemId: t.workItemId,
            fileName: "",
            mimeType: "application/octet-stream",
            sizeBytes: BigInt(0),
            sha256: "",
            storageKey: key,
            status: "UPLOADING",
            uploadedById: "u2",
          },
        });
        inserted.resolve();
        await commit.promise;
        return row;
      });
      await inserted.promise;
      plantBlob(key);
      gate.resolve(); // the delete now runs, and has to wait on the uncommitted insert
      await sleep(600);
      commit.resolve();
      const row = await upload;
      const result = await outcome;

      const rowAfter = await prisma.pmAttachment.count({ where: { id: row.id } });
      const blobAfter = blob(key);
      expect(blobAfter && rowAfter === 0, "an orphan blob: on disk, with no row").toBe(false);
      if (result === "deleted") expect(blobAfter).toBe(false);
      else expect(result).toBe("rejected:concurrent_mutation");
    });
  });

  // ── the real routes, real rows, real files ─────────────────────────────────

  describe("the routes against a real database and a real directory", () => {
    function app(user: { id: string; role: string }) {
      const a = express();
      a.use(express.json());
      a.use((req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: user.id, username: user.id, displayName: user.id, role: user.role } as never;
        next();
      });
      a.use("/api", routerFactory(prisma, { root: ROOT, maxBytes: MAX }));
      return a;
    }
    const ALICE = { id: "u-alice", role: "family" };
    const BOB = { id: "u-bob", role: "family" };
    const OWNER = { id: "u-owner", role: "owner" };

    it("upload -> READY row + file + activity; list shows it; download returns the bytes", async () => {
      const it1 = await item();
      const up = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments`).attach("file", PNG, { filename: "shot.png", contentType: "image/png" });
      expect(up.status).toBe(201);
      const id = up.body.attachment.id as string;

      const stored = await prisma.pmAttachment.findUniqueOrThrow({ where: { id } });
      expect(stored).toMatchObject({ status: "READY", mimeType: "image/png", uploadedById: "u-alice", fileName: "shot.png" });
      expect(stored.sizeBytes).toBe(BigInt(PNG.length));
      expect(stored.sha256).toBe(createHash("sha256").update(PNG).digest("hex"));
      expect(filesOnDisk()).toEqual([`${stored.storageKey.slice(0, 2)}/${stored.storageKey}`]);
      const acts = await prisma.pmActivity.findMany({ where: { workItemId: it1.id } });
      expect(acts.map((a) => [a.verb, a.newValue, a.actorId])).toEqual([["attachment_added", "shot.png", "u-alice"]]);

      const list = await request(app(BOB)).get(`/api/pm/work-items/${it1.id}/attachments`);
      expect(list.body.attachments.map((a: { id: string }) => a.id)).toEqual([id]);

      const dl = await request(app(BOB)).get(`/api/pm/attachments/${id}?inline=1`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(dl.status).toBe(200);
      expect((dl.body as Buffer).equals(PNG)).toBe(true);
    });

    it("a refused upload leaves NO row and NO file in the real tables", async () => {
      const it1 = await item();
      const res = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments`).attach("file", Buffer.from("MZ"), "setup.exe");
      expect(res.status).toBe(415);
      expect(await prisma.pmAttachment.count({ where: { workItemId: it1.id } })).toBe(0);
      expect(filesOnDisk()).toEqual([]);
    });

    it("an over-cap upload leaves NO row and NO file", async () => {
      const it1 = await item();
      const res = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments`).attach("file", Buffer.alloc(MAX + 5_000, 7), "big.bin");
      expect(res.status).toBe(413);
      expect(await prisma.pmAttachment.count({ where: { workItemId: it1.id } })).toBe(0);
      expect(filesOnDisk()).toEqual([]);
    });

    it("a comment attachment must belong to a comment of THAT item", async () => {
      const it1 = await item();
      const it2 = await item();
      const c2 = await comment(it2.id);
      const res = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments?comment_id=${c2.id}`).attach("file", PNG, "p.png");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("comment_not_found");
      const own = await comment(it1.id, ALICE.id);
      const ok = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments?comment_id=${own.id}`).attach("file", PNG, "p.png");
      expect(ok.status).toBe(201);
      expect(ok.body.attachment.commentId).toBe(own.id);
    });

    it("only the comment's author, or an owner/admin, may attach to an existing comment", async () => {
      const it1 = await item();
      const alices = await comment(it1.id, ALICE.id);
      const refused = await request(app(BOB)).post(`/api/pm/work-items/${it1.id}/attachments?comment_id=${alices.id}`).attach("file", PNG, "p.png");
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("attachment_forbidden");
      expect(await prisma.pmAttachment.count({ where: { workItemId: it1.id } })).toBe(0);
      expect(filesOnDisk()).toEqual([]);
      const owner = await request(app(OWNER)).post(`/api/pm/work-items/${it1.id}/attachments?comment_id=${alices.id}`).attach("file", PNG, "p.png");
      expect(owner.status).toBe(201);
    });

    it("delete: the uploader removes it — row and file gone, history written; another member is refused", async () => {
      const it1 = await item();
      const up = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments`).attach("file", PNG, "shot.png");
      const id = up.body.attachment.id as string;

      expect((await request(app(BOB)).delete(`/api/pm/attachments/${id}`)).status).toBe(403);
      expect(await prisma.pmAttachment.count({ where: { id, status: "READY" } })).toBe(1);

      expect((await request(app(ALICE)).delete(`/api/pm/attachments/${id}`)).status).toBe(200);
      expect(await prisma.pmAttachment.count({ where: { id } })).toBe(0);
      expect(filesOnDisk()).toEqual([]);
      const acts = await prisma.pmActivity.findMany({ where: { workItemId: it1.id }, orderBy: { createdAt: "asc" } });
      expect(acts.map((a) => a.verb)).toEqual(["attachment_added", "attachment_removed"]);
      expect((await request(app(ALICE)).get(`/api/pm/attachments/${id}`)).status).toBe(404);
    });

    it("an owner removes someone else's file", async () => {
      const it1 = await item();
      const up = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments`).attach("file", PNG, "shot.png");
      expect((await request(app(OWNER)).delete(`/api/pm/attachments/${up.body.attachment.id}`)).status).toBe(200);
    });

    it("two deletes racing: exactly one wins (the status is in the WHERE, not checked first)", async () => {
      const it1 = await item();
      const up = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments`).attach("file", PNG, "shot.png");
      const id = up.body.attachment.id as string;
      const [a, b] = await Promise.all([
        request(app(ALICE)).delete(`/api/pm/attachments/${id}`),
        request(app(ALICE)).delete(`/api/pm/attachments/${id}`),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 404]);
      const removed = await prisma.pmActivity.count({ where: { workItemId: it1.id, verb: "attachment_removed" } });
      expect(removed).toBe(1);
    });

    it("uploading to a work item that was deleted answers 404 and leaves no file", async () => {
      const it1 = await item();
      await prisma.pmWorkItem.delete({ where: { id: it1.id } });
      const res = await request(app(ALICE)).post(`/api/pm/work-items/${it1.id}/attachments`).attach("file", PNG, "p.png");
      expect(res.status).toBe(404);
      expect(filesOnDisk()).toEqual([]);
    });
  });

  // ── the sweep, on real rows ────────────────────────────────────────────────

  describe("sweepAttachments", () => {
    const HOUR = 60 * 60 * 1000;

    it("reaps stale UPLOADING, FAILED and DELETED rows with their files, and leaves READY and fresh UPLOADING alone", async () => {
      const it1 = await item();
      const stale = await row(it1.id, { status: "UPLOADING", createdAt: new Date(Date.now() - 2 * HOUR) });
      const fresh = await row(it1.id, { status: "UPLOADING", createdAt: new Date(Date.now() - 5 * 60_000) });
      const failed = await row(it1.id, { status: "FAILED" });
      const deleted = await row(it1.id, { status: "DELETED" });
      const ready = await row(it1.id, { status: "READY", createdAt: new Date(Date.now() - 48 * HOUR) });

      const out = await svc.sweepAttachments(prisma, { root: ROOT });

      expect(out).toMatchObject({ staleUploads: 1, reaped: 3, failed: 0 });
      const left = (await prisma.pmAttachment.findMany({ where: { workItemId: it1.id } })).map((a) => a.id).sort();
      expect(left).toEqual([fresh.id, ready.id].sort());
      for (const gone of [stale, failed, deleted]) expect(blob(gone.storageKey)).toBe(false);
      for (const kept of [fresh, ready]) expect(blob(kept.storageKey)).toBe(true);
    });

    it("clears a FAILED row from before the volume existed (a key this store never minted)", async () => {
      const it1 = await item();
      const legacy = await prisma.pmAttachment.create({
        data: {
          workItemId: it1.id,
          fileName: "old.txt",
          mimeType: "text/plain",
          sizeBytes: BigInt(5),
          sha256: "",
          storageKey: "legacy-key-from-before-the-volume",
          status: "FAILED",
        },
      });
      expect(await svc.sweepAttachments(prisma, { root: ROOT })).toMatchObject({ reaped: 1, failed: 0 });
      expect(await prisma.pmAttachment.count({ where: { id: legacy.id } })).toBe(0);
    });

    it("never touches another suite's attachments by accident: it only reaps what the status says", async () => {
      const it1 = await item();
      const ready = await row(it1.id, { status: "READY" });
      expect(await svc.sweepAttachments(prisma, { root: ROOT })).toMatchObject({ reaped: 0 });
      expect(blob(ready.storageKey)).toBe(true);
    });
  });
});
