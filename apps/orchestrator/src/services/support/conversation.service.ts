/**
 * Service desk (ADR-069 §3) — the conversation: public replies and internal
 * notes are ONE comment stream, told apart by `PmComment.visibility`.
 *
 * Only a PUBLIC comment on a ticket is ever delivered to the requester (the
 * email channel, WS-13, is what delivers it); an INTERNAL one never leaves the
 * team. In this slice a reply is RECORDED and nothing is sent — the composer
 * says so. The database refuses a PUBLIC comment on a project work item
 * (pmcomment_public_only_on_tickets), so the rule does not rest on this file.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { writeActivity } from "../pm/pm.service.js";
import {
  FORMER_MEMBER,
  loadPeople,
  personOf,
} from "./support-mappers.js";
import { assertDeskOpen, applyStateChange, cleanHtml, findTicketRow, getTicket, pickState } from "./ticket.service.js";
import type { SupportDeps } from "./requester.service.js";
import { lockTicketClock, syncTicketSla } from "./sla-clock.service.js";
import {
  type ApiConversation,
  type ApiConversationEntry,
  type ApiPerson,
  type ApiTicket,
  type CommentVisibility,
  type ConversationInput,
  type SupportCtx,
  type SupportViewer,
} from "./support.types.js";

/** Each source (comments, activity) is capped at its latest N rows; a ticket
 *  with more says so (`truncated`) rather than quietly dropping the early part. */
const ENTRY_CAP = 500;

export const EMPTY_BODY = "empty_body";

type CommentEntry = Extract<ApiConversationEntry, { type: "comment" }>;

const PRIORITY_WORDS: Record<string, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

/** `RELATES:<workItemId>` — the shape pm-relations and the escalation write. */
const relationTarget = (value: string | null): string | null => {
  const idx = value ? value.indexOf(":") : -1;
  return value && idx >= 0 ? value.slice(idx + 1) : null;
};

export async function getConversation(
  prisma: PrismaClient,
  ticketId: string,
  ctx: SupportCtx,
): Promise<ApiConversation> {
  const ticket = await findTicketRow(prisma, ticketId);
  const id = ticket.id;

  const [comments, activity] = await Promise.all([
    prisma.pmComment.findMany({
      where: { workItemId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ENTRY_CAP + 1,
    }),
    prisma.pmActivity.findMany({
      // A comment is shown as itself; its activity row would only repeat it.
      where: { workItemId: id, verb: { not: "commented" } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ENTRY_CAP + 1,
    }),
  ]);
  const truncated = comments.length > ENTRY_CAP || activity.length > ENTRY_CAP;
  const shownComments = comments.slice(0, ENTRY_CAP);
  const shownActivity = activity.slice(0, ENTRY_CAP);

  // One batch per kind of id, across everything on screen.
  const userIds = new Set<string>();
  const stateIds = new Set<string>();
  const labelIds = new Set<string>();
  const companyIds = new Set<string>();
  const departmentIds = new Set<string>();
  const workItemIds = new Set<string>();
  for (const c of shownComments) if (c.authorId) userIds.add(c.authorId);
  for (const a of shownActivity) {
    if (a.actorId) userIds.add(a.actorId);
    for (const v of [a.oldValue, a.newValue]) {
      if (!v) continue;
      if (a.verb === "assigned" || a.verb === "unassigned") userIds.add(v);
      else if (a.verb === "state_changed") stateIds.add(v);
      else if (a.verb === "label_added" || a.verb === "label_removed") labelIds.add(v);
      else if (a.verb === "updated" && a.field === "company") companyIds.add(v);
      else if (a.verb === "updated" && a.field === "department") departmentIds.add(v);
      else if (a.verb === "relation_added" || a.verb === "relation_removed") {
        const other = relationTarget(v);
        if (other) workItemIds.add(other);
      }
    }
  }
  const [people, states, labels, companies, departments, linked] = await Promise.all([
    loadPeople(prisma, userIds),
    stateIds.size
      ? prisma.pmState.findMany({ where: { id: { in: [...stateIds] } }, select: { id: true, name: true } })
      : [],
    labelIds.size
      ? prisma.pmLabel.findMany({ where: { id: { in: [...labelIds] } }, select: { id: true, name: true } })
      : [],
    companyIds.size && ctx.canReadCrm
      ? prisma.crmCompany.findMany({ where: { id: { in: [...companyIds] } }, select: { id: true, name: true } })
      : [],
    departmentIds.size
      ? prisma.department.findMany({ where: { id: { in: [...departmentIds] } }, select: { id: true, name: true } })
      : [],
    workItemIds.size && ctx.canReadProjects
      ? prisma.pmWorkItem.findMany({
          where: { id: { in: [...workItemIds] } },
          select: { id: true, sequenceId: true, project: { select: { identifier: true } } },
        })
      : [],
  ]);
  const nameOf = (rows: Array<{ id: string; name: string }>) =>
    new Map(rows.map((r) => [r.id, r.name] as const));
  const stateName = nameOf(states);
  const labelName = nameOf(labels);
  const companyName = nameOf(companies);
  const departmentName = nameOf(departments);
  const itemKey = new Map(linked.map((w) => [w.id, `${w.project.identifier}-${w.sequenceId}`] as const));

  const resolve = (verb: string, field: string | null, v: string | null): string | null => {
    if (!v) return null;
    if (verb === "assigned" || verb === "unassigned") return people.get(v) ?? FORMER_MEMBER;
    if (verb === "state_changed") return stateName.get(v) ?? "a removed status";
    if (verb === "label_added" || verb === "label_removed") return labelName.get(v) ?? "a removed label";
    if (verb === "title_changed") return v;
    if (verb === "relation_added" || verb === "relation_removed") {
      const other = relationTarget(v);
      return (other && itemKey.get(other)) || "a work item";
    }
    if (verb === "updated" && field === "priority") return PRIORITY_WORDS[v] ?? v;
    if (verb === "updated" && field === "company") {
      return ctx.canReadCrm ? (companyName.get(v) ?? "a removed customer") : "a customer";
    }
    if (verb === "updated" && field === "department") return departmentName.get(v) ?? "a removed department";
    return null;
  };

  const entries: ApiConversationEntry[] = [
    ...shownComments.map((c): ApiConversationEntry => {
      let author: ApiPerson | null = null;
      if (c.authorKind === "USER" && c.authorId) author = personOf(people, c.authorId);
      else if (c.authorKind === "CONTACT") {
        // The requester's name as of intake: the live row is the owner's to keep.
        author = { id: c.contactId ?? ticket.ticket.requesterContactId ?? "", displayName: ticket.ticket.requesterName };
      }
      return {
        type: "comment",
        id: c.id,
        visibility: c.visibility,
        authorKind: c.authorKind,
        author,
        html: c.commentHtml,
        createdAt: c.createdAt.toISOString(),
      };
    }),
    ...shownActivity.map((a): ApiConversationEntry => ({
      type: "activity",
      id: a.id,
      verb: a.verb,
      field: a.field,
      from: resolve(a.verb, a.field, a.oldValue),
      to: resolve(a.verb, a.field, a.newValue),
      actor: a.actorId ? personOf(people, a.actorId) : null,
      createdAt: a.createdAt.toISOString(),
    })),
  ];
  entries.sort((x, y) =>
    x.createdAt === y.createdAt ? (x.id < y.id ? -1 : 1) : x.createdAt < y.createdAt ? -1 : 1,
  );
  return { entries, truncated };
}

// ── Replies and notes ────────────────────────────────────────────────────────

async function addComment(
  prisma: PrismaClient,
  viewer: SupportViewer,
  ticketId: string,
  input: ConversationInput,
  visibility: CommentVisibility,
  ctx: SupportCtx,
  deps: SupportDeps,
): Promise<{ entry: CommentEntry; ticket: ApiTicket }> {
  const html = cleanHtml(input.bodyHtml);
  if (html === null) throw new Error(EMPTY_BODY);

  const row = await findTicketRow(prisma, ticketId);
  await assertDeskOpen(prisma, row.projectId);
  const desk = await prisma.pmProject.findUniqueOrThrow({
    where: { id: row.projectId },
    include: { states: true, labels: true },
  });
  const target = input.stateId ? await pickState(prisma, desk, input.stateId) : null;
  const now = deps.now ? deps.now() : new Date();

  const comment = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockTicketClock(tx, row.id);
    // "Send and set to Pending": the move and the comment are one change.
    if (target && target.id !== row.stateId) {
      await applyStateChange(tx, row, target, viewer.id, now, deps);
    }
    const created = await tx.pmComment.create({
      data: {
        workItemId: row.id,
        authorId: viewer.id,
        authorKind: "USER",
        visibility,
        commentHtml: html,
        createdAt: now,
      },
    });
    if (visibility === "PUBLIC") {
      // First response is the first PUBLIC comment from staff, stamped by a
      // compare-and-set: two simultaneous first replies leave ONE timestamp.
      await tx.pmTicket.updateMany({
        where: { workItemId: row.id, firstRespondedAt: null },
        data: { firstRespondedAt: now },
      });
      await tx.pmTicket.update({
        where: { workItemId: row.id },
        data: { lastPublicActivityAt: now },
      });
      await syncTicketSla(tx, row.id, now, "reply", deps);
    }
    await writeActivity(tx, {
      workItemId: row.id,
      actorId: viewer.id,
      verb: "commented",
      field: visibility === "PUBLIC" ? "reply" : "note",
    });
    // The list's "last update" moves with the conversation, not just the fields.
    await tx.pmWorkItem.update({ where: { id: row.id }, data: { updatedAt: now } });
    return created;
  });

  const people = await loadPeople(prisma, [viewer.id]);
  const entry: CommentEntry = {
    type: "comment",
    id: comment.id,
    visibility: comment.visibility,
    authorKind: comment.authorKind,
    author: personOf(people, viewer.id),
    html: comment.commentHtml,
    createdAt: comment.createdAt.toISOString(),
  };
  return { entry, ticket: await getTicket(prisma, row.id, ctx) };
}

export const addReply = (
  prisma: PrismaClient,
  viewer: SupportViewer,
  ticketId: string,
  input: ConversationInput,
  ctx: SupportCtx,
  deps: SupportDeps = {},
) => addComment(prisma, viewer, ticketId, input, "PUBLIC", ctx, deps);

export const addNote = (
  prisma: PrismaClient,
  viewer: SupportViewer,
  ticketId: string,
  input: ConversationInput,
  ctx: SupportCtx,
  deps: SupportDeps = {},
) => addComment(prisma, viewer, ticketId, input, "INTERNAL", ctx, deps);
