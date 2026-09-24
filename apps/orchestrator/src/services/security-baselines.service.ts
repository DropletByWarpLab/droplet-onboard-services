/**
 * WARP-2980 (ADR-059 P5, spec §6.7, §6.14) — the baseline job and its
 * `patterns` health row.
 *
 * S0 stub: `registerSecurityBaselineJobs` registers NOTHING and sets nothing,
 * so the health row honestly reads "Not running" until slice A3 lands the
 * tick. The signatures are the ones index.ts and routes/security.ts call.
 */
import type { PrismaClient } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import type { SecurityHealthRow } from "./security-events.service.js";
import type { SecurityViewerScope } from "./security-access.js";

export const SECURITY_BASELINE_INTERVAL_MS = 60_000;
export const SECURITY_BASELINE_LOCK_KEY = "droplet:security-baselines";

export interface BaselineHealthState {
  /** Set by `registerSecurityBaselineJobs`. Null = the job is not running (the §7 boot assertion). */
  registeredAt: Date | null;
  /** The last tick that ran every step. */
  lastOkAt: Date | null;
  lastError: { at: Date; message: string } | null;
}

const baselineHealth: BaselineHealthState = { registeredAt: null, lastOkAt: null, lastError: null };

export function baselineHealthState(): Readonly<BaselineHealthState> {
  return baselineHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetBaselineHealthForTests(): void {
  Object.assign(baselineHealth, { registeredAt: null, lastOkAt: null, lastError: null } satisfies BaselineHealthState);
}

export function registerSecurityBaselineJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  prisma: PrismaClient,
): void {
  void cronRuntime;
  void prisma;
}

export function patternsHealthRow(state: Readonly<BaselineHealthState>, now: Date): SecurityHealthRow {
  void now;
  return { id: "patterns", state: "down", detail: state.registeredAt ? "Not built yet" : "Not running", lastSeenAt: null };
}

/** The one call the /security/health handler makes. Never throws. */
export async function securityPatternsHealth(
  prisma: PrismaClient,
  scope: SecurityViewerScope | null,
  now: Date,
): Promise<SecurityHealthRow> {
  void prisma;
  void scope;
  return patternsHealthRow(baselineHealth, now);
}
