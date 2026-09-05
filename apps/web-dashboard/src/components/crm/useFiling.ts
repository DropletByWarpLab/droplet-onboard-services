// Data layer for the filing review surface (WARP-2730, ADR-048): SWR reads +
// decision helpers against /api/crm/filing/*. Same shape as `useCrm.ts` — same
// error class, same mutate-after-write discipline — so the two CRM surfaces
// behave identically under failure.

import useSWR from "swr";
import { useCallback } from "react";

import { authFetch } from "@/lib/auth";
import { CrmRequestError } from "./useCrm";

/** Kinds the review card knows how to render. Mirrors `IngestProposalKind`. */
export type FilingKind =
  | "LINK_FILE"
  | "LOG_EMAIL_ACTIVITY"
  | "SET_PROJECT_CUSTOMER"
  | "CREATE_CUSTOMER"
  | "CREATE_PROJECT"
  | "CREATE_CONTACT"
  | "MATCH_REVIEW"
  | "CREATE_MONEY_DOC";

export interface FilingFileRef {
  ncFileId: number;
  filePath: string;
  fileSpace: string;
}

/** The payload union, as the wire sends it. Loose on purpose: the server has
 *  already parsed it through the authoritative `.strict()` allow-list and set
 *  `readable`, so re-declaring every field here would be a second contract to
 *  keep in step for no gain. */
export interface FilingPayload {
  name?: string;
  domain?: string;
  phone?: string;
  address?: string;
  companyId?: string;
  companyName?: string;
  displayName?: string;
  email?: string;
  organization?: string;
  roleTitle?: string;
  summary?: string;
  extractedName?: string;
  candidates?: { companyId: string; name: string }[];
  kind?: string;
  number?: string;
  currency?: string;
  /** A STRING. Money is a string at every boundary — `Number()` rounds above
   *  2^53 and the column is NUMERIC(20,6). Never parse this to render it. */
  total?: string;
  direction?: string;
  counterpartyName?: string;
  file?: FilingFileRef;
}

export interface FilingProposal {
  id: string;
  kind: FilingKind;
  status: string;
  policyClass: "AUTO" | "REVIEW" | "NEVER";
  policyReason: string | null;
  confidence: number;
  phiVerdict: "CLEAN" | "MENTIONS" | "RECORD";
  matchKind: "EMAIL" | "DOMAIN" | "NAME" | "NONE";
  sourceKind: "FILE" | "EMAIL";
  ncFileId: number | null;
  createdAt: string;
  decidedAt: string | null;
  readable: boolean;
  payload: FilingPayload | null;
  evidence: { quote: string; chunkIdx?: number }[];
}

export interface FilingSummary {
  mode: "off" | "propose" | "auto";
  level: "links_only" | "also_create";
  vertical: "general" | "healthcare";
  enabled: boolean;
  pending: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CrmRequestError(
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
    throw new CrmRequestError(
      data.error ?? `Request failed (${res.status})`,
      res.status,
      data.error,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * The banner count.
 *
 * A 403 here is the ordinary answer for a `family` member, not a fault: this
 * surface is owner/admin only because a card carries quotes from a stored
 * document. `shouldRetryOnError: false` so the banner simply does not appear
 * for them, rather than retrying a refusal every few seconds.
 */
export function useFilingSummary(): {
  summary: FilingSummary | undefined;
  error: unknown;
  mutate: () => Promise<unknown>;
} {
  const { data, error, mutate } = useSWR<FilingSummary>(
    "/api/crm/filing/summary",
    getJson,
    { shouldRetryOnError: false, refreshInterval: 60_000 },
  );
  return { summary: data, error, mutate };
}

export function useFilingProposals(status: "pending" | "decided"): {
  proposals: FilingProposal[] | undefined;
  error: unknown;
  isLoading: boolean;
  mutate: () => Promise<unknown>;
} {
  const { data, error, isLoading, mutate } = useSWR<{ proposals: FilingProposal[] }>(
    `/api/crm/filing/proposals?status=${status}`,
    getJson,
    { shouldRetryOnError: false },
  );
  return { proposals: data?.proposals, error, isLoading, mutate };
}

export interface FilingActions {
  apply: (id: string, chooseCompanyId?: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  notSame: (id: string, companyId: string) => Promise<void>;
  setMode: (mode: FilingSummary["mode"], extra?: Partial<FilingSummary>) => Promise<void>;
}

export function useFilingActions(): FilingActions {
  const apply = useCallback(async (id: string, chooseCompanyId?: string) => {
    await send(
      `/api/crm/filing/proposals/${encodeURIComponent(id)}/apply`,
      "POST",
      chooseCompanyId ? { chooseCompanyId } : {},
    );
  }, []);

  const reject = useCallback(async (id: string) => {
    await send(`/api/crm/filing/proposals/${encodeURIComponent(id)}/reject`, "POST");
  }, []);

  const notSame = useCallback(async (id: string, companyId: string) => {
    await send(`/api/crm/filing/proposals/${encodeURIComponent(id)}/not-same`, "POST", {
      companyId,
    });
  }, []);

  const setMode = useCallback(
    async (mode: FilingSummary["mode"], extra?: Partial<FilingSummary>) => {
      await send("/api/crm/filing/settings", "PATCH", {
        mode,
        ...(extra?.level ? { level: extra.level } : {}),
        ...(extra?.vertical ? { vertical: extra.vertical } : {}),
      });
    },
    [],
  );

  return { apply, reject, notSame, setMode };
}
