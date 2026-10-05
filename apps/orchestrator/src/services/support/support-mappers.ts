/**
 * Service desk (ADR-069) — row shapes, batched lookups and the mappers that turn
 * them into the wire contract (`support.types.ts`).
 *
 * Names are resolved HERE, server-side, in one batch per page: a ticket list of
 * fifty rows costs one query for the page plus one each for people, contacts —
 * never one per row (WARP-3372: the dashboard must not render `User 1a2b`).
 */
import type { Prisma } from "@prisma/client";
import type { Db } from "../pm/pm.service.js";
import {
  DEPARTMENT_SELECT,
  resolveDepartmentRef,
} from "../pm/pm-department.js";
import {
  TICKET_TYPE_LABELS,
  type ApiDesk,
  type ApiDeskLabel,
  type ApiDeskState,
  type ApiLinkedItem,
  type ApiPerson,
  type ApiRequester,
  type ApiRequesterCard,
  type ApiTicket,
  type ApiTicketSummary,
  type StateGroup,
  type SupportCtx,
} from "./support.types.js";

export const FORMER_MEMBER = "Former member";

// ── Prisma shapes ────────────────────────────────────────────────────────────

export const DESK_INCLUDE = {
  department: { select: DEPARTMENT_SELECT },
  states: { orderBy: { sortOrder: "asc" } },
  labels: { orderBy: { name: "asc" } },
} satisfies Prisma.PmProjectInclude;
export type DeskRow = Prisma.PmProjectGetPayload<{ include: typeof DESK_INCLUDE }>;

export const TICKET_INCLUDE = {
  state: true,
  assignees: true,
  labels: { include: { label: true } },
  department: { select: DEPARTMENT_SELECT },
  project: {
    select: {
      id: true,
      name: true,
      identifier: true,
      kind: true,
      department: { select: DEPARTMENT_SELECT },
    },
  },
  ticket: true,
} satisfies Prisma.PmWorkItemInclude;
export type TicketRow = Prisma.PmWorkItemGetPayload<{ include: typeof TICKET_INCLUDE }>;
type TicketOf = NonNullable<TicketRow["ticket"]>;

/** A ticket row with its PmTicket row proven present. */
export type LiveTicketRow = TicketRow & { ticket: TicketOf };
export const hasTicket = (row: TicketRow): row is LiveTicketRow => row.ticket !== null;

// ── Simple mappers ───────────────────────────────────────────────────────────

/** A desk row whose state was deleted out from under a ticket (SetNull) still
 *  has to render: say so plainly rather than inventing a status. */
const NO_STATE: ApiDeskState = {
  id: "",
  name: "No status",
  group: "backlog",
  slaClock: "RUNNING",
  color: null,
  sortOrder: 0,
  isDefault: false,
};

export function mapDeskState(row: {
  id: string;
  name: string;
  group: string;
  slaClock: string;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
}): ApiDeskState {
  return {
    id: row.id,
    name: row.name,
    group: row.group as StateGroup,
    slaClock: row.slaClock as ApiDeskState["slaClock"],
    color: row.color,
    sortOrder: row.sortOrder,
    isDefault: row.isDefault,
  };
}

const TYPE_LABELS: ReadonlySet<string> = new Set(TICKET_TYPE_LABELS);

export function mapDeskLabel(row: { id: string; name: string; color: string | null }): ApiDeskLabel {
  return { id: row.id, name: row.name, color: row.color, isType: TYPE_LABELS.has(row.name) };
}

export function mapDesk(row: DeskRow): ApiDesk {
  return {
    id: row.id,
    name: row.name,
    identifier: row.identifier,
    description: row.description,
    icon: row.icon,
    color: row.color,
    department: resolveDepartmentRef(null, row.department),
    archived: row.isArchived,
    states: row.states.map(mapDeskState),
    labels: row.labels.map(mapDeskLabel),
    channels: [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const ticketKey = (row: { sequenceId: number; project: { identifier: string } }): string =>
  `${row.project.identifier}-${row.sequenceId}`;

// ── Batched lookups ──────────────────────────────────────────────────────────

/** id -> display name for every user id given. Absent ids are simply missing. */
export async function loadPeople(db: Db, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true },
  });
  return new Map(rows.map((u) => [u.id, u.displayName] as const));
}

export const personOf = (people: ReadonlyMap<string, string>, id: string): ApiPerson => ({
  id,
  displayName: people.get(id) ?? FORMER_MEMBER,
});

export interface LiveContact {
  name: string;
  email: string | null;
  organization: string | null;
  phone: string | null;
}

/** id -> the live contact, with its primary email and phone. */
export async function loadContacts(db: Db, ids: Iterable<string>): Promise<Map<string, LiveContact>> {
  const unique = [...new Set([...ids].filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await db.contact.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      displayName: true,
      organization: true,
      emails: { select: { address: true }, orderBy: [{ isPrimary: "desc" }, { address: "asc" }], take: 1 },
      phones: { select: { number: true }, orderBy: [{ isPrimary: "desc" }, { number: "asc" }], take: 1 },
    },
  });
  return new Map(
    rows.map((c) => [
      c.id,
      {
        name: c.displayName,
        email: c.emails[0]?.address ?? null,
        organization: c.organization,
        phone: c.phones[0]?.number ?? null,
      },
    ]),
  );
}

export interface Lookups {
  people: ReadonlyMap<string, string>;
  contacts: ReadonlyMap<string, LiveContact>;
}

export async function lookupsFor(db: Db, rows: readonly LiveTicketRow[]): Promise<Lookups> {
  const userIds: string[] = [];
  const contactIds: string[] = [];
  for (const r of rows) {
    for (const a of r.assignees) userIds.push(a.userId);
    if (r.createdById) userIds.push(r.createdById);
    if (r.ticket.requesterUserId) userIds.push(r.ticket.requesterUserId);
    if (r.ticket.requesterContactId) contactIds.push(r.ticket.requesterContactId);
  }
  const [people, contacts] = await Promise.all([loadPeople(db, userIds), loadContacts(db, contactIds)]);
  return { people, contacts };
}

// ── Ticket mappers ───────────────────────────────────────────────────────────

/** Who asked: the live Contact or User while it exists, the intake snapshot once
 *  it is gone. Never blank, never an invented person. */
export function resolveRequester(row: LiveTicketRow, lookups: Lookups): ApiRequester {
  const t = row.ticket;
  if (t.requesterKind === "CONTACT") {
    const id = t.requesterContactId ?? "";
    const live = lookups.contacts.get(id);
    return live
      ? { kind: "CONTACT", id, name: live.name, email: live.email ?? t.requesterEmail, gone: false }
      : { kind: "CONTACT", id, name: t.requesterName, email: t.requesterEmail, gone: true };
  }
  const id = t.requesterUserId ?? "";
  const live = lookups.people.get(id);
  return live !== undefined
    ? { kind: "USER", id, name: live, email: t.requesterEmail, gone: false }
    : { kind: "USER", id, name: t.requesterName, email: t.requesterEmail, gone: true };
}

export function mapTicketSummary(row: LiveTicketRow, lookups: Lookups): ApiTicketSummary {
  const t = row.ticket;
  return {
    id: row.id,
    key: ticketKey(row),
    deskId: row.projectId,
    deskName: row.project.name,
    subject: row.name,
    status: row.state ? mapDeskState(row.state) : NO_STATE,
    priority: row.priority,
    assignees: row.assignees.map((a) => personOf(lookups.people, a.userId)),
    requester: resolveRequester(row, lookups),
    channel: t.channel,
    labels: row.labels.map((l) => mapDeskLabel(l.label)),
    department: resolveDepartmentRef(row.department, row.project.department),
    slaStatus: t.slaStatus,
    firstRespondedAt: t.firstRespondedAt?.toISOString() ?? null,
    solvedAt: t.solvedAt?.toISOString() ?? null,
    reopenCount: t.reopenCount,
    lastPublicActivityAt: t.lastPublicActivityAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function mapTicketSummaries(
  db: Db,
  rows: readonly LiveTicketRow[],
): Promise<ApiTicketSummary[]> {
  const lookups = await lookupsFor(db, rows);
  return rows.map((r) => mapTicketSummary(r, lookups));
}

const LINK_END_SELECT = {
  id: true,
  name: true,
  sequenceId: true,
  project: { select: { identifier: true, name: true, kind: true } },
  state: { select: { name: true, group: true } },
} satisfies Prisma.PmWorkItemSelect;

/** The PM work items linked to a ticket (escalations). An end in another desk is
 *  not listed; an end the viewer may not read names nothing. */
async function linkedItemsFor(db: Db, ticketId: string, ctx: SupportCtx): Promise<ApiLinkedItem[]> {
  const rels = await db.pmWorkItemRelation.findMany({
    where: { OR: [{ fromId: ticketId }, { toId: ticketId }] },
    include: { from: { select: LINK_END_SELECT }, to: { select: LINK_END_SELECT } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const out: ApiLinkedItem[] = [];
  for (const rel of rels) {
    const other = rel.fromId === ticketId ? rel.to : rel.from;
    if (other.project.kind !== "PROJECT") continue;
    if (!ctx.canReadProjects) {
      out.push({
        relationId: rel.id,
        restricted: true,
        id: null,
        key: null,
        name: null,
        projectName: null,
        state: null,
      });
      continue;
    }
    out.push({
      relationId: rel.id,
      restricted: false,
      id: other.id,
      key: `${other.project.identifier}-${other.sequenceId}`,
      name: other.name,
      projectName: other.project.name,
      state: other.state ? { name: other.state.name, group: other.state.group as StateGroup } : null,
    });
  }
  return out;
}

/** The full ticket: the summary plus the request, who logged it, the requester
 *  card and the linked work items. */
export async function mapTicketDetail(
  db: Db,
  row: LiveTicketRow,
  ctx: SupportCtx,
): Promise<ApiTicket> {
  const lookups = await lookupsFor(db, [row]);
  const summary = mapTicketSummary(row, lookups);
  const live = row.ticket.requesterContactId
    ? lookups.contacts.get(row.ticket.requesterContactId)
    : undefined;
  // The customer's name is the CRM's data: shown only with that grant.
  const company = row.ticket.companyId && ctx.canReadCrm
    ? await db.crmCompany.findUnique({
        where: { id: row.ticket.companyId },
        select: { id: true, name: true },
      })
    : null;
  const requesterCard: ApiRequesterCard = {
    ...summary.requester,
    organization: live?.organization ?? null,
    phone: live?.phone ?? null,
    company,
  };
  return {
    ...summary,
    descriptionHtml: row.descriptionHtml,
    createdBy: row.createdById ? personOf(lookups.people, row.createdById) : null,
    requesterCard,
    linkedItems: await linkedItemsFor(db, row.id, ctx),
  };
}
