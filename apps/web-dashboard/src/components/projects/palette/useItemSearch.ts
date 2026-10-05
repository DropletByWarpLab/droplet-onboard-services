"use client";

// WARP-3537 — the palette's item search: "jump to project / item by key or title".
//
// Two doors, both existing routes — nothing new on the server:
//   • a TITLE: `GET /api/pm/work-items?workspace=home&q=` — the workspace-wide search
//     that also backs the assistant's search tool (brief §3.9, §4.5), so a person's
//     search and the assistant's are one query surface;
//   • a KEY (`INBOX-42`): `GET /api/pm/work-items/by-key/:key`, which finds the item
//     in ANY project, loaded or not. A key is not in the text of a title, so the
//     search above would never find it.
//
// The typed text is debounced (one request per pause, not per keystroke) and a
// failure is simply "no items": the palette still jumps to projects and runs actions.

import { useEffect, useState } from "react";
import useSWR from "swr";
import { parseWorkItemKey } from "@droplet/shared-types";
import { authFetch } from "@/lib/auth";
import type { PmWorkItem } from "../types";

export const ITEM_SEARCH_MIN = 2;
export const ITEM_SEARCH_LIMIT = 8;
const DEBOUNCE_MS = 200;

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

/** The value, but only once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export interface ItemSearch {
  items: PmWorkItem[];
  /** A request for the CURRENT text is still out. */
  searching: boolean;
}

export function useItemSearch(query: string, enabled: boolean): ItemSearch {
  const typed = query.trim();
  const q = useDebounced(typed, DEBOUNCE_MS);
  const live = enabled && q.length >= ITEM_SEARCH_MIN;
  const keyed = live && parseWorkItemKey(q) !== null;

  const text = useSWR(
    live ? `/api/pm/work-items?workspace=home&q=${encodeURIComponent(q)}&per_page=${ITEM_SEARCH_LIMIT}` : null,
    (u: string) => getJson<{ work_items: PmWorkItem[] }>(u),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );
  const byKey = useSWR(
    keyed ? `/api/pm/work-items/by-key/${encodeURIComponent(q)}` : null,
    (u: string) => getJson<{ work_item: PmWorkItem }>(u),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  );

  // Typed but not settled yet counts as searching: the list must not claim "nothing matches" mid-pause.
  const pending = enabled && typed.length >= ITEM_SEARCH_MIN && (typed !== q || text.isLoading || byKey.isLoading);

  const out: PmWorkItem[] = [];
  const seen = new Set<string>();
  // The exact key first: it is what the person typed.
  for (const it of [...(byKey.data ? [byKey.data.work_item] : []), ...(text.data?.work_items ?? [])]) {
    if (live && !seen.has(it.id)) {
      seen.add(it.id);
      out.push(it);
    }
  }
  return { items: out, searching: pending };
}
