/**
 * Notes moved off browser localStorage onto the box, so ownership is now a
 * server-side concern: a note belongs to the user who wrote it, and another
 * household member holding its id must not be able to read it back through a
 * list, edit it, or delete it.
 *
 * Also covers the ordering Home depends on — pinned first, then most recently
 * edited — and that pinning is a plain field update.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  listNotes,
  listPinnedNotes,
  createNote,
  updateNote,
  deleteNote,
  NoteConflictError,
} from "../services/notes.service.js";

/** Minimal in-memory stand-in for prisma.note, including the compound
 *  orderBy the service relies on. */
function makePrismaStub() {
  const notes: any[] = [];
  let nextId = 1;
  let clock = 0;
  const sort = (rows: any[], orderBy: any) => {
    const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0] as [string, string];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  };
  const stub = {
    note: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `n-${nextId++}`,
          createdAt: new Date(++clock),
          updatedAt: new Date(clock),
          ...data,
        };
        notes.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        const rows = notes.filter(
          (n) =>
            n.userId === where.userId &&
            (where.pinned === undefined || n.pinned === where.pinned),
        );
        return sort(rows, orderBy);
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        notes.find((n) => n.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const row = notes.find((n) => n.id === where.id);
        Object.assign(row, data);
        row.updatedAt = new Date(++clock);
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => {
        notes.splice(notes.findIndex((n) => n.id === where.id), 1);
      }),
    },
  };
  return { prisma: stub as unknown as PrismaClient, notes };
}

let prisma: PrismaClient;
beforeEach(() => {
  prisma = makePrismaStub().prisma;
});

describe("notes are private to their author", () => {
  it("a list only returns the caller's own notes", async () => {
    await createNote(prisma, "alice", { body: "alice's" });
    await createNote(prisma, "bob", { body: "bob's" });
    const mine = await listNotes(prisma, "alice");
    expect(mine.map((n) => n.body)).toEqual(["alice's"]);
  });

  it("editing someone else's note is forbidden, even with its id", async () => {
    const hers = await createNote(prisma, "alice", { body: "private" });
    await expect(
      updateNote(prisma, "bob", hers.id, { body: "overwritten" }),
    ).rejects.toThrow("forbidden");
    expect((await listNotes(prisma, "alice"))[0].body).toBe("private");
  });

  it("deleting someone else's note is forbidden", async () => {
    const hers = await createNote(prisma, "alice", { body: "private" });
    await expect(deleteNote(prisma, "bob", hers.id)).rejects.toThrow("forbidden");
    expect(await listNotes(prisma, "alice")).toHaveLength(1);
  });

  it("a missing id is a not-found, not a silent success", async () => {
    await expect(updateNote(prisma, "alice", "nope", { pinned: true })).rejects.toThrow(
      "note_not_found",
    );
    await expect(deleteNote(prisma, "alice", "nope")).rejects.toThrow("note_not_found");
  });
});

/**
 * WARP-1885. Notes have no browser-local copy behind them any more, so a
 * blind last-write-wins PATCH destroys work with no way back: an editor left
 * open on a laptop overwrites paragraphs added from a phone, and the status
 * line says "Saved". `expectedUpdatedAt` makes the write conditional.
 */
describe("a stale edit can't silently overwrite a newer one", () => {
  it("refuses an edit based on a version the note has moved past", async () => {
    const n = await createNote(prisma, "alice", { body: "from the phone" });
    const stale = n.updatedAt.toISOString();
    // Another device saves first.
    await updateNote(prisma, "alice", n.id, { body: "two more paragraphs" });

    await expect(
      updateNote(prisma, "alice", n.id, {
        body: "laptop's stale text",
        expectedUpdatedAt: stale,
      }),
    ).rejects.toThrow("note_conflict");
    // The newer version is still the one on the box.
    expect((await listNotes(prisma, "alice"))[0].body).toBe("two more paragraphs");
  });

  it("the refusal carries the note as it now stands, so the UI can offer both", async () => {
    const n = await createNote(prisma, "alice", { body: "original" });
    const stale = n.updatedAt.toISOString();
    await updateNote(prisma, "alice", n.id, { body: "theirs" });

    const err = await updateNote(prisma, "alice", n.id, {
      body: "mine",
      expectedUpdatedAt: stale,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoteConflictError);
    expect((err as NoteConflictError).current.body).toBe("theirs");
  });

  it("an edit based on the current version goes through", async () => {
    const n = await createNote(prisma, "alice", { body: "draft" });
    const saved = await updateNote(prisma, "alice", n.id, {
      body: "finished",
      expectedUpdatedAt: n.updatedAt.toISOString(),
    });
    expect(saved.body).toBe("finished");
  });

  it("a patch with no expected version still writes — pin/unpin doesn't race", async () => {
    const n = await createNote(prisma, "alice", { body: "x" });
    await updateNote(prisma, "alice", n.id, { body: "moved on" });
    const pinned = await updateNote(prisma, "alice", n.id, { pinned: true });
    expect(pinned.pinned).toBe(true);
    expect(pinned.body).toBe("moved on");
  });

  it("ownership is settled before freshness — a stranger learns nothing about timing", async () => {
    const hers = await createNote(prisma, "alice", { body: "private" });
    await expect(
      updateNote(prisma, "bob", hers.id, {
        body: "overwritten",
        expectedUpdatedAt: new Date(0).toISOString(),
      }),
    ).rejects.toThrow("forbidden");
  });
});

describe("pinning", () => {
  it("a new note starts unpinned", async () => {
    const n = await createNote(prisma, "alice", { body: "hi" });
    expect(n.pinned).toBe(false);
  });

  it("pin then unpin round-trips without touching the body", async () => {
    const n = await createNote(prisma, "alice", { body: "keep me" });
    const pinned = await updateNote(prisma, "alice", n.id, { pinned: true });
    expect(pinned.pinned).toBe(true);
    expect(pinned.body).toBe("keep me");
    const unpinned = await updateNote(prisma, "alice", n.id, { pinned: false });
    expect(unpinned.pinned).toBe(false);
    expect(unpinned.body).toBe("keep me");
  });

  it("Home reads only the pinned ones, newest first", async () => {
    const a = await createNote(prisma, "alice", { body: "first" });
    const b = await createNote(prisma, "alice", { body: "second" });
    await createNote(prisma, "alice", { body: "unpinned" });
    await updateNote(prisma, "alice", a.id, { pinned: true });
    await updateNote(prisma, "alice", b.id, { pinned: true });
    const pinned = await listPinnedNotes(prisma, "alice");
    expect(pinned.map((n) => n.body)).toEqual(["second", "first"]);
  });

  it("the full list puts pinned notes above the rest", async () => {
    await createNote(prisma, "alice", { body: "old" });
    const b = await createNote(prisma, "alice", { body: "pinned" });
    await createNote(prisma, "alice", { body: "newest" });
    await updateNote(prisma, "alice", b.id, { pinned: true });
    expect((await listNotes(prisma, "alice")).map((n) => n.body)).toEqual([
      "pinned",
      "newest",
      "old",
    ]);
  });
});
