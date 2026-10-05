/** Pure SLA clock. Terms include their calendar: policy edits cannot move a live promise. */
import { addBusinessMs, businessMsBetween, type BusinessCalendar } from "./business-time.js";
import { validateCalendarForSave } from "./business-time.js";
import { z } from "zod";
export type SlaMetric = "firstResponse" | "nextResponse" | "resolution";
export type SlaStatus = "NONE" | "ON_TRACK" | "AT_RISK" | "BREACHED" | "MET" | "PAUSED";
export interface SlaTerms {
  priority?: "urgent" | "high" | "medium" | "low" | "none";
  firstResponseMins: number | null; nextResponseMins: number | null; resolutionMins: number | null;
  atRiskPercent: number; calendar: BusinessCalendar | null;
  nextResponseStartedAt: string | null; nextResponsePausedMs: number;
  notified?: Array<"AT_RISK" | "BREACHED">;
}
export interface SlaClockInput {
  createdAt: Date; now: Date; clock: "RUNNING" | "PAUSED" | "STOPPED";
  firstRespondedAt: Date | null; solvedAt: Date | null;
  pausedMs: number; pausedAt: Date | null; terms: SlaTerms;
  previousStatus: SlaStatus;
}
export interface SlaClockResult {
  firstResponseDueAt: Date | null; nextResponseDueAt: Date | null; resolutionDueAt: Date | null;
  slaPausedMs: bigint; slaPausedAt: Date | null; slaStatus: SlaStatus;
  metric: SlaMetric | null; remainingBusinessMs: number | null;
}
const ranks = { NONE: -1, ON_TRACK: 0, AT_RISK: 1, BREACHED: 2 };
export function parseSlaTerms(input: unknown): SlaTerms {
  const minutes = z.number().int().min(1).max(525600).nullable();
  const terms = z.object({ firstResponseMins: minutes, nextResponseMins: minutes, resolutionMins: minutes,
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
    atRiskPercent: z.number().int().min(1).max(99), calendar: z.unknown().nullable().default(null),
    nextResponseStartedAt: z.string().datetime().nullable().default(null), nextResponsePausedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    notified: z.array(z.enum(["AT_RISK", "BREACHED"])).max(2).default([]),
  }).parse(input);
  return { ...terms, calendar: terms.calendar === null ? null : validateCalendarForSave(terms.calendar) };
}
export function evaluateSla(input: SlaClockInput): SlaClockResult {
  if (!Number.isSafeInteger(input.pausedMs) || input.pausedMs < 0 || !Number.isFinite(input.createdAt.getTime()) || !Number.isFinite(input.now.getTime())) throw new RangeError("invalid_sla_clock");
  const { terms, now } = input;
  const accrued = input.pausedAt ? businessMsBetween(input.pausedAt, now, terms.calendar) : 0;
  const pausedMs = input.pausedMs + (input.clock === "RUNNING" ? accrued : 0);
  const pausedAt = input.clock === "RUNNING" ? null : input.pausedAt ?? now;
  // While paused, the remaining working time is measured at the pause instant.
  const at = input.pausedAt ?? now;
  const effectiveAt = input.clock === "RUNNING" ? now : pausedAt!;
  const deadlinePaused = pausedMs + (input.clock === "RUNNING" ? 0 : accrued);
  const targets: Array<[SlaMetric, Date, number, number, boolean]> = [
    ["firstResponse", input.createdAt, terms.firstResponseMins ?? 0, deadlinePaused, input.firstRespondedAt === null],
    ["nextResponse", new Date(terms.nextResponseStartedAt ?? input.createdAt), terms.nextResponseMins ?? 0, Math.max(0, deadlinePaused - terms.nextResponsePausedMs), terms.nextResponseStartedAt !== null],
    ["resolution", input.createdAt, terms.resolutionMins ?? 0, deadlinePaused, input.solvedAt === null],
  ];
  let status: SlaStatus = "ON_TRACK";
  let metric: SlaMetric | null = null;
  let remaining: number | null = null;
  const dues: Record<SlaMetric, Date | null> = { firstResponse: null, nextResponse: null, resolution: null };
  for (const [name, start, mins, paused, active] of targets) {
    if (!mins) continue;
    // Completed metrics are judged at their actual completion, before their deadline disappears.
    const completion = name === "firstResponse" ? input.firstRespondedAt : name === "resolution" ? input.solvedAt : null;
    if (!active && completion === null) continue;
    const due = addBusinessMs(start, mins * 60000 + paused, terms.calendar);
    const checkpoint = completion ?? effectiveAt;
    const elapsed = Math.max(0, businessMsBetween(start, checkpoint, terms.calendar) - Math.max(0, pausedMs - (name === "nextResponse" ? terms.nextResponsePausedMs : 0)));
    const candidate: SlaStatus = elapsed >= mins * 60000 ? "BREACHED" : active && elapsed >= mins * 60000 * terms.atRiskPercent / 100 ? "AT_RISK" : "ON_TRACK";
    if (ranks[candidate] > ranks[status]) { status = candidate; metric = name; }
    if (active) {
      dues[name] = due;
      const left = Math.max(0, mins * 60000 - Math.max(0, businessMsBetween(start, at, terms.calendar) - Math.max(0, input.pausedMs - (name === "nextResponse" ? terms.nextResponsePausedMs : 0))));
      remaining = remaining === null ? left : Math.min(remaining, left);
    }
  }
  // A missed promise stays missed when it is answered or solved later.
  if (input.previousStatus === "BREACHED") status = "BREACHED";
  else if (status !== "BREACHED" && input.clock === "PAUSED") status = "PAUSED";
  else if (status !== "BREACHED" && input.clock === "STOPPED") status = "MET";
  return { firstResponseDueAt: dues.firstResponse, nextResponseDueAt: dues.nextResponse, resolutionDueAt: dues.resolution,
    slaPausedMs: BigInt(Math.round(pausedMs)), slaPausedAt: pausedAt, slaStatus: status, metric, remainingBusinessMs: remaining };
}
