/**
 * Unit tests for the brain-memory filesystem helpers (WARP-203).
 *
 * Spec §6.2 (storage layout on disk) — these helpers own the
 * /data/brain-memory/<userId>/<itemId>/ tree. We exercise them against a
 * temp directory so the tests run without the bind-mount the production
 * deployment relies on.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir } from "node:fs/promises";
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

  // ── CodeQL js/path-injection (#168–#171) ──
  // userId / itemId arrive as raw route params; every path constructor must
  // refuse anything that is not a single, traversal-free segment.
  describe("path-segment guard", () => {
    const badIds = ["..", "../bob", "a/b", "a\\b", "", "/etc", "x\0y", "a".repeat(129)];

    it.each(badIds)("pathForItem rejects userId %j", (bad) => {
      expect(() => svc.pathForItem(bad, "item-1")).toThrow(/invalid userId/);
    });

    it.each(badIds)("pathForItem rejects itemId %j", (bad) => {
      expect(() => svc.pathForItem("alice", bad)).toThrow(/invalid itemId/);
    });

    it("accepts UUIDs and pre-WARP-485 Nextcloud usernames", () => {
      const uuid = "3f1c2a9e-1b2c-4d5e-8f90-abcdef123456";
      expect(svc.pathForItem(uuid, uuid)).toBe(join(tmpRoot, uuid, uuid));
      expect(svc.pathForItem("stefan.cruceru@warp-lab.ai", "x")).toBe(
        join(tmpRoot, "stefan.cruceru@warp-lab.ai", "x"),
      );
      expect(svc.pathForItem("o'brien jr", "x")).toBe(
        join(tmpRoot, "o'brien jr", "x"),
      );
    });

    it("purgeUser refuses traversal and absolute-path probes, leaving siblings intact", async () => {
      await mkdir(join(tmpRoot, "bob"), { recursive: true });
      await writeFile(join(tmpRoot, "bob", "keep.txt"), "x");

      await expect(svc.purgeUser("../bob")).rejects.toThrow(/invalid userId/);
      await expect(svc.purgeUser("..")).rejects.toThrow(/invalid userId/);
      await expect(svc.purgeUser("/")).rejects.toThrow(/invalid userId/);
      await expect(svc.purgeUser(tmpRoot)).rejects.toThrow(/invalid userId/);

      expect((await stat(join(tmpRoot, "bob", "keep.txt"))).isFile()).toBe(true);
      expect((await stat(tmpRoot)).isDirectory()).toBe(true);
    });

    it("ensureItemDir / writeManifest / purgeItem refuse a traversing itemId", async () => {
      await mkdir(join(tmpRoot, "bob", "secret"), { recursive: true });

      await expect(svc.ensureItemDir("alice", "../bob/escape")).rejects.toThrow(
        /invalid itemId/,
      );
      await expect(svc.writeManifest("alice", "../bob", { a: 1 })).rejects.toThrow(
        /invalid itemId/,
      );
      await expect(svc.purgeItem("alice", "../bob/secret")).rejects.toThrow(
        /invalid itemId/,
      );

      // Nothing was created or removed outside alice's tree.
      expect((await stat(join(tmpRoot, "bob", "secret"))).isDirectory()).toBe(true);
      await expect(stat(join(tmpRoot, "alice"))).rejects.toThrow();
      await expect(stat(join(tmpRoot, "bob", "manifest.json"))).rejects.toThrow();
    });
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
    // WARP-242: one wrapped DEK per item — alice's must be crypto-shredded
    // with her data, bob's must survive.
    const dekRows = [
      { keyId: "brain:i1", version: 1 }, // alice's i1 (bob's i1 shares the id in this fixture; fine — the shred keys off alice's item ids)
      { keyId: "brain:i2", version: 1 },
      { keyId: "brain:untouched", version: 1 },
    ];

    const fakePrisma = {
      brainMemoryItem: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          items.filter((i) => i.userId === where.userId).map((i) => ({ id: i.id })),
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
      documentEncryptionKey: {
        deleteMany: async ({
          where,
        }: {
          where: { keyId: { in: string[] } };
        }) => {
          for (let i = dekRows.length - 1; i >= 0; i--) {
            if (where.keyId.in.includes(dekRows[i].keyId)) dekRows.splice(i, 1);
          }
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
    // WARP-242: alice's DEKs are gone (crypto-shred), unrelated keys remain.
    expect(dekRows).toEqual([{ keyId: "brain:untouched", version: 1 }]);

    // On-disk: alice tree gone, bob untouched.
    const aliceGone = await stat(join(tmpRoot, "alice")).catch(() => null);
    expect(aliceGone).toBeNull();
    const bob = await stat(join(tmpRoot, "bob"));
    expect(bob.isDirectory()).toBe(true);
  });

  it("purgeUserData is idempotent — safe to call on a user with no data", async () => {
    const fakePrisma = {
      brainMemoryItem: {
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
      },
      fileContentChunk: {
        deleteMany: async () => ({ count: 0 }),
      },
      documentEncryptionKey: {
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

// ── WARP-493 (recovered from PR #275's reverted WARP-488 commits) ──
// Boot-time migrator that renames username-keyed per-user dirs to
// UUID-keyed dirs after WARP-485's auth-id normalization. The pre-WARP-485
// OCS fallback stored req.user.id as the Nextcloud username string, and
// any item uploaded under that session landed in BRAIN_ROOT/<username>/.
// Post-WARP-485 req.user.id is the local User.id UUID, so old dirs are
// orphaned. This migrator looks up User.nextcloudUsername to resolve the
// rename target and uses fs.renameSync (atomic on the same filesystem) so
// inodes are preserved.
describe("brain-memory migrateBrainMemoryDirectoryLayout (WARP-493)", () => {
  // Use a sibling tempdir so we don't fight the suite-wide beforeEach that
  // wipes the outer tmpRoot. We mint and tear down our own dir per case.
  let migRoot: string;

  beforeEach(async () => {
    migRoot = await mkdtemp(join(tmpdir(), "brain-memory-migrate-"));
  });

  afterEach(async () => {
    await rm(migRoot, { recursive: true, force: true });
  });

  // Minimal Prisma stub. The migrator only calls user.findUnique with
  // `{ where: { nextcloudUsername } }`; everything else can throw.
  function makePrisma(
    rows: { id: string; nextcloudUsername: string }[],
  ): import("@prisma/client").PrismaClient {
    return {
      user: {
        findUnique: vi.fn(
          async ({ where }: { where: { nextcloudUsername: string } }) => {
            return (
              rows.find((r) => r.nextcloudUsername === where.nextcloudUsername) ??
              null
            );
          },
        ),
      },
    } as unknown as import("@prisma/client").PrismaClient;
  }

  it("renames a username-keyed dir to its matching UUID", async () => {
    // Seed: BRAIN_ROOT/stefan-cruceru/item-1/original.pdf
    const username = "stefan-cruceru";
    const uuid = "11111111-2222-3333-4444-555555555555";
    await mkdir(join(migRoot, username, "item-1"), { recursive: true });
    await writeFile(join(migRoot, username, "item-1", "original.pdf"), "x");

    const prisma = makePrisma([{ id: uuid, nextcloudUsername: username }]);

    const result = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);

    expect(result.renamed).toBe(1);
    expect(result.skippedUuid).toBe(0);
    expect(result.orphans).toEqual([]);
    expect(result.conflicts).toEqual([]);

    // Old name gone, new UUID name present with bytes intact.
    const oldGone = await stat(join(migRoot, username)).catch(() => null);
    expect(oldGone).toBeNull();
    const newDir = await stat(join(migRoot, uuid));
    expect(newDir.isDirectory()).toBe(true);
    const bytes = await readFile(
      join(migRoot, uuid, "item-1", "original.pdf"),
      "utf8",
    );
    expect(bytes).toBe("x");
  });

  it("is idempotent — UUID-named dirs are skipped, second run is a no-op", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await mkdir(join(migRoot, uuid, "item-1"), { recursive: true });

    const prisma = makePrisma([]); // No user lookups should fire.

    const r1 = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);
    expect(r1.renamed).toBe(0);
    expect(r1.skippedUuid).toBe(1);
    expect(r1.orphans).toEqual([]);

    // Lookup must not have been called — dir is already a UUID.
    expect(
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);

    const r2 = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);
    expect(r2.renamed).toBe(0);
    expect(r2.skippedUuid).toBe(1);
  });

  it("logs orphan (username with no matching User) and leaves dir untouched", async () => {
    const orphan = "ghost-user";
    await mkdir(join(migRoot, orphan, "item-x"), { recursive: true });

    const prisma = makePrisma([]); // No matching User row.

    const result = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);

    expect(result.renamed).toBe(0);
    expect(result.orphans).toEqual([orphan]);

    // Dir still in place.
    const stillThere = await stat(join(migRoot, orphan));
    expect(stillThere.isDirectory()).toBe(true);
  });

  it("logs conflict and skips when BOTH username dir AND UUID dir exist (no overwrite)", async () => {
    // Data-loss scenario: rename would clobber an existing UUID-named dir.
    // The migrator MUST skip, log, and let the operator resolve manually.
    const username = "stefan-cruceru";
    const uuid = "11111111-2222-3333-4444-555555555555";
    await mkdir(join(migRoot, username, "old-item"), { recursive: true });
    await writeFile(join(migRoot, username, "old-item", "x.txt"), "old");
    await mkdir(join(migRoot, uuid, "new-item"), { recursive: true });
    await writeFile(join(migRoot, uuid, "new-item", "y.txt"), "new");

    const prisma = makePrisma([{ id: uuid, nextcloudUsername: username }]);

    const result = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);

    expect(result.renamed).toBe(0);
    expect(result.conflicts).toEqual([
      { username, uuid, reason: "uuid_dir_exists" },
    ]);

    // BOTH dirs still in place with original contents.
    const oldStill = await readFile(
      join(migRoot, username, "old-item", "x.txt"),
      "utf8",
    );
    expect(oldStill).toBe("old");
    const newStill = await readFile(
      join(migRoot, uuid, "new-item", "y.txt"),
      "utf8",
    );
    expect(newStill).toBe("new");
  });

  it("is safe on an empty BRAIN_ROOT (no entries → zero work)", async () => {
    const prisma = makePrisma([]);
    const result = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);
    expect(result).toEqual({
      renamed: 0,
      skippedUuid: 0,
      orphans: [],
      conflicts: [],
    });
  });

  it("ignores non-directory entries at the BRAIN_ROOT level", async () => {
    // A stray file at the root (e.g. .DS_Store, or a manifest the operator
    // copied in) MUST NOT trip the migrator. Only top-level directories
    // are candidate per-user trees.
    await writeFile(join(migRoot, ".DS_Store"), "");
    await mkdir(join(migRoot, "stefan-cruceru", "item-1"), {
      recursive: true,
    });

    const uuid = "33333333-4444-5555-6666-777777777777";
    const prisma = makePrisma([
      { id: uuid, nextcloudUsername: "stefan-cruceru" },
    ]);

    const result = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);
    expect(result.renamed).toBe(1);
    expect(result.orphans).toEqual([]);

    // Stray file untouched at root.
    const stray = await stat(join(migRoot, ".DS_Store"));
    expect(stray.isFile()).toBe(true);

    // Migrated dir present, old gone.
    const newDir = await stat(join(migRoot, uuid));
    expect(newDir.isDirectory()).toBe(true);
    const oldGone = await stat(join(migRoot, "stefan-cruceru")).catch(
      () => null,
    );
    expect(oldGone).toBeNull();
  });

  it("processes multiple users in one pass — renames each independently", async () => {
    await mkdir(join(migRoot, "alice", "i1"), { recursive: true });
    await mkdir(join(migRoot, "bob", "i2"), { recursive: true });
    await mkdir(join(migRoot, "ghost", "i3"), { recursive: true });
    const aliceUuid = "aaaaaaaa-1111-1111-1111-111111111111";
    const bobUuid = "bbbbbbbb-2222-2222-2222-222222222222";

    const prisma = makePrisma([
      { id: aliceUuid, nextcloudUsername: "alice" },
      { id: bobUuid, nextcloudUsername: "bob" },
      // No row for "ghost" → orphan.
    ]);

    const result = await svc.migrateBrainMemoryDirectoryLayout(prisma, migRoot);
    expect(result.renamed).toBe(2);
    expect(result.orphans).toEqual(["ghost"]);

    const entries = await readdir(migRoot);
    entries.sort();
    expect(entries).toEqual([aliceUuid, bobUuid, "ghost"].sort());
  });

  it("is safe when BRAIN_ROOT itself does not exist (missing tmpdir)", async () => {
    // Operator runs the orchestrator before any brain-memory item has
    // ever been written → the bind-mount target may not exist yet. The
    // migrator must succeed cleanly and report zero work.
    const missingRoot = join(migRoot, "does", "not", "exist");
    const prisma = makePrisma([]);
    const result = await svc.migrateBrainMemoryDirectoryLayout(
      prisma,
      missingRoot,
    );
    expect(result).toEqual({
      renamed: 0,
      skippedUuid: 0,
      orphans: [],
      conflicts: [],
    });
  });
});
