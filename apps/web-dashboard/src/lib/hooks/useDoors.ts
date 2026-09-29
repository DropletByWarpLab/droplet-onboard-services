"use client";

/**
 * ADR-055 P4b — the /doors page's data.
 *
 * `useDoors` reads the doors (retired ones too — the page files them apart)
 * and carries the three owner-only writes; `useDoorEvents` is the
 * cursor-paged log, laid out like the Security feed's. Both re-read every 15 s
 * so a position that changes shows up on a page left open.
 *
 * Every write throws the securityFetch TypedError for the caller to render
 * with `translateError(err, "doors")`; none of them touches the doors'
 * position, which only ever comes from a device's report.
 */
import { useCallback, useMemo } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { createDoor, DOORS_PATH, getDoorEvents, getDoors, patchDoor, retireDoor } from "@/lib/api";
import type { DoorCreateBody, DoorEventView, DoorEventsPage, DoorPatchBody, DoorView, DoorsResponse } from "@/lib/types";

const REFRESH_MS = 15_000;
const EVENTS_KEY = "door-events";
const DOORS_KEY = [DOORS_PATH, "all"] as const;

export function useDoors() {
  const { data, error, isLoading, mutate } = useSWR<DoorsResponse>(DOORS_KEY, () => getDoors({ includeRetired: true }), {
    refreshInterval: REFRESH_MS,
  });

  /** A write re-reads the list. The log (a useSWRInfinite, out of a global mutate's reach) picks a rename up on its own beat. */
  const settle = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const create = useCallback(
    async (body: DoorCreateBody): Promise<{ door: DoorView }> => {
      const r = await createDoor(body);
      await settle();
      return r;
    },
    [settle],
  );
  const patch = useCallback(
    async (id: string, body: DoorPatchBody): Promise<{ door: DoorView }> => {
      const r = await patchDoor(id, body);
      await settle();
      return r;
    },
    [settle],
  );
  const retire = useCallback(
    async (id: string): Promise<{ door: DoorView }> => {
      const r = await retireDoor(id);
      await settle();
      return r;
    },
    [settle],
  );

  return { doors: data?.doors ?? null, error: error as Error | undefined, isLoading, mutate, create, patch, retire };
}

export function useDoorEvents() {
  const getKey = useCallback((pageIndex: number, previous: DoorEventsPage | null) => {
    if (pageIndex === 0) return [EVENTS_KEY, null] as const;
    if (!previous || previous.nextCursor === null) return null;
    return [EVENTS_KEY, previous.nextCursor] as const;
  }, []);

  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<DoorEventsPage>(
    getKey,
    ([, cursor]: readonly [string, string | null]) => getDoorEvents({ cursor }),
    { refreshInterval: REFRESH_MS, revalidateFirstPage: true, revalidateOnFocus: false, revalidateAll: false },
  );

  const events: DoorEventView[] = useMemo(() => (data ?? []).flatMap((p) => p.events), [data]);
  const isLoadingMore = isValidating && size > 0 && Boolean(data && typeof data[size - 1] === "undefined");
  const lastPage = data?.[data.length - 1];
  const hasMore = Boolean(lastPage && lastPage.nextCursor !== null);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    void setSize((s) => s + 1);
  }, [hasMore, isLoadingMore, setSize]);

  return { events, isLoading, isLoadingMore, error: error as Error | undefined, hasMore, loadMore, refresh: () => mutate() };
}
