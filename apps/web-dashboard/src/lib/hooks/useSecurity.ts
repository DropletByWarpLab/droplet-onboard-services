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
import useSWR, { useSWRConfig, type Revalidator, type RevalidatorOptions } from "swr";
import useSWRInfinite from "swr/infinite";
import {
  SECURITY_HOURS_PATH,
  SECURITY_MODE_PATH,
  SECURITY_PATTERNS_PATH,
  SECURITY_SOURCES_PATH,
  SECURITY_ZONES_PATH,
  archiveSecurityZone,
  createSecurityZone,
  deleteSecurityHoursException,
  fetchCameras,
  getSecurityEvents,
  getSecurityHealth,
  getSecurityIncidentCounts,
  getSecurityWallHealth,
  getSignInEndsAt,
  getWallModules,
  getSecurityHours,
  getSecurityMode,
  getSecurityPatternCells,
  getSecurityPatterns,
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
  SecurityIncidentCounts,
  SecurityModeAction,
  SecurityModeActionResult,
  SecurityModeView,
  SecurityPatternCells,
  SecurityPatternsOverview,
  SecuritySourcesView,
  SecurityZoneCreateBody,
  SecurityZoneCreated,
  SecurityZoneLinksBody,
  SecurityZonePatchBody,
  SecurityZonesResponse,
  SecurityZoneWriteResult,
} from "@/lib/types";
import { MODULE_GATE_KEY, isModuleEffective, type ModulesView } from "@/lib/hooks/useModuleGate";
import type { WallRead } from "@/components/security/wall-status";

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

// ── WARP-2981 (ADR-059 P6, §3.8): the Security wall ──
//
// A TV left on for hours with nobody to press Retry. The page's own SWR keys
// (`["security-wall", …]`, never /security's) so its retry policy cannot
// change /security's, and every read is retried — on its own backoff, capped
// at 2 min — whatever the error:
//   · SWR stops POLLING a key while its error is cached, and its default
//     retry backs off to ~30 min; the wall's must come back within minutes;
//   · a 404 is retried too: the module gate answers 404 on a toggle it could
//     not read (fail closed), and a key that gave up on a 404 would stay dead.
//     What stops a refused person's reads is the modules gate below, not the
//     retry policy.
// `revalidateOnFocus: false` also lets retries run in a tab the browser
// thinks is inactive (SWR only retries an inactive page when one of focus /
// reconnect revalidation is off).

export const WALL_KEY = "security-wall";
export const WALL_REFRESH_MS = 15_000;
export const WALL_MODULES_REFRESH_MS = 120_000;
export const WALL_SESSION_REFRESH_MS = 300_000;

/** 15 s, 30 s, 60 s, then 120 s for good (SWR's retryCount starts at 1). */
export function wallRetryDelayMs(retryCount: number): number {
  return Math.min(120_000, 15_000 * 2 ** Math.max(0, retryCount - 1));
}

/** SWR `onErrorRetry`: every error, on `wallRetryDelayMs`. */
export function wallOnErrorRetry(
  _err: unknown,
  _key: unknown,
  _config: unknown,
  revalidate: Revalidator,
  opts: Required<RevalidatorOptions>,
): void {
  setTimeout(() => void revalidate(opts), wallRetryDelayMs(opts.retryCount));
}

const WALL_SWR = {
  refreshInterval: WALL_REFRESH_MS,
  refreshWhenHidden: true,
  revalidateOnFocus: false,
  shouldRetryOnError: true,
  onErrorRetry: wallOnErrorRetry,
} as const;

/**
 * A read's answer and when it came (epoch ms), cached TOGETHER under the
 * wall's key. The SWR cache outlives the component — a remount (Back, a
 * client navigation, the module guard letting the wall back in) draws the
 * cached values at once — so their time has to come with them. Kept in
 * component state it restarted at "never", and hour-old numbers read as
 * "Waiting for Droplet…" instead of "from {time}" (D12).
 */
interface Heard<T> {
  value: T;
  at: number;
}

function heard<T>(read: () => Promise<T>): () => Promise<Heard<T>> {
  return async () => ({ value: await read(), at: Date.now() });
}

/**
 * The wall's own /api/modules read, each answer mirrored into the nav gate's
 * shared key. Two components hold it: the wall (useSecurityWall) and
 * `WallModulesKeeper`, which AuthGate mounts BESIDE the module route guard.
 * Once the guard blocks, it unmounts the wall; the nav gate's own read stops
 * polling after one error (`shouldRetryOnError: false`, and a TV never fires
 * focus), so without the keeper a single failed poll would leave the TV on the
 * guard's card for good. SWR shares the key: one request, not two.
 */
export function useWallModules() {
  const { mutate } = useSWRConfig();
  return useSWR<Heard<ModulesView>>([WALL_KEY, "modules"], heard(() => getWallModules()), {
    ...WALL_SWR,
    refreshInterval: WALL_MODULES_REFRESH_MS,
    // A mutate with data also clears an error the nav gate's key has cached, so its own poll resumes.
    onSuccess: (data) => void mutate(MODULE_GATE_KEY, data.value, { revalidate: false }),
  });
}

/** Keeps `useWallModules` polling, and mirroring, while the module guard has the wall unmounted. Renders nothing. */
export function WallModulesKeeper(): null {
  useWallModules();
  return null;
}

export interface SecurityWallState {
  /** Null until the wall's modules read has answered: nothing else is asked before. */
  access: { security: boolean; cameras: boolean } | null;
  counts: SecurityIncidentCounts | null;
  sources: SecurityHealthRow[] | null;
  mode: SecurityModeView | null;
  /** /auth/me `session.endsAt` (P6-A), or null. */
  signInEndsAt: string | null;
  /** Epoch ms of each read's last success, cached with its answer; null = never. */
  lastOkAt: Record<WallRead, number | null>;
  /** The read's latest attempt failed (its last value, if any, is still shown). */
  failed: Record<WallRead, boolean>;
}

/**
 * Everything /security/wall shows. Fails CLOSED on the module, the opposite of
 * the nav gate: its own /api/modules read gates the Security reads (and the
 * camera check), so nothing is asked before it answers, nor for a person
 * Security is not open to — each such read would be a feature-gate denial,
 * which the threat mirror turns into a "threat". Every answer is mirrored into
 * the nav gate's shared key, so ModuleRouteGuard above the page blocks within
 * 2 min of Security going off (and lets it back in once it is on again).
 */
export function useSecurityWall(): SecurityWallState {
  const modules = useWallModules();
  const access = modules.data
    ? { security: isModuleEffective(modules.data.value, "security"), cameras: isModuleEffective(modules.data.value, "cameras") }
    : null;
  const on = access?.security === true;

  const counts = useSWR<Heard<SecurityIncidentCounts>>(on ? [WALL_KEY, "counts"] : null, heard(() => getSecurityIncidentCounts()), WALL_SWR);
  const health = useSWR<Heard<{ sources: SecurityHealthRow[] }>>(on ? [WALL_KEY, "health"] : null, heard(() => getSecurityWallHealth()), WALL_SWR);
  const mode = useSWR<Heard<SecurityModeView>>(on ? [WALL_KEY, "mode"] : null, heard(() => getSecurityMode()), WALL_SWR);
  const session = useSWR<string | null>([WALL_KEY, "session"], () => getSignInEndsAt(), {
    ...WALL_SWR,
    refreshInterval: WALL_SESSION_REFRESH_MS,
  });

  return {
    access,
    counts: counts.data?.value ?? null,
    sources: health.data?.value.sources ?? null,
    mode: mode.data?.value ?? null,
    signInEndsAt: session.data ?? null,
    lastOkAt: {
      modules: modules.data?.at ?? null,
      counts: counts.data?.at ?? null,
      sources: health.data?.at ?? null,
      mode: mode.data?.at ?? null,
    },
    failed: {
      modules: Boolean(modules.error),
      counts: Boolean(counts.error),
      sources: Boolean(health.error),
      mode: Boolean(mode.error),
    },
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
