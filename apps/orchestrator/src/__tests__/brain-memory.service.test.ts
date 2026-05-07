/**
 * Unit tests for the brain-memory filesystem helpers (WARP-203).
 *
 * Spec §6.2 (storage layout on disk) — these helpers own the
 * /data/brain-memory/<userId>/<itemId>/ tree. We exercise them against a
 * temp directory so the tests run without the bind-mount the production
 * deployment relies on.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let svc: typeof import("../services/brain-memory.service.js");
let tmpRoot: string;

beforeAll(async () => {
  // Pin BRAIN_MEMORY_ROOT to a temp dir BEFORE the module loads — the
  // module reads the env var at import time and freezes BRAIN_ROOT.
  const dir = await mkdtemp(join(tmpdir(), "brain-memory-test-"));
  process.env.BRAIN_MEMORY_ROOT = dir;
  tmpRoot = dir;
  svc = await import("../services/brain-memory.service.js");
});

beforeEach(async () => {
  // Ensure a clean slate between tests — delete the whole tree, then
  // recreate the root.
  await rm(tmpRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("brain-memory.service", () => {
  it("pathForItem composes /<root>/<userId>/<itemId>", () => {
    const p = svc.pathForItem("alice", "abc123");
    expect(p).toBe(join(tmpRoot, "alice", "abc123"));
  });

  it("ensureItemDir creates the per-item directory recursively", async () => {
    const dir = await svc.ensureItemDir("alice", "abc123");
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });

  it("writeOriginal writes bytes under the item dir as original.<ext>", async () => {
    const bytes = Buffer.from("hello world");
    const path = await svc.writeOriginal(
      "alice",
      "item-1",
      "budget.pdf",
      bytes,
    );
    expect(path).toBe(join(tmpRoot, "alice", "item-1", "original.pdf"));
    const written = await readFile(path);
    expect(written.equals(bytes)).toBe(true);
  });

  it("writeOriginal handles filenames without an extension", async () => {
    const bytes = Buffer.from("plain");
    const path = await svc.writeOriginal(
      "alice",
      "item-2",
      "Makefile",
      bytes,
    );
    expect(path).toBe(join(tmpRoot, "alice", "item-2", "original"));
    expect((await readFile(path)).equals(bytes)).toBe(true);
  });

  it("writeManifest writes pretty-printed JSON to manifest.json", async () => {
    const manifest = { itemId: "x", filename: "y.txt", bytes: 12 };
    await svc.writeManifest("alice", "item-3", manifest);
    const raw = await readFile(
      join(tmpRoot, "alice", "item-3", "manifest.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual(manifest);
    expect(raw).toContain("\n  "); // pretty-printed
  });

  it("purgeItem removes only the named item directory", async () => {
    await svc.writeOriginal("alice", "keep", "a.txt", Buffer.from("a"));
    await svc.writeOriginal("alice", "drop", "b.txt", Buffer.from("b"));
    await svc.purgeItem("alice", "drop");
    const dropped = await stat(join(tmpRoot, "alice", "drop")).catch(
      () => null,
    );
    expect(dropped).toBeNull();
    const kept = await stat(join(tmpRoot, "alice", "keep"));
    expect(kept.isDirectory()).toBe(true);
  });

  it("purgeUser removes the user tree, leaving siblings intact", async () => {
    await svc.writeOriginal("alice", "i1", "a.txt", Buffer.from("a"));
    await svc.writeOriginal("bob", "i1", "b.txt", Buffer.from("b"));
    await svc.purgeUser("alice");
    const aliceGone = await stat(join(tmpRoot, "alice")).catch(() => null);
    expect(aliceGone).toBeNull();
    const bob = await stat(join(tmpRoot, "bob"));
    expect(bob.isDirectory()).toBe(true);
  });

  it("isPathUnderUser blocks parent-traversal escapes", () => {
    expect(svc.isPathUnderUser("alice", join(tmpRoot, "alice", "x"))).toBe(
      true,
    );
    expect(svc.isPathUnderUser("alice", join(tmpRoot, "bob", "x"))).toBe(
      false,
    );
    expect(
      svc.isPathUnderUser("alice", join(tmpRoot, "alice", "..", "bob")),
    ).toBe(false);
  });

  // ── WARP-205 ──
  // purgeUserData drives the cascade-on-user-delete path wired into
  // routes/auth.ts. Run against an in-memory fake prisma to keep the
  // test fast (real prisma is exercised end-to-end in the live
  // integration suite).
  it("purgeUserData deletes brain rows + chunks + user tree, leaves siblings alone", async () => {
    await svc.writeOriginal("alice", "i1", "a.txt", Buffer.from("a"));
    await svc.writeOriginal("bob", "i1", "b.txt", Buffer.from("b"));

    const aliceItems = [
      { id: "i1", userId: "alice" },
      { id: "i2", userId: "alice" },
    ];
    const aliceChunks = [
      { id: 1n, userId: "alice", source: "brain" },
      { id: 2n, userId: "alice", source: "brain" },
      { id: 3n, userId: "alice", source: "brain" },
    ];
    const bobItems = [{ id: "i1", userId: "bob" }];
    const bobChunks = [{ id: 4n, userId: "bob", source: "brain" }];

    const items = [...aliceItems, ...bobItems];
    const chunks = [...aliceChunks, ...bobChunks];

    const fakePrisma = {
      brainMemoryItem: {
        deleteMany: async ({ where }: { where: { userId: string } }) => {
          const before = items.length;
          for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].userId === where.userId) items.splice(i, 1);
          }
          return { count: before - items.length };
        },
      },
      fileContentChunk: {
        deleteMany: async ({
          where,
        }: {
          where: { userId: string; source: string };
        }) => {
          const before = chunks.length;
          for (let i = chunks.length - 1; i >= 0; i--) {
            if (
              chunks[i].userId === where.userId &&
              chunks[i].source === where.source
            )
              chunks.splice(i, 1);
          }
          return { count: before - chunks.length };
        },
      },
    };

    const result = await svc.purgeUserData(
      fakePrisma as unknown as import("@prisma/client").PrismaClient,
      "alice",
    );

    expect(result.items).toBe(2);
    expect(result.chunks).toBe(3);
    expect(items).toEqual([{ id: "i1", userId: "bob" }]);
    expect(chunks).toEqual([{ id: 4n, userId: "bob", source: "brain" }]);

    // On-disk: alice tree gone, bob untouched.
    const aliceGone = await stat(join(tmpRoot, "alice")).catch(() => null);
    expect(aliceGone).toBeNull();
    const bob = await stat(join(tmpRoot, "bob"));
    expect(bob.isDirectory()).toBe(true);
  });

  it("purgeUserData is idempotent — safe to call on a user with no data", async () => {
    const fakePrisma = {
      brainMemoryItem: {
        deleteMany: async () => ({ count: 0 }),
      },
      fileContentChunk: {
        deleteMany: async () => ({ count: 0 }),
      },
    };

    const result = await svc.purgeUserData(
      fakePrisma as unknown as import("@prisma/client").PrismaClient,
      "ghost-user",
    );
    expect(result).toEqual({ items: 0, chunks: 0 });
  });
});
