// WARP-3520 — data layer for the editing surfaces of Projects: custom fields,
// relations, archive, item search and project settings (states, labels, fields).
//
// Its own file rather than more lines in usePm.ts: several slices edit that one
// concurrently, and the helpers below are only used by the editors. It reads the
// same `/api/pm/*` API through the same `authFetch`, and throws the same
// `PmRequestError` (so `translateError(e, "projects")` dispatches on `e.code`),
// extended with the zod/validator field errors the orchestrator returns as
// `details.fieldErrors` — usePm's `send` drops them.

import useSWR, { useSWRConfig } from "swr";
import { useCallback } from "react";
import { authFetch } from "@/lib/auth";
import { PmRequestError } from "./usePm";
import type {
  PmProject,
  PmProperty,
  PmPropertyValue,
  PmRelation,
  PmState,
  PmLabel,
  PmWorkItem,
  PropertyType,
  RelationKind,
  StateGroup,
} from "./types";

/** A rejected write that carries the server's per-field messages. */
export class PmFieldError extends PmRequestError {
  readonly fieldErrors: Record<string, string[]>;
  constructor(
    message: string,
    status: number,
    code: string | undefined,
    fieldErrors: Record<string, string[]>,
  ) {
    super(message, status, code);
    this.name = "PmFieldError";
    this.fieldErrors = fieldErrors;
  }
}

/** The first field-level message for `field`, if the error carries one. */
export function fieldError(e: unknown, field: string): string | null {
  if (e instanceof PmFieldError) return e.fieldErrors[field]?.[0] ?? null;
  return null;
}

async function get<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PmRequestError(data.error ?? `Request failed (${res.status})`, res.status, data.error);
  }
  return res.json() as Promise<T>;
}

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: { fieldErrors?: Record<string, string[]> };
    };
    throw new PmFieldError(
      data.error ?? `Request failed (${res.status})`,
      res.status,
      data.error,
      data.details?.fieldErrors ?? {},
    );
  }
  return res.json().catch(() => ({})) as Promise<T>;
}

// ── SWR keys ────────────────────────────────────────────────────────────────
// The strings the READ hooks use, so a write can revalidate exactly the cache
// it changed (`useRevalidate`). `states` and `labels` are the keys usePm.ts
// already uses — keep them byte-identical. The board's own item list is NOT
// here: it is revalidated through the page's `onItemsChanged` / `onChanged`
// callbacks, because how it is keyed is the page's business (and changes).
export const pmKeys = {
  states: (projectId: string) => `/api/pm/projects/${projectId}/states`,
  labels: (projectId: string) => `/api/pm/projects/${projectId}/labels`,
  properties: (projectId: string) => `/api/pm/projects/${projectId}/properties`,
  archived: (projectId: string) =>
    `/api/pm/projects/${projectId}/work-items?archived=only&per_page=200`,
  relations: (itemId: string) => `/api/pm/work-items/${itemId}/relations`,
} as const;

/** Revalidate SWR keys through the surrounding `SWRConfig` (so tests with a
 *  custom cache provider see it too — the global `mutate` would not). */
export function useRevalidate(): (...keys: string[]) => Promise<void> {
  const { mutate } = useSWRConfig();
  return useCallback(
    async (...keys: string[]) => {
      await Promise.all(keys.map((k) => mutate(k)));
    },
    [mutate],
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The project's custom-field definitions, in display order. */
export function useProjectProperties(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    projectId ? pmKeys.properties(projectId) : null,
    (u: string) => get<{ properties: PmProperty[] }>(u),
  );
  return { properties: data?.properties, error, isLoading, mutate };
}

/** Every relation touching the item, oriented on it. */
export function useRelations(itemId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    itemId ? pmKeys.relations(itemId) : null,
    (u: string) => get<{ relations: PmRelation[] }>(u),
  );
  return { relations: data?.relations, error, isLoading, mutate };
}

/** Workspace-wide item search for the parent / relation pickers. `enabled`
 *  false (or a blank query) is a null key — nothing is fetched. */
export function useWorkItemSearch(query: string, enabled = true) {
  const q = query.trim();
  const { data, error, isLoading } = useSWR(
    enabled && q.length > 0
      ? `/api/pm/work-items?q=${encodeURIComponent(q)}&per_page=20`
      : null,
    (u: string) => get<{ work_items: PmWorkItem[] }>(u),
    { keepPreviousData: true },
  );
  return { results: data?.work_items, error, isLoading };
}

/** One item by id — used to show the current parent's key and name. */
export function useWorkItemLookup(itemId: string | null) {
  const { data, error } = useSWR(itemId ? `/api/pm/work-items/${itemId}` : null, (u: string) =>
    get<{ work_item: PmWorkItem }>(u),
  );
  return { item: data?.work_item, error };
}

/** The project's archived items (the "Archived" list). `enabled` gates the fetch
 *  to when the list is actually open. */
export function useArchivedItems(projectId: string | null, enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR(
    enabled && projectId ? pmKeys.archived(projectId) : null,
    (u: string) => get<{ work_items: PmWorkItem[] }>(u),
  );
  return { items: data?.work_items, error, isLoading, mutate };
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** An option as sent: an existing option keeps its `id`; a new one has none. */
export interface PropertyOptionInput {
  id?: string;
  label: string;
  color?: string | null;
}

export function editActions() {
  return {
    // work items
    /** PATCH any subset of the item's fields (wire names: `name`, `priority`,
     *  `assignees`, `label_ids`, `parent_id`, `department_id`, `start_date`,
     *  `due_date` (YYYY-MM-DD or null), `type`, `estimate`, …). */
    patchItem: (itemId: string, patch: Record<string, unknown>) =>
      request<{ work_item: PmWorkItem }>(`/api/pm/work-items/${itemId}`, "PATCH", patch),
    archiveItem: (itemId: string) =>
      request<{ work_item: PmWorkItem }>(`/api/pm/work-items/${itemId}/archive`, "POST"),
    restoreItem: (itemId: string) =>
      request<{ work_item: PmWorkItem }>(`/api/pm/work-items/${itemId}/restore`, "POST"),
    /** Hard delete — owner/admin only on the server. */
    deleteItem: (itemId: string) =>
      request<{ deleted: string }>(`/api/pm/work-items/${itemId}`, "DELETE"),

    // custom-field values
    setProperty: (itemId: string, propertyId: string, value: PmPropertyValue) =>
      request<{ work_item: PmWorkItem }>(
        `/api/pm/work-items/${itemId}/properties/${propertyId}`,
        "PUT",
        { value },
      ),
    clearProperty: (itemId: string, propertyId: string) =>
      request<{ work_item: PmWorkItem }>(
        `/api/pm/work-items/${itemId}/properties/${propertyId}`,
        "DELETE",
      ),

    // relations. `fromId —kind→ toId`: for "blocked by X" call
    // addRelation(X, thisItem, "BLOCKS").
    addRelation: (fromId: string, toId: string, kind: RelationKind) =>
      request<{ relation: PmRelation }>(`/api/pm/work-items/${fromId}/relations`, "POST", {
        to_work_item_id: toId,
        kind,
      }),
    removeRelation: (relationId: string) =>
      request<{ deleted: string }>(`/api/pm/relations/${relationId}`, "DELETE"),

    // project details
    updateProject: (
      projectId: string,
      patch: {
        name?: string;
        description?: string | null;
        icon?: string | null;
        color?: string | null;
        leadId?: string | null;
        department_id?: string | null;
        company_id?: string | null;
      },
    ) => request<{ project: PmProject }>(`/api/pm/projects/${projectId}`, "PATCH", patch),

    // states
    createState: (
      projectId: string,
      body: { name: string; group: StateGroup; color?: string; sortOrder?: number },
    ) => request<{ state: PmState }>(`/api/pm/projects/${projectId}/states`, "POST", body),
    updateState: (
      stateId: string,
      patch: {
        name?: string;
        group?: StateGroup;
        color?: string | null;
        sortOrder?: number;
        /** Only `true` is accepted: a project always has exactly one default,
         *  so you move it by making ANOTHER state the default. */
        isDefault?: true;
      },
    ) => request<{ state: PmState }>(`/api/pm/states/${stateId}`, "PATCH", patch),
    /** `reassignTo`: where the deleted state's items go. Omitted ⇒ the
     *  project's default state. */
    deleteState: (stateId: string, reassignTo?: string) =>
      request<{ deleted: string }>(
        `/api/pm/states/${stateId}${reassignTo ? `?reassign_to=${encodeURIComponent(reassignTo)}` : ""}`,
        "DELETE",
      ),
    /** `stateIds` must list EVERY state of the project exactly once. */
    reorderStates: (projectId: string, stateIds: string[]) =>
      request<{ states: PmState[] }>(`/api/pm/projects/${projectId}/states/reorder`, "POST", {
        state_ids: stateIds,
      }),

    // labels
    createLabel: (projectId: string, body: { name: string; color?: string }) =>
      request<{ label: PmLabel }>(`/api/pm/projects/${projectId}/labels`, "POST", body),
    updateLabel: (labelId: string, patch: { name?: string; color?: string | null }) =>
      request<{ label: PmLabel }>(`/api/pm/labels/${labelId}`, "PATCH", patch),
    deleteLabel: (labelId: string) =>
      request<{ deleted: string }>(`/api/pm/labels/${labelId}`, "DELETE"),

    // custom fields (definitions) — owner / admin / project lead on the server
    createProperty: (
      projectId: string,
      body: { name: string; type: PropertyType; options?: PropertyOptionInput[] },
    ) => request<{ property: PmProperty }>(`/api/pm/projects/${projectId}/properties`, "POST", body),
    /** `type` is immutable. Sending `options` is a FULL replacement: an option
     *  left out is deleted and cleared from every item that held it. */
    updateProperty: (
      propertyId: string,
      patch: { name?: string; options?: PropertyOptionInput[]; sort_order?: number },
    ) => request<{ property: PmProperty }>(`/api/pm/properties/${propertyId}`, "PATCH", patch),
    deleteProperty: (propertyId: string) =>
      request<{ deleted: string }>(`/api/pm/properties/${propertyId}`, "DELETE"),
    /** `propertyIds` must list EVERY field of the project exactly once. */
    reorderProperties: (projectId: string, propertyIds: string[]) =>
      request<{ properties: PmProperty[] }>(
        `/api/pm/projects/${projectId}/properties/reorder`,
        "POST",
        { property_ids: propertyIds },
      ),
  };
}
