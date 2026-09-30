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
 */
import type { PrismaClient, SecurityAiLinking, SecurityAiSummaries } from "@prisma/client";
import { auditSecurityInTx } from "./security-audit.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";

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
 * WARP-2979 P4 PR-2 — just the summaries switch, for the places that must
 * never write while they ask: the engine's seal, a resolve that seals, and
 * routes 18 and 28. It reads and never creates the row (a missing row is its
 * default, `on`). Rejects when the database cannot be read; each caller
 * decides (a seal or a resolve then asks for no summary; route 18 shows none).
 */
export async function readSummariesSetting(prisma: Pick<PrismaClient, "securityAiSettings">): Promise<SecurityAiSummaries> {
  const row = await prisma.securityAiSettings.findUnique({ where: { id: SECURITY_AI_SETTINGS_ID }, select: { summaries: true } });
  return row?.summaries ?? "on";
}

/** The audit line for a change, in the words the settings panel uses. */
function changeCopy(from: SecurityAiSettingsView, to: SecurityAiSettingsInput): string {
  const parts: string[] = [];
  if (from.linking !== to.linking) {
    parts.push(
      to.linking === "link_and_suggest"
        ? "Droplet's AI now links cameras on its own when it's sure, and suggests the rest"
        : to.linking === "suggest_only"
          ? "Droplet's AI now only suggests links"
          : "Droplet's AI no longer looks for links",
    );
  }
  if (from.summaries !== to.summaries) {
    parts.push(to.summaries === "on" ? "Droplet now writes incident summaries" : "Droplet no longer writes incident summaries");
  }
  return `Security: ${parts.join("; ")}`;
}

/**
 * Route 27 (manage): compare-and-set on `version`, then `auditSecurityInTx`
 * `ai_settings.set` LAST, in one READ_COMMITTED transaction. The row is
 * created first if it was never read (its defaults, ON CONFLICT DO NOTHING).
 * A stale `expectedVersion` → 409 VERSION_CONFLICT, whatever it asks for
 * (the panel re-reads and shows the other person's choice). Nothing to change
 * → `changed: false`, no write, no audit.
 */
export async function setSecurityAiSettings(
  prisma: PrismaClient,
  ctx: { req: { user?: { id: string; role?: string } | undefined }; now: Date },
  input: SecurityAiSettingsInput,
): Promise<SecurityAiSettingsView & { changed: boolean }> {
  await prisma.securityAiSettings.createMany({ data: [{ id: SECURITY_AI_SETTINGS_ID }], skipDuplicates: true });
  return prisma.$transaction(async (tx) => {
    const current = await tx.securityAiSettings.findUniqueOrThrow({ where: { id: SECURITY_AI_SETTINGS_ID }, select: SELECT });
    if (current.version !== input.expectedVersion) {
      throw new SecurityAiSettingsError(409, "VERSION_CONFLICT", "Someone else changed these settings; reload and try again");
    }
    if (current.linking === input.linking && current.summaries === input.summaries) {
      return { linking: current.linking, summaries: current.summaries, version: current.version, changed: false };
    }
    const { count } = await tx.securityAiSettings.updateMany({
      where: { id: SECURITY_AI_SETTINGS_ID, version: input.expectedVersion },
      data: { linking: input.linking, summaries: input.summaries, version: { increment: 1 }, updatedById: ctx.req.user?.id ?? null },
    });
    if (count !== 1) throw new SecurityAiSettingsError(409, "VERSION_CONFLICT", "Someone else changed these settings; reload and try again");
    await auditSecurityInTx(tx, ctx.req, {
      action: "ai_settings.set",
      what: changeCopy(current, input),
      refs: {
        linking: input.linking,
        summaries: input.summaries,
        from: { linking: current.linking, summaries: current.summaries },
      },
    });
    return { linking: input.linking, summaries: input.summaries, version: current.version + 1, changed: true };
  }, READ_COMMITTED_TX);
}
