"use client";

import useSWR from "swr";
import { apiFetch } from "./apiFetch";

/**
 * Notes live on the box (`/api/notes`), not in this browser's localStorage —
 * so a note written on a phone is there on the laptop, survives a cache clear,
 * and gets backed up with everything else.
 *
 * `pinned` is a plain field on the note; pinning is a PATCH like any other
 * edit. Home renders the pinned ones.
 */

export interface Note {
  id: string;
  userId: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

const NOTES_URL = "/api/notes";

/**
 * Mirrors `NOTE_MAX_BODY` in
 * `apps/orchestrator/src/services/notes.service.ts`. The server 400s a longer
 * body, and a 400 on an autosave is a lost keystroke — so the editor caps the
 * textarea at the same number and the rejection never happens.
 */
export const NOTE_MAX_BODY = 20000;

export function useNotes() {
  const { data, error, isLoading, mutate } = useSWR<{ notes: Note[] }>(
    NOTES_URL,
    (u: string) => apiFetch<{ notes: Note[] }>(u, { credentials: "same-origin" }),
  );
  // Server order is pinned-first then most-recently-edited; keep it.
  return { notes: data?.notes ?? [], error, isLoading, refresh: mutate };
}

export async function createNote(input: { body: string; pinned?: boolean }) {
  return apiFetch<{ note: Note }>(NOTES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
}

/**
 * `expectedUpdatedAt` is the `updatedAt` the edit was based on. Send it on
 * body edits: the box refuses the write with 409 if the note has since changed
 * elsewhere, instead of overwriting it. Without it this is last-write-wins, and
 * since the move off localStorage there is no second copy to recover from.
 */
export async function updateNote(
  id: string,
  patch: Partial<{ body: string; pinned: boolean; expectedUpdatedAt: string }>,
) {
  return apiFetch<{ note: Note }>(`${NOTES_URL}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(patch),
  });
}

/** True when a save was refused because the note changed somewhere else. */
export function isNoteConflict(err: unknown): boolean {
  return (err as { status?: number } | null | undefined)?.status === 409;
}

/** The note as the box actually holds it, off a rejected save. `null` when the
 *  rejection wasn't a conflict or carried no body we can read. */
export function conflictingNote(err: unknown): Note | null {
  if (!isNoteConflict(err)) return null;
  const note = (err as { body?: { note?: Note } } | null | undefined)?.body?.note;
  return note && typeof note.body === "string" ? note : null;
}

export async function deleteNote(id: string) {
  return apiFetch<void>(`${NOTES_URL}/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
}
