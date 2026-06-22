// Data layer for the native Projects surface: SWR reads + mutation helpers
// against the orchestrator /api/pm/* API, plus people resolution.

import useSWR from "swr";
import { useCallback, useMemo } from "react";
import { authFetch } from "@/lib/auth";
import { makePerson } from "./config";
import type {
  PmProject,
  PmState,
  PmLabel,
  PmWorkItem,
  PmComment,
  PmSummary,
  Person,
} from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
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
    throw new Error(data.error ?? `Request failed (${res.status})`);
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

interface DirectoryUser {
  id: string;
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
    for (const u of data?.users ?? []) m.set(u.id, makePerson(u.id, u.displayName));
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
