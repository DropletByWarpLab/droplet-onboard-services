/**
 * WARP-2834 (ADR-051) — what the corpus pass COUNTS as read.
 *
 * `runCorpusPass` had no test at all before this file. Its pure helpers
 * (`encodeCursor`, `parseDigests`) were covered in `brain-pass.test.ts`; the
 * loop that decides what `/brief` reports was not, which is how it came to
 * count a document it never opened.
 *
 * THE DEFECT THESE CASES PIN. The loop skips a document with no extractable
 * text, and one whose owner cannot be resolved to a local `User` — then
 * advanced BOTH `unitsSeen` and `unitsDigested` regardless. `/coverage` renders
 * `unitsDigested` as "documents read", so the brain reported having read
 * documents it had not opened.
 *
 * It overstated WORST on the corpus that matters most. The file-indexer writes
 * every groupfolder document under a sentinel owner — `__household__`, or
 * `__dept_<uuid>__` since WARP-1264 — and no `User` row carries those, so on a
 * business box, whose shared drive IS the corpus, the unresolvable-owner branch
 * is the common case rather than the edge.
 *
 * The distinction the cases below hold: a unit is `digested` when the model
 * READ it. A document the model read and found nothing worth recording in is
 * still digested — the inference was spent and the document has been
 * considered. "Produced nothing" lives in `rowsWritten`, not here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.mock` is hoisted above every const, so the spies have to be hoisted with
// it — the repo's `vi.hoisted` pattern (brain-notify.test.ts, agent-runs).
// Declaring them as plain consts throws "Cannot access before initialization"
// at collection, and the whole file reports "no tests" rather than a failure.
const { upsertDigest, decryptChunkRows } = vi.hoisted(() => ({
  upsertDigest: vi.fn(async () => ({ id: "d1" })),
  // Passes plaintext rows through, as it does on an unencrypted box.
  decryptChunkRows: vi.fn(async (_p: unknown, rows: unknown[]) => rows),
}));
vi.mock("../services/brain/brain-digest.service", () => ({ upsertDigest }));
vi.mock("../services/brain/brain-digest.service.js", () => ({ upsertDigest }));
vi.mock("../services/file-search.service", () => ({ decryptChunkRows }));
vi.mock("../services/file-search.service.js", () => ({ decryptChunkRows }));

import { runCorpusPass, CORPUS_PASS_KEY } from "../services/brain/brain-corpus.service";

type FileRow = { updatedAt: Date; path: string; ncFileId: number; userId: string };

const NOW = new Date("2033-06-10T00:00:00.000Z");

/** A model that always answers with one well-formed digest. */
const okChat = vi.fn(async () => ({
  ok: true,
  json: async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify([
            { kind: "entity", title: "Acme", body: "A customer.", quote: "Acme Ltd" },
          ]),
        },
      },
    ],
  }),
}));

/** `brainPass.update` calls are the assertion surface — that is where the
 *  counters move. */
const updates: Array<Record<string, unknown>> = [];

function deps(
  files: FileRow[],
  over: { chunkText?: string | null; ownerRow?: { id: string } | null } = {},
) {
  const prisma = {
    brainPass: {
      upsert: vi.fn(async () => ({ enabled: true, cursor: null })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      }),
    },
    fileIndexStatus: { findMany: vi.fn(async () => files) },
    fileContentChunk: {
      findMany: vi.fn(async () => [
        { text: over.chunkText === undefined ? "Acme Ltd is a customer." : over.chunkText },
      ]),
    },
    user: {
      findFirst: vi.fn(async () =>
        over.ownerRow === undefined ? { id: "u-owner" } : over.ownerRow,
      ),
    },
  };
  return { prisma: prisma as never, chat: okChat as never, model: "test-model" };
}

function file(over: Partial<FileRow> = {}): FileRow {
  return { updatedAt: NOW, path: "/Acme/contract.pdf", ncFileId: 11, userId: "alice", ...over };
}

/** The `unitsDigested` increment across every update this run made. */
const digestedCount = () =>
  updates.filter((d) => Object.prototype.hasOwnProperty.call(d, "unitsDigested")).length;
const seenCount = () =>
  updates.filter((d) => Object.prototype.hasOwnProperty.call(d, "unitsSeen")).length;

beforeEach(() => {
  updates.length = 0;
  upsertDigest.mockClear();
  okChat.mockClear();
});

describe("runCorpusPass — what counts as read (WARP-2834)", () => {
  it("counts a document the model actually read", async () => {
    const out = await runCorpusPass(deps([file()]), { limit: 10 });
    expect(out.ran).toBe(true);
    expect(seenCount()).toBe(1);
    expect(digestedCount()).toBe(1);
    expect(okChat).toHaveBeenCalledOnce();
  });

  it("does NOT count a document whose owner cannot be resolved", async () => {
    // The `__household__` / `__dept_<uuid>__` case — the shared drive, which on
    // a business box is most of the corpus. The model is never called.
    const out = await runCorpusPass(
      deps([file({ userId: "__household__" })], { ownerRow: null }),
      { limit: 10 },
    );
    expect(out.ran).toBe(true);
    expect(seenCount()).toBe(1);
    expect(digestedCount()).toBe(0);
    expect(okChat).not.toHaveBeenCalled();
    expect(upsertDigest).not.toHaveBeenCalled();
  });

  it("does NOT count a document with no extractable text", async () => {
    const out = await runCorpusPass(deps([file()], { chunkText: "   " }), { limit: 10 });
    expect(out.ran).toBe(true);
    expect(seenCount()).toBe(1);
    expect(digestedCount()).toBe(0);
    expect(okChat).not.toHaveBeenCalled();
  });

  it("still ADVANCES past a skipped document, so the pass cannot wedge", async () => {
    // Not counting it must not mean re-reading it forever. `unitsSeen` and the
    // cursor both move; only `unitsDigested` is withheld.
    await runCorpusPass(deps([file()], { ownerRow: null }), { limit: 10 });
    // The PER-UNIT update is the one that moves the cursor; a second,
    // run-completion update follows it with lastRunAt/rowsWritten and no
    // per-unit counters, so target the first rather than the count.
    const perUnit = updates.find((d) => Object.prototype.hasOwnProperty.call(d, "cursor"));
    expect(perUnit).toBeDefined();
    expect(perUnit).toHaveProperty("unitsSeen");
    expect(perUnit).not.toHaveProperty("unitsDigested");
  });

  it("counts a document the model read but found nothing in", async () => {
    // The inference was spent and the document has been considered. "Produced
    // nothing" is `rowsWritten`'s business, not coverage's — reporting this as
    // unread would understate in the other direction.
    okChat.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "[]" } }] }),
    } as never);
    const out = await runCorpusPass(deps([file()]), { limit: 10 });
    expect(digestedCount()).toBe(1);
    expect(out.digestsWritten).toBe(0);
    expect(upsertDigest).not.toHaveBeenCalled();
  });

  it("counts a mixed batch correctly — read the readable, pass over the rest", async () => {
    // Two files, and the owner lookup answers for neither by default in this
    // fake, so drive it per call.
    const d = deps([file({ path: "/a.pdf" }), file({ path: "/b.pdf", ncFileId: 12 })]);
    (d.prisma as unknown as { user: { findFirst: ReturnType<typeof vi.fn> } }).user.findFirst
      .mockResolvedValueOnce({ id: "u-owner" })
      .mockResolvedValueOnce(null);

    await runCorpusPass(d, { limit: 10 });
    expect(seenCount()).toBe(2);
    expect(digestedCount()).toBe(1);
  });

  it("does nothing at all when the pass is disabled", async () => {
    const d = deps([file()]);
    (d.prisma as unknown as {
      brainPass: { upsert: ReturnType<typeof vi.fn> };
    }).brainPass.upsert.mockResolvedValueOnce({ enabled: false, cursor: null });

    const out = await runCorpusPass(d, { limit: 10 });
    expect(out.ran).toBe(false);
    expect(out.passKey).toBe(CORPUS_PASS_KEY);
    expect(updates).toHaveLength(0);
    expect(okChat).not.toHaveBeenCalled();
  });
});
