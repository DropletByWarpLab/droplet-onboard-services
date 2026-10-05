"use client";

import useSWR from "swr";
import { authFetch } from "@/lib/auth";
import { SupportRequestError } from "./useSupport";
import type { Ticket, TicketPriority } from "./types";

export interface BusinessCalendar {
  id: string; name: string; timezone: string;
  windows: Array<{ day: number; start: string; end: string }>;
  holidays: string[];
}
export type SlaMetric = "firstResponse" | "nextResponse" | "resolution";
export type EscalationAction = { type: "raise_priority" } | { type: "reassign"; userId: string } | { type: "notify"; userIds: string[] };
export interface SlaPolicy {
  enabled: boolean; calendarId: string | null; atRiskPercent: number;
  targets: Partial<Record<TicketPriority, Partial<Record<`${SlaMetric}Mins`, number>>>>;
  escalation: Array<{ on: "AT_RISK" | "BREACHED"; metric: SlaMetric | "any"; actions: EscalationAction[] }>;
}
export interface DeskSla {
  canManage?: boolean;
  policy: SlaPolicy | null;
  assignment: { mode: "MANUAL" | "ROUND_ROBIN" | "LEAST_OPEN"; departmentId: string | null; memberIds: string[] };
}
export interface Macro {
  id: string; projectId: string | null; ownerId: string; name: string; bodyHtml: string;
  visibility: "PERSONAL" | "SHARED";
  actions: { stateId?: string; priority?: TicketPriority; assignee?: "me" | "none" | { userId: string }; addLabelIds?: string[]; removeLabelIds?: string[] };
}
export interface SlaReport {
  statusCounts: Record<string, number>; total: number; met: number; breached: number; attainmentPercent: number | null;
}
export interface MacroPreview { name: string; bodyHtml: string; changes: string[] }

export async function slaRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await authFetch(`/api/support${url}`, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new SupportRequestError(details.error ?? `Request failed (${response.status})`, response.status, details.error, details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const part = encodeURIComponent;
export function useDeskSla(deskId: string) {
  return useSWR(`/desks/${part(deskId)}/sla`, (url) => slaRequest<DeskSla>(url));
}
export function useBusinessCalendars() {
  return useSWR("/calendars", (url) => slaRequest<{ calendars: BusinessCalendar[]; canManage?: boolean }>(url));
}
export function useMacros(deskId: string) {
  return useSWR(`/macros?deskId=${part(deskId)}`, (url) => slaRequest<{ macros: Macro[]; canManageShared?: boolean }>(url));
}
export const slaActions = {
  saveDesk: (id: string, value: Pick<DeskSla, "policy" | "assignment">) => slaRequest<DeskSla>(`/desks/${part(id)}/sla`, "PUT", value),
  saveCalendar: (id: string | null, value: Omit<BusinessCalendar, "id">) => slaRequest<{ calendar: BusinessCalendar }>(`/calendars${id ? `/${part(id)}` : ""}`, id ? "PUT" : "POST", value),
  deleteCalendar: (id: string) => slaRequest<void>(`/calendars/${part(id)}`, "DELETE"),
  report: (id: string, from: string, to: string) => slaRequest<SlaReport>(`/desks/${part(id)}/sla/report?${new URLSearchParams({ from, to })}`),
  saveMacro: (id: string | null, value: Omit<Macro, "id" | "ownerId">) => slaRequest<{ macro: Macro }>(`/macros${id ? `/${part(id)}` : ""}`, id ? "PUT" : "POST", value),
  deleteMacro: (id: string) => slaRequest<void>(`/macros/${part(id)}`, "DELETE"),
  previewMacro: (ticketId: string, macroId: string) => slaRequest<MacroPreview>(`/tickets/${part(ticketId)}/macros/${part(macroId)}/preview`, "POST"),
  applyMacro: (ticketId: string, macroId: string) => slaRequest<{ ticket: Ticket; bodyHtml: string }>(`/tickets/${part(ticketId)}/macros/${part(macroId)}/apply`, "POST"),
};

/** Parsed in a detached document; no untrusted nodes are attached to the page. */
export function macroDraftText(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const node of document.querySelectorAll("script,style,iframe,object,embed")) node.remove();
  for (const node of document.querySelectorAll("br")) node.replaceWith(document.createTextNode("\n"));
  for (const node of document.querySelectorAll("p,div,li,h1,h2,h3,blockquote,pre")) node.append(document.createTextNode("\n"));
  return (document.body.textContent ?? "").trim();
}
