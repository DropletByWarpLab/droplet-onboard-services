import { Prisma, type PrismaClient } from "@prisma/client";
import { writeActivity } from "../pm/pm.service.js";
import { TICKET_INCLUDE, hasTicket } from "./support-mappers.js";
import { evaluateSla, parseSlaTerms, type SlaTerms, type SlaStatus } from "./sla-engine.js";
import { policySchema } from "./sla-schemas.js";
import { businessMsBetween, validateCalendarForSave } from "./business-time.js";
import { assertAgents, type SupportDeps } from "./requester.service.js";

/** The ticket clock and assignment cursor share the ticket's own transaction. */
export async function lockTicketClock(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "workItemId" FROM "PmTicket" WHERE "workItemId" = ${id} FOR UPDATE`;
}
export async function syncTicketSla(
  tx: Prisma.TransactionClient, id: string, now: Date,
  event: "tick" | "create" | "priority" | "state" | "reply" | "requester" = "tick",
  deps: SupportDeps = {},
): Promise<void> {
  await lockTicketClock(tx, id);
  const row = await tx.pmWorkItem.findFirst({ where: { id, project: { kind: "SERVICE_DESK" }, isArchived: false }, include: TICKET_INCLUDE });
  if (!row || !hasTicket(row)) return;
  const ticket = row.ticket;
  const policyRow = await tx.pmSlaPolicy.findUnique({ where: { projectId: row.projectId }, include: { calendar: true } });
  const policy = policyRow?.enabled ? policySchema.parse({ enabled: policyRow.enabled, calendarId: policyRow.calendarId,
    targets: policyRow.targets, atRiskPercent: policyRow.atRiskPercent, escalation: policyRow.escalation }) : null;
  let terms = ticket.slaTargets === null ? null : parseSlaTerms(ticket.slaTargets);
  if ((event === "create" && terms === null) || (event === "priority" && terms?.priority !== row.priority)) {
    const target = policy?.targets[row.priority as keyof typeof policy.targets];
    terms = target && policy ? {
      priority: row.priority,
      firstResponseMins: target.firstResponseMins ?? null, nextResponseMins: target.nextResponseMins ?? null,
      resolutionMins: target.resolutionMins ?? null, atRiskPercent: policy.atRiskPercent,
      // Accumulated paused milliseconds were measured in this calendar. Keep it
      // for the ticket's lifetime, including a priority change after a policy edit.
      calendar: terms ? terms.calendar : policyRow?.calendar ? validateCalendarForSave(policyRow.calendar) : null,
      nextResponseStartedAt: terms?.nextResponseStartedAt ?? null,
      nextResponsePausedMs: terms?.nextResponsePausedMs ?? 0,
      // Retargeting starts a new risk window; a breached promise stays breached.
      notified: terms?.notified?.filter((s) => s === "BREACHED") ?? [],
    } : null;
  }
  if (!terms) {
    await tx.pmTicket.update({ where: { workItemId: id }, data: {
      slaTargets: Prisma.DbNull, slaStatus: "NONE", firstResponseDueAt: null, nextResponseDueAt: null, resolutionDueAt: null,
    } });
    return;
  }
  const input = { createdAt: row.createdAt, now, clock: row.state?.slaClock ?? "RUNNING",
    firstRespondedAt: ticket.firstRespondedAt, solvedAt: ticket.solvedAt, pausedMs: Number(ticket.slaPausedMs), pausedAt: ticket.slaPausedAt,
    terms, previousStatus: ticket.slaStatus as SlaStatus };
  const beforeReply = event === "reply" ? evaluateSla(input) : null;
  if (event === "reply") terms = { ...terms, nextResponseStartedAt: null };
  if (event === "requester" && ticket.firstRespondedAt !== null && terms.nextResponseStartedAt === null) terms = { ...terms, nextResponseStartedAt: now.toISOString(),
    nextResponsePausedMs: Number(ticket.slaPausedMs) + (ticket.slaPausedAt ? businessMsBetween(ticket.slaPausedAt, now, terms.calendar) : 0) };
  const result = evaluateSla({ ...input, terms });
  if (beforeReply?.slaStatus === "BREACHED") { result.slaStatus = "BREACHED"; result.metric = beforeReply.metric; }
  if (event === "reply" && result.slaStatus === "ON_TRACK") terms = { ...terms, notified: terms.notified?.filter((s) => s === "BREACHED") ?? [] };
  const transition = (result.slaStatus === "AT_RISK" || result.slaStatus === "BREACHED") && !terms.notified?.includes(result.slaStatus);
  if (transition) terms = { ...terms, notified: [...(terms.notified ?? []), result.slaStatus as "AT_RISK" | "BREACHED"] };
  await tx.pmTicket.update({ where: { workItemId: id }, data: {
    firstResponseDueAt: result.firstResponseDueAt, nextResponseDueAt: result.nextResponseDueAt,
    resolutionDueAt: result.resolutionDueAt, slaPausedMs: result.slaPausedMs,
    slaPausedAt: result.slaPausedAt, slaStatus: result.slaStatus,
    slaTargets: terms as unknown as Prisma.InputJsonValue,
  } });
  if (!transition) return;
  await writeActivity(tx, { workItemId: id, actorId: null,
    verb: result.slaStatus === "BREACHED" ? "sla_breached" : "sla_at_risk",
    field: result.metric, oldValue: ticket.slaStatus, newValue: result.slaStatus });
  // Actions run once in the transaction that changes the explicit status.
  let raised = false;
  let effectivePriority = row.priority;
  for (const escalation of policy?.escalation ?? []) {
    if (escalation.on !== result.slaStatus || (escalation.metric !== "any" && escalation.metric !== result.metric)) continue;
    for (const action of escalation.actions) {
      if (action.type === "raise_priority") {
        const order = ["none", "low", "medium", "high", "urgent"] as const;
        const priority = order[Math.min(order.indexOf(effectivePriority) + 1, 4)]!;
        if (priority !== effectivePriority) {
          raised = true;
          await tx.pmWorkItem.update({ where: { id }, data: { priority } });
          await writeActivity(tx, { workItemId: id, actorId: null, verb: "updated", field: "priority", oldValue: effectivePriority, newValue: priority });
          effectivePriority = priority;
        }
      } else if (action.type === "reassign") {
        // Revalidate current eligibility; a withdrawn grant cannot gain a private ticket.
        try { await assertAgents(tx as unknown as PrismaClient, [action.userId], deps); }
        catch (error) { if (error instanceof Error && error.message === "invalid_assignee") continue; throw error; }
        if (!row.assignees.some((a) => a.userId === action.userId)) {
          await tx.pmWorkItemAssignee.deleteMany({ where: { workItemId: id } });
          await tx.pmWorkItemAssignee.create({ data: { workItemId: id, userId: action.userId } });
          await writeActivity(tx, { workItemId: id, actorId: null, verb: "assigned", field: "assignees", newValue: action.userId });
        }
      }
      // notify uses this SLA activity's existing transactional notification claim.
    }
  }
  if (raised) await syncTicketSla(tx, id, now, "priority", deps);
}

/** Bounded cursor walk: a long-running desk cannot starve later tickets. */
export async function sweepTicketSlas(prisma: PrismaClient, deps: SupportDeps = {}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const flagKey = "pm-sla:scan-cursor";
  const flag = await prisma.systemFlag.findUnique({ where: { key: flagKey } });
  if (flag && typeof flag.valueJson !== "string") throw new Error("unreadable_sla_cursor");
  let cursor = typeof flag?.valueJson === "string" ? flag.valueJson : "";
  let checked = 0;
  for (let page = 0; page < 5; page++) {
    const rows = await prisma.pmTicket.findMany({
      where: { workItemId: { gt: cursor }, slaStatus: { notIn: ["NONE", "MET"] }, workItem: { isArchived: false, project: { kind: "SERVICE_DESK", isArchived: false } } },
      orderBy: { workItemId: "asc" }, take: 100,
      select: { workItemId: true },
    });
    for (const row of rows) { await prisma.$transaction((tx) => syncTicketSla(tx, row.workItemId, now, "tick", deps)); checked++; }
    cursor = rows.length < 100 ? "" : rows[rows.length - 1]!.workItemId;
    await prisma.systemFlag.upsert({ where: { key: flagKey }, create: { key: flagKey, valueJson: cursor }, update: { valueJson: cursor } });
    if (rows.length < 100) break;
  }
  return checked;
}
