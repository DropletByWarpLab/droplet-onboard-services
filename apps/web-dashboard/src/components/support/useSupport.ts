"use client";

// Data layer for the Support (service desk) surface: SWR reads + mutation
// helpers against the orchestrator /api/support/* API. Mirrors usePm.ts: one
// hook per read, polling refresh, and a request error that carries the wire
// `error` code so `translateError(e, "support")` never renders snake_case.

import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { useCallback, useMemo } from "react";
import { authFetch } from "@/lib/auth";
import type {
  Conversation,
  CommentEntry,
  ContactCandidate,
  CreateContactInput,
  CreateDeskInput,
  CreateTicketInput,
  Desk,
  DeskEmailAccount,
  DeskEmailChannelSettings,
  Escalation,
  QueueCounts,
  SupportPerson,
  SupportQueue,
  Ticket,
  TicketList,
  TicketSummary,
  UpdateDeskInput,
  UpdateTicketInput,
} from "./types";

/** Thrown by {@link getJson} / {@link send} on a non-2xx response. `status`
 *  separates an auth failure from a server fault; `code` is the orchestrator's
 *  stable `error` string; `body` keeps any extra fields (a 409
 *  `contact_email_exists` names the existing `contactId`). A network failure
 *  rejects inside `fetch` before we get here, so a missing `status` is itself
 *  the "couldn't reach the appliance" signal. */
export class SupportRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = "SupportRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function failure(res: Response): Promise<SupportRequestError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof body.error === "string" ? body.error : undefined;
  return new SupportRequestError(code ?? `Request failed (${res.status})`, res.status, code, body);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return res.json().catch(() => ({})) as Promise<T>;
}

const API = "/api/support";

// ── Reads ───────────────────────────────────────────────────────────────────

export function useDesks(includeArchived = false) {
  const { data, error, isLoading, mutate } = useSWR(
    `${API}/desks${includeArchived ? "?archived=1" : ""}`,
    (u: string) => getJson<{ desks: Desk[] }>(u),
    { refreshInterval: 60_000 },
  );
  return { desks: data?.desks, error, isLoading, mutate };
}

/** The members a ticket can be assigned to. Fails soft: an empty picker, never
 *  an errored page. */
export function useAgents() {
  const { data } = useSWR(`${API}/agents`, (u: string) => getJson<{ agents: SupportPerson[] }>(u), {
    dedupingInterval: 60_000,
    revalidateOnFocus: false,
  });
  return { agents: data?.agents };
}

export function useQueueCounts(deskId: string | null) {
  const url = `${API}/queues${deskId ? `?deskId=${encodeURIComponent(deskId)}` : ""}`;
  const { data, mutate } = useSWR(url, (u: string) => getJson<{ queues: QueueCounts }>(u), {
    refreshInterval: 20_000,
  });
  return { counts: data?.queues, mutate };
}

const PAGE_SIZE = 50;

function listUrl(
  base: { deskId: string | null; queue: SupportQueue; q: string },
  cursor: string | null,
): string {
  const p = new URLSearchParams();
  if (base.deskId) p.set("deskId", base.deskId);
  p.set("queue", base.queue);
  if (base.q.trim()) p.set("q", base.q.trim());
  p.set("limit", String(PAGE_SIZE));
  if (cursor) p.set("cursor", cursor);
  return `${API}/tickets?${p.toString()}`;
}

/** The ticket list for one queue, loaded page by page. `total` is the server's
 *  exact count of the filter, so "showing N of M" is never read off a page. */
export function useTicketList(base: { deskId: string | null; queue: SupportQueue; q: string }) {
  const { deskId, queue, q } = base;
  const getKey = useCallback(
    (pageIndex: number, previous: TicketList | null) => {
      if (pageIndex === 0) return listUrl({ deskId, queue, q }, null);
      if (!previous || previous.nextCursor === null) return null;
      return listUrl({ deskId, queue, q }, previous.nextCursor);
    },
    [deskId, queue, q],
  );
  const { data, error, isLoading, isValidating, size, setSize, mutate } = useSWRInfinite<TicketList>(
    getKey,
    (u: string) => getJson<TicketList>(u),
    { refreshInterval: 20_000, revalidateFirstPage: true, revalidateOnFocus: false },
  );
  const tickets: TicketSummary[] = useMemo(() => (data ?? []).flatMap((p) => p.tickets), [data]);
  const total = data?.[0]?.total ?? 0;
  const lastPage = data?.[data.length - 1];
  const hasMore = Boolean(lastPage && lastPage.nextCursor !== null);
  const isLoadingMore =
    isValidating && size > 0 && Boolean(data && typeof data[size - 1] === "undefined");
  const loadMore = useCallback(() => {
    if (hasMore && !isLoadingMore) setSize((s) => s + 1);
  }, [hasMore, isLoadingMore, setSize]);
  return { tickets, total, error, isLoading, isLoadingMore, hasMore, loadMore, mutate };
}

/** One ticket, by work item id or by key (`SUP-12`). */
export function useTicket(ref: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    ref ? `${API}/tickets/${encodeURIComponent(ref)}` : null,
    (u: string) => getJson<{ ticket: Ticket }>(u),
    { refreshInterval: 15_000 },
  );
  return { ticket: data?.ticket, error, isLoading, mutate };
}

export function useConversation(ticketId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    ticketId ? `${API}/tickets/${ticketId}/conversation` : null,
    (u: string) => getJson<Conversation>(u),
    { refreshInterval: 15_000 },
  );
  return { conversation: data, error, isLoading, mutate };
}

/** Other tickets from the same customer contact. Fails soft: the card renders
 *  without the list. */
export function useRequesterTickets(contactId: string | null) {
  const { data } = useSWR(
    contactId ? `${API}/requesters/${encodeURIComponent(contactId)}/tickets?limit=6` : null,
    (u: string) => getJson<TicketList>(u),
  );
  return { tickets: data?.tickets, total: data?.total ?? 0 };
}

/** Requester picker search. The key is null under two characters: the server
 *  answers an empty list there, so the request would be a wasted round trip. */
export function useContactSearch(q: string) {
  const term = q.trim();
  const { data, isLoading } = useSWR(
    term.length >= 2 ? `${API}/contacts?q=${encodeURIComponent(term)}` : null,
    (u: string) => getJson<{ contacts: ContactCandidate[] }>(u),
    { keepPreviousData: true },
  );
  return { contacts: data?.contacts ?? [], isLoading };
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** Revalidate everything the surface has cached — lists, counts, tickets,
 *  conversations. Matches on the URL substring so the infinite list's internal
 *  `$inf$` keys are caught as well. */
export function useRevalidateSupport() {
  const { mutate } = useSWRConfig();
  return useCallback(
    () =>
      mutate((key) => typeof key === "string" && key.includes("/api/support/"), undefined, {
        revalidate: true,
      }),
    [mutate],
  );
}

export function supportActions() {
  return {
    createDesk: (body: CreateDeskInput) => send<{ desk: Desk }>(`${API}/desks`, "POST", body),
    updateDesk: (id: string, body: UpdateDeskInput) =>
      send<{ desk: Desk }>(`${API}/desks/${id}`, "PATCH", body),
    createTicket: (body: CreateTicketInput) =>
      send<{ ticket: Ticket }>(`${API}/tickets`, "POST", body),
    updateTicket: (id: string, body: UpdateTicketInput) =>
      send<{ ticket: Ticket }>(`${API}/tickets/${id}`, "PATCH", body),
    sendReply: (id: string, bodyHtml: string, stateId?: string) =>
      send<{ entry: CommentEntry; ticket: Ticket }>(`${API}/tickets/${id}/replies`, "POST", {
        bodyHtml,
        ...(stateId ? { stateId } : {}),
      }),
    addNote: (id: string, bodyHtml: string, stateId?: string) =>
      send<{ entry: CommentEntry; ticket: Ticket }>(`${API}/tickets/${id}/notes`, "POST", {
        bodyHtml,
        ...(stateId ? { stateId } : {}),
      }),
    escalate: (id: string, body: { projectId: string; title?: string }) =>
      send<Escalation>(`${API}/tickets/${id}/escalate`, "POST", body),
    createContact: (body: CreateContactInput) =>
      send<{ contact: ContactCandidate }>(`${API}/contacts`, "POST", body),
    listEmailAccounts: () => getJson<{ accounts: DeskEmailAccount[] }>(`${API}/email/accounts`),
    getEmailChannel: (deskId: string) => getJson<{ channel: DeskEmailChannelSettings | null }>(`${API}/desks/${deskId}/email-channel`),
    saveEmailChannel: (deskId: string, body: { emailAccountId: string | null; contactOwnerUserId?: string; enabled?: boolean; autoAckEnabled?: boolean; autoAckTemplate?: string; reopenWindowDays?: number }) =>
      send<{ channel: DeskEmailChannelSettings | null }>(`${API}/desks/${deskId}/email-channel`, "PUT", body),
    retryReply: (ticketId: string, commentId: string) =>
      send<{ status: "queued" }>(`${API}/tickets/${ticketId}/replies/${commentId}/retry`, "POST"),
  };
}
