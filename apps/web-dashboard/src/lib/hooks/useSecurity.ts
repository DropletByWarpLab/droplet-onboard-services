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
  SECURITY_ALERT_ROUTING_PATH,
  SECURITY_HOURS_PATH,
  SECURITY_INCIDENTS_PATH,
  SECURITY_INCIDENT_SUMMARY_PATH,
  SECURITY_MODE_PATH,
  SECURITY_PATTERNS_PATH,
  SECURITY_SOURCES_PATH,
  SECURITY_SUPPRESSIONS_PATH,
  SECURITY_ZONES_PATH,
  acknowledgeSecurityIncident,
  getAlertRouting,
  getSecurityIncident,
  getSecurityIncidentSummary,
  getSecurityIncidents,
  putAlertRouting,
  resolveSecurityIncident,
  type SecurityIncidentsQuery,
  archiveSecurityZone,
  createSecurityZone,
  deleteSecurityHoursException,
  fetchCameras,
  getSecurityEvents,
  getSecurityHealth,
  getSecurityHours,
  getSecurityMode,
  getSecurityPatternCells,
  getSecurityPatterns,
  getSecuritySources,
  getSecuritySuppressions,
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
  AlertRoutingPerson,
  AlertRoutingSetBody,
  AlertRoutingView,
  CameraInfo,
  IncidentActionResult,
  IncidentDetail,
  IncidentSummary,
  IncidentsPage,
  IncidentsSummary,
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
  SecurityPatternCells,
  SecurityPatternsOverview,
  SecuritySourcesView,
  SecuritySuppressionList,
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

// ── WARP-2980 (ADR-059 P5 PR-A): what normal looks like ──

/** The learning numbers move with the job's hourly step; a minute's lag is plenty. */
const PATTERNS_REFRESH_MS = 60_000;

/** GET /api/security/patterns — never an empty 200 on an outage: a failed read is an `error`. */
export function useSecurityPatterns() {
  const { data, error, isLoading, mutate } = useSWR<SecurityPatternsOverview>(
    SECURITY_PATTERNS_PATH,
    () => getSecurityPatterns(),
    { refreshInterval: PATTERNS_REFRESH_MS },
  );
  return { overview: data ?? null, error: error as Error | undefined, isLoading, mutate };
}

/**
 * The cameras this viewer may see (/api/cameras is filtered to their grants,
 * like every Security read) — the patterns page lists the ones Droplet has
 * never heard from. Shares the `/api/cameras` cache with useCameraDisplayNames.
 */
export function useSecurityCameras() {
  const { data, error } = useSWR<CameraInfo[]>("/api/cameras", fetchCameras);
  return { cameras: data ?? null, error: error as Error | undefined };
}

/** GET /api/security/patterns/cells — one key and label; a `null` key fetches nothing. */
export function useSecurityPatternCells(key: string | null, label: string | null) {
  const { data, error, isLoading } = useSWR<SecurityPatternCells>(
    key && label ? [SECURITY_PATTERNS_PATH, "cells", key, label] : null,
    () => getSecurityPatternCells(key!, label!),
  );
  return { cells: data ?? null, error: error as Error | undefined, isLoading };
}

// ── WARP-2980 (ADR-059 P5 PR-B): expected activity ──

/**
 * GET /api/security/suppressions — the expected activity this viewer may see
 * and whether they may change it (`canManage`, the server's answer). A failed
 * read is an `error`, never an empty list: "nothing is marked as expected"
 * and "Droplet couldn't say" must not look the same.
 */
export function useSecuritySuppressions() {
  const { data, error, isLoading, mutate } = useSWR<SecuritySuppressionList>(SECURITY_SUPPRESSIONS_PATH, () => getSecuritySuppressions());
  return { list: data ?? null, error: error as Error | undefined, isLoading, mutate };
}

// ── WARP-2978 (ADR-059 P3 §7 routes 16–22): incidents and who is told about alerts ──

/** The health header's key — the `alerts` row moves when who is told changes. */
const SECURITY_HEALTH_PATH = "/api/security/health";

export type SecurityIncidentsFilter = Omit<SecurityIncidentsQuery, "cursor">;

/**
 * GET /api/security/incidents, keyset-paged like the feed: each page keys on
 * the filter plus the previous page's `nextCursor`, and a filter change
 * restarts at the head. The first page refreshes every 15 s. As with the
 * feed, these useSWRInfinite keys are out of reach of a global mutate: after
 * a write that moves incidents, call `refresh()`.
 */
export function useSecurityIncidents(filter: SecurityIncidentsFilter) {
  const filterKey = useMemo(() => JSON.stringify(filter), [filter]);

  const getKey = useCallback(
    (pageIndex: number, previous: IncidentsPage | null) => {
      if (pageIndex === 0) return ["security-incidents", filterKey, null] as const;
      if (!previous || previous.nextCursor === null) return null;
      return ["security-incidents", filterKey, previous.nextCursor] as const;
    },
    [filterKey],
  );

  const fetcher = useCallback(
    ([, , cursor]: readonly [string, string, string | null]) => getSecurityIncidents({ ...filter, cursor }),
    // `filterKey` is the stable identity of `filter`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );

  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<IncidentsPage>(getKey, fetcher, {
    refreshInterval: REFRESH_MS,
    revalidateFirstPage: true,
    revalidateOnFocus: false,
    revalidateAll: false,
  });

  const incidents: IncidentSummary[] = useMemo(() => (data ?? []).flatMap((p) => p.incidents), [data]);
  const isLoadingMore = isValidating && size > 0 && Boolean(data && typeof data[size - 1] === "undefined");
  const lastPage = data?.[data.length - 1];
  const hasMore = Boolean(lastPage && lastPage.nextCursor !== null);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    void setSize((s) => s + 1);
  }, [hasMore, isLoadingMore, setSize]);

  return {
    /** null until the first page has loaded — an empty array is a real (empty) answer. */
    incidents: data ? incidents : null,
    isLoading,
    isLoadingMore,
    error: error as Error | undefined,
    hasMore,
    loadMore,
    refresh: () => mutate(),
  };
}

/**
 * GET /api/security/incidents/summary — the counts and latest three for
 * /d/security and the Incidents tab, and whether after-hours alerts can fire
 * (`alertsReady`). `enabled: false` never asks (a switched-off module).
 */
export function useSecurityIncidentSummary(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<IncidentsSummary>(
    enabled ? SECURITY_INCIDENT_SUMMARY_PATH : null,
    () => getSecurityIncidentSummary(),
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );
  return { summary: data ?? null, error: error as Error | undefined, isLoading, refresh: () => mutate() };
}

/**
 * GET /api/security/incidents/:id, and the two act-level writes. Each write
 * puts the server's answer (the whole incident, as this viewer may see it)
 * in the cache and refreshes the summary; it throws the typed error for the
 * caller to render with `translateError(err, "security")` — then `refresh()`,
 * since a 409 means the incident moved.
 */
export function useSecurityIncident(id: string | null) {
  const { mutate: globalMutate } = useSWRConfig();
  const key = id ? ([SECURITY_INCIDENTS_PATH, id] as const) : null;
  const { data, error, isLoading, mutate } = useSWR<IncidentDetail>(key, () => getSecurityIncident(id!), {
    refreshInterval: REFRESH_MS,
    shouldRetryOnError: false,
  });

  const apply = useCallback(
    async (r: IncidentActionResult): Promise<IncidentActionResult> => {
      await Promise.all([mutate(r.incident, { revalidate: false }), globalMutate(SECURITY_INCIDENT_SUMMARY_PATH)]);
      return r;
    },
    [mutate, globalMutate],
  );

  const acknowledge = useCallback(
    async (opts: { notificationId?: string | null } = {}) => apply(await acknowledgeSecurityIncident(id!, opts)),
    [apply, id],
  );
  const resolve = useCallback(
    async (opts: { note?: string } = {}) => apply(await resolveSecurityIncident(id!, opts)),
    [apply, id],
  );

  return {
    incident: data ?? null,
    error: error as Error | undefined,
    isLoading,
    refresh: () => mutate(),
    acknowledge,
    resolve,
  };
}

/**
 * GET /api/security/alert-routing — everyone at manage, the viewer's own line
 * below it. `set` PUTs one person's state with the version it read, then
 * re-reads the whole list (the fallback banner and other rows can move) and
 * the health header (its `alerts` row names who is told).
 */
export function useAlertRouting() {
  const { mutate: globalMutate } = useSWRConfig();
  const { data, error, isLoading, mutate } = useSWR<AlertRoutingView>(SECURITY_ALERT_ROUTING_PATH, () => getAlertRouting(), {
    shouldRetryOnError: false,
  });

  const set = useCallback(
    async (userId: string, body: AlertRoutingSetBody): Promise<AlertRoutingPerson> => {
      const r = await putAlertRouting(userId, body);
      await Promise.all([mutate(), globalMutate(SECURITY_HEALTH_PATH)]);
      return r.person;
    },
    [mutate, globalMutate],
  );

  return { routing: data ?? null, error: error as Error | undefined, isLoading, refresh: () => mutate(), set };
}
