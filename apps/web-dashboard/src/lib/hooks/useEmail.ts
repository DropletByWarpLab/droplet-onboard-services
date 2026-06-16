"use client";

import useSWR from "swr";
import {
  fetchEmailAccounts,
  fetchEmailThreads,
  fetchEmailThread,
  fetchThreadAnalysis,
} from "../api";
import type {
  EmailAccount,
  EmailFilter,
  ThreadSummary,
  ThreadDetail,
  ThreadAnalysis,
} from "../types-email";

/**
 * WARP-837 — SWR hooks for the Email surface.
 *
 * Each wraps a typed api.ts fetcher and surfaces `{ …, error, isLoading }`.
 * The thread/analysis hooks use a CONDITIONAL key: SWR skips the fetch entirely
 * while the required id is missing (null key), which is exactly the "no thread
 * selected" placeholder state — no wasted request, no fabricated data.
 */

/** Connected mailboxes. Polls modestly — IMAP status drifts (idle ↔ reconnecting). */
export function useEmailAccounts() {
  const { data, error, isLoading, mutate } = useSWR<EmailAccount[]>(
    "/api/email/accounts",
    fetchEmailAccounts,
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
    },
  );
  return {
    accounts: data ?? [],
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}

/**
 * Threads for an account in a given filter. The key includes both the account
 * and the filter, so flipping a filter chip is a natural re-fetch. Null account
 * ⇒ no fetch (the empty / no-account state).
 */
export function useEmailThreads(
  accountId: string | null,
  filter: EmailFilter,
) {
  const { data, error, isLoading, mutate } = useSWR<ThreadSummary[]>(
    accountId ? (["email-threads", accountId, filter] as const) : null,
    () => fetchEmailThreads(accountId as string, filter),
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  );
  return {
    threads: data ?? [],
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}

/** Full thread + messages. Null thread ⇒ no fetch (neutral placeholder pane). */
export function useEmailThread(
  accountId: string | null,
  threadId: string | null,
) {
  const { data, error, isLoading, mutate } = useSWR<ThreadDetail>(
    accountId && threadId
      ? (["email-thread", accountId, threadId] as const)
      : null,
    () => fetchEmailThread(accountId as string, threadId as string),
    { revalidateOnFocus: false },
  );
  return {
    thread: data,
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}

/**
 * The AI side-panel analysis for a thread. Null thread ⇒ no fetch. The route
 * can answer 503 while the analysis service spins up; SWR retries on its own,
 * and we expose `error` so the panel can offer a manual retry too.
 */
export function useThreadAnalysis(
  accountId: string | null,
  threadId: string | null,
) {
  const { data, error, isLoading, mutate } = useSWR<ThreadAnalysis>(
    accountId && threadId
      ? (["email-analysis", accountId, threadId] as const)
      : null,
    () => fetchThreadAnalysis(accountId as string, threadId as string),
    { revalidateOnFocus: false },
  );
  return {
    analysis: data,
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}
