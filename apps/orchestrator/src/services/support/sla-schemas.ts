import { z } from "zod";
import { validateCalendarForSave } from "./business-time.js";

export const SLA_ERRORS = {
  INVALID: "invalid_sla_configuration", CALENDAR_NOT_FOUND: "calendar_not_found",
  CALENDAR_IN_USE: "calendar_in_use", MACRO_NOT_FOUND: "macro_not_found",
} as const;
export const prioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
const id = z.string().min(1).max(64);
const minutes = z.number().int().min(1).max(525600);
export const targetSchema = z.object({
  firstResponseMins: minutes.optional(), nextResponseMins: minutes.optional(), resolutionMins: minutes.optional(),
}).strict().refine((v) => Object.keys(v).length > 0);
export const escalationSchema = z.array(z.object({
  on: z.enum(["AT_RISK", "BREACHED"]),
  metric: z.enum(["any", "firstResponse", "nextResponse", "resolution"]),
  actions: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("raise_priority") }).strict(),
    z.object({ type: z.literal("reassign"), userId: id }).strict(),
    z.object({ type: z.literal("notify"), userIds: z.array(id).min(1).max(50) }).strict(),
  ])).min(1).max(10),
}).strict()).max(20);
export const policySchema = z.object({
  enabled: z.boolean(), calendarId: id.nullable(),
  targets: z.object({ urgent: targetSchema.optional(), high: targetSchema.optional(), medium: targetSchema.optional(), low: targetSchema.optional(), none: targetSchema.optional() }).strict(),
  atRiskPercent: z.number().int().min(1).max(99), escalation: escalationSchema.default([]),
}).strict();
export const assignmentSchema = z.object({
  mode: z.enum(["MANUAL", "ROUND_ROBIN", "LEAST_OPEN"]), departmentId: id.nullable(),
  memberIds: z.array(id).max(200).refine((v) => new Set(v).size === v.length),
}).strict().refine((v) => v.mode === "MANUAL" || v.memberIds.length > 0);
export const macroActionsSchema = z.object({
  stateId: id.optional(), priority: prioritySchema.optional(),
  assignee: z.union([z.enum(["me", "none"]), z.object({ userId: id }).strict()]).optional(),
  addLabelIds: z.array(id).max(100).optional(), removeLabelIds: z.array(id).max(100).optional(),
}).strict();
export const macroSchema = z.object({
  projectId: id.nullable(), name: z.string().trim().min(1).max(200), bodyHtml: z.string().min(1).max(100000),
  actions: macroActionsSchema, visibility: z.enum(["PERSONAL", "SHARED"]),
}).strict().refine((v) => v.projectId !== null || (!v.actions.stateId && !v.actions.addLabelIds?.length && !v.actions.removeLabelIds?.length));
export type PolicyInput = z.infer<typeof policySchema>;
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export type MacroInput = z.infer<typeof macroSchema>;
export function parseCalendar(input: unknown) {
  const parsed = z.object({ name: z.string().trim().min(1).max(200), timezone: z.string(), windows: z.array(z.unknown()), holidays: z.array(z.string()) }).strict().parse(input);
  return { name: parsed.name, ...validateCalendarForSave(parsed) };
}
