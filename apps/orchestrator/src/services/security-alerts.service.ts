/**
 * WARP-2978 (ADR-059 P3 §3.7, spec §6.7) — who is told about Security alerts,
 * the notifier that tells them, and the `alerts` health row (§6.11).
 *
 * Slice B: the final signatures the engine calls, with safe bodies. Until
 * slice C lands the notifier nothing is sent, and the row says so.
 */
import type { PrismaClient } from "@prisma/client";
import type { SecurityHealthRow } from "./security-events.service.js";
import type { EffectiveAccessResolver } from "../middleware/feature-gate.js";

/** What the engine hands the notifier. */
export interface NotifierDeps {
  isSecurityModuleOn: () => Promise<boolean>;
  resolveAccess: EffectiveAccessResolver;
}

/** Step 6 of the engine's tick. Slice B: sends nothing. */
export async function notifyPendingIncidents(prisma: PrismaClient, deps: NotifierDeps, now: Date): Promise<{ incidents: number }> {
  void prisma;
  void deps;
  void now;
  return { incidents: 0 };
}

/** Step 6, second half: notices stuck `queued`. Slice B: nothing. */
export async function redeliverStuckNotices(prisma: PrismaClient, now: Date): Promise<{ redelivered: number }> {
  void prisma;
  void now;
  return { redelivered: 0 };
}

/** Step 7: the alerts row, every 6th tick. Slice B: nothing to compute. */
export async function recomputeAlertsHealth(
  prisma: PrismaClient,
  resolve: EffectiveAccessResolver | undefined,
  now: Date,
): Promise<void> {
  void prisma;
  void resolve;
  void now;
}

/**
 * The `alerts` row (owner/admin only — it names who is told). Never throws.
 * Slice B: down "Not running".
 */
export async function securityAlertsHealth(
  prisma: PrismaClient,
  resolve: EffectiveAccessResolver | undefined,
  now: Date,
): Promise<SecurityHealthRow> {
  void prisma;
  void resolve;
  void now;
  return { id: "alerts", state: "down", detail: "Not running", lastSeenAt: null };
}
