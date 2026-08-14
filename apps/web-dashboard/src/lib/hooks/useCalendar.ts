"use client";

import useSWR from "swr";
import { apiFetch } from "./apiFetch";

export interface CalendarEvent {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  location: string | null;
  /** WARP-1874 — https-only video-call link, alongside `location`. */
  meetingUrl: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  source: "local" | "external";
  sourceId: string | null;
  externalUid: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarSource {
  id: string;
  name: string;
  url: string;
  authMode: "none" | "basic";
  username: string | null;
  syncIntervalSec: number;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export function useCalendarEvents(opts: { from?: Date; to?: Date } = {}) {
  const params = new URLSearchParams();
  if (opts.from) params.set("from", opts.from.toISOString());
  if (opts.to) params.set("to", opts.to.toISOString());
  const url = `/api/calendar/events${params.toString() ? `?${params}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR<{ events: CalendarEvent[] }>(
    url,
    (u: string) => apiFetch<{ events: CalendarEvent[] }>(u, { credentials: "same-origin" }),
  );
  return { events: data?.events ?? [], error, isLoading, refresh: mutate };
}

export function useCalendarSources() {
  const { data, error, isLoading, mutate } = useSWR<{ sources: CalendarSource[] }>(
    "/api/calendar/sources",
    (u: string) => apiFetch<{ sources: CalendarSource[] }>(u, { credentials: "same-origin" }),
  );
  return { sources: data?.sources ?? [], error, isLoading, refresh: mutate };
}

export async function createEvent(input: {
  title: string;
  description?: string;
  location?: string;
  meetingUrl?: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
}) {
  return apiFetch<{ event: CalendarEvent }>("/api/calendar/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
}

export async function updateEvent(id: string, patch: Partial<{
  title: string;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
}>) {
  return apiFetch<{ event: CalendarEvent }>(`/api/calendar/events/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(patch),
  });
}

export async function deleteEvent(id: string) {
  return apiFetch<{ deleted: string }>(`/api/calendar/events/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
}

export async function createSource(input: {
  name: string;
  url: string;
  authMode: "none" | "basic";
  username?: string;
  password?: string;
  syncIntervalSec?: number;
}) {
  return apiFetch<{ source: CalendarSource }>("/api/calendar/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
}

export async function deleteSource(id: string) {
  return apiFetch<{ deleted: string }>(`/api/calendar/sources/${id}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
}

export async function syncSource(id: string) {
  return apiFetch<{ added: number; updated: number; total: number; error?: string }>(
    `/api/calendar/sources/${id}/sync`,
    { method: "POST", credentials: "same-origin" },
  );
}

export async function getPublishUrl() {
  return apiFetch<{ url: string }>("/api/calendar/publish-token", {
    credentials: "same-origin",
  });
}
