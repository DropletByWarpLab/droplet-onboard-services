/** Cleanup survives the attachment rows it serves, and retries real unlink failures. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { makeAttachmentFake } from "../../__tests__/helpers/pm-attachment-fake.js";
import { blobPath } from "./pm-attachment-storage.js";
import { sweepAttachments } from "./pm-attachments.service.js";
import { ATTACHMENT_CLEANUP_PREFIX as PREFIX, finishAttachmentCleanup, queueAttachmentCleanup } from "./pm-attachment-cleanup.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pm-cleanup-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function writeBlob(key: string) {
  const path = blobPath(root, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "private attachment bytes");
  return path;
}

describe("durable attachment cleanup", () => {
  it("recovers a committed cascade interrupted before unlink, through the existing sweep", async () => {
    const f = makeAttachmentFake();
    const key = randomUUID();
    const path = writeBlob(key);
    await queueAttachmentCleanup(f.prisma, [key, key, "../outside"]);
    expect(f.db.flags).toEqual([{ key: PREFIX + key, valueJson: { storageKey: key } }]);
    expect(f.db.attachments).toEqual([]); // the cascade already committed
    expect(existsSync(path)).toBe(true);

    await sweepAttachments(f.prisma, { root });
    expect(existsSync(path)).toBe(false);
    expect(f.db.flags).toEqual([]);
    await sweepAttachments(f.prisma, { root }); // already gone is idempotent
  });

  it("retains a failed unlink intent, drains other blobs, and retries after the filesystem is repaired", async () => {
    const f = makeAttachmentFake();
    const stuck = randomUUID();
    const fine = randomUUID();
    const badPath = blobPath(root, stuck);
    mkdirSync(badPath, { recursive: true }); // rm without recursive must fail
    const finePath = writeBlob(fine);
    await queueAttachmentCleanup(f.prisma, [stuck, fine]);

    await sweepAttachments(f.prisma, { root });
    expect(f.db.flags.map((r) => r.key)).toEqual([PREFIX + stuck]);
    expect(existsSync(finePath)).toBe(false);
    expect(existsSync(badPath)).toBe(true);
    rmSync(badPath, { recursive: true });
    writeFileSync(badPath, "now removable");
    await sweepAttachments(f.prisma, { root });
    expect(existsSync(badPath)).toBe(false);
    expect(f.db.flags).toEqual([]);
  });

  it("cannot unlink a traversal, an unrelated SystemFlag, or a blob bound to a different cleanup key", async () => {
    const f = makeAttachmentFake();
    const keep = randomUUID();
    const path = writeBlob(keep);
    f.db.flags.push(
      { key: PREFIX + randomUUID(), valueJson: { storageKey: keep } },
      { key: PREFIX + "bad", valueJson: { storageKey: "../outside" } },
      { key: PREFIX + "empty", valueJson: null },
      { key: "other-feature:cleanup", valueJson: { storageKey: keep } },
    );
    await sweepAttachments(f.prisma, { root });
    expect(f.db.flags).toHaveLength(4);
    expect(existsSync(path)).toBe(true);
  });

  it("leaves the marker on DB acknowledgement failure, then retries an already absent blob", async () => {
    const f = makeAttachmentFake();
    const prisma: PrismaClient = f.prisma;
    const key = randomUUID();
    const path = writeBlob(key);
    await queueAttachmentCleanup(f.prisma, [key]);
    const ack = vi.spyOn(prisma.systemFlag, "deleteMany").mockRejectedValueOnce(new Error("database unavailable"));

    await expect(finishAttachmentCleanup(prisma, PREFIX + key, root)).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(f.db.flags).toHaveLength(1);
    ack.mockRestore();
    await sweepAttachments(prisma, { root });
    expect(f.db.flags).toEqual([]);
  });

  it("does not let malformed markers at the start of a batch starve later deletions", async () => {
    const f = makeAttachmentFake();
    for (let i = 0; i < 200; i += 1) {
      f.db.flags.push({ key: `${PREFIX}0000-${String(i).padStart(3, "0")}`, valueJson: null });
    }
    const key = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const path = writeBlob(key);
    await queueAttachmentCleanup(f.prisma, [key]);
    await sweepAttachments(f.prisma, { root });
    expect(existsSync(path)).toBe(false);
    expect(f.db.flags).toHaveLength(200);
  });

  it("bounds each sweep and leaves excess committed intents for its next tick", async () => {
    const f = makeAttachmentFake();
    const keys = Array.from({ length: 2001 }, () => randomUUID());
    await queueAttachmentCleanup(f.prisma, keys);
    await sweepAttachments(f.prisma, { root }); // missing blobs also count as confirmed removal
    expect(f.db.flags).toHaveLength(1);
    await sweepAttachments(f.prisma, { root });
    expect(f.db.flags).toEqual([]);
  }, 120_000);
});
