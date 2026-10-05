import { Prisma, type PrismaClient } from "@prisma/client";
import { ensureHomeWorkspace, isPrismaCode, writeActivity, type Db } from "../pm/pm.service.js";
import { assertAssignableDepartment } from "../pm/pm-department.js";
import { sanitizePmHtml } from "../pm/sanitize-html.js";
import { assertAgents, type SupportDeps } from "./requester.service.js";
import { findTicketRow, updateTicket } from "./ticket.service.js";
import { lockTicketClock } from "./sla-clock.service.js";
import { SLA_ERRORS, assignmentSchema, macroSchema, parseCalendar, policySchema, type PolicyInput, type AssignmentInput, type MacroInput } from "./sla-schemas.js";
import { SUPPORT_ERRORS, type SupportCtx, type SupportViewer, type TicketUpdateInput } from "./support.types.js";
import { resolveEffectiveAccess } from "../effective-access.service.js";

const isAdmin = (viewer: SupportViewer) => ["owner", "admin"].includes(viewer.role);
async function requireSharedManage(viewer: SupportViewer, deps: SupportDeps) {
  if (!isAdmin(viewer)) throw new Error(SLA_ERRORS.MACRO_NOT_FOUND);
  const access = await (deps.resolveAccess ?? resolveEffectiveAccess)(viewer.id);
  if (!access?.features.some((f) => f.moduleId === "support" && f.level === "manage")) throw new Error(SLA_ERRORS.MACRO_NOT_FOUND);
}
async function deskOf(db: Db, id: string, writable = false) {
  const desk = await db.pmProject.findFirst({ where: { id, kind: "SERVICE_DESK" } });
  if (!desk) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
  if (writable && desk.isArchived) throw new Error(SUPPORT_ERRORS.DESK_ARCHIVED);
  return desk;
}
const calendarWire = (row: { id: string; name: string; timezone: string; windows: Prisma.JsonValue; holidays: Prisma.JsonValue }) => ({
  id: row.id, name: row.name, timezone: row.timezone, windows: row.windows, holidays: row.holidays,
});
export async function listBusinessCalendars(prisma: PrismaClient) {
  const workspace = await ensureHomeWorkspace(prisma);
  return (await prisma.pmBusinessCalendar.findMany({ where: { workspaceId: workspace.id }, orderBy: { name: "asc" } })).map(calendarWire);
}
export async function saveBusinessCalendar(prisma: PrismaClient, id: string | null, input: unknown) {
  const parsed = parseCalendar(input);
  const data = { ...parsed, windows: parsed.windows.map((w) => ({ day: w.day, start: w.start, end: w.end })), holidays: [...parsed.holidays] };
  const workspace = await ensureHomeWorkspace(prisma);
  if (id && !await prisma.pmBusinessCalendar.findFirst({ where: { id, workspaceId: workspace.id } })) throw new Error(SLA_ERRORS.CALENDAR_NOT_FOUND);
  try {
    return calendarWire(id ? await prisma.pmBusinessCalendar.update({ where: { id }, data }) : await prisma.pmBusinessCalendar.create({ data: { ...data, workspaceId: workspace.id } }));
  } catch (error) {
    if (isPrismaCode(error, "P2025")) throw new Error(SLA_ERRORS.CALENDAR_NOT_FOUND);
    if (isPrismaCode(error, "P2002")) throw new Error(SLA_ERRORS.INVALID);
    throw error;
  }
}
export async function deleteBusinessCalendar(prisma: PrismaClient, id: string) {
  const workspace = await ensureHomeWorkspace(prisma);
  try {
    const deleted = await prisma.pmBusinessCalendar.deleteMany({ where: { id, workspaceId: workspace.id } });
    if (!deleted.count) throw new Error(SLA_ERRORS.CALENDAR_NOT_FOUND);
  } catch (error) {
    if (isPrismaCode(error, "P2003")) throw new Error(SLA_ERRORS.CALENDAR_IN_USE);
    throw error;
  }
}
export async function getDeskSla(prisma: PrismaClient, deskId: string) {
  await deskOf(prisma, deskId);
  const [policy, assignment] = await Promise.all([
    prisma.pmSlaPolicy.findUnique({ where: { projectId: deskId } }),
    prisma.pmAssignmentRule.findUnique({ where: { projectId: deskId } }),
  ]);
  return {
    policy: policy ? { enabled: policy.enabled, calendarId: policy.calendarId, targets: policy.targets, atRiskPercent: policy.atRiskPercent, escalation: policy.escalation } : null,
    assignment: assignment ? { mode: assignment.mode, departmentId: assignment.departmentId, memberIds: assignment.memberIds } : { mode: "MANUAL", departmentId: null, memberIds: [] },
  };
}
export async function saveDeskSla(prisma: PrismaClient, deskId: string, input: { policy: PolicyInput; assignment: AssignmentInput }, deps: SupportDeps = {}) {
  const policy = policySchema.parse(input.policy);
  const assignment = assignmentSchema.parse(input.assignment);
  const people = [...assignment.memberIds, ...policy.escalation.flatMap((e) => e.actions.flatMap((a) => a.type === "reassign" ? [a.userId] : a.type === "notify" ? a.userIds : []))];
  await assertAgents(prisma, people, deps);
  await prisma.$transaction(async (tx) => {
    const desk = await deskOf(tx, deskId, true);
    if (policy.calendarId && !await tx.pmBusinessCalendar.findFirst({ where: { id: policy.calendarId, workspaceId: desk.workspaceId } })) throw new Error(SLA_ERRORS.CALENDAR_NOT_FOUND);
    if (assignment.departmentId) await assertAssignableDepartment(tx, assignment.departmentId);
    await tx.pmSlaPolicy.upsert({ where: { projectId: deskId }, create: { ...policy, projectId: deskId }, update: policy });
    await tx.$queryRaw`SELECT "id" FROM "PmAssignmentRule" WHERE "projectId" = ${deskId} FOR UPDATE`;
    const old = await tx.pmAssignmentRule.findUnique({ where: { projectId: deskId } });
    const changed = !old || old.mode !== assignment.mode || old.departmentId !== assignment.departmentId || JSON.stringify(old.memberIds) !== JSON.stringify(assignment.memberIds);
    await tx.pmAssignmentRule.upsert({ where: { projectId: deskId }, create: { ...assignment, projectId: deskId }, update: { ...assignment, ...(changed ? { lastAssignedUserId: null } : {}) } });
  });
  return getDeskSla(prisma, deskId);
}

const VARIABLES = new Set(["requester.firstName", "ticket.key", "agent.name", "desk.name"]);
function cleanMacroBody(body: string): string {
  const cleaned = sanitizePmHtml(body).trim();
  if (!cleaned || [...cleaned.matchAll(/\{\{([^{}]*)\}\}/g)].some((m) => !VARIABLES.has(m[1]!))) throw new Error(SLA_ERRORS.INVALID);
  return cleaned;
}
function macroWhere(viewer: SupportViewer, deskId: string) {
  return { AND: [{ OR: [{ projectId: deskId }, { projectId: null }] }, { OR: [{ ownerId: viewer.id }, { visibility: "SHARED" as const }] }] };
}
export async function listMacros(prisma: PrismaClient, viewer: SupportViewer, deskId: string) {
  await deskOf(prisma, deskId);
  return prisma.pmMacro.findMany({ where: macroWhere(viewer, deskId), orderBy: [{ name: "asc" }, { id: "asc" }], take: 200 });
}
export async function saveMacro(prisma: PrismaClient, viewer: SupportViewer, id: string | null, raw: MacroInput, deps: SupportDeps = {}) {
  const input = macroSchema.parse(raw);
  if (input.projectId) await deskOf(prisma, input.projectId, true);
  const existing = id ? await prisma.pmMacro.findUnique({ where: { id } }) : null;
  if (id && (!existing || (existing.ownerId !== viewer.id && !(existing.visibility === "SHARED" && isAdmin(viewer))))) throw new Error(SLA_ERRORS.MACRO_NOT_FOUND);
  if (input.visibility === "SHARED" || existing?.visibility === "SHARED") await requireSharedManage(viewer, deps);
  const data = { ...input, bodyHtml: cleanMacroBody(input.bodyHtml) };
  if (input.actions.stateId && !await prisma.pmState.findFirst({ where: { id: input.actions.stateId, projectId: input.projectId! } })) throw new Error(SUPPORT_ERRORS.INVALID_STATE);
  const labelIds = [...new Set([...(input.actions.addLabelIds ?? []), ...(input.actions.removeLabelIds ?? [])])];
  if (labelIds.length && await prisma.pmLabel.count({ where: { id: { in: labelIds }, projectId: input.projectId! } }) !== labelIds.length) throw new Error(SUPPORT_ERRORS.INVALID_LABEL);
  if (typeof input.actions.assignee === "object") await assertAgents(prisma, [input.actions.assignee.userId], deps);
  try {
    return id ? await prisma.pmMacro.update({ where: { id }, data }) : await prisma.pmMacro.create({ data: { ...data, ownerId: viewer.id } });
  } catch (error) { if (isPrismaCode(error, "P2025")) throw new Error(SLA_ERRORS.MACRO_NOT_FOUND); throw error; }
}
export async function deleteMacro(prisma: PrismaClient, viewer: SupportViewer, id: string, deps: SupportDeps = {}) {
  const existing = await prisma.pmMacro.findFirst({ where: { id, OR: [{ ownerId: viewer.id }, ...(isAdmin(viewer) ? [{ visibility: "SHARED" as const }] : [])] } });
  if (!existing) throw new Error(SLA_ERRORS.MACRO_NOT_FOUND);
  if (existing.visibility === "SHARED") await requireSharedManage(viewer, deps);
  const result = await prisma.pmMacro.deleteMany({ where: { id, ownerId: existing.ownerId, visibility: existing.visibility } });
  if (!result.count) throw new Error(SLA_ERRORS.MACRO_NOT_FOUND);
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (s) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[s]!);
async function preview(db: Db, viewer: SupportViewer, ticketId: string, macroId: string, deps: SupportDeps) {
  const row = await findTicketRow(db, ticketId);
  await deskOf(db, row.projectId, true);
  const macro = await db.pmMacro.findFirst({ where: { id: macroId, ...macroWhere(viewer, row.projectId) } });
  if (!macro) throw new Error(SLA_ERRORS.MACRO_NOT_FOUND);
  const actions = macroSchema.parse({ projectId: macro.projectId, name: macro.name, bodyHtml: macro.bodyHtml, actions: macro.actions, visibility: macro.visibility }).actions;
  const patch: TicketUpdateInput = {};
  const changes: string[] = [];
  if (actions.stateId) {
    const state = await db.pmState.findFirst({ where: { id: actions.stateId, projectId: row.projectId } });
    if (!state) throw new Error(SUPPORT_ERRORS.INVALID_STATE);
    patch.stateId = state.id; changes.push(`Status: ${state.name}`);
  }
  if (actions.priority) { patch.priority = actions.priority; changes.push(`Priority: ${actions.priority}`); }
  if (actions.assignee) {
    patch.assigneeIds = actions.assignee === "none" ? [] : [actions.assignee === "me" ? viewer.id : actions.assignee.userId];
    await assertAgents(db as PrismaClient, patch.assigneeIds, deps);
    const users = await db.user.findMany({ where: { id: { in: patch.assigneeIds } }, select: { displayName: true } });
    changes.push(`Assignee: ${users.map((u) => u.displayName).join(", ") || "Unassigned"}`);
  }
  if (actions.addLabelIds || actions.removeLabelIds) {
    const ids = [...new Set([...(actions.addLabelIds ?? []), ...(actions.removeLabelIds ?? [])])];
    const labels = await db.pmLabel.findMany({ where: { id: { in: ids }, projectId: row.projectId } });
    if (labels.length !== ids.length) throw new Error(SUPPORT_ERRORS.INVALID_LABEL);
    patch.labelIds = [...new Set([...row.labels.map((l) => l.labelId), ...(actions.addLabelIds ?? [])])].filter((id) => !actions.removeLabelIds?.includes(id));
    for (const label of labels) changes.push(`${actions.removeLabelIds?.includes(label.id) ? "Remove" : "Add"} label: ${label.name}`);
  }
  const agent = await db.user.findUnique({ where: { id: viewer.id }, select: { displayName: true } });
  const values: Record<string, string> = { "requester.firstName": row.ticket.requesterName.trim().split(/\s+/)[0] ?? "", "ticket.key": `${row.project.identifier}-${row.sequenceId}`, "agent.name": agent?.displayName ?? "Former member", "desk.name": row.project.name };
  const bodyHtml = cleanMacroBody(macro.bodyHtml).replace(/\{\{([^{}]*)\}\}/g, (_, key: string) => escapeHtml(values[key] ?? ""));
  return { macro, patch, bodyHtml, changes };
}
export async function previewMacro(prisma: PrismaClient, viewer: SupportViewer, ticketId: string, macroId: string, deps: SupportDeps = {}) {
  const result = await preview(prisma, viewer, ticketId, macroId, deps);
  return { name: result.macro.name, bodyHtml: result.bodyHtml, changes: result.changes };
}
export async function applyMacro(prisma: PrismaClient, viewer: SupportViewer, ticketId: string, macroId: string, ctx: SupportCtx, deps: SupportDeps = {}) {
  return prisma.$transaction(async (tx) => {
    await lockTicketClock(tx, ticketId);
    const result = await preview(tx, viewer, ticketId, macroId, deps);
    const ticket = await updateTicket(prisma, viewer, ticketId, result.patch, ctx, deps, tx);
    await writeActivity(tx, { workItemId: ticket.id, actorId: viewer.id, verb: "macro_applied", newValue: result.macro.name });
    return { ticket, bodyHtml: result.bodyHtml };
  });
}
