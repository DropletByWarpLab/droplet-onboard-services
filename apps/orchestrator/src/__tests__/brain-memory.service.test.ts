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
});
