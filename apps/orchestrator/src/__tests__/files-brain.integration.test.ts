/**
 * WARP-493 — atomic brain-memory cutover integration test.
 *
 * Fills the gap the WARP-488 (PR #275) reviewer identified: no test
 * exercised the DIR MIGRATOR + DB BACKFILL + ROUTE READ PATH together,
 * which is exactly where a partial cutover regresses (dirs renamed but
 * reads still username-keyed = ENOENT on every pre-fix item).
 *
 * Flow under test (mirrors the real deploy order):
 *
 *   1. Seed PRE-FIX state — username-keyed BrainMemoryItem rows AND
 *      username-named `BRAIN_ROOT/<username>/<itemId>/` dirs with real
 *      bytes in a per-suite tempdir.
 *   2. Apply the SQL backfill's row-level effect to the mocked store
 *      (the real `warp_491_brain_memory_userid_backfill` SQL is proven
 *      against a scratch Postgres — see the migration header; vitest
 *      has no Postgres, so the in-memory simulation below mirrors its
 *      three UPDATEs exactly, orphan no-op included).
 *   3. Run the real boot migrator `migrateBrainMemoryDirectoryLayout`.
 *   4. Drive the REAL files-brain router with a UUID-authed request and
 *      assert every pre-fix item is readable — list, manifest, and the
 *      download route, whose byte-streaming hits ownership check +
 *      `isPathUnderUser(storagePath)` + on-disk `stat` in one pass (the
 *      three ways a missed surface would 404/ENOENT).
 *
 * Orphans (username with no `User.nextcloudUsername` mapping) must
 * survive untouched on BOTH layers, and a second migrator+backfill pass
 * must be a no-op (idempotence).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { mkdtemp, mkdir, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let brainRoot: string;

vi.mock("../services/mqtt.service.js", () => ({
  connectMqtt: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn(),
  subscribe: vi.fn(),
  subscribeToTopic: vi.fn(() => () => {}),
  topicMatches: vi.fn(),
}));

// ── In-memory Prisma stand-in ──
//
// Only the pieces this flow touches: BrainMemoryItem findUnique/findMany
// (route reads), User findUnique by nextcloudUsername (dir migrator).
interface ItemRow {
  id: string;
  userId: string;
  filename: string;
  mimeType: string | null;
  bytes: bigint;
  storagePath: string;
  source: string;
  originatingChatId: string | null;
  uploadedAt: Date;
  indexedAt: Date | null;
  extractorWarnings: string[];
  hasOriginalBytes: boolean;
  status: string;
  failureReason: string | null;
  lastAttemptedAt: Date | null;
  recentAttemptCount: number;
  recentAttemptWindowStartedAt: Date | null;
  sha256: string | null;
}

interface UserRow {
  id: string;
  nextcloudUsername: string | null;
}

const itemStore = new Map<string, ItemRow>();
const userStore: UserRow[] = [];

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { nextcloudUsername: string } }) =>
          userStore.find(
            (u) => u.nextcloudUsername === where.nextcloudUsername,
          ) ?? null,
      ),
    },
    brainMemoryItem: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string } }) =>
          (where.id && itemStore.get(where.id)) || null,
      ),
      findMany: vi.fn(
        async ({ where }: { where?: { userId?: string } } = {}) =>
          Array.from(itemStore.values()).filter(
            (r) => !where?.userId || r.userId === where.userId,
          ),
      ),
      count: vi.fn(
        async ({ where }: { where?: { userId?: string } } = {}) =>
          Array.from(itemStore.values()).filter(
            (r) => !where?.userId || r.userId === where.userId,
          ).length,
      ),
    },
    fileContentChunk: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    BrainMemoryItemStatus: {
      queued_for_transcription: "queued_for_transcription",
      indexing: "indexing",
      ready: "ready",
      failed: "failed",
    },
  };
});

const ALICE_UUID = "aaaaaaaa-1111-1111-1111-111111111111";
const ALICE_NC = "alice-nc";
const GHOST_NC = "ghost"; // no User row → orphan on both layers
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Row-level twin of the three UPDATEs in
 * `20260702000000_warp_491_brain_memory_userid_backfill/migration.sql`:
 * join userId → User.nextcloudUsername, skip UUID-shaped keys, rewrite
 * `/<username>/<itemId>/` → `/<uuid>/<itemId>/` in storagePath, flip
 * userId. Orphans (no mapping row) fall through untouched.
 */
function applySqlBackfillEffect(): void {
  for (const row of itemStore.values()) {
    if (UUID_REGEX.test(row.userId)) continue;
    const user = userStore.find((u) => u.nextcloudUsername === row.userId);
    if (!user) continue; // orphan — the SQL is a no-op on these
    row.storagePath = row.storagePath.replace(
      `/${row.userId}/${row.id}/`,
      `/${user.id}/${row.id}/`,
    );
    row.userId = user.id;
  }
}

function makeItem(overrides: Partial<ItemRow> & { id: string }): ItemRow {
  const row: ItemRow = {
    userId: ALICE_NC,
    filename: "notes.txt",
    mimeType: "text/plain",
    bytes: 16n,
    storagePath: "",
    source: "chat_attachment",
    originatingChatId: null,
    uploadedAt: new Date(),
    indexedAt: new Date(),
    extractorWarnings: [],
    hasOriginalBytes: true,
    status: "ready",
    failureReason: null,
    lastAttemptedAt: null,
    recentAttemptCount: 0,
    recentAttemptWindowStartedAt: null,
    sha256: null,
    ...overrides,
  };
  itemStore.set(row.id, row);
  return row;
}

let app: import("express").Express;
let svc: typeof import("../services/brain-memory.service.js");
let prisma: import("@prisma/client").PrismaClient;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-brain-integration-"));
  brainRoot = dir;
  // Pin BEFORE brain-memory.service loads — BRAIN_ROOT freezes at import.
  process.env.BRAIN_MEMORY_ROOT = dir;
  svc = await import("../services/brain-memory.service.js");

  const express = (await import("express")).default;
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient();
  const { createFilesBrainRouter } = await import("../routes/files-brain.js");
  const _app = express();
  _app.use(express.json());
  // UUID-authed production identity shape: id is the local User UUID,
  // username is the Nextcloud display name. Post-493 routes must key
  // exclusively on id.
  _app.use((req, _res, next) => {
    (req as { user?: { id: string; username: string } }).user = {
      id: ALICE_UUID,
      username: ALICE_NC,
    };
    next();
  });
  _app.use("/api", createFilesBrainRouter(prisma));
  app = _app;
});

afterAll(async () => {
  await rm(brainRoot, { recursive: true, force: true });
});

/** Seed the full pre-fix world: username-keyed rows + username dirs + bytes. */
async function seedPreFixState(): Promise<void> {
  itemStore.clear();
  userStore.length = 0;
  await rm(brainRoot, { recursive: true, force: true });
  await mkdir(brainRoot, { recursive: true });

  userStore.push({ id: ALICE_UUID, nextcloudUsername: ALICE_NC });

  // Alice's pre-fix item: row + dir + bytes all keyed by username.
  await mkdir(join(brainRoot, ALICE_NC, "bmi-1"), { recursive: true });
  await writeFile(
    join(brainRoot, ALICE_NC, "bmi-1", "original.txt"),
    "pre-fix bytes",
  );
  makeItem({
    id: "bmi-1",
    userId: ALICE_NC,
    storagePath: join(brainRoot, ALICE_NC, "bmi-1", "original.txt"),
  });

  // Orphan: dir + row keyed by a username with no User mapping.
  await mkdir(join(brainRoot, GHOST_NC, "bmi-ghost"), { recursive: true });
  await writeFile(
    join(brainRoot, GHOST_NC, "bmi-ghost", "original.txt"),
    "ghost bytes",
  );
  makeItem({
    id: "bmi-ghost",
    userId: GHOST_NC,
    storagePath: join(brainRoot, GHOST_NC, "bmi-ghost", "original.txt"),
  });
}

/** The deploy, in order: SQL backfill effect, then boot dir migrator. */
async function runCutover() {
  applySqlBackfillEffect();
  return svc.migrateBrainMemoryDirectoryLayout(prisma, brainRoot);
}

beforeEach(async () => {
  await seedPreFixState();
});

describe("WARP-493 — pre-fix items readable after the atomic cutover", () => {
  it("sanity: BEFORE the cutover a UUID-authed read finds nothing (the bug being fixed)", async () => {
    const list = await request(app).get("/api/files/brain");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(0);
    const dl = await request(app).get("/api/files/brain/bmi-1/download");
    expect(dl.status).toBe(404);
  });

  it("list + manifest + download all serve the pre-fix item via UUID after cutover", async () => {
    const result = await runCutover();
    expect(result.renamed).toBe(1); // alice-nc → UUID
    expect(result.orphans).toEqual([GHOST_NC]);

    // Row converged.
    expect(itemStore.get("bmi-1")?.userId).toBe(ALICE_UUID);

    // List (DB read path).
    const list = await request(app).get("/api/files/brain");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe("bmi-1");

    // Manifest (DB ownership path).
    const manifest = await request(app).get("/api/files/brain/bmi-1");
    expect(manifest.status).toBe(200);
    expect(manifest.body.userId).toBe(ALICE_UUID);

    // Download — the full-coherence probe: ownership (row userId), path
    // guard (isPathUnderUser against the REWRITTEN storagePath under the
    // RENAMED dir), and on-disk stat + byte streaming. This is the exact
    // request that ENOENT'd in the WARP-488 partial-cutover scenario.
    const dl = await request(app).get("/api/files/brain/bmi-1/download");
    expect(dl.status).toBe(200);
    expect(dl.text).toBe("pre-fix bytes");
  });

  it("orphan rows and dirs survive untouched — logged, never deleted", async () => {
    const result = await runCutover();
    expect(result.orphans).toEqual([GHOST_NC]);

    // Row still username-keyed (SQL no-op on orphans).
    expect(itemStore.get("bmi-ghost")?.userId).toBe(GHOST_NC);
    // Dir + bytes still in place under the username name.
    const s = await stat(join(brainRoot, GHOST_NC, "bmi-ghost", "original.txt"));
    expect(s.isFile()).toBe(true);
    // And the orphan is NOT readable by alice (no cross-user leak).
    const dl = await request(app).get("/api/files/brain/bmi-ghost/download");
    expect(dl.status).toBe(404);
  });

  it("second cutover pass is a no-op and pre-fix items stay readable (idempotence)", async () => {
    await runCutover();
    const second = await runCutover();
    expect(second.renamed).toBe(0);
    expect(second.skippedUuid).toBe(1); // alice's converged dir
    expect(second.orphans).toEqual([GHOST_NC]);

    const entries = (await readdir(brainRoot)).sort();
    expect(entries).toEqual([ALICE_UUID, GHOST_NC].sort());

    const dl = await request(app).get("/api/files/brain/bmi-1/download");
    expect(dl.status).toBe(200);
    expect(dl.text).toBe("pre-fix bytes");
  });
});
