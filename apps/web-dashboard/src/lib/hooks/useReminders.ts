"use client";

import useSWR from "swr";
import { apiFetch } from "./apiFetch";

export interface Reminder {
  id: string;
  userId: string;
  title: string;
  body: string | null;
  dueAt: string;
  completedAt: string | null;
  calendarEventId: string | null;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Includes both active and completed reminders unless `includeCompleted` is
 *  false (default false — most callers want the active list). */
export function useReminders(opts: { includeCompleted?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.includeCompleted === false || opts.includeCompleted === undefined) {
    params.set("completed", "false");
  }
  const url = `/api/reminders${params.toString() ? `?${params}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR<{ reminders: Reminder[] }>(
    url,
    (u) => apiFetch(u, { credentials: "same-origin" }),
    // Refresh every 30s so a reminder that just fired updates its
    // notifiedAt without a manual reload.
    { refreshInterval: 30_000 },
  );
  return { reminders: data?.reminders ?? [], error, isLoading, refresh: mutate };
}

export async function createReminder(input: {
  title: string;
  body?: string;
  dueAt: string;
  calendarEventId?: string;
}) {
  return apiFetch<{ reminder: Reminder }>("/api/reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
}

export async function patchReminder(
  id: string,
  patch: Partial<{ title: string; body: string | null; dueAt: string; completed: boolean }>,
) {
  return apiFetch<{ reminder: Reminder }>(`/api/reminders/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(patch),
  });
}

export async function deleteReminder(id: string) {
  return apiFetch<{ deleted: string }>(`/api/reminders/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
}
