/**
 * Service desk (ADR-069 §1) — tickets: list, queues, read, create, update.
 *
 * A ticket is a `PmWorkItem` in a SERVICE_DESK project plus a `PmTicket` row.
 * Everything a work item already has — state, priority, assignees, labels,
 * department, activity — a ticket has for free, and every change writes the
 * same `PmActivity` rows through the same `writeActivity` choke point the PM
 * service uses, inside the transaction that made the change.
 *
 * What is NOT here: replies and notes (conversation.service.ts), escalation
 * (escalation.service.ts), and anything an email channel or an SLA clock will
 * add (WS-13 / WS-14). The service trusts its caller's role; the route owns
 * authorisation.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { PM_ERRORS, isPrismaCode, writeActivity, type Db } from "../pm/pm.service.js";
import { assertAssignableDepartment } from "../pm/pm-department.js";
import { sanitizePmHtml } from "../pm/sanitize-html.js";
import {
  TICKET_INCLUDE,
  hasTicket,
  mapTicketDetail,
  mapTicketSummaries,
  type LiveTicketRow,
} from "./support-mappers.js";
import { assertAgents, usableContact, type SupportDeps } from "./requester.service.js";
import {
  LIST_ORDER,
  afterCursor,
  clampLimit,
  decodeCursor,
  encodeCursor,
  isTerminalGroup,
  isUuid,
  listWhere,
  parseTicketKey,
  queueWhere,
  ticketBaseWhere,
} from "./ticket-query.js";
import {
  STAFF_TICKET_CHANNELS,
  SUPPORT_ERRORS,
  SUPPORT_QUEUES,
  type ApiQueueCounts,
  type ApiTicket,
  type ApiTicketList,
  type SupportCtx,
  type SupportViewer,
  type TicketCreateInput,
  type TicketListQuery,
  type TicketUpdateInput,
} from "./support.types.js";

const clock = (deps: SupportDeps): Date => (deps.now ? deps.now() : new Date());

// ── Lookups ──────────────────────────────────────────────────────────────────

/**
 * The live ticket a ref names — a work item uuid or a key like `SUP-12` — or
 * TICKET_NOT_FOUND. "Live" means in a SERVICE_DESK project, carrying its
 * PmTicket row and not archived: a PM work item can satisfy none of that, so a
 * project row is a 404 here exactly as a ticket is a 404 on the PM side. An
 * archived DESK does not hide its tickets from a read (a link must not break);
 * {@link assertDeskOpen} is what stops writes to them.
 */
export async function findTicketRow(db: Db, ref: string): Promise<LiveTicketRow> {
  let where: Prisma.PmWorkItemWhereInput;
  if (isUuid(ref)) {
    where = { id: ref };
  } else {
    const key = parseTicketKey(ref);
    if (!key) throw new Error(SUPPORT_ERRORS.TICKET_NOT_FOUND);
    where = { sequenceId: key.sequenceId, project: { identifier: key.identifier } };
  }
  const row = await db.pmWorkItem.findFirst({
    where: { AND: [where, { isArchived: false, project: { kind: "SERVICE_DESK" } }] },
    include: TICKET_INCLUDE,
  });
  if (!row || !hasTicket(row)) throw new Error(SUPPORT_ERRORS.TICKET_NOT_FOUND);
  return row;
}

export async function getTicket(
  prisma: PrismaClient,
  ref: string,
  ctx: SupportCtx,
): Promise<ApiTicket> {
  return mapTicketDetail(prisma, await findTicketRow(prisma, ref), ctx);
}

/** Writes to a ticket in an archived desk are refused — the desk is closed. */
export async function assertDeskOpen(db: Db, deskId: string): Promise<void> {
  const desk = await db.pmProject.findUnique({ where: { id: deskId }, select: { isArchived: true } });
  if (!desk) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
  if (desk.isArchived) throw new Error(SUPPORT_ERRORS.DESK_ARCHIVED);
}

// ── Lists ────────────────────────────────────────────────────────────────────

async function pageTickets(
  prisma: PrismaClient,
  where: Prisma.PmWorkItemWhereInput,
  limitInput: number | undefined,
  cursorInput: string | undefined,
): Promise<ApiTicketList> {
  const limit = clampLimit(limitInput);
  const cursor = cursorInput ? decodeCursor(cursorInput) : null;
  // The count never carries the cursor: `total` is the filter's, not the page's.
  const [rows, total] = await Promise.all([
    prisma.pmWorkItem.findMany({
      where: cursor ? { AND: [where, afterCursor(cursor)] } : where,
      include: TICKET_INCLUDE,
      orderBy: LIST_ORDER,
      take: limit + 1,
    }),
    prisma.pmWorkItem.count({ where }),
  ]);
  const page = rows.slice(0, limit).filter(hasTicket);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    tickets: await mapTicketSummaries(prisma, page),
    total,
    nextCursor: last ? encodeCursor(last) : null,
  };
}

async function assertDeskExists(prisma: PrismaClient, deskId: string): Promise<void> {
  const desk = await prisma.pmProject.findFirst({
    where: { id: deskId, kind: "SERVICE_DESK" },
    select: { id: true },
  });
  if (!desk) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
}

export async function listTickets(
  prisma: PrismaClient,
  viewer: SupportViewer,
  query: TicketListQuery,
  deps: SupportDeps = {},
): Promise<ApiTicketList> {
  if (query.deskId) await assertDeskExists(prisma, query.deskId);
  return pageTickets(prisma, listWhere(query, viewer.id, clock(deps)), query.limit, query.cursor);
}

export async function queueCounts(
  prisma: PrismaClient,
  viewer: SupportViewer,
  opts: { deskId?: string } = {},
  deps: SupportDeps = {},
): Promise<ApiQueueCounts> {
  if (opts.deskId) await assertDeskExists(prisma, opts.deskId);
  const now = clock(deps);
  const base = ticketBaseWhere(opts.deskId);
  const counts = await Promise.all(
    SUPPORT_QUEUES.map((q) =>
      prisma.pmWorkItem.count({ where: { AND: [base, queueWhere(q, viewer.id, now)] } }),
    ),
  );
  return Object.fromEntries(SUPPORT_QUEUES.map((q, i) => [q, counts[i]!])) as ApiQueueCounts;
}

/** Every ticket a customer contact has raised, newest activity first. */
export async function listRequesterTickets(
  prisma: PrismaClient,
  contactId: string,
  query: { limit?: number; cursor?: string } = {},
): Promise<ApiTicketList> {
  const where: Prisma.PmWorkItemWhereInput = {
    AND: [
      ticketBaseWhere(),
      { ticket: { is: { requesterKind: "CONTACT", requesterContactId: contactId } } },
    ],
  };
  return pageTickets(prisma, where, query.limit, query.cursor);
}

// ── Shared write helpers ─────────────────────────────────────────────────────

type DeskWithRefs = Prisma.PmProjectGetPayload<{ include: { states: true; labels: true } }>;

/** A state of THIS desk, or STATE_NOT_FOUND (no such state) / INVALID_STATE
 *  (it belongs to another project) — the same split PM draws. */
export async function pickState(db: Db, desk: DeskWithRefs, stateId: string) {
  const own = desk.states.find((s) => s.id === stateId);
  if (own) return own;
  const other = await db.pmState.findUnique({ where: { id: stateId }, select: { id: true } });
  throw new Error(other ? SUPPORT_ERRORS.INVALID_STATE : SUPPORT_ERRORS.STATE_NOT_FOUND);
}

async function assertDeskLabels(db: Db, desk: DeskWithRefs, labelIds: readonly string[]): Promise<void> {
  const own = new Set(desk.labels.map((l) => l.id));
  const missing = labelIds.filter((id) => !own.has(id));
  if (missing.length === 0) return;
  const elsewhere = await db.pmLabel.count({ where: { id: { in: missing } } });
  throw new Error(elsewhere > 0 ? SUPPORT_ERRORS.INVALID_LABEL : SUPPORT_ERRORS.LABEL_NOT_FOUND);
}

/** A customer record is the CRM's: someone without that grant is told it does
 *  not exist, exactly as for an id that does not. */
async function assertCompany(db: Db, companyId: string, ctx: SupportCtx): Promise<void> {
  const found = ctx.canReadCrm
    ? await db.crmCompany.findUnique({ where: { id: companyId }, select: { id: true } })
    : null;
  if (!found) throw new Error(SUPPORT_ERRORS.COMPANY_NOT_FOUND);
}

/**
 * Move a ticket to `target` as a COMPARE-AND-SET on the state it was read in
 * (CLAUDE.md "No guessing"; pre-PR pattern P1): two agents moving one ticket
 * cannot both win, and the loser — nothing applied — gets a 409 to retry, so
 * `reopenCount` is incremented by exactly one writer.
 *
 * The ticket's clock columns follow the state GROUP, never its name: entering a
 * completed group stamps `solvedAt`; moving between two completed states
 * (Solved -> Closed) leaves it; leaving one is a reopen — count it and clear
 * `solvedAt`. PM's own `isCompleted` / `completedAt` signal (WARP-884) is kept
 * in step in the same statement.
 */
export async function applyStateChange(
  tx: Prisma.TransactionClient,
  existing: LiveTicketRow,
  target: { id: string; group: string },
  actorId: string | null,
  now: Date,
): Promise<void> {
  const toTerminal = isTerminalGroup(target.group);
  const cas = await tx.pmWorkItem.updateMany({
    where: { id: existing.id, stateId: existing.stateId },
    data: {
      stateId: target.id,
      isCompleted: toTerminal,
      completedAt: toTerminal ? now : null,
      updatedAt: now,
    },
  });
  if (cas.count === 0) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);

  const wasTerminal = isTerminalGroup(existing.state?.group);
  if (!wasTerminal && toTerminal) {
    await tx.pmTicket.update({ where: { workItemId: existing.id }, data: { solvedAt: now } });
  } else if (wasTerminal && !toTerminal) {
    await tx.pmTicket.update({
      where: { workItemId: existing.id },
      data: { reopenCount: { increment: 1 }, solvedAt: null },
    });
  }
  await writeActivity(tx, {
    workItemId: existing.id,
    actorId,
    verb: "state_changed",
    field: "state",
    oldValue: existing.stateId,
    newValue: target.id,
  });
}

/** Sanitised HTML, or null when nothing survives the allowlist. */
export function cleanHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const clean = sanitizePmHtml(html).trim();
  return clean.length > 0 ? clean : null;
}

// ── Create ───────────────────────────────────────────────────────────────────

interface ResolvedRequester {
  kind: "CONTACT" | "USER";
  contactId: string | null;
  userId: string | null;
  name: string;
  email: string | null;
  soleCompanyId: string | null;
}

async function resolveNewRequester(
  prisma: PrismaClient,
  viewer: SupportViewer,
  input: TicketCreateInput["requester"],
  ctx: SupportCtx,
): Promise<ResolvedRequester> {
  if (input?.kind === "CONTACT") {
    const c = await usableContact(prisma, viewer.id, input.contactId, ctx);
    return {
      kind: "CONTACT",
      contactId: input.contactId,
      userId: null,
      name: c.name,
      email: c.email,
      soleCompanyId: c.soleCompanyId,
    };
  }
  const userId = input?.userId ?? viewer.id;
  const user = await prisma.user.findFirst({
    where: { id: userId, directoryStatus: "ACTIVE" },
    select: { displayName: true },
  });
  if (!user) throw new Error(SUPPORT_ERRORS.INVALID_REQUESTER);
  // The directory email is an encrypted column; the snapshot is the name.
  return { kind: "USER", contactId: null, userId, name: user.displayName, email: null, soleCompanyId: null };
}

export async function createTicket(
  prisma: PrismaClient,
  viewer: SupportViewer,
  input: TicketCreateInput,
  ctx: SupportCtx,
  deps: SupportDeps = {},
): Promise<ApiTicket> {
  const desk = await prisma.pmProject.findFirst({
    where: { id: input.deskId, kind: "SERVICE_DESK" },
    include: { states: true, labels: true },
  });
  if (!desk) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
  if (desk.isArchived) throw new Error(SUPPORT_ERRORS.DESK_ARCHIVED);

  // A person cannot forge a channel only another path produces (email intake,
  // the assistant, an API token).
  const channel = input.channel ?? "INTERNAL";
  if (!(STAFF_TICKET_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(SUPPORT_ERRORS.INVALID_CHANNEL);
  }

  const requester = await resolveNewRequester(prisma, viewer, input.requester, ctx);

  // An explicit customer wins; otherwise the contact's ONLY company; otherwise
  // none — never a guess among several.
  let companyId: string | null = requester.soleCompanyId;
  if (input.companyId !== undefined) {
    await assertCompany(prisma, input.companyId, ctx);
    companyId = input.companyId;
  }

  const state = input.stateId
    ? await pickState(prisma, desk, input.stateId)
    : (desk.states.find((s) => s.isDefault) ??
      [...desk.states].sort((a, b) => a.sortOrder - b.sortOrder)[0]);
  if (!state) throw new Error(SUPPORT_ERRORS.STATE_NOT_FOUND);

  const labelIds = [...new Set(input.labelIds ?? [])];
  await assertDeskLabels(prisma, desk, labelIds);
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  await assertAgents(prisma, assigneeIds, deps);

  const now = clock(deps);
  const terminal = isTerminalGroup(state.group);

  let created: { id: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      // Checked against `tx`, so the department that is checked is the one the
      // row is written against (WARP-2724).
      if (input.departmentId !== undefined) await assertAssignableDepartment(tx, input.departmentId);

      // Bump the per-desk counter atomically: the row lock taken here is held to
      // the end of the transaction, so a concurrent create waits and never
      // reuses the number (WARP-885).
      const bumped = await tx.pmProject.update({
        where: { id: desk.id },
        data: { seqCounter: { increment: 1 } },
        select: { seqCounter: true },
      });
      const sequenceId = bumped.seqCounter;

      const item = await tx.pmWorkItem.create({
        data: {
          projectId: desk.id,
          sequenceId,
          name: input.subject,
          descriptionHtml: cleanHtml(input.descriptionHtml),
          stateId: state.id,
          priority: input.priority ?? "none",
          departmentId: input.departmentId ?? null,
          createdById: viewer.id,
          sortOrder: sequenceId,
          isCompleted: terminal,
          completedAt: terminal ? now : null,
          assignees: assigneeIds.length
            ? { create: assigneeIds.map((userId) => ({ userId })) }
            : undefined,
          labels: labelIds.length ? { create: labelIds.map((labelId) => ({ labelId })) } : undefined,
        },
        select: { id: true },
      });
      await tx.pmTicket.create({
        data: {
          workItemId: item.id,
          requesterKind: requester.kind,
          requesterContactId: requester.contactId,
          requesterUserId: requester.userId,
          requesterName: requester.name,
          requesterEmail: requester.email,
          companyId,
          channel,
          solvedAt: terminal ? now : null,
        },
      });
      await writeActivity(tx, { workItemId: item.id, actorId: viewer.id, verb: "created" });
      // A create WITH assignees is an assignment, and `created` does not say who:
      // one `assigned` row per assignee, the same shape pm.createWorkItem writes.
      for (const userId of assigneeIds) {
        await writeActivity(tx, {
          workItemId: item.id,
          actorId: viewer.id,
          verb: "assigned",
          field: "assignees",
          oldValue: null,
          newValue: userId,
        });
      }
      return item;
    });
  } catch (err) {
    // A customer deleted between the check and the insert.
    if (isPrismaCode(err, "P2003")) throw new Error(SUPPORT_ERRORS.COMPANY_NOT_FOUND);
    throw err;
  }
  return getTicket(prisma, created.id, ctx);
}

// ── Update ───────────────────────────────────────────────────────────────────

export async function updateTicket(
  prisma: PrismaClient,
  viewer: SupportViewer,
  ticketId: string,
  input: TicketUpdateInput,
  ctx: SupportCtx,
  deps: SupportDeps = {},
): Promise<ApiTicket> {
  const existing = await findTicketRow(prisma, ticketId);
  const desk = await prisma.pmProject.findUnique({
    where: { id: existing.projectId },
    include: { states: true, labels: true },
  });
  if (!desk) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
  if (desk.isArchived) throw new Error(SUPPORT_ERRORS.DESK_ARCHIVED);

  const target = input.stateId !== undefined ? await pickState(prisma, desk, input.stateId) : null;
  const labelIds = input.labelIds ? [...new Set(input.labelIds)] : undefined;
  if (labelIds) await assertDeskLabels(prisma, desk, labelIds);
  if (input.companyId) await assertCompany(prisma, input.companyId, ctx);

  const currentAssignees = existing.assignees.map((a) => a.userId);
  const nextAssignees = input.assigneeIds ? [...new Set(input.assigneeIds)] : undefined;
  // Only people being ADDED are checked: an assignee who has since lost the
  // grant must not block an unrelated edit of the ticket they were already on.
  if (nextAssignees) {
    await assertAgents(
      prisma,
      nextAssignees.filter((id) => !currentAssignees.includes(id)),
      deps,
    );
  }

  const now = clock(deps);
  const actorId = viewer.id;
  try {
    await prisma.$transaction(async (tx) => {
      if (input.departmentId) await assertAssignableDepartment(tx, input.departmentId);

      // The state move goes first: a lost compare-and-set aborts the whole
      // change before anything else is written.
      if (target && target.id !== existing.stateId) {
        await applyStateChange(tx, existing, target, actorId, now);
      }

      const data: Prisma.PmWorkItemUpdateInput = { updatedAt: now };
      if (input.subject !== undefined && input.subject !== existing.name) {
        data.name = input.subject;
        await writeActivity(tx, {
          workItemId: existing.id,
          actorId,
          verb: "title_changed",
          field: "name",
          oldValue: existing.name,
          newValue: input.subject,
        });
      }
      if (input.descriptionHtml !== undefined) {
        const next = cleanHtml(input.descriptionHtml);
        if (next !== existing.descriptionHtml) {
          data.descriptionHtml = next;
          await writeActivity(tx, { workItemId: existing.id, actorId, verb: "description_changed" });
        }
      }
      if (input.priority !== undefined && input.priority !== existing.priority) {
        data.priority = input.priority;
        await writeActivity(tx, {
          workItemId: existing.id,
          actorId,
          verb: "updated",
          field: "priority",
          oldValue: existing.priority,
          newValue: input.priority,
        });
      }
      if (input.departmentId !== undefined && input.departmentId !== existing.departmentId) {
        // The checked update input exposes the relation, not its foreign key.
        data.department = input.departmentId
          ? { connect: { id: input.departmentId } }
          : { disconnect: true };
        await writeActivity(tx, {
          workItemId: existing.id,
          actorId,
          verb: "updated",
          field: "department",
          oldValue: existing.departmentId,
          newValue: input.departmentId,
        });
      }
      await tx.pmWorkItem.update({ where: { id: existing.id }, data });

      if (nextAssignees) {
        const added = nextAssignees.filter((id) => !currentAssignees.includes(id));
        const removed = currentAssignees.filter((id) => !nextAssignees.includes(id));
        if (removed.length > 0) {
          await tx.pmWorkItemAssignee.deleteMany({
            where: { workItemId: existing.id, userId: { in: removed } },
          });
        }
        if (added.length > 0) {
          await tx.pmWorkItemAssignee.createMany({
            data: added.map((userId) => ({ workItemId: existing.id, userId })),
            skipDuplicates: true,
          });
        }
        for (const userId of added) {
          await writeActivity(tx, {
            workItemId: existing.id,
            actorId,
            verb: "assigned",
            field: "assignees",
            oldValue: null,
            newValue: userId,
          });
        }
        for (const userId of removed) {
          await writeActivity(tx, {
            workItemId: existing.id,
            actorId,
            verb: "unassigned",
            field: "assignees",
            oldValue: userId,
            newValue: null,
          });
        }
      }

      if (labelIds) {
        const current = existing.labels.map((l) => l.labelId);
        const added = labelIds.filter((id) => !current.includes(id));
        const removed = current.filter((id) => !labelIds.includes(id));
        if (removed.length > 0) {
          await tx.pmWorkItemLabel.deleteMany({
            where: { workItemId: existing.id, labelId: { in: removed } },
          });
        }
        if (added.length > 0) {
          await tx.pmWorkItemLabel.createMany({
            data: added.map((labelId) => ({ workItemId: existing.id, labelId })),
            skipDuplicates: true,
          });
        }
        for (const labelId of added) {
          await writeActivity(tx, {
            workItemId: existing.id,
            actorId,
            verb: "label_added",
            field: "labels",
            oldValue: null,
            newValue: labelId,
          });
        }
        for (const labelId of removed) {
          await writeActivity(tx, {
            workItemId: existing.id,
            actorId,
            verb: "label_removed",
            field: "labels",
            oldValue: labelId,
            newValue: null,
          });
        }
      }

      if (input.companyId !== undefined && input.companyId !== existing.ticket.companyId) {
        await tx.pmTicket.update({
          where: { workItemId: existing.id },
          data: { companyId: input.companyId },
        });
        await writeActivity(tx, {
          workItemId: existing.id,
          actorId,
          verb: "updated",
          field: "company",
          oldValue: existing.ticket.companyId,
          newValue: input.companyId,
        });
      }
    });
  } catch (err) {
    if (isPrismaCode(err, "P2003")) throw new Error(SUPPORT_ERRORS.COMPANY_NOT_FOUND);
    throw err;
  }
  return getTicket(prisma, ticketId, ctx);
}
