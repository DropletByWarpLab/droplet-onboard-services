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

export async function updateNote(
  id: string,
  patch: Partial<{ body: string; pinned: boolean }>,
) {
  return apiFetch<{ note: Note }>(`${NOTES_URL}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(patch),
  });
}

export async function deleteNote(id: string) {
  return apiFetch<void>(`${NOTES_URL}/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
}
