"use client";

/**
 * WARP-2977 (ADR-059 P2) — the /security feed and its source-health header.
 *
 * Cursor-paginated like useEvents: each page keys on the filter plus the
 * previous page's `nextCursor`; a filter change restarts at the head. The
 * first page refreshes every 15 s so a kept tab shows new activity. The
 * health header refreshes on the same beat — it is what tells an empty feed
 * that is quiet apart from one that is not being fed.
 */
import { useCallback, useMemo } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { fetchCameras, getSecurityEvents, getSecurityHealth, type SecurityEventsQuery } from "@/lib/api";
import type { CameraInfo, SecurityEvent, SecurityEventsPage, SecurityHealthRow } from "@/lib/types";

const REFRESH_MS = 15_000;

export type SecurityFeedFilter = Omit<SecurityEventsQuery, "cursor">;

export function useSecurityFeed(filter: SecurityFeedFilter) {
  const filterKey = useMemo(() => JSON.stringify(filter), [filter]);

  const getKey = useCallback(
    (pageIndex: number, previous: SecurityEventsPage | null) => {
      if (pageIndex === 0) return ["security-events", filterKey, null] as const;
      if (!previous || previous.nextCursor === null) return null;
      return ["security-events", filterKey, previous.nextCursor] as const;
    },
    [filterKey],
  );

  const fetcher = useCallback(
    ([, , cursor]: readonly [string, string, string | null]) => getSecurityEvents({ ...filter, cursor }),
    // `filterKey` is the stable identity of `filter`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );

  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<SecurityEventsPage>(
    getKey,
    fetcher,
    { refreshInterval: REFRESH_MS, revalidateFirstPage: true, revalidateOnFocus: false, revalidateAll: false },
  );

  const events: SecurityEvent[] = useMemo(() => (data ?? []).flatMap((p) => p.events), [data]);
  const isLoadingMore = isValidating && size > 0 && Boolean(data && typeof data[size - 1] === "undefined");
  const lastPage = data?.[data.length - 1];
  const hasMore = Boolean(lastPage && lastPage.nextCursor !== null);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    void setSize((s) => s + 1);
  }, [hasMore, isLoadingMore, setSize]);

  return { events, isLoading, isLoadingMore, error: error as Error | undefined, hasMore, loadMore, refresh: () => mutate() };
}

export function useSecurityHealth() {
  const { data, error, isLoading, mutate } = useSWR<{ sources: SecurityHealthRow[] }>(
    "/api/security/health",
    () => getSecurityHealth(),
    { refreshInterval: REFRESH_MS },
  );
  return { sources: data?.sources ?? null, error: error as Error | undefined, isLoading, refresh: () => mutate() };
}

/**
 * Frigate name → the household's name for the camera (WARP-1893). Shares the
 * `/api/cameras` cache with the cameras pages. That list is already filtered
 * to the viewer's grants, as the feed is, so it names nothing the feed hides.
 */
export function useCameraDisplayNames(): (name: string) => string {
  const { data } = useSWR<CameraInfo[]>("/api/cameras", fetchCameras);
  const byName = useMemo(() => new Map((data ?? []).map((c) => [c.name, c.displayName || c.name])), [data]);
  return useCallback((name: string) => byName.get(name) ?? name, [byName]);
}
