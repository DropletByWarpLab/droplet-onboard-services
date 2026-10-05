// Data layer for the native Projects surface: SWR reads + mutation helpers
// against the orchestrator /api/pm/* API, plus people resolution.

import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
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
import type {
  PmProject,
  PmState,
  PmLabel,
  PmWorkItem,
  PmComment,
  PmSummary,
  PmActivity,
  PmQueryPage,
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
  const { data, error, isLoading, mutate } = useSWR(enabled ? "/api/pm/summary" : null, (u: string) =>
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
      });
    },
    { revalidateAll: true, revalidateFirstPage: true, parallel: false, keepPreviousData: sameScope },
  );

  const last = data?.[data.length - 1];
  const hasMore = !!last && last.nextCursor !== null;
  useEffect(() => {
    if (hasMore && !isValidating && size < QUERY_MAX_PAGES) void setSize(size + 1);
  }, [hasMore, isValidating, size, setSize]);

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
    loadingMore: hasMore && size < QUERY_MAX_PAGES,
    /** More pages remain and will not be fetched: the cap was reached. */
    truncated: hasMore && size >= QUERY_MAX_PAGES,
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

export function useSubIssues(projectId: string | null, parentId: string | null) {
  const { data } = useSWR(
    projectId && parentId
      ? `/api/pm/projects/${projectId}/work-items?parent=${encodeURIComponent(parentId)}`
      : null,
    (u: string) => getJson<{ work_items: PmWorkItem[] }>(u),
  );
  return { subIssues: data?.work_items };
}

export function useComments(workItemId: string | null) {
  const { data, mutate } = useSWR(
    workItemId ? `/api/pm/work-items/${workItemId}/comments` : null,
    (u: string) => getJson<{ comments: PmComment[] }>(u),
  );
  return { comments: data?.comments, mutate };
}

export function useActivity(workItemId: string | null) {
  const { data, mutate } = useSWR(
    workItemId ? `/api/pm/work-items/${workItemId}/activity` : null,
    (url: string) => getJson<{ activity: PmActivity[] }>(url),
  );
  return { activity: data?.activity, mutate };
}


interface DirectoryUser {
  id: string;
  // WARP-947: the local `User.id` UUID. PM attribution surfaces (activity feed,
  // comment authors, assignees) reference this UUID — not the Nextcloud
  // username in `id`. Optional/nullable: a directory user with no local row, or
  // an older orchestrator that predates the field, yields null.
  userId?: string | null;
  username: string;
  displayName: string;
}

/** Resolve assignee/lead user ids → display names + avatar tone. Falls back to a
 *  short id stub when the directory hasn't loaded or the user is unknown. */
export function usePeople() {
  const { data } = useSWR("/api/auth/users", (u: string) =>
    getJson<{ users: DirectoryUser[] }>(u),
  );
  const map = useMemo(() => {
    const m = new Map<string, Person>();
    for (const u of data?.users ?? []) {
      const person = makePerson(u.id, u.displayName);
      // PM ids (actorId, authorId, assignees) are the local User.id UUID, so the
      // UUID is the primary resolution key. Also index the Nextcloud username so
      // any username-keyed caller still resolves. (WARP-947)
      if (u.userId) m.set(u.userId, person);
      m.set(u.id, person);
    }
    return m;
  }, [data]);
  const person = useCallback(
    (id: string): Person => map.get(id) ?? makePerson(id, `User ${id.slice(0, 4)}`),
    [map],
  );
  return { person, users: data?.users };
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
    deleteProject: (id: string) => send<{ deleted: string }>(`/api/pm/projects/${id}`, "DELETE"),
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
