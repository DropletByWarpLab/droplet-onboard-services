/**
 * WARP-2979 (ADR-059 P4 §4.2, DS-006/DS-007) — what Droplet's AI may do in
 * Security: one row, `SecurityAiSettings` (CHECK `id = 'singleton'`).
 *
 *   · `linking` — `link_and_suggest` (the default: above the auto bar a link
 *     becomes active on its own, with a "Linked by Droplet" chip and Undo; the
 *     rest are suggested), `suggest_only`, or `off` (Droplet looks for none;
 *     existing suggestions stay decidable).
 *   · `summaries` — `on` (the default) or `off`. Summaries are written on this
 *     box only, never in the cloud (PR-2).
 *
 * The row is created LAZILY by its first reader: INSERT … ON CONFLICT DO
 * NOTHING (`createMany` + `skipDuplicates`) and then a read — never
 * `upsert({update: {}})`, which Prisma 5 runs as read-then-insert and which
 * races two first readers into a unique violation. The column defaults are
 * the defaults above and satisfy the CHECK.
 *
 * Readers: the proposal job's tick (step 1), the `links` health row, routes
 * 23 and 26. The only writer is route 27 (`setSecurityAiSettings`, manage,
 * compare-and-set on `version`, audited `ai_settings.set` in its transaction).
 *
 * S0 FOUNDATION: `readSecurityAiSettings` is complete (the job and the health
 * row need it now); `setSecurityAiSettings` is slice R's and throws until then
 * — no route calls it yet.
 */
import type { PrismaClient, SecurityAiLinking, SecurityAiSummaries } from "@prisma/client";

export const SECURITY_AI_SETTINGS_ID = "singleton";

export const SECURITY_AI_LINKING = ["link_and_suggest", "suggest_only", "off"] as const satisfies readonly SecurityAiLinking[];
export const SECURITY_AI_SUMMARIES = ["on", "off"] as const satisfies readonly SecurityAiSummaries[];

/** Route 26's body, and what every reader gets. */
export interface SecurityAiSettingsView {
  linking: SecurityAiLinking;
  summaries: SecurityAiSummaries;
  /** Send back as `expectedVersion` on route 27. */
  version: number;
}

/** Route 27's body (zod `.strict()` in the route). */
export interface SecurityAiSettingsInput {
  linking: SecurityAiLinking;
  summaries: SecurityAiSummaries;
  expectedVersion: number;
}

/** Route 27's refusals besides the 400 and the 503 `AUDIT_UNAVAILABLE`. */
export class SecurityAiSettingsError extends Error {
  constructor(
    readonly status: 409,
    readonly code: "VERSION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "SecurityAiSettingsError";
  }
}

const SELECT = { linking: true, summaries: true, version: true } as const;

/**
 * The settings, creating the row with its defaults on first sight. Rejects
 * when the database cannot be read — the caller decides what that means (the
 * job skips its tick; route 26 answers 503 `AI_SETTINGS_UNAVAILABLE`; it is
 * never read as "off" or as the defaults).
 */
export async function readSecurityAiSettings(
  prisma: Pick<PrismaClient, "securityAiSettings">,
): Promise<SecurityAiSettingsView> {
  const row = await prisma.securityAiSettings.findUnique({ where: { id: SECURITY_AI_SETTINGS_ID }, select: SELECT });
  if (row) return { linking: row.linking, summaries: row.summaries, version: row.version };
  await prisma.securityAiSettings.createMany({ data: [{ id: SECURITY_AI_SETTINGS_ID }], skipDuplicates: true });
  const made = await prisma.securityAiSettings.findUniqueOrThrow({ where: { id: SECURITY_AI_SETTINGS_ID }, select: SELECT });
  return { linking: made.linking, summaries: made.summaries, version: made.version };
}

/**
 * Route 27 (manage): compare-and-set on `version`, then `auditSecurityInTx`
 * `ai_settings.set` LAST, in one READ_COMMITTED transaction. Nothing to change
 * → `changed: false`, no write, no audit. A lost CAS → 409 VERSION_CONFLICT.
 *
 * S0 stub — slice R builds it; nothing calls it before then.
 */
export async function setSecurityAiSettings(
  prisma: PrismaClient,
  ctx: { req: { user?: { id: string; role?: string } | undefined }; now: Date },
  input: SecurityAiSettingsInput,
): Promise<SecurityAiSettingsView & { changed: boolean }> {
  void prisma;
  void ctx;
  void input;
  throw new Error("setSecurityAiSettings is not built yet (WARP-2979 slice R)");
}
