// Test-only builders for the Support surface's wire shapes. Nothing in
// production imports this file.

import type {
  CommentEntry,
  ContactCandidate,
  Desk,
  DeskState,
  Ticket,
  TicketSummary,
} from "./types";

const state = (id: string, name: string, group: DeskState["group"], slaClock: DeskState["slaClock"], sortOrder: number, isDefault = false): DeskState => ({
  id,
  name,
  group,
  slaClock,
  color: "#6366f1",
  sortOrder,
  isDefault,
});

export const STATES: DeskState[] = [
  state("st-new", "New", "unstarted", "RUNNING", 0, true),
  state("st-open", "Open", "started", "RUNNING", 1),
  state("st-pending", "Pending", "started", "PAUSED", 2),
  state("st-hold", "On hold", "started", "PAUSED", 3),
  state("st-solved", "Solved", "completed", "STOPPED", 4),
  state("st-closed", "Closed", "completed", "STOPPED", 5),
];

export function makeDesk(over: Partial<Desk> = {}): Desk {
  return {
    id: "desk-1",
    name: "Support",
    identifier: "SUP",
    description: null,
    icon: null,
    color: null,
    department: null,
    archived: false,
    states: STATES,
    labels: [
      { id: "lb-q", name: "Question", color: null, isType: true },
      { id: "lb-i", name: "Incident", color: null, isType: true },
    ],
    channels: [],
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...over,
  };
}

export function makeSummary(over: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: "t-1",
    key: "SUP-1",
    deskId: "desk-1",
    deskName: "Support",
    subject: "Printer jams on page two",
    status: STATES[0]!,
    priority: "none",
    assignees: [],
    requester: { kind: "CONTACT", id: "c-1", name: "Dana Reyes", email: "dana@example.test", gone: false },
    channel: "INTERNAL",
    labels: [],
    department: null,
    slaStatus: "NONE",
    firstRespondedAt: null,
    solvedAt: null,
    reopenCount: 0,
    lastPublicActivityAt: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:30:00.000Z",
    ...over,
  };
}

export function makeTicket(over: Partial<Ticket> = {}): Ticket {
  const base = makeSummary();
  return {
    ...base,
    descriptionHtml: "<p>It keeps jamming.</p>",
    createdBy: { id: "u-1", displayName: "Ada" },
    requesterCard: { ...base.requester, organization: "Acme", phone: "555 0100", company: { id: "co-1", name: "Acme" } },
    linkedItems: [],
    ...over,
  };
}

export const comment = (over: Partial<CommentEntry> = {}): CommentEntry => ({
  type: "comment",
  id: "cm-1",
  visibility: "PUBLIC",
  authorKind: "USER",
  author: { id: "u-1", displayName: "Ada" },
  html: "<p>We are on it.</p>",
  deliveryStatus: "NONE",
  deliveryFailure: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

export const candidate = (over: Partial<ContactCandidate> = {}): ContactCandidate => ({
  id: "c-1",
  name: "Dana Reyes",
  email: "dana@example.test",
  organization: "Acme",
  via: "yours",
  ...over,
});
