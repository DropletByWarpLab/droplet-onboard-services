"use client";

import { useCallback, useMemo } from "react";
import useSWRInfinite from "swr/infinite";
import { fetchEventsFiltered } from "@/lib/api";
import type { EventDetail, EventFilter, FilteredEventsResult } from "@/lib/types";

/**
 * Cursor-paginated events fetch for the Events page.
 *
 * SWR Infinite drives "Load more" semantics: each page is keyed by the
 * filter + the cursor (start_time of the previous page's oldest
 * event). Calling `loadMore()` advances setSize by 1 which triggers a
 * fetch with the next cursor. End-of-data is signalled by
 * `nextCursor: null` from the server, mapped to `hasMore = false`
 * here.
 *
 * Filter changes invalidate all pages because the SWR key includes a
 * stable JSON serialisation of the filter object — switching from
 * "person" to "car" automatically restarts pagination at the head.
 *
 * Refresh interval is intentionally low (15 s) — the events page is a
 * "what just happened" surface, and a kept-tab should pick up new
 * events without manual refresh. Longer intervals miss live activity;
 * shorter rates burn the orchestrator's Frigate budget.
 */
export function useEvents(filter: EventFilter) {
  // Drop `before` from the persisted key so a page-1 fetch (no cursor)
  // and a page-N fetch (with cursor) share the same logical filter and
  // the cache survives "load more" without re-keying.
  const baseFilter = useMemo<EventFilter>(() => {
    const { before: _before, ...rest } = filter;
    return rest;
  }, [filter]);

  // useSWRInfinite's getKey is called for each page index; previousPageData
  // gives us the prior page's response so we can extract its cursor.
  const getKey = useCallback(
    (pageIndex: number, previousPageData: FilteredEventsResult | null) => {
      // First page: no cursor.
      if (pageIndex === 0) {
        return ["events", JSON.stringify(baseFilter), null] as const;
      }
      // No more data — tell SWR to stop fetching.
      if (previousPageData && previousPageData.nextCursor === null) return null;
      const cursor = previousPageData?.nextCursor ?? null;
      return ["events", JSON.stringify(baseFilter), cursor] as const;
    },
    [baseFilter],
  );

  const fetcher = useCallback(
    ([, , cursor]: readonly [string, string, number | null]) =>
      fetchEventsFiltered({
        ...baseFilter,
        before: cursor ?? undefined,
      }),
    [baseFilter],
  );

  const { data, error, isLoading, isValidating, size, setSize, mutate } =
    useSWRInfinite<FilteredEventsResult>(getKey, fetcher, {
      refreshInterval: 15_000,
      revalidateFirstPage: true,
      // Avoid revalidating older pages on focus — the user is at the
      // top, and re-fetching deep pages causes the visible list to
      // flicker. The first page picks up new events on its 15 s tick.
      revalidateOnFocus: false,
      revalidateAll: false,
    });

  const events: EventDetail[] = useMemo(
    () => (data ?? []).flatMap((p) => p.events),
    [data],
  );

  // SWR Infinite loading semantics: `isLoading` only fires for the
  // initial page; subsequent pages show through `isValidating` while
  // their fetch is in flight. We surface a single "loading next page"
  // boolean so the button can disable itself.
  const isLoadingMore =
    isValidating && size > 0 && Boolean(data && typeof data[size - 1] === "undefined");

  const lastPage = data?.[data.length - 1];
  const hasMore = Boolean(lastPage && lastPage.nextCursor !== null);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    setSize((s) => s + 1);
  }, [hasMore, isLoadingMore, setSize]);

  return {
    events,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    loadMore,
    refresh: () => mutate(),
  };
}
