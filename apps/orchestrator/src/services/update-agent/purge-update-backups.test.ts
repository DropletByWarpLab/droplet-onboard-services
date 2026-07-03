/**
 * WARP-539 — 7-day GC of the per-update rollback backups.
 *
 * `applyPendingUpdate` step 1 writes .data/updates/<id>/backup/ (previous
 * image refs + host configs pre-image + a schema-only pg_dump) so a failed
 * swap can roll back. Once an update reaches a TERMINAL status
 * (committed / rolled_back / failed) that backup is forensic-only; keeping
 * it forever leaks disk on a box that updates every release. This extends
 * the existing daily-purge cron (index.ts, 03:00) with a filesystem GC that
 * drops backup dirs for terminal updates older than the retention window.
 *
 * The purge is deliberately conservative:
 *   - a backup dir with NO matching DeviceUpdate row is left alone (it is
 *     either mid-write from a just-started apply, or hand-placed forensic
 *     material — never our call to delete blind);
 *   - a backup for a non-terminal row (pending/verifying/applying) is NEVER
 *     purged — it is the live rollback target;
 *   - age is measured off the row's updatedAt (when it reached its terminal
 *     status), NOT the dir mtime, so a clock skew on the box can't strand or
 *     prematurely reap a backup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import { purgeUpdateBackups } from "./purge-update-backups.js";

interface Row {
  id: string;
  status: string;
  updatedAt: Date;
}

function createPrismaStub(rows: Row[]) {
  return {
    deviceUpdate: {
      findMany: async (args: {
        where?: { status?: { in: string[] }; updatedAt?: { lt: Date } };
      }) => {
        const wantStatus = args.where?.status?.in;
        const before = args.where?.updatedAt?.lt;
        return rows.filter(
          (r) =>
            (wantStatus === undefined || wantStatus.includes(r.status)) &&
            (before === undefined || r.updatedAt.getTime() < before.getTime()),
        );
      },
    },
  } as never as PrismaClient;
}

function loggerSpy() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never as pino.Logger;
}

let updatesDir: string;

function seedBackup(id: string): string {
  const dir = path.join(updatesDir, id, "backup");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "previous-refs.json"), JSON.stringify({ orchestrator: "sha256:x" }));
  return path.join(updatesDir, id);
}

beforeEach(() => {
  updatesDir = mkdtempSync(path.join(tmpdir(), "warp539-updates-"));
});

afterEach(() => {
  rmSync(updatesDir, { recursive: true, force: true });
});

describe("purgeUpdateBackups (WARP-539)", () => {
  it("removes backup dirs for TERMINAL updates older than the window", async () => {
    const oldCommitted = seedBackup("du-old-committed");
    const oldRolledBack = seedBackup("du-old-rolledback");
    const prisma = createPrismaStub([
      { id: "du-old-committed", status: "committed", updatedAt: new Date(Date.now() - 10 * 86400_000) },
      { id: "du-old-rolledback", status: "rolled_back", updatedAt: new Date(Date.now() - 8 * 86400_000) },
    ]);

    const res = await purgeUpdateBackups(prisma, { updatesDir, retentionDays: 7, logger: loggerSpy() });

    expect(res.purged).toBe(2);
    expect(existsSync(path.join(oldCommitted, "backup"))).toBe(false);
    expect(existsSync(path.join(oldRolledBack, "backup"))).toBe(false);
    // The whole per-update dir is reaped once its backup is gone.
    expect(existsSync(oldCommitted)).toBe(false);
    expect(existsSync(oldRolledBack)).toBe(false);
  });

  it("keeps backups for terminal updates INSIDE the window", async () => {
    const recent = seedBackup("du-recent");
    const prisma = createPrismaStub([
      { id: "du-recent", status: "committed", updatedAt: new Date(Date.now() - 2 * 86400_000) },
    ]);

    const res = await purgeUpdateBackups(prisma, { updatesDir, retentionDays: 7, logger: loggerSpy() });

    expect(res.purged).toBe(0);
    expect(existsSync(path.join(recent, "backup"))).toBe(true);
  });

  it("NEVER purges a non-terminal (live rollback target) update, even if old", async () => {
    const applying = seedBackup("du-applying");
    const prisma = createPrismaStub([
      { id: "du-applying", status: "applying", updatedAt: new Date(Date.now() - 30 * 86400_000) },
    ]);

    const res = await purgeUpdateBackups(prisma, { updatesDir, retentionDays: 7, logger: loggerSpy() });

    expect(res.purged).toBe(0);
    expect(existsSync(path.join(applying, "backup"))).toBe(true);
  });

  it("leaves an orphan backup dir with no matching DeviceUpdate row untouched", async () => {
    const orphan = seedBackup("du-orphan");
    const prisma = createPrismaStub([]); // no rows at all

    const res = await purgeUpdateBackups(prisma, { updatesDir, retentionDays: 7, logger: loggerSpy() });

    expect(res.purged).toBe(0);
    expect(existsSync(path.join(orphan, "backup"))).toBe(true);
  });

  it("is a no-op when the updates dir does not exist yet (fresh box)", async () => {
    const prisma = createPrismaStub([]);
    const res = await purgeUpdateBackups(prisma, {
      updatesDir: path.join(updatesDir, "does-not-exist"),
      retentionDays: 7,
      logger: loggerSpy(),
    });
    expect(res.purged).toBe(0);
  });

  it("tolerates a terminal row whose backup dir was already removed", async () => {
    // Row is terminal + old, but no dir on disk (already GC'd, or never
    // snapshotted because the apply was rejected pre-snapshot).
    const prisma = createPrismaStub([
      { id: "du-gone", status: "failed", updatedAt: new Date(Date.now() - 20 * 86400_000) },
    ]);
    const res = await purgeUpdateBackups(prisma, { updatesDir, retentionDays: 7, logger: loggerSpy() });
    expect(res.purged).toBe(0);
  });
});
