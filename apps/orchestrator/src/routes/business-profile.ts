/**
 * WARP-1120 (Phase 2, §12) — the business-profile API.
 *
 *   GET   /api/business-profile   Role-split read. owner/admin get the full
 *                                 profile + onboarding/nudge state; family gets
 *                                 the summary ONLY; guest/service get an empty
 *                                 object. The audience ladder is enforced here
 *                                 AND in the prompt block (§15) — the model must
 *                                 not leak what the API hides.
 *   PATCH /api/business-profile   owner/admin only. zod-validated partial update;
 *                                 each field ≤600 / summary ≤1500 REJECTED over
 *                                 length (never a silent truncation, §8.1);
 *                                 content-hygiene rejects fenced code / role
 *                                 markers / tool-call syntax (§15); sets
 *                                 lastSource=settings; from not_started|skipped
 *                                 transitions onboarding state → completed via an
 *                                 ATOMIC CONDITIONAL update (§9.2). Audited as a
 *                                 `system` activity row (what:
 *                                 business_profile_update — D-10).
 *
 * The net-new Settings business-profile CARD component is deferred to the
 * WARP-1123 design packet (Phase 1 Settings work); these routes prove
 * editability now. // WARP-1123 — card mounts against GET/PATCH here.
 *
 * PRIVACY: the profile is LOCAL box state, never sent off the box (§5-12).
 * RBAC via the shared requireRole middleware — never bypassed (§5-8).
 */
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import {
  getBusinessProfile,
  updateBusinessProfile,
  markProfileCompletedFromManualFill,
  checkContentHygiene,
  BUSINESS_PROFILE_FIELD_MAX_CHARS,
  BUSINESS_PROFILE_SUMMARY_MAX_CHARS,
  BUSINESS_PROFILE_SINGLETON_ID,
  type BusinessProfileRow,
} from "../services/business-profile.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

/** The editable fields (§8.1). Each carries its DB-matching hard cap as a
 *  zod `.max()` so an over-length value is a 400, never a silent truncation. */
const field = z.string().max(BUSINESS_PROFILE_FIELD_MAX_CHARS);
const patchSchema = z
  .object({
    summary: z.string().max(BUSINESS_PROFILE_SUMMARY_MAX_CHARS).optional(),
    whatWeDo: field.optional(),
    customers: field.optional(),
    teamShape: field.optional(),
    toolsUsed: field.optional(),
    typicalDay: field.optional(),
    goals: field.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "At least one field is required",
  });

/** Owner/admin see the full profile; family sees the summary only; everyone
 *  else (guest/service) sees nothing. Mirrors composeBusinessBlock's ladder so
 *  the API and the prompt agree exactly. */
function readView(row: BusinessProfileRow, role: string | undefined) {
  if (role === "owner" || role === "admin") {
    return {
      onboardingState: row.onboardingState,
      // WARP-1121 — the dashboard keys the interview overlay (progress
      // eyebrow, resume banner, reopen-as-card) off this id.
      interviewChatId: row.interviewChatId,
      summary: row.summary,
      whatWeDo: row.whatWeDo,
      customers: row.customers,
      teamShape: row.teamShape,
      toolsUsed: row.toolsUsed,
      typicalDay: row.typicalDay,
      goals: row.goals,
      lastSource: row.lastSource,
      reviewNudgeState: row.reviewNudgeState,
      reviewDueAt: row.reviewDueAt,
      reviewDismissedAt: row.reviewDismissedAt,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
  if (role === "family") {
    // Summary ONLY — the goals/customers/pain-points columns never reach a
    // family member (§15). Not even onboardingState, which is an owner concern.
    return { summary: row.summary };
  }
  // guest/service: the business profile is not theirs to read (§12).
  return {};
}

export function createBusinessProfileRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/business-profile",
    requireRole("owner", "admin", "family", "guest", "service"),
    async (req, res, next) => {
      try {
        const profile = await getBusinessProfile(prisma);
        const role = (req as AuthedRequest).user?.role;
        const view = readView(profile, role);
        // WARP-1121 §9.1 — the dashboard gates the interview intro card on
        // the workspace type. Only the owner/admin view carries it.
        // WARP-1341: business-only build — a missing row or a read hiccup
        // resolves to BUSINESS (every workspace IS business now, so the
        // interview affordances are always correct to show).
        if (role === "owner" || role === "admin") {
          let workspaceType = "BUSINESS";
          try {
            const ws = await prisma.workspace.findUnique({ where: { id: 1 } });
            workspaceType = ws?.type ?? "BUSINESS";
          } catch {
            /* keep BUSINESS */
          }
          (view as Record<string, unknown>).workspaceType = workspaceType;
          // WARP-1668 — can THIS user actually open the parked interview?
          // `interviewChatId` alone cannot answer that: the session row is
          // owner-scoped (getConversationForUser is `where: {id, userId}`)
          // and the FK is `onDelete: SetNull`, so the link can be null or
          // point at another admin's session while the singleton state still
          // reads in_progress. The dashboard gates the resume banner on this
          // — a banner that renders must be a banner that works. Fail CLOSED:
          // any doubt (no link, missing row, other owner, read error) is
          // `false`, which hides the banner rather than dead-ending it.
          let interviewResumable = false;
          if (profile.interviewChatId) {
            try {
              const session = await prisma.chatSession.findFirst({
                where: {
                  id: profile.interviewChatId,
                  userId: (req as AuthedRequest).user?.username ?? "",
                },
                select: { id: true },
              });
              interviewResumable = Boolean(session);
            } catch {
              /* keep false — never advertise a resume we cannot honour */
            }
          }
          (view as Record<string, unknown>).interviewResumable =
            interviewResumable;
        }
        res.json(view);
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/business-profile",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const parsed = patchSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid business-profile patch",
            details: parsed.error.flatten(),
          });
          return;
        }

        // Content hygiene (§15): reject fenced code, role markers, and tool-call
        // syntax in every provided string BEFORE it becomes persistent
        // system-prompt content. Reject-not-truncate — the user re-words.
        for (const [key, value] of Object.entries(parsed.data)) {
          if (typeof value !== "string") continue;
          const hygiene = checkContentHygiene(value);
          if (!hygiene.ok) {
            res.status(400).json({
              error: "Invalid business-profile content",
              field: key,
              reason: hygiene.reason,
            });
            return;
          }
        }

        // Capture the prior state for the audit + to know whether the manual
        // fill should transition. getBusinessProfile also materialises the
        // singleton on first PATCH.
        const before = await getBusinessProfile(prisma);
        const userId = (req as AuthedRequest).user?.id ?? null;

        const updated = await updateBusinessProfile(prisma, {
          ...parsed.data,
          lastSource: "settings",
          updatedBy: userId,
        });

        // §9.2 manual-fill transition — atomic + conditional: only moves the row
        // from not_started|skipped → completed, so a concurrent commit/skip
        // can't be clobbered (the loser updates zero rows).
        const transitioned = await markProfileCompletedFromManualFill(prisma);
        const stateAfter = transitioned ? "completed" : updated.onboardingState;

        const changed = Object.keys(parsed.data);
        // Audit — D-10: kind `system`, action in `what`, ids in refs. Never a
        // new ActivityKind (recordSafely would swallow the unknown-kind throw
        // and drop the row silently).
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "building-2",
          what: "business_profile_update",
          sub: `updated ${changed.join(", ")}`,
          refs: {
            surface: "settings-business-profile",
            changed,
            stateBefore: before.onboardingState,
            stateAfter,
          },
          actor: actorFromRequest(req),
        });

        res.json(
          readView(
            { ...updated, onboardingState: stateAfter },
            (req as AuthedRequest).user?.role,
          ),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-1121 (§12) — dismiss the review-due nudge. Explicit-state rule
  // (§5-2): dismissal is a REAL enum value + timestamp, never a nulled
  // schedule field. Phase 4's cron job sets `due`; this route is the only
  // path to `dismissed`. Audited like every write.
  router.post(
    "/business-profile/review-dismiss",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        await getBusinessProfile(prisma); // materialise the singleton
        const dismissedAt = new Date();
        await prisma.businessProfile.update({
          where: { id: BUSINESS_PROFILE_SINGLETON_ID },
          data: {
            reviewNudgeState: "dismissed",
            reviewDismissedAt: dismissedAt,
          },
        });
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "building-2",
          what: "review_dismiss",
          sub: "business-profile review nudge dismissed",
          refs: { surface: "chat-nudge" },
          actor: actorFromRequest(req),
        });
        res.json({
          reviewNudgeState: "dismissed",
          reviewDismissedAt: dismissedAt,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
