/**
 * WARP-2733 (ADR-048) — applying without being asked.
 *
 * This is the file where the feature stops suggesting and starts acting, so
 * every line of it is about the conditions under which it must NOT.
 *
 * ── The consent argument ───────────────────────────────────────────────────
 *
 * Not `tool-schedule-ticker`'s `spec.writes && !spec.reversible` gate: that
 * precedent has never fired. Nothing on stage creates a `ToolSchedule` row,
 * `spec.writes` is caller-declared and defaults false, and every shipped
 * firing test uses `writes:false, reversible:true`. The genuinely reachable
 * unattended writer is `scene-schedule-ticker`, which has no reversibility
 * gate at all and rests on "creating the schedule IS the owner opt-in".
 *
 * So the argument is CONSENT AT ENABLE TIME, which is what the box already
 * does and what `AutoFilingSetting` already models: the owner promotes a CLASS
 * of action, described to them in plain English derived from the policy table,
 * and the box performs that class unattended within caps. Reversibility and
 * additivity remain — as this design's own guarantees, not as an inherited
 * precedent it turned out not to have.
 *
 * Against WARP-2179 ("a background run may not silently take a Tier-2 action —
 * the user authorised a goal, not each destructive act the model subsequently
 * chose"): THE MODEL NEVER CHOOSES AN ACTION HERE. It fills fields. The action
 * class is enumerated in `policy.ts`, in code, and the model has no way to
 * reach a class the owner did not promote.
 *
 * ── The pre-flight is fail-closed and ORDERED ──────────────────────────────
 *
 * Cheapest and most decisive first, so a paused box does no work and an
 * unattributable one does none at all:
 *
 *   1. mode is `auto`                     — otherwise nothing is automatic
 *   2. the enabling owner still resolves   — `resolveAttributedToolAccess`
 *   3. that principal is owner or admin    — OUR assertion, see below
 *   4. the `crm` module is on              — the surface this writes to
 *
 * 🔴 STEP 3 IS OURS. `resolveAttributedToolAccess` returns `scope: null` for an
 * owner meaning "resolved, needs no narrowing" — NOT "no narrowing needed
 * because they are an owner". It denies service principals and deactivated
 * users, which is most of what we need, but it does not assert a TIER for us.
 * Reading its `null` scope as permission would let a role-less family creator
 * through, because they resolve to `scope: null` too.
 */
import type { PrismaClient } from "@prisma/client";

import { createLogger } from "../../lib/logger.js";
import { resolveAttributedToolAccess } from "../tool-access.service.js";
import { applyProposal, FILING_ERRORS } from "./apply.service.js";
import { AUDIT_PHRASES, recordFilingAuditBestEffort } from "./audit.js";
import { capReachedFor, readCaps, reconsiderBounded, type CapState } from "./caps.js";
import type { ResolvedFilingSettings } from "./settings.js";

const logger = createLogger("filing-auto");

/** How many AUTO proposals one tick may apply. Bounded so a backlog is worked
 *  through steadily rather than in one burst that no digest could summarise. */
export const AUTO_APPLY_PER_TICK = 5;

export type PreflightResult =
  | { ok: true; caps: CapState }
  | {
      ok: false;
      reason: "not_auto" | "owner_unavailable" | "wrong_role" | "module_off";
      /** Rendered on the Filing header, in the owner's words. */
      message: string | null;
    };

/**
 * Everything that must hold before a single unattended write.
 *
 * Returns rather than throws: none of these is an error, they are states. A
 * box whose owner has left is not broken, it is paused, and the difference is
 * what the header says.
 */
export async function preflight(
  prisma: PrismaClient,
  settings: ResolvedFilingSettings,
): Promise<PreflightResult> {
  if (settings.mode !== "auto") {
    return { ok: false, reason: "not_auto", message: null };
  }

  const access = await resolveAttributedToolAccess(prisma, settings.enabledById);
  if (access.unresolved) {
    // Absent, deleted, DEACTIVATED, or unreadable. A run we cannot attribute
    // must not run — the same inversion `resolveAttributedToolAccess` makes on
    // the schedule path, and for the same reason: on this path "no principal"
    // means we do not know who is acting, not that auth is off.
    logger.warn(
      { unresolved: access.unresolved },
      "filing: auto mode paused — the enabling owner could not be resolved",
    );
    return {
      ok: false,
      reason: "owner_unavailable",
      message: "Paused — the person who turned this on is no longer active.",
    };
  }

  // 🔴 OUR assertion, not the resolver's. `scope: null` means "no §3
  // narrowing", which a role-less family creator also gets.
  if (access.tier !== "owner" && access.tier !== "admin") {
    logger.warn(
      { tier: access.tier },
      "filing: auto mode paused — the enabling principal is not owner or admin",
    );
    return {
      ok: false,
      reason: "wrong_role",
      message: "Paused — the person who turned this on no longer manages this Droplet.",
    };
  }

  const crm = await prisma.moduleSetting.findUnique({ where: { moduleId: "crm" } });
  if (!crm?.enabled) {
    return {
      ok: false,
      reason: "module_off",
      message: "Paused — the Customers module is switched off.",
    };
  }

  const caps = await readCaps(prisma, settings);
  return { ok: true, caps };
}

/**
 * How the UNATTENDED path re-checks that a file is still there.
 *
 * 🔴 NOT THE SAME CHECK THE HUMAN PATH USES, and the difference is worth
 * stating rather than hiding behind a shared name.
 *
 * When a person clicks Apply, `routes/crm-filing.ts` re-resolves the fileid by
 * PROPFIND **as that person**, so the check is an AUTHORIZATION as well as an
 * existence test — the file has to be one they can still see.
 *
 * The worker has no caller. There is no session, no Nextcloud token, and
 * nobody to act as; inventing one by using the admin credential would be a
 * privilege escalation dressed as a convenience, and it is the exact shape
 * `routes/files.ts` refuses.
 *
 * So the unattended check asks the box's OWN index instead: is there still a
 * `FileIndexStatus` row for this fileid, at this path, owned by someone the
 * enabling owner may read? That is:
 *
 *   - a real existence test — `db.py`'s `delete_index_status` removes the row
 *     when the file is deleted in Nextcloud, which is the same signal the
 *     orphan purge keys on;
 *   - a real scope test — `permittedOwnerIds` is the same allow-list the claim
 *     was made under, so auto-apply cannot reach a file the worker was never
 *     permitted to read;
 *   - NOT a permission re-check against Nextcloud. A share revoked in
 *     Nextcloud without touching the file would not be seen here until the
 *     next index.
 *
 * That last line is the honest limit, and it is bounded by the fact that
 * nothing on this path ever SHOWS the document — it attaches an id the owner
 * already had access to when the file was read.
 */
export function indexBackedFileCheck(
  prisma: PrismaClient,
  permittedOwnerIds: readonly string[],
): (filePath: string) => Promise<number | null> {
  return async (filePath: string) => {
    if (permittedOwnerIds.length === 0) return null;
    const row = await prisma.fileIndexStatus.findFirst({
      where: { path: filePath, userId: { in: [...permittedOwnerIds] } },
      select: { ncFileId: true },
    });
    return row?.ncFileId ?? null;
  };
}

export interface AutoApplyResult {
  applied: number;
  refused: number;
  /** Cap-deferred proposals returned to AUTO because the window rolled. */
  freed: number;
}

/**
 * Apply the proposals the policy table promoted, within caps.
 *
 * 🔴 THE POLICY CLASS IS READ OFF THE ROW, not recomputed here. `propose.ts`
 * classified it at the moment the document was read, with the settings and the
 * caps that were true then, and that verdict is the record of what the owner's
 * configuration authorised. Recomputing it at apply time would mean a settings
 * change silently re-authorising a proposal that was made under different
 * rules — and the row would still show the old reason.
 */
export async function runAutoApply(
  prisma: PrismaClient,
  settings: ResolvedFilingSettings,
  ctx: { resolveFileId: (filePath: string) => Promise<number | null> },
): Promise<AutoApplyResult | { skipped: PreflightResult }> {
  const pre = await preflight(prisma, settings);
  if (!pre.ok) return { skipped: pre };

  const freed = await reconsiderBounded(prisma, pre.caps);

  const ready = await prisma.ingestProposal.findMany({
    where: { status: "PENDING", policyClass: "AUTO" },
    orderBy: { createdAt: "asc" },
    take: AUTO_APPLY_PER_TICK,
    select: { id: true, kind: true },
  });

  let applied = 0;
  let refused = 0;

  for (const p of ready) {
    // Re-checked per proposal, because applying one moves the counter. Without
    // this a tick could spend five creates against a budget of one.
    if (capReachedFor(p.kind, pre.caps)) {
      refused += 1;
      continue;
    }

    try {
      const result = await applyProposal(
        prisma,
        p.id,
        { actorId: settings.enabledById!, resolveFileId: ctx.resolveFileId },
        {},
      );
      // 🔴 Marked as the BOX's work, not the owner's. `autoApplied` is what the
      // caps count and what the card reads to say "applied automatically" — an
      // unattended write that looked hand-made would be unauditable and would
      // spend nobody's budget.
      await prisma.ingestProposal.updateMany({
        where: { id: p.id },
        data: { autoApplied: true },
      });
      applied += 1;
      if (isCreate(p.kind)) pre.caps.createdToday += 1;
      pre.caps.appliedThisHour += 1;
      pre.caps.hourlyReached = pre.caps.appliedThisHour >= pre.caps.hourlyCap;
      pre.caps.dailyReached = pre.caps.createdToday >= pre.caps.dailyCap;

      // WARP-2732 gave the audit a best-effort variant, and this call is
      // exactly the class it was written for: `applyProposal` has ALREADY
      // committed by the time we get here, so a throwing audit would abort the
      // tick after the write landed and leave the counter blaming the apply.
      await recordFilingAuditBestEffort({
        ownerId: settings.enabledById!,
        what: AUDIT_PHRASES.applied,
        refs: {
          sourceRef: `proposal:${result.proposalId}`,
          sourceKind: "FILE",
          extractStatus: "done",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A source that moved, a row somebody decided in another tab, a payload
      // an older extractor wrote: all ordinary. They become review cards by
      // staying PENDING — nothing here deletes a proposal it could not apply.
      if (isExpected(msg)) {
        refused += 1;
        logger.info({ proposalId: p.id, reason: msg }, "filing: auto-apply declined");
        continue;
      }
      throw err;
    }
  }

  if (applied || refused || freed) {
    logger.info({ applied, refused, freed }, "filing auto-apply");
  }
  return { applied, refused, freed };
}

function isCreate(kind: string): boolean {
  return kind === "CREATE_CUSTOMER" || kind === "CREATE_PROJECT";
}

function isExpected(message: string): boolean {
  return (
    message === FILING_ERRORS.NOT_PENDING ||
    message === FILING_ERRORS.SOURCE_CHANGED ||
    message === FILING_ERRORS.PAYLOAD_UNREADABLE ||
    message === FILING_ERRORS.NEVER_APPLIABLE ||
    message === FILING_ERRORS.CHOICE_REQUIRED ||
    message === FILING_ERRORS.PROPOSAL_NOT_FOUND
  );
}
