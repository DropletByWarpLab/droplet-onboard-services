// Data layer for the native Projects surface: SWR reads + mutation helpers
// against the orchestrator /api/pm/* API, plus people resolution.

import useSWR from "swr";
import { useCallback, useMemo } from "react";
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

export function useSummary() {
  const { data, error, isLoading, mutate } = useSWR("/api/pm/summary", (u: string) =>
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

export function useProjectItems(projectId: string | null) {
  const url = projectId ? `/api/pm/projects/${projectId}/work-items` : null;
  const { data, error, isLoading, mutate } = useSWR(url, (u: string) =>
    getJson<{ work_items: PmWorkItem[] }>(u),
  );
  return { items: data?.work_items, error, isLoading, mutate, key: url };
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
