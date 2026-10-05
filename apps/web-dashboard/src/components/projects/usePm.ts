// Data layer for the native Projects surface: SWR reads + mutation helpers
// against the orchestrator /api/pm/* API, plus people resolution.

import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { usePmLivePagedRead } from "./usePmLive";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  serializePmFilter,
  type PmFilter,
  type PmGroupByField,
  type PmSavedViewDto,
  type PmSortSpec,
  type PmViewLayout,
} from "@droplet/shared-types";
import { authFetch } from "@/lib/auth";
import type { Department } from "@/lib/types";
import { makePerson } from "./config";
import { localToday } from "./date-only";
import type {
  PmProject,
  PmState,
  PmLabel,
  PmWorkItem,
  PmComment,
  PmSummary,
  PmActivity,
  PmQueryPage,
  PmCycle,
  PmModule,
  PmModuleRef,
  PmBurndown,
  PmScopedItems,
  Person,
} from "./types";

/** Error thrown by {@link getJson} / {@link send} on a non-2xx response.
 *  Carries the HTTP status so the UI can tell an auth failure (401/403) from a
 *  server/connection fault, and the wire `error` string as `code` so the
 *  friendly-copy translator (`translateError(e, "projects")`) can dispatch on
 *  the orchestrator's stable codes (`module_disabled`, `project_not_found`, …)
 *  without any surface ever rendering the raw snake_case (WARP-1154). A
 *  genuine network/timeout failure rejects inside `fetch` before we reach
 *  here, so the surfaced error has no `status` — that absence is itself the
 *  "couldn't reach the appliance" signal. */
export class PmRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "PmRequestError";
    this.status = status;
    this.code = code;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PmRequestError(
      body.error ?? `Request failed (${res.status})`,
      res.status,
      body.error,
    );
  }
  return res.json() as Promise<T>;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PmRequestError(
      data.error ?? `Request failed (${res.status})`,
      res.status,
      data.error,
    );
  }
  return res.json().catch(() => ({})) as Promise<T>;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function useProjects(includeArchived: boolean) {
  const url = `/api/pm/projects${includeArchived ? "?archived=1" : ""}`;
  const { data, error, isLoading, mutate } = useSWR(
    url,
    (u: string) => getJson<{ projects: PmProject[] }>(u),
  );
  return { projects: data?.projects, error, isLoading, mutate };
}

/**
 * WARP-2875 — `enabled` is the `projects` capability flag. A null key when the
 * module is off is how useSWR is told not to fetch (same as useCrmSummary);
 * /business mounts this hook on every box, and Projects is off by default.
 */
export function useSummary(enabled: boolean) {
  // WARP-3372 — "overdue" is measured against the viewer's own calendar day, the
  // same one the board's overdue chip uses, so the two cannot disagree. The day
  // is part of the key: it rolls over with midnight, not with a stale cache.
  const url = enabled ? `/api/pm/summary?today=${localToday()}` : null;
  const { data, error, isLoading, mutate } = useSWR(url, (u: string) =>
    getJson<{ summary: PmSummary }>(u),
  );
  return { summary: data?.summary, error, isLoading, mutate };
}

export function useProjectStates(projectId: string | null) {
  const { data, error, isLoading } = useSWR(
    projectId ? `/api/pm/projects/${projectId}/states` : null,
    (u: string) => getJson<{ states: PmState[] }>(u),
  );
  return { states: data?.states, error, isLoading };
}

/** ADR-045 §5.3 — the departments the CALLER may pick from in the board filter.
 *
 *  `GET /api/departments` is SERVER-SCOPED: owner/admin see every unit
 *  (archived included), everyone else sees only units they hold a
 *  `DepartmentMembership` on, archived hidden. That is the right scope for a
 *  picker and the WRONG scope for a LABEL — PM is household-shared, so a work
 *  item owned by a department the caller is not a member of would render blank.
 *  Which is why the label travels on the work item (`item.department`) and this
 *  hook only feeds the picker; `departmentOptions` unions the two so an
 *  out-of-scope or archived department that owns visible work is still
 *  filterable.
 *
 *  Fails soft: a 403 or a 500 leaves `departments` undefined and the picker
 *  falls back to whatever the board itself shows. A department read must never
 *  be able to error a board. */
export function useDepartments() {
  const { data } = useSWR("/api/departments", (u: string) =>
    getJson<{ departments: Department[] }>(u),
  );
  return { departments: data?.departments };
}

export function useProjectLabels(projectId: string | null) {
  const { data } = useSWR(
    projectId ? `/api/pm/projects/${projectId}/labels` : null,
    (u: string) => getJson<{ labels: PmLabel[] }>(u),
  );
  return { labels: data?.labels };
}

/** The browser's IANA zone. Relative dates in a filter ("today", "-7d") are
 *  resolved by the SERVER in this zone — the browser never computes one. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Rows asked for per request. The server allows 500; a project of a few
 *  hundred items arrives in one or two requests. */
const QUERY_PAGE_SIZE = 200;
/** Pages the board chases on its own — 10 000 items — before it stops and says so. */
export const QUERY_MAX_PAGES = 50;

export interface WorkItemQueryArgs {
  enabled: boolean;
  /** One project, or `null` for the whole workspace. */
  projectId: string | null;
  filter: PmFilter;
  /** Named filters whose match counts come back on the first page (the saved-view chips). */
  counts?: Record<string, PmFilter>;
  /** WARP-3537 — the table's ordering. Absent: the server's own (a project's manual order). */
  sort?: PmSortSpec[];
  /** WARP-3537 — exact per-group counts for the whole result, returned as `groups` on the first page. */
  groupBy?: PmGroupByField;
}

/**
 * WARP-3522 — the board and the list read through the query API, so the filter
 * runs on the server and the page never filters what it holds. Pages load one
 * after another on their own (`useSWRInfinite`), the first renders at once, and
 * the caller is told while more remain ("Showing 200 of 530"). Items repeated
 * across a page boundary (offset paging; see the server's `cursor.ts`) are
 * de-duplicated by id.
 *
 * `refresh` revalidates every loaded page and resolves to the fresh items, which
 * is what the drawer needs to pick up its own item after an edit.
 */
export function useWorkItemQuery({ enabled, projectId, filter, counts, sort, groupBy }: WorkItemQueryArgs) {
  const tz = useMemo(browserTimeZone, []);
  const failedPage = useRef<{ error: unknown; cursor: string | null } | null>(null);
  const filterKey = serializePmFilter(filter);
  // By value, so an equal sort in a new array is the same query. The server binds a
  // page cursor to the sort it was issued under, so the sort is part of the key.
  const sortKey = sort ? JSON.stringify(sort) : "";
  const countsKey = counts
    ? Object.entries(counts)
        .map(([name, f]) => name + "=" + serializePmFilter(f))
        .join("|")
    : "";

  // Editing a filter must not flash the board to a skeleton, so the previous
  // answer stays up while the next one loads — but only WITHIN one project:
  // another project's items under this project's header, even for a moment,
  // would be wrong (their states are not this board's columns).
  const lastProject = useRef(projectId);
  const sameScope = lastProject.current === projectId;
  useEffect(() => {
    lastProject.current = projectId;
  }, [projectId]);

  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<PmQueryPage>(
    (_index, prev: PmQueryPage | null) => {
      if (!enabled) return null;
      if (prev && prev.nextCursor === null) return null;
      return ["pm-query", projectId ?? "*", filterKey, tz ?? "", countsKey, sortKey, groupBy ?? "", prev ? prev.nextCursor : null];
    },
    (key: unknown[]) => {
      const cursor = key[7] as string | null;
      return send<PmQueryPage>("/api/pm/work-items/query", "POST", {
        projectId,
        filter,
        tz,
        limit: QUERY_PAGE_SIZE,
        cursor,
        ...(sort ? { sort } : {}),
        // `counts` and `groups` are one answer for the whole result, not one per page.
        ...(cursor === null && counts ? { counts } : {}),
        ...(cursor === null && groupBy ? { groupBy } : {}),
      }).catch((error: unknown) => {
        failedPage.current = { error, cursor };
        throw error;
      });
    },
    { revalidateFirstPage: false, parallel: false, keepPreviousData: sameScope },
  );

  const last = data?.[data.length - 1];
  const hasMore = !!last && last.nextCursor !== null;
  useEffect(() => {
    if (hasMore && !isValidating && !error && size < QUERY_MAX_PAGES) void setSize(size + 1);
  }, [hasMore, isValidating, error, size, setSize]);

  const items = useMemo(() => {
    if (!data) return undefined;
    const seen = new Set<string>();
    const out: PmWorkItem[] = [];
    for (const page of data) {
      for (const it of page.work_items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  }, [data]);

  const refresh = useCallback(async () => {
    const fresh = await mutate();
    return fresh?.flatMap((p) => p.work_items);
  }, [mutate]);
  // Query pages use tuple keys; refresh their mounted Infinite aggregate through
  // its own mutate when this project (or any project in a workspace view) changes.
  usePmLivePagedRead(enabled ? (projectId ? `/api/pm/projects/${projectId}/work-items` : "/api/pm/work-items?query") : null, refresh);

  const first = data?.[0];
  return {
    items,
    total: first?.total,
    counts: first?.counts,
    /** WARP-3537 — exact per-group counts for the whole result (only when a group-by was asked for). */
    groups: first?.groups,
    stale: first?.stale,
    effectiveFilter: first?.filter,
    /** More pages remain and are on their way. */
    loadingMore: hasMore && size < QUERY_MAX_PAGES && !error,
    /** More pages remain and will not be fetched: the cap was reached. */
    truncated: hasMore && size >= QUERY_MAX_PAGES,
    /** Distinguish a failed tail from a new filter whose first request failed. */
    partialError: !!error && failedPage.current?.error === error && failedPage.current?.cursor !== null,
    loadError: error && failedPage.current?.error === error && failedPage.current?.cursor !== null ? error : undefined,
    error,
    isLoading,
    refresh,
  };
}

/** `INBOX-42` → the item. For a deep link to an item that is not in the loaded list. */
export function useWorkItemByKey(key: string | null, enabled: boolean) {
  const { data, error, mutate } = useSWR(
    key && enabled ? `/api/pm/work-items/by-key/${encodeURIComponent(key)}` : null,
    (u: string) => getJson<{ work_item: PmWorkItem }>(u),
    // A key that answers 404 will not answer differently in five seconds.
    { shouldRetryOnError: false },
  );
  const refresh = useCallback(() => mutate(), [mutate]);
  // Frames carry the row id, while the URL carries its human-readable key.
  // Register the resolved id so an unrelated item's change leaves this read alone.
  usePmLivePagedRead(key && enabled && data?.work_item ? `/api/pm/work-items/${data.work_item.id}` : null, refresh);
  return { item: data?.work_item, error, mutate };
}

/** Where saved views are listed from: one project's, or every view the caller can see. */
export type ViewsScope = { kind: "project"; projectId: string } | { kind: "all" } | null;

/**
 * Saved views the CALLER can see: shared ones and their own personal ones. The
 * built-ins are not fetched — they are constants in shared-types, needed before
 * any request could return — so `views` is only the saved ones. A `null` scope
 * is "do not fetch".
 */
export function useSavedViews(scope: ViewsScope) {
  const url =
    scope === null
      ? null
      : scope.kind === "project"
        ? `/api/pm/views?project=${encodeURIComponent(scope.projectId)}`
        : "/api/pm/views";
  const { data, error, isLoading, mutate } = useSWR(url, (u: string) =>
    getJson<{ builtin: PmSavedViewDto[]; views: PmSavedViewDto[] }>(u),
  );
  return { views: data?.views, error, isLoading, mutate };
}

/** Rows asked for per request. The server's own default is 100 and its ceiling
 *  500; 200 keeps a 250-item project to two requests without any one response
 *  getting heavy. */
export const PAGE_SIZE = 200;

/** The most pages a walk of `total` rows may take: the pages those rows fill,
 *  plus two. Any more means the server's cursor is not advancing, and the walk
 *  ends rather than become a request loop. */
const maxPages = (total: number): number => Math.ceil(total / PAGE_SIZE) + 2;

/** One page of a PM list, exactly as the orchestrator sends it: the rows under a
 *  key that names them (`work_items`, `comments`, `activity`), `nextCursor`
 *  (null on the last page) and the exact `total` of the whole list. */
type ListPage = { nextCursor: string | null; total: number } & Record<string, unknown>;

/** A tab that regains focus re-reads the list, but never more often than this:
 *  a re-read walks every page, so it is not free on a big project. */
const FOCUS_REFRESH_MIN_MS = 30_000;

/**
 * Re-read the whole chain when the tab regains focus — what `revalidateOnFocus`
 * did for the single-page list, so a board left open still catches up with what
 * the rest of the team did. `mutate()` with no argument revalidates EVERY page.
 */
function useRefreshOnFocus(enabled: boolean, busy: boolean, mutate: () => Promise<unknown>): void {
  const lastLoadAt = useRef(Date.now());
  useEffect(() => {
    if (!busy) lastLoadAt.current = Date.now();
  }, [busy]);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastLoadAt.current < FOCUS_REFRESH_MIN_MS) return;
      lastLoadAt.current = Date.now();
      void mutate();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, mutate]);
}

/**
 * WARP-3371 — EVERY page of a PM list (work items, comments, activity), loaded
 * progressively.
 *
 * The board used to read one page of 100 and stop, with nothing on screen to say
 * so. This follows `nextCursor` page after page until it is null: the first page
 * paints as soon as it lands, `total` is the server's exact count (so the view
 * can say "100 of 250"), and the walk is bounded twice over — by the cursor
 * itself, and by a page count derived from `total`, so a server that ever failed
 * to advance its cursor ends the walk instead of becoming a request loop. Rows
 * are de-duplicated by id for the same reason.
 *
 * A page after the first that fails does NOT discard the pages already in hand:
 * `loadError` carries it while `rows` keeps rendering, and SWR retries the
 * failed page on its own backoff. `error` is only the failure of the FIRST page,
 * i.e. "there is nothing to show".
 */
function usePages<T extends { id: string }>(url: string | null, field: string) {
  const getKey = useCallback(
    (index: number, previous: ListPage | null): string | null => {
      if (!url) return null;
      const sep = url.includes("?") ? "&" : "?";
      if (index === 0) return `${url}${sep}limit=${PAGE_SIZE}`;
      if (!previous?.nextCursor) return null; // the last page has been read
      if (index >= maxPages(previous.total)) return null; // the cursor is not advancing
      return `${url}${sep}limit=${PAGE_SIZE}&cursor=${encodeURIComponent(previous.nextCursor)}`;
    },
    [url],
  );
  const { data, error, isLoading, isValidating, setSize, mutate } = useSWRInfinite<ListPage>(
    getKey,
    (u: string) => getJson<ListPage>(u),
    {
      // The chain is walked ONE page per `setSize` below. SWR's default re-reads
      // the first page on every step, which would fetch it once more for each
      // page that follows it.
      revalidateFirstPage: false,
      // …but a chain that is already cached must still be re-read when the
      // board is opened again.
      revalidateOnMount: true,
      // With nothing re-read implicitly any more the stock focus revalidation
      // would be a no-op; `useRefreshOnFocus` below is the real one.
      revalidateOnFocus: false,
    },
  );

  const pages = data ?? [];
  const last = pages[pages.length - 1];
  // "More is coming" only while the walk is allowed to continue (see `maxPages`),
  // so a cursor that never advances reads as "done", not as loading forever.
  const hasMore = Boolean(last?.nextCursor && pages.length < maxPages(last.total));

  // Pull the next page the moment the previous one has landed.
  useEffect(() => {
    if (hasMore && !isValidating && !error) void setSize(pages.length + 1);
  }, [hasMore, isValidating, error, pages.length, setSize]);

  useRefreshOnFocus(url !== null, isValidating, mutate);

  const flatten = useCallback(
    (all: ListPage[]): T[] => {
      const seen = new Set<string>();
      return all
        .flatMap((p) => (p[field] as T[] | undefined) ?? [])
        .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
    },
    [field],
  );
  const rows = useMemo(() => (data ? flatten(data) : undefined), [data, flatten]);

  /** Revalidate every page; resolves to the fresh, flattened rows. */
  const refresh = useCallback(async (): Promise<T[] | undefined> => {
    const fresh = await mutate();
    return fresh ? flatten(fresh) : undefined;
  }, [mutate, flatten]);
  usePmLivePagedRead(url, refresh);

  return {
    rows,
    total: last?.total,
    /** More pages are still on the way. */
    hasMore,
    loadError: pages.length > 0 ? (error as Error | undefined) : undefined,
    error: pages.length === 0 ? error : undefined,
    isLoading,
    mutate: refresh,
  };
}

export function useProjectItems(projectId: string | null) {
  const url = projectId ? `/api/pm/projects/${projectId}/work-items` : null;
  const { rows, mutate, ...rest } = usePages<PmWorkItem>(url, "work_items");
  return {
    ...rest,
    items: rows,
    key: url,
    /** Revalidate every page; resolves to the fresh list as `{ work_items }`. */
    mutate: async (): Promise<{ work_items: PmWorkItem[] } | undefined> => {
      const fresh = await mutate();
      return fresh ? { work_items: fresh } : undefined;
    },
  };
}

export function useSubIssues(projectId: string | null, parentId: string | null) {
  const { rows } = usePages<PmWorkItem>(
    projectId && parentId
      ? `/api/pm/projects/${projectId}/work-items?parent=${encodeURIComponent(parentId)}`
      : null,
    "work_items",
  );
  return { subIssues: rows };
}

// WARP-3371 — comments and the activity feed are pages too (the API caps a
// request at 500), so a long thread is read to the end instead of stopping at
// whatever the first response held.
export function useComments(workItemId: string | null) {
  const { rows, mutate } = usePages<PmComment>(
    workItemId ? `/api/pm/work-items/${workItemId}/comments` : null,
    "comments",
  );
  return { comments: rows, mutate };
}

export function useActivity(workItemId: string | null) {
  const { rows, mutate } = usePages<PmActivity>(
    workItemId ? `/api/pm/work-items/${workItemId}/activity` : null,
    "activity",
  );
  return { activity: rows, mutate };
}

// ── Cycles and modules (WARP-3521) ──────────────────────────────────────────

/** A project's cycles, active first, then upcoming, then completed (the server's order). */
export function useProjectCycles(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    projectId ? `/api/pm/projects/${projectId}/cycles` : null,
    (u: string) => getJson<{ cycles: PmCycle[] }>(u),
  );
  return { cycles: data?.cycles, error, isLoading, mutate };
}

/** One cycle's own work items. Server-scoped: the board's project list is a capped page. */
export function useCycleItems(cycleId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    cycleId ? `/api/pm/cycles/${cycleId}/work-items` : null,
    (u: string) => getJson<PmScopedItems>(u),
  );
  return { items: data?.work_items, total: data?.total, error, isLoading, mutate };
}

/** The planning backlog: the project's unfinished work that is in no cycle. */
export function useBacklog(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    projectId ? `/api/pm/projects/${projectId}/backlog` : null,
    (u: string) => getJson<PmScopedItems>(u),
  );
  return { items: data?.work_items, total: data?.total, error, isLoading, mutate };
}

export function useCycleBurndown(cycleId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    cycleId ? `/api/pm/cycles/${cycleId}/burndown` : null,
    (u: string) => getJson<{ burndown: PmBurndown }>(u),
  );
  return { burndown: data?.burndown, error, isLoading, mutate };
}

export function useProjectModules(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    projectId ? `/api/pm/projects/${projectId}/modules` : null,
    (u: string) => getJson<{ modules: PmModule[] }>(u),
  );
  return { modules: data?.modules, error, isLoading, mutate };
}

/** One module's own work items. */
export function useModuleItems(moduleId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    moduleId ? `/api/pm/modules/${moduleId}/work-items` : null,
    (u: string) => getJson<PmScopedItems>(u),
  );
  return { items: data?.work_items, total: data?.total, error, isLoading, mutate };
}

/** The modules ONE work item is in — the drawer's picker. */
export function useWorkItemModules(workItemId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    workItemId ? `/api/pm/work-items/${workItemId}/modules` : null,
    (u: string) => getJson<{ modules: PmModuleRef[] }>(u),
  );
  return { modules: data?.modules, error, isLoading, mutate };
}

/** One entry of `GET /api/pm/people` — what Projects needs to show a person. */
interface PmPerson {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** An id the people list does not know, once the list HAS loaded: a leaver, or
 *  a machine. Never a guess at who it was. */
export const FORMER_MEMBER = "Former member";
/** What an id shows before the list has answered (or if it cannot). Neutral on
 *  purpose: "Former member" would be false for someone who is on the list. */
const MEMBER_PENDING = "Team member";

/**
 * Resolve the user ids on PM rows (lead, assignee, creator, comment author,
 * activity actor — all the local `User.id`) to a name and an avatar.
 *
 * WARP-3372 — this used to read `GET /api/auth/users`, which is owner/admin-only,
 * so every member saw "User 1a2b" for every colleague. `/api/pm/people` is the
 * PM-scoped projection every role that can read the board is allowed to read.
 * A known id is its person; an unknown id is "Former member" once the list has
 * loaded; before that (or if it fails) it is a neutral label — never the id.
 */
export function usePeople() {
  const { data } = useSWR("/api/pm/people", (u: string) => getJson<{ people: PmPerson[] }>(u));
  const map = useMemo(() => {
    const m = new Map<string, Person>();
    for (const p of data?.people ?? []) m.set(p.id, makePerson(p.id, p.displayName, p.avatarUrl));
    return m;
  }, [data]);
  const person = useCallback(
    (id: string): Person => map.get(id) ?? makePerson(id, data ? FORMER_MEMBER : MEMBER_PENDING),
    [map, data],
  );
  return { person, people: data?.people };
}

// ── Mutations ───────────────────────────────────────────────────────────────

export interface CreateWorkItemInput {
  name: string;
  description_html?: string;
  state_id?: string;
  priority?: string;
  assignees?: string[];
  label_ids?: string[];
  due_date?: string;
  /** WARP-3521 — plan the new item into a cycle of this project. */
  cycle_id?: string;
}

export function pmActions() {
  return {
    createWorkItem: (projectId: string, body: CreateWorkItemInput) =>
      send<{ work_item: PmWorkItem }>(`/api/pm/projects/${projectId}/work-items`, "POST", body),
    createProject: (body: {
      name: string;
      identifier?: string;
      description?: string;
      color?: string;
    }) => send<{ project: PmProject }>(`/api/pm/projects`, "POST", body),
    transitionItem: (itemId: string, stateId: string) =>
      send<{ work_item: PmWorkItem }>(`/api/pm/work-items/${itemId}/transition`, "POST", {
        state_id: stateId,
      }),
    updateItem: (itemId: string, patch: Record<string, unknown>) =>
      send<{ work_item: PmWorkItem }>(`/api/pm/work-items/${itemId}`, "PATCH", patch),
    addComment: (itemId: string, commentHtml: string) =>
      send<{ comment: PmComment }>(`/api/pm/work-items/${itemId}/comments`, "POST", {
        comment_html: commentHtml,
      }),
    // WARP-3370 — archive / restore are PATCH `archived` (a member may); delete is
    // for good, owner/admin only, archived projects only, and the API wants the
    // identifier typed again.
    archiveProject: (id: string) =>
      send<{ project: PmProject }>(`/api/pm/projects/${id}`, "PATCH", { archived: true }),
    restoreProject: (id: string) =>
      send<{ project: PmProject }>(`/api/pm/projects/${id}`, "PATCH", { archived: false }),
    deleteProject: (id: string, confirmIdentifier: string) =>
      send<{ deleted: string }>(`/api/pm/projects/${id}`, "DELETE", { confirm_identifier: confirmIdentifier }),

    // ── Cycles (WARP-3521). Dates are `YYYY-MM-DD`; `null` clears one. ──
    createCycle: (
      projectId: string,
      body: { name: string; description?: string | null; start_date?: string | null; end_date?: string | null },
    ) => send<{ cycle: PmCycle }>(`/api/pm/projects/${projectId}/cycles`, "POST", body),
    updateCycle: (
      id: string,
      patch: { name?: string; description?: string | null; start_date?: string | null; end_date?: string | null },
    ) => send<{ cycle: PmCycle }>(`/api/pm/cycles/${id}`, "PATCH", patch),
    deleteCycle: (id: string) => send<{ deleted: string }>(`/api/pm/cycles/${id}`, "DELETE"),
    startCycle: (id: string) => send<{ cycle: PmCycle }>(`/api/pm/cycles/${id}/start`, "POST"),
    /** `moveIncompleteTo` is a cycle id or the word "backlog" — required, never defaulted. */
    completeCycle: (id: string, moveIncompleteTo: string) =>
      send<{ cycle: PmCycle; moved: { count: number; to: string | null } }>(
        `/api/pm/cycles/${id}/complete`,
        "POST",
        { moveIncompleteTo },
      ),
    /** Plan an item into a cycle, or (null) take it out. */
    setItemCycle: (itemId: string, cycleId: string | null) =>
      send<{ work_item: PmWorkItem }>(`/api/pm/work-items/${itemId}`, "PATCH", { cycle_id: cycleId }),

    // ── Modules (WARP-3521) ──
    createModule: (
      projectId: string,
      body: {
        name: string;
        description?: string | null;
        lead_id?: string | null;
        status?: string;
        start_date?: string | null;
        target_date?: string | null;
      },
    ) => send<{ module: PmModule }>(`/api/pm/projects/${projectId}/modules`, "POST", body),
    updateModule: (
      id: string,
      patch: {
        name?: string;
        description?: string | null;
        lead_id?: string | null;
        status?: string;
        start_date?: string | null;
        target_date?: string | null;
      },
    ) => send<{ module: PmModule }>(`/api/pm/modules/${id}`, "PATCH", patch),
    deleteModule: (id: string) => send<{ deleted: string }>(`/api/pm/modules/${id}`, "DELETE"),
    addModuleItems: (moduleId: string, workItemIds: string[]) =>
      send<{ added: number; module: PmModule }>(`/api/pm/modules/${moduleId}/work-items`, "POST", {
        work_item_ids: workItemIds,
      }),
    removeModuleItem: (moduleId: string, workItemId: string) =>
      send<{ removed: number; module: PmModule }>(
        `/api/pm/modules/${moduleId}/work-items/${workItemId}`,
        "DELETE",
      ),
  };
}

export interface SaveViewInput {
  projectId: string | null;
  scope: "PERSONAL" | "SHARED";
  name: string;
  layout: PmViewLayout;
  filter: PmFilter;
  /** WARP-3537 — what the table and list persist per view. `null` is "the layout's own default". */
  groupBy?: PmGroupByField | null;
  sortBy?: PmSortSpec[] | null;
  columns?: string[] | null;
}

/** WARP-3522 — saved-view writes. Errors carry the orchestrator's stable codes
 *  (`view_name_taken`, `view_limit_reached`, …), which `translateError` words. */
export function viewActions() {
  return {
    create: (input: SaveViewInput) => send<{ view: PmSavedViewDto }>("/api/pm/views", "POST", input),
    update: (
      id: string,
      patch: Partial<{
        name: string;
        layout: PmViewLayout;
        filter: PmFilter;
        groupBy: PmGroupByField | null;
        sortBy: PmSortSpec[] | null;
        columns: string[] | null;
      }>,
    ) =>
      send<{ view: PmSavedViewDto }>(`/api/pm/views/${encodeURIComponent(id)}`, "PATCH", patch),
    remove: (id: string) => send<{ deleted: string }>(`/api/pm/views/${encodeURIComponent(id)}`, "DELETE"),
  };
}
