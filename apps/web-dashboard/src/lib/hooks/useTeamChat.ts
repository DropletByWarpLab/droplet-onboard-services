"use client";

/**
 * WARP-1683 — SWR hooks for the Messages surface (/messages) + the nav's
 * unread badge.
 *
 * Polling for v1 (no ws-bridge wiring): the ACTIVE thread refreshes every
 * ~5s, the thread list + unread badge every ~20s, and everything
 * revalidates on window focus (SWR default). Keys are plain API paths so a
 * mutate() after a send/read touches exactly the affected fetches.
 *
 * The unread hook is fail-quiet: while the module is off (the orchestrator
 * 404s behind the module gate) or the probe errors, the badge reads 0 —
 * a badge must never invent attention from an error state.
 */
import useSWR from "swr";
import {
  fetchTeamChatContacts,
  fetchTeamChatMessages,
  fetchTeamChatThreads,
  fetchTeamChatUnreadCount,
  type TeamChatContact,
  type TeamChatMessage,
  type TeamChatThreadSummary,
} from "../api";

export const TEAM_CHAT_THREADS_KEY = "/api/team-chat/threads";
export const TEAM_CHAT_UNREAD_KEY = "/api/team-chat/unread-count";
export const teamChatMessagesKey = (threadId: string) =>
  `/api/team-chat/threads/${threadId}/messages`;

const THREAD_LIST_POLL_MS = 20_000;
const ACTIVE_THREAD_POLL_MS = 5_000;

export function useTeamChatThreads() {
  const { data, error, isLoading, mutate } = useSWR<TeamChatThreadSummary[]>(
    TEAM_CHAT_THREADS_KEY,
    fetchTeamChatThreads,
    { refreshInterval: THREAD_LIST_POLL_MS },
  );
  return { threads: data, error, isLoading, mutate };
}

export function useTeamChatMessages(threadId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<{
    messages: TeamChatMessage[];
    nextCursor: string | null;
  }>(
    threadId ? teamChatMessagesKey(threadId) : null,
    () => fetchTeamChatMessages(threadId as string),
    { refreshInterval: ACTIVE_THREAD_POLL_MS },
  );
  return {
    messages: data?.messages,
    nextCursor: data?.nextCursor ?? null,
    error,
    isLoading,
    mutate,
  };
}

export function useTeamChatContacts() {
  const { data, error, isLoading } = useSWR<TeamChatContact[]>(
    "/api/team-chat/contacts",
    fetchTeamChatContacts,
    // The roster changes on People admin actions only — focus revalidation
    // (SWR default) is enough; no interval.
    { shouldRetryOnError: false },
  );
  return { contacts: data, error, isLoading };
}

/** Total unread across threads — the sidebar badge. 0 while unresolved. */
export function useTeamChatUnread(): number {
  const { data } = useSWR<number>(TEAM_CHAT_UNREAD_KEY, fetchTeamChatUnreadCount, {
    refreshInterval: THREAD_LIST_POLL_MS,
    shouldRetryOnError: false,
  });
  return data ?? 0;
}
