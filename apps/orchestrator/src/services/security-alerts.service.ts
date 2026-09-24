/**
 * WARP-2978 (ADR-059 P3 §3.7, spec §6.7) — who is told about Security alerts,
 * the notifier that tells them, and the `alerts` health row (§6.11).
 *
 * S0: the health row's final signature with a safe body. Until slice C lands
 * the notifier nothing can be sent, so the row says so.
 */
import type { PrismaClient } from "@prisma/client";
import type { SecurityHealthRow } from "./security-events.service.js";
import type { EffectiveAccessResolver } from "../middleware/feature-gate.js";

/**
 * The `alerts` row (owner/admin only — it names who is told). Never throws.
 * S0: down "Not running".
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
