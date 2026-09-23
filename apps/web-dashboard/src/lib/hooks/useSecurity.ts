"use client";

/**
 * WARP-2977 (ADR-059 P2) — the /security feed and its source-health header.
 *
 * Cursor-paginated like useEvents: each page keys on the filter plus the
 * previous page's `nextCursor`; a filter change restarts at the head. The
 * first page refreshes every 15 s so a kept tab shows new activity. The
 * health header refreshes on the same beat — it is what tells an empty feed
 * that is quiet apart from one that is not being fed.
 *
 * WARP-2977 P2b adds the areas, sources, site-mode and opening-hours hooks
 * (bottom of the file). Each returns its OWN `mutate`, and each write helper
 * throws the apiFetch TypedError for the caller to render with
 * `translateError(err, "security")`. None of them can reach the feed's
 * useSWRInfinite keys — after a write that changes feed rows (a mode change,
 * an area's links), call the feed's own `refresh()` as well.
 */
import { useCallback, useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import {
  SECURITY_HOURS_PATH,
  SECURITY_MODE_PATH,
  SECURITY_SOURCES_PATH,
  SECURITY_ZONES_PATH,
  archiveSecurityZone,
  createSecurityZone,
  deleteSecurityHoursException,
  fetchCameras,
  getSecurityEvents,
  getSecurityHealth,
  getSecurityHours,
  getSecurityMode,
  getSecuritySources,
  getSecurityZones,
  patchSecurityZone,
  postSecurityMode,
  putSecurityHours,
  putSecurityHoursException,
  putSecurityZoneLinks,
  unarchiveSecurityZone,
  type SecurityEventsQuery,
} from "@/lib/api";
import type {
  CameraInfo,
  SecurityEvent,
  SecurityEventsPage,
  SecurityHealthRow,
  SecurityHoursBody,
  SecurityHoursExceptionBody,
  SecurityHoursView,
  SecurityHoursWriteResult,
  SecurityModeAction,
  SecurityModeActionResult,
  SecurityModeView,
  SecuritySourcesView,
  SecurityZoneCreateBody,
  SecurityZoneCreated,
  SecurityZoneLinksBody,
  SecurityZonePatchBody,
  SecurityZonesResponse,
  SecurityZoneWriteResult,
} from "@/lib/types";

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

// ── WARP-2977 P2b (ADR-059 §3.4, §3.6): areas, sources, site mode, opening hours ──

/** The mode card re-reads on this beat; the server ticker runs every 60 s. */
const MODE_REFRESH_MS = 30_000;

/** Both area-list keys (with and without archived areas) — an area write moves both. */
const isZonesKey = (key: unknown): boolean =>
  key === SECURITY_ZONES_PATH || (Array.isArray(key) && key[0] === SECURITY_ZONES_PATH);

/**
 * GET /api/security/zones — the viewer's visible areas and links.
 * `includeArchived` is a manage-level filter (the server ignores it below).
 * The writes revalidate every area list and the sources' link statuses.
 */
export function useSecurityZones(opts: { includeArchived?: boolean } = {}) {
  const includeArchived = Boolean(opts.includeArchived);
  const { mutate: globalMutate } = useSWRConfig();
  const { data, error, isLoading, mutate } = useSWR<SecurityZonesResponse>(
    includeArchived ? [SECURITY_ZONES_PATH, "archived"] : SECURITY_ZONES_PATH,
    () => getSecurityZones({ includeArchived }),
  );

  const settle = useCallback(async () => {
    await Promise.all([globalMutate(isZonesKey), globalMutate(SECURITY_SOURCES_PATH)]);
  }, [globalMutate]);

  const create = useCallback(
    async (body: SecurityZoneCreateBody): Promise<SecurityZoneCreated> => {
      const r = await createSecurityZone(body);
      await settle();
      return r;
    },
    [settle],
  );
  const patch = useCallback(
    async (id: string, body: SecurityZonePatchBody): Promise<SecurityZoneWriteResult> => {
      const r = await patchSecurityZone(id, body);
      await settle();
      return r;
    },
    [settle],
  );
  const archive = useCallback(
    async (id: string, expectedVersion: number): Promise<SecurityZoneWriteResult> => {
      const r = await archiveSecurityZone(id, expectedVersion);
      await settle();
      return r;
    },
    [settle],
  );
  const unarchive = useCallback(
    async (id: string, expectedVersion: number): Promise<SecurityZoneWriteResult> => {
      const r = await unarchiveSecurityZone(id, expectedVersion);
      await settle();
      return r;
    },
    [settle],
  );
  const putLinks = useCallback(
    async (id: string, body: SecurityZoneLinksBody): Promise<SecurityZoneWriteResult> => {
      const r = await putSecurityZoneLinks(id, body);
      await settle();
      return r;
    },
    [settle],
  );

  return {
    zones: data?.zones ?? null,
    error: error as Error | undefined,
    isLoading,
    mutate,
    create,
    patch,
    archive,
    unarchive,
    putLinks,
  };
}

/** GET /api/security/sources — cameras + parts to link, and each link's present/missing/unknown status. */
export function useSecuritySources() {
  const { data, error, isLoading, mutate } = useSWR<SecuritySourcesView>(SECURITY_SOURCES_PATH, () =>
    getSecuritySources(),
  );
  return { sources: data ?? null, error: error as Error | undefined, isLoading, mutate };
}

/**
 * GET /api/security/mode — the EFFECTIVE mode (never a guessed "open": a
 * failed read is an `error`, and the card must say it can't tell).
 * `act` posts an intent (act level) and puts the server's answer in the cache.
 */
export function useSecurityMode() {
  const { data, error, isLoading, mutate } = useSWR<SecurityModeView>(SECURITY_MODE_PATH, () => getSecurityMode(), {
    refreshInterval: MODE_REFRESH_MS,
  });

  const act = useCallback(
    async (action: SecurityModeAction): Promise<SecurityModeActionResult> => {
      const r = await postSecurityMode(action);
      await mutate(r.mode, { revalidate: false });
      return r;
    },
    [mutate],
  );

  return { mode: data ?? null, error: error as Error | undefined, isLoading, mutate, act };
}

/**
 * GET /api/security/hours — the week, special days, preview and timezone
 * hint. An hours write can move the mode (the server recomputes it in the
 * same transaction), so every write refreshes the mode cache too.
 */
export function useSecurityHours() {
  const { mutate: globalMutate } = useSWRConfig();
  const { data, error, isLoading, mutate } = useSWR<SecurityHoursView>(SECURITY_HOURS_PATH, () => getSecurityHours());

  const apply = useCallback(
    async (r: SecurityHoursWriteResult): Promise<SecurityHoursWriteResult> => {
      if (r.hours === null || r.mode === null) {
        // Saved, but the server couldn't read it back: fetch both instead.
        await Promise.all([mutate(), globalMutate(SECURITY_MODE_PATH)]);
        return r;
      }
      await Promise.all([
        mutate(r.hours, { revalidate: false }),
        globalMutate(SECURITY_MODE_PATH, r.mode, { revalidate: false }),
      ]);
      return r;
    },
    [mutate, globalMutate],
  );

  const save = useCallback(async (body: SecurityHoursBody) => apply(await putSecurityHours(body)), [apply]);
  const saveException = useCallback(
    async (date: string, body: SecurityHoursExceptionBody) => apply(await putSecurityHoursException(date, body)),
    [apply],
  );
  const deleteException = useCallback(
    async (date: string, version: number): Promise<void> => {
      await deleteSecurityHoursException(date, version);
      await Promise.all([mutate(), globalMutate(SECURITY_MODE_PATH)]);
    },
    [mutate, globalMutate],
  );

  return {
    hours: data ?? null,
    error: error as Error | undefined,
    isLoading,
    mutate,
    save,
    saveException,
    deleteException,
  };
}
