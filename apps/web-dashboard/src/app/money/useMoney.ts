// Data layer for /money (WARP-2581): SWR reads against /api/money. Same shape
// and the same error-class contract as `useCrm.ts`, so two Business surfaces
// behave identically under failure.

import useSWR from "swr";

import { authFetch } from "@/lib/auth";

/**
 * WARP-2739 — which way the money runs. This is what the filter tabs pick and
 * what `?kind=` on the wire has always meant; the server derives it from the
 * document's kind and sends it on every row, so nothing here re-derives it.
 */
export type MoneyDirection = "RECEIVABLE" | "PAYABLE";

/** What a document IS. Six values since WARP-2739; `/money` only ever shows
 *  the four that are money owed. */
export type MoneyDocumentKind = "INVOICE" | "BILL" | "CREDIT_NOTE" | "RECEIPT";

export interface MoneyLedgerTotal {
  /** Null for the box's own documents: they are one book with no connection. */
  connectionId: string | null;
  provider: string | null;
  /** null means "this ledger's own currency", which the box does not know. */
  currency: string | null;
  /** Sum of BALANCES — what is unpaid, not what was invoiced. */
  balance: string;
  documentCount: number;
  overdueCount: number;
  overdueBalance: string;
}

export interface MoneySide {
  documentCount: number;
  overdueCount: number;
  /** Per ledger and per currency. There is deliberately no cross-ledger sum. */
  ledgers: MoneyLedgerTotal[];
}

export interface MoneySummary {
  receivable: MoneySide;
  payable: MoneySide;
  lastReadAt: string | null;
  oldestReadAt: string | null;
}

export interface MoneyDocument {
  id: string;
  kind: MoneyDocumentKind;
  direction: MoneyDirection;
  /** LANDED rows are the vendor's copy; LOCAL ones this box wrote. */
  origin: "LANDED" | "LOCAL";
  /** Null on a local document — no vendor has ever seen it. */
  externalId: string | null;
  externalSystem: string | null;
  connectionId: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  counterparty: { externalId: string | null; name: string | null; companyId: string | null };
  amount: string | null;
  balance: string | null;
  currency: string | null;
  /** The vendor's own word, on a landed row. */
  vendorStatus: string | null;
  /** The box's own lifecycle, on a local row. */
  status: string | null;
  isOverdue: boolean;
  vendorUpdatedAt: string | null;
  lastReadAt: string;
}

/** Carries the HTTP status, because 403 and 404 are different pages here: a
 *  refusal is a locked state, and a module that is off renders as ABSENT. */
export class MoneyRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MoneyRequestError";
    this.status = status;
  }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new MoneyRequestError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export function useMoneySummary(): {
  summary: MoneySummary | undefined;
  error: MoneyRequestError | undefined;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<MoneySummary, MoneyRequestError>(
    "/api/money",
    getJson,
    // Landed data. It changes when the scheduler ticks, not when the page is
    // looked at, and this surface must not imply otherwise.
    { refreshInterval: 300_000, shouldRetryOnError: false },
  );
  return { summary: data, error, isLoading };
}

export function useMoneyDocuments(kind: MoneyDirection | "ALL"): {
  documents: MoneyDocument[] | undefined;
  error: MoneyRequestError | undefined;
  isLoading: boolean;
} {
  const query = kind === "ALL" ? "" : `?kind=${kind === "RECEIVABLE" ? "receivable" : "payable"}`;
  const { data, error, isLoading } = useSWR<{ documents: MoneyDocument[] }, MoneyRequestError>(
    `/api/money/documents${query}`,
    getJson,
    { refreshInterval: 300_000, shouldRetryOnError: false },
  );
  return { documents: data?.documents, error, isLoading };
}
