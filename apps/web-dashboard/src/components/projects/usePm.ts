// Data layer for the native Projects surface: SWR reads + mutation helpers
// against the orchestrator /api/pm/* API, plus people resolution.

import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { useCallback, useEffect, useMemo, useRef } from "react";
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

/** Rows asked for per request. The server's own default is 100 and its ceiling
 *  500; 200 keeps a 250-item project to two requests without any one response
 *  getting heavy. */
export const PAGE_SIZE = 200;

/** One page of a work-item list, exactly as the orchestrator sends it. */
interface WorkItemsPage {
  work_items: PmWorkItem[];
  /** Null on the last page. */
  nextCursor: string | null;
  /** The exact size of the whole list, never of this page. */
  total: number;
}

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
 * WARP-3371 — EVERY page of a work-item list, loaded progressively.
 *
 * The board used to read one page of 100 and stop, with nothing on screen to say
 * so. This follows `nextCursor` page after page until it is null: the first page
 * paints as soon as it lands, `total` is the server's exact count (so the view
 * can say "100 of 250"), and the loop is bounded by the data — a stuck cursor is
 * impossible because the server only ever hands back a cursor that moves
 * forward.
 *
 * A page after the first that fails does NOT discard the pages already in hand:
 * `loadError` carries it while `items` keeps rendering, and SWR retries the
 * failed page on its own backoff. `error` is only the failure of the FIRST page,
 * i.e. "there is nothing to show".
 */
function useWorkItemPages(url: string | null) {
  const getKey = useCallback(
    (index: number, previous: WorkItemsPage | null): string | null => {
      if (!url) return null;
      const sep = url.includes("?") ? "&" : "?";
      if (index === 0) return `${url}${sep}limit=${PAGE_SIZE}`;
      if (!previous?.nextCursor) return null; // the last page has been read
      return `${url}${sep}limit=${PAGE_SIZE}&cursor=${encodeURIComponent(previous.nextCursor)}`;
    },
    [url],
  );
  const { data, error, isLoading, isValidating, setSize, mutate } = useSWRInfinite<WorkItemsPage>(
    getKey,
    (u: string) => getJson<WorkItemsPage>(u),
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
  const hasMore = Boolean(last?.nextCursor);

  // Pull the next page the moment the previous one has landed.
  useEffect(() => {
    if (hasMore && !isValidating && !error) void setSize(pages.length + 1);
  }, [hasMore, isValidating, error, pages.length, setSize]);

  useRefreshOnFocus(url !== null, isValidating, mutate);

  const items = useMemo(() => (data ? data.flatMap((p) => p.work_items) : undefined), [data]);

  /** Revalidate every page; resolves to the fresh, flattened list. */
  const refresh = useCallback(async (): Promise<{ work_items: PmWorkItem[] } | undefined> => {
    const fresh = await mutate();
    return fresh ? { work_items: fresh.flatMap((p) => p.work_items) } : undefined;
  }, [mutate]);

  return {
    items,
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
  return { ...useWorkItemPages(url), key: url };
}

export function useSubIssues(projectId: string | null, parentId: string | null) {
  const { items } = useWorkItemPages(
    projectId && parentId
      ? `/api/pm/projects/${projectId}/work-items?parent=${encodeURIComponent(parentId)}`
      : null,
  );
  return { subIssues: items };
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
  };
}
