"use client";

import { useCallback, useMemo } from "react";
import useSWRInfinite from "swr/infinite";
import { fetchReviewsFiltered, markReviewViewed } from "@/lib/api";
import type { FilteredReviewsResult, ReviewFilter, ReviewItem } from "@/lib/types";

/**
 * Cursor-paginated reviews fetch — mirrors useEvents in shape so the
 * Events page can swap data sources between events and reviews
 * without changing the surrounding UI scaffolding.
 *
 * Reviews are sparser than events (one cluster ≈ many detections), so
 * the head-page revalidate interval is the same 15 s — gives the
 * operator a "what's new since I looked away" window without burning
 * bandwidth.
 */
export function useReviews(filter: ReviewFilter) {
  const baseFilter = useMemo<ReviewFilter>(() => {
    const { before: _before, ...rest } = filter;
    return rest;
  }, [filter]);

  const getKey = useCallback(
    (pageIndex: number, previousPageData: FilteredReviewsResult | null) => {
      if (pageIndex === 0) return ["reviews", JSON.stringify(baseFilter), null] as const;
      if (previousPageData && previousPageData.nextCursor === null) return null;
      const cursor = previousPageData?.nextCursor ?? null;
      return ["reviews", JSON.stringify(baseFilter), cursor] as const;
    },
    [baseFilter],
  );

  const fetcher = useCallback(
    ([, , cursor]: readonly [string, string, number | null]) =>
      fetchReviewsFiltered({ ...baseFilter, before: cursor ?? undefined }),
    [baseFilter],
  );

  const { data, error, isLoading, isValidating, size, setSize, mutate } =
    useSWRInfinite<FilteredReviewsResult>(getKey, fetcher, {
      refreshInterval: 15_000,
      revalidateFirstPage: true,
      revalidateOnFocus: false,
      revalidateAll: false,
    });

  const reviews: ReviewItem[] = useMemo(
    () => (data ?? []).flatMap((p) => p.reviews),
    [data],
  );

  const isLoadingMore =
    isValidating && size > 0 && Boolean(data && typeof data[size - 1] === "undefined");

  const lastPage = data?.[data.length - 1];
  const hasMore = Boolean(lastPage && lastPage.nextCursor !== null);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    setSize((s) => s + 1);
  }, [hasMore, isLoadingMore, setSize]);

  /** Mark a review viewed and patch the local cache so the badge
   *  flips immediately without waiting on the next refresh tick. */
  const markViewed = useCallback(
    async (reviewId: string) => {
      await markReviewViewed(reviewId);
      await mutate(
        (pages) =>
          pages?.map((p) => ({
            ...p,
            reviews: p.reviews.map((r) =>
              r.id === reviewId ? { ...r, hasBeenReviewed: true } : r,
            ),
          })),
        { revalidate: false },
      );
    },
    [mutate],
  );

  return {
    reviews,
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    loadMore,
    markViewed,
    refresh: () => mutate(),
  };
}
