"use client";

import { useCallback, useMemo } from "react";
import useSWRInfinite from "swr/infinite";
import { fetchMotionActivity } from "@/lib/api";
import type { MotionActivityResult, MotionFilter } from "@/lib/types";

export function useMotionActivity(filter: MotionFilter, scheduleKey?: string, enabled = true) {
  const getKey = useCallback((page: number, previous: MotionActivityResult | null) => {
    if (!enabled || (page > 0 && (!previous || previous.nextCursor === null))) return null;
    return ["motion-activity", JSON.stringify(filter), page === 0 ? null : previous?.nextCursor, scheduleKey] as const;
  }, [filter, scheduleKey, enabled]);
  const fetcher = useCallback(([, , cursor]: readonly [string, string, number | null | undefined, string | undefined]) =>
    fetchMotionActivity({ ...filter, cursor: cursor ?? undefined }), [filter]);
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<MotionActivityResult>(getKey, fetcher, {
    revalidateOnFocus: false,
    revalidateFirstPage: true,
    revalidateAll: false,
  });
  const activity = useMemo(() => (data ?? []).flatMap((page) => page.activity), [data]);
  const last = data?.[data.length - 1];
  const hasMore = Boolean(last && last.nextCursor !== null);
  const isLoadingMore = isValidating && Boolean(data && !data[size - 1]);
  return {
    activity,
    coverage: data?.[0]?.coverage,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    scanLimitReached: last?.scanLimitReached === true,
    loadMore: () => { if (hasMore && !isLoadingMore) void setSize((current) => current + 1); },
    refresh: () => mutate(),
  };
}
