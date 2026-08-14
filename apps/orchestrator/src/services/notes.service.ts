/**
 * Notes business logic.
 *
 * CRUD over the user's own Note rows. Every mutating call re-reads the row and
 * enforces `existing.userId === userId` before touching it — same ownership
 * posture as calendar.service.ts, so a guessed id from another household
 * member's browser can't edit or delete a note.
 *
 * Routes call into this module; nothing here reads `req`.
 */

import type { Note, PrismaClient } from "@prisma/client";

/** Longest note body we store. Generous for a scratchpad, bounded so a paste
 *  of a whole file can't be used to grow the table without limit. */
export const NOTE_MAX_BODY = 20000;

export interface NotePatch {
  body?: string;
  pinned?: boolean;
  /**
   * ISO timestamp of the version the edit was based on. When present and the
   * stored row has moved on, the write is refused with `note_conflict` instead
   * of overwriting it.
   *
   * Notes live only on the box now — there is no browser-local copy behind
   * them — so a blind last-write-wins PATCH is unrecoverable data loss: an
   * editor left open on a laptop would silently destroy paragraphs added from
   * a phone, while the status line read "Saved". The client sends the
   * `updatedAt` it rendered; a mismatch means someone else got there first and
   * the customer, not the race, decides which version survives.
   */
  expectedUpdatedAt?: string;
}

/** Thrown when {@link NotePatch.expectedUpdatedAt} doesn't match the stored
 *  row. Carries the current note so the caller can show what it lost to. */
export class NoteConflictError extends Error {
  constructor(readonly current: Note) {
    super("note_conflict");
    this.name = "NoteConflictError";
  }
}

export async function listNotes(prisma: PrismaClient, userId: string) {
  return prisma.note.findMany({
    where: { userId },
    // Pinned first, then most-recently-edited — the order both the Notes
    // surface and the Home tile want.
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
  });
}

export async function listPinnedNotes(prisma: PrismaClient, userId: string) {
  return prisma.note.findMany({
    where: { userId, pinned: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function createNote(
  prisma: PrismaClient,
  userId: string,
  input: { body: string; pinned?: boolean },
) {
  return prisma.note.create({
    data: {
      userId,
      body: input.body,
      pinned: input.pinned === true,
    },
  });
}

export async function updateNote(
  prisma: PrismaClient,
  userId: string,
  id: string,
  patch: NotePatch,
) {
  const existing = await prisma.note.findUnique({ where: { id } });
  if (!existing) throw new Error("note_not_found");
  if (existing.userId !== userId) throw new Error("forbidden");
  // Ownership first, then freshness: a caller who doesn't own the row learns
  // nothing about when it last changed.
  if (patch.expectedUpdatedAt !== undefined) {
    const expected = new Date(patch.expectedUpdatedAt).getTime();
    // NaN (unparseable) fails this too — the route's zod `.datetime()` already
    // rejects those, so reaching here with one means refusing is the safe read.
    if (existing.updatedAt.getTime() !== expected) {
      throw new NoteConflictError(existing);
    }
  }
  return prisma.note.update({
    where: { id },
    data: {
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    },
  });
}

export async function deleteNote(
  prisma: PrismaClient,
  userId: string,
  id: string,
) {
  const existing = await prisma.note.findUnique({ where: { id } });
  if (!existing) throw new Error("note_not_found");
  if (existing.userId !== userId) throw new Error("forbidden");
  await prisma.note.delete({ where: { id } });
}
