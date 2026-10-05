/**
 * Service desk (ADR-069 §1) — escalating a ticket to engineering.
 *
 * "Escalating a ticket is an existing `PmWorkItemRelation` across projects": one
 * new work item in a project, one RELATES edge to the ticket, and an activity
 * row on BOTH ends — all in one transaction, so there is never a PM item with no
 * link or a link with no item.
 *
 * 🔴 Nothing of the conversation crosses. The PM work item carries the ticket's
 * KEY and nothing else: the people who read Projects may not hold the Support
 * grant, and the `pm` grant must never become a back door into a customer's
 * words. The agent chooses the title (the dialog pre-fills the subject and lets
 * them edit it); an API caller who sends none gets "Escalated from SUP-12".
 *
 * Does not use pm-relations' `createRelation`: that refuses a desk end on
 * purpose, so a PM route can never link to a ticket. The one writer allowed to
 * is this one, and the route in front of it requires BOTH grants.
 */
import type { PrismaClient } from "@prisma/client";
import { writeActivity } from "../pm/pm.service.js";
import { ticketKey } from "./support-mappers.js";
import { assertDeskOpen, findTicketRow, getTicket } from "./ticket.service.js";
import { isTerminalGroup } from "./ticket-query.js";
import {
  SUPPORT_ERRORS,
  type ApiEscalation,
  type EscalateInput,
  type SupportCtx,
  type SupportViewer,
} from "./support.types.js";

export async function escalateTicket(
  prisma: PrismaClient,
  viewer: SupportViewer,
  ticketId: string,
  input: EscalateInput,
  ctx: SupportCtx,
): Promise<ApiEscalation> {
  const ticket = await findTicketRow(prisma, ticketId);
  await assertDeskOpen(prisma, ticket.projectId);

  // A desk id is as unknown here as it is on the PM side: only a live project.
  const project = await prisma.pmProject.findFirst({
    where: { id: input.projectId, kind: "PROJECT", isArchived: false },
    include: { states: true },
  });
  if (!project) throw new Error(SUPPORT_ERRORS.PROJECT_NOT_FOUND);

  const landing =
    project.states.find((s) => s.isDefault) ??
    [...project.states].sort((a, b) => a.sortOrder - b.sortOrder)[0] ??
    null;
  const terminal = landing ? isTerminalGroup(landing.group) : false;
  const key = ticketKey(ticket);
  const now = new Date();

  const item = await prisma.$transaction(async (tx) => {
    // Same atomic counter bump as createWorkItem: the row lock is held to commit.
    const bumped = await tx.pmProject.update({
      where: { id: project.id },
      data: { seqCounter: { increment: 1 } },
      select: { seqCounter: true },
    });
    const created = await tx.pmWorkItem.create({
      data: {
        projectId: project.id,
        sequenceId: bumped.seqCounter,
        name: input.title ?? `Escalated from ${key}`,
        descriptionHtml: `<p>Escalated from support ticket ${key}.</p>`,
        stateId: landing?.id ?? null,
        createdById: viewer.id,
        sortOrder: bumped.seqCounter,
        isCompleted: terminal,
        completedAt: terminal ? now : null,
      },
      select: { id: true, name: true, sequenceId: true },
    });

    // RELATES is symmetric: ONE row, the smaller id in `fromId` (the database
    // CHECK compares byte order, which for UUIDs is `<` on the strings).
    const [fromId, toId] =
      ticket.id < created.id ? [ticket.id, created.id] : [created.id, ticket.id];
    await tx.pmWorkItemRelation.create({
      data: { fromId, toId, kind: "RELATES", createdById: viewer.id },
    });

    await writeActivity(tx, { workItemId: created.id, actorId: viewer.id, verb: "created" });
    // Each end's own timeline explains the link, naming the OTHER end.
    await tx.pmActivity.createMany({
      data: [
        {
          workItemId: ticket.id,
          actorId: viewer.id,
          verb: "relation_added",
          field: "relation",
          newValue: `RELATES:${created.id}`,
        },
        {
          workItemId: created.id,
          actorId: viewer.id,
          verb: "relation_added",
          field: "relation",
          newValue: `RELATES:${ticket.id}`,
        },
      ],
    });
    await tx.pmWorkItem.update({ where: { id: ticket.id }, data: { updatedAt: now } });
    return created;
  });

  return {
    workItem: {
      id: item.id,
      key: `${project.identifier}-${item.sequenceId}`,
      name: item.name,
      projectId: project.id,
      projectName: project.name,
    },
    ticket: await getTicket(prisma, ticket.id, ctx),
  };
}
