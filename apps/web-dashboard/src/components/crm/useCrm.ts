// Data layer for the CRM sub-tabs (WARP-2545): SWR reads + mutation helpers
// against /api/crm/*. Deliberately the same shape as `usePm.ts` — same error
// class contract, same mutate-after-write discipline — so the two surfaces on
// one page behave identically under failure.

import useSWR from "swr";
import { useCallback, useMemo } from "react";

import { authFetch } from "@/lib/auth";
import type {
  CrmActivity,
  CrmCompany,
  CrmContact,
  CrmDeal,
  CrmPipeline,
  CrmStageSummary,
  CrmSubject,
} from "./types";

/** Mirrors `PmRequestError`: carries the HTTP status so the UI can tell an
 *  auth failure from a connection fault, and the wire `error` string as `code`
 *  so `translateError` can dispatch on the orchestrator's stable codes without
 *  any surface rendering raw snake_case. */
export class CrmRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CrmRequestError";
    this.status = status;
    this.code = code;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CrmRequestError(body.error ?? `Request failed (${res.status})`, res.status, body.error);
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
    throw new CrmRequestError(data.error ?? `Request failed (${res.status})`, res.status, data.error);
  }
  // 204 has no body; every other write returns the row it wrote.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function usePipelines(): {
  pipelines: CrmPipeline[] | undefined;
  error: unknown;
  isLoading: boolean;
  mutate: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<{ pipelines: CrmPipeline[] }>(
    "/api/crm/pipelines",
    getJson,
  );
  return { pipelines: data?.pipelines, error, isLoading, mutate: () => void mutate() };
}

export function useCompanies(query: string, showArchived: boolean): {
  companies: CrmCompany[] | undefined;
  total: number;
  error: unknown;
  isLoading: boolean;
  mutate: () => void;
} {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (showArchived) params.set("archived", "1");
  const qs = params.toString();
  const { data, error, isLoading, mutate } = useSWR<{ companies: CrmCompany[]; total: number }>(
    `/api/crm/companies${qs ? `?${qs}` : ""}`,
    getJson,
  );
  return {
    companies: data?.companies,
    total: data?.total ?? 0,
    error,
    isLoading,
    mutate: () => void mutate(),
  };
}

export function useDeals(pipelineId: string | null): {
  deals: CrmDeal[] | undefined;
  error: unknown;
  isLoading: boolean;
  mutate: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<{ deals: CrmDeal[]; total: number }>(
    // Null pipeline = "not resolved yet", NOT "all pipelines" — asking for all
    // of them would render a board mixing two pipelines' columns.
    pipelineId ? `/api/crm/deals?pipeline=${encodeURIComponent(pipelineId)}` : null,
    getJson,
  );
  return { deals: data?.deals, error, isLoading, mutate: () => void mutate() };
}

/**
 * WARP-2561 — now reports `error` and `isLoading`, like every sibling hook in
 * this file.
 *
 * It returned neither, which is survivable on the deal board (the board has
 * its own columns and the summary only decorates them) and is not survivable
 * on a tile whose entire content IS the summary: with only `stages`, a failed
 * read and a slow one are the same `undefined`, so the tile must either show a
 * skeleton forever or invent a zero. Both lie in a different direction.
 */
export function useCrmSummary(pipelineId: string | null): {
  stages: CrmStageSummary[] | undefined;
  error: unknown;
  isLoading: boolean;
  mutate: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<{
    pipelineId: string;
    stages: CrmStageSummary[];
  }>(
    pipelineId ? `/api/crm/summary?pipeline=${encodeURIComponent(pipelineId)}` : null,
    getJson,
  );
  return { stages: data?.stages, error, isLoading, mutate: () => void mutate() };
}

export function useTimeline(subject: { type: CrmSubject; id: string } | null): {
  activities: CrmActivity[] | undefined;
  isLoading: boolean;
  mutate: () => void;
} {
  const { data, isLoading, mutate } = useSWR<{ activities: CrmActivity[]; total: number }>(
    subject
      ? `/api/crm/activities?subject_type=${subject.type}&subject_id=${encodeURIComponent(subject.id)}`
      : null,
    getJson,
  );
  return { activities: data?.activities, isLoading, mutate: () => void mutate() };
}

/**
 * People for the CRM's pickers. Reads `/api/contacts`, which the `contacts`
 * module gates independently — so this can 404 on a box where the CRM is on
 * and Contacts is off. That is not an error state: the caller renders the
 * picker as unavailable rather than as broken.
 */
export function useContacts(query: string, enabled: boolean): {
  contacts: CrmContact[] | undefined;
  unavailable: boolean;
} {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const qs = params.toString();
  const { data, error } = useSWR<{ contacts: CrmContact[]; total: number }>(
    enabled ? `/api/contacts${qs ? `?${qs}` : ""}` : null,
    getJson,
  );
  const unavailable =
    !enabled || (error instanceof CrmRequestError && (error.status === 404 || error.status === 403));
  return { contacts: data?.contacts, unavailable };
}

export interface CrmActions {
  createCompany: (input: { name: string; domain?: string | null; industry?: string | null }) => Promise<CrmCompany>;
  archiveCompany: (id: string, archived: boolean) => Promise<void>;
  createDeal: (input: {
    title: string;
    companyId?: string | null;
    pipelineId?: string;
    stageId?: string;
    amountMinor?: string | null;
    currency?: string | null;
    expectedCloseOn?: string | null;
  }) => Promise<CrmDeal>;
  moveDeal: (dealId: string, stageId: string) => Promise<CrmDeal>;
  logActivity: (input: {
    subjectType: CrmSubject;
    companyId?: string | null;
    dealId?: string | null;
    contactId?: string | null;
    kind: "NOTE" | "CALL" | "MEETING" | "TASK" | "EMAIL";
    summary: string;
  }) => Promise<CrmActivity>;
  linkContactToCompany: (companyId: string, contactId: string) => Promise<void>;
}

export function useCrmActions(): CrmActions {
  const createCompany = useCallback<CrmActions["createCompany"]>(
    async (input) => (await send<{ company: CrmCompany }>("/api/crm/companies", "POST", input)).company,
    [],
  );
  const archiveCompany = useCallback<CrmActions["archiveCompany"]>(
    async (id, archived) => {
      await send(`/api/crm/companies/${encodeURIComponent(id)}`, "PATCH", { archived });
    },
    [],
  );
  const createDeal = useCallback<CrmActions["createDeal"]>(
    async (input) => (await send<{ deal: CrmDeal }>("/api/crm/deals", "POST", input)).deal,
    [],
  );
  const moveDeal = useCallback<CrmActions["moveDeal"]>(
    async (dealId, stageId) =>
      (await send<{ deal: CrmDeal }>(`/api/crm/deals/${encodeURIComponent(dealId)}/stage`, "POST", { stageId }))
        .deal,
    [],
  );
  const logActivity = useCallback<CrmActions["logActivity"]>(
    async (input) => (await send<{ activity: CrmActivity }>("/api/crm/activities", "POST", input)).activity,
    [],
  );
  const linkContactToCompany = useCallback<CrmActions["linkContactToCompany"]>(
    async (companyId, contactId) => {
      await send(`/api/crm/companies/${encodeURIComponent(companyId)}/contacts`, "POST", { contactId });
    },
    [],
  );

  return useMemo(
    () => ({ createCompany, archiveCompany, createDeal, moveDeal, logActivity, linkContactToCompany }),
    [createCompany, archiveCompany, createDeal, moveDeal, logActivity, linkContactToCompany],
  );
}
