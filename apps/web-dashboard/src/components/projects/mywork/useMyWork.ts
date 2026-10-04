"use client";

// The signed-in user's cross-project lists, one section at a time, loaded page by
// page until the server says there are no more (nothing is silently capped).
// `today` is the VIEWER's calendar day — the server decides "overdue" and "due
// this week" from it, never from its own clock or zone — and is part of the key,
// so the lists refetch when local midnight passes.
//
// Freshness. SWR's focus / reconnect / remount revalidation re-requests the FIRST
// page of a list (its items and all four counts); pages loaded after it are
// re-requested by `mutate()` — the Refresh button and any edit made in the drawer
// — which revalidates every loaded page. Do not turn `revalidateFirstPage` off to
// save a request on "Load more": a loaded page is then never refetched by focus
// at all, and the lists go stale until something calls `mutate()`.

import { useMemo } from "react";
import useSWRInfinite from "swr/infinite";
import { pmGet } from "../calendar/pmGet";
import type { DateOnly } from "../calendar/dateOnly";
import type { PmWorkItem } from "../types";
import type { PmMyWorkCounts, PmMyWorkPage, PmMyWorkProject, PmMyWorkSection } from "./types";

export const MY_WORK_PAGE_SIZE = 100;

export function myWorkUrl(section: PmMyWorkSection, today: DateOnly, offset: number, limit = MY_WORK_PAGE_SIZE): string {
  return `/api/pm/my-work?section=${section}&today=${today}&limit=${limit}&offset=${offset}`;
}

export function useMyWork(section: PmMyWorkSection, today: DateOnly) {
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<PmMyWorkPage>(
    (index, previous) => {
      if (previous && previous.nextOffset === null) return null; // the last page has been loaded
      return myWorkUrl(section, today, index === 0 ? 0 : (previous?.nextOffset ?? index * MY_WORK_PAGE_SIZE));
    },
    (url: string) => pmGet<PmMyWorkPage>(url),
  );

  const view = useMemo(() => {
    const pages = data ?? [];
    const items: PmWorkItem[] = pages.flatMap((p) => p.items);
    const projects = new Map<string, PmMyWorkProject>();
    for (const p of pages) for (const pr of p.projects) if (!projects.has(pr.id)) projects.set(pr.id, pr);
    const last = pages[pages.length - 1];
    const counts: PmMyWorkCounts | undefined = pages[0]?.counts;
    return {
      items,
      projects: [...projects.values()],
      counts,
      total: pages[0]?.total ?? 0,
      hasMore: !!last && last.nextOffset !== null,
    };
  }, [data]);

  return {
    ...view,
    error,
    isLoading,
    /** A request is in flight — the initial load, a refresh, or another page. */
    isValidating,
    isLoadingMore: isValidating && size > (data?.length ?? 0),
    loadMore: () => {
      void setSize((n) => n + 1);
    },
    mutate,
  };
}
