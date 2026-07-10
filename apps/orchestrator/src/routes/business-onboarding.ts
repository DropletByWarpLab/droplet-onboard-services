/**
 * WARP-1121 (Phase 3, §12) — the onboarding-interview lifecycle API.
 *
 *   POST /api/business-onboarding/start    §9.2 conditional transition;
 *                                          idempotent resume while an
 *                                          interview is in flight.
 *   POST /api/business-onboarding/skip     §9.2 conditional transition;
 *                                          409 on race / illegal edge.
 *   POST /api/business-onboarding/commit   Transactional, bounded (≤20
 *                                          facts ≤280 · fields ≤600 ·
 *                                          summary ≤1500), audience clamped
 *                                          (D-11), re-run supersession,
 *                                          server-appended closing message.
 *
 * All three owner/admin only (§9.5 — lesser roles lack the write role to
 * commit BY CONSTRUCTION, not just by UI omission). Every write audits as
 * kind `system` with the action in `what` (D-10), and the tests assert the
 * PERSISTED ActivityRow (recordSafely swallows unknown-kind throws, §5-13).
 *
 * `GET /api/setup/state` is deliberately untouched (§5-9) — onboarding
 * state travels on these authenticated endpoints only.
 */
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import {
  startOnboarding,
  skipOnboarding,
  commitOnboarding,
  OnboardingStateConflictError,
  OnboardingPayloadError,
  ONBOARDING_MAX_FACTS,
  ONBOARDING_FACT_MAX_CHARS,
} from "../services/business-onboarding.service.js";
import {
  BUSINESS_PROFILE_FIELD_MAX_CHARS,
  BUSINESS_PROFILE_SUMMARY_MAX_CHARS,
} from "../services/business-profile.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

/** Commit payload (§9.2 bounds). Over-length is a 400 (reject, never a
 *  silent truncation). `audience` accepts any string and the SERVICE clamps
 *  to family unless exactly "admin" (D-11) — the payload is assembled from
 *  model-generated JSON, so unknown values must not fail the whole commit. */
const commitSchema = z.object({
  profile: z
    .object({
      whatWeDo: z.string().max(BUSINESS_PROFILE_FIELD_MAX_CHARS).optional(),
      customers: z.string().max(BUSINESS_PROFILE_FIELD_MAX_CHARS).optional(),
      teamShape: z.string().max(BUSINESS_PROFILE_FIELD_MAX_CHARS).optional(),
      toolsUsed: z.string().max(BUSINESS_PROFILE_FIELD_MAX_CHARS).optional(),
      typicalDay: z.string().max(BUSINESS_PROFILE_FIELD_MAX_CHARS).optional(),
      goals: z.string().max(BUSINESS_PROFILE_FIELD_MAX_CHARS).optional(),
    })
    .optional(),
  summary: z.string().max(BUSINESS_PROFILE_SUMMARY_MAX_CHARS).optional(),
  facts: z
    .array(
      z.object({
        category: z.enum([
          "Business",
          "Tone",
          "Workflow",
          "Schedule",
          "Scope",
          "Other",
        ]),
        fact: z.string().min(1).max(ONBOARDING_FACT_MAX_CHARS),
        audience: z.string().optional(),
      }),
    )
    .max(ONBOARDING_MAX_FACTS)
    .optional(),
});

export function createBusinessOnboardingRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post(
    "/business-onboarding/start",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const userId = (req as AuthedRequest).user?.username;
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const result = await startOnboarding(prisma, userId);
        if (result.created) {
          await recordActivity({
            kind: "system",
            severity: "info",
            sourceIcon: "building-2",
            what: "business_onboarding_start",
            sub: `interview ${result.state === "re_running" ? "re-run" : "started"}`,
            refs: {
              conversationId: result.conversationId,
              state: result.state,
            },
            actor: actorFromRequest(req),
          });
        }
        res.json(result);
      } catch (err) {
        if (err instanceof OnboardingStateConflictError) {
          res.status(409).json({
            error: "onboarding_state_conflict",
            state: err.current,
          });
          return;
        }
        next(err);
      }
    },
  );

  router.post(
    "/business-onboarding/skip",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const userId = (req as AuthedRequest).user?.username;
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const result = await skipOnboarding(prisma, userId);
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "building-2",
          what: "business_onboarding_skip",
          sub: `${result.from} → ${result.state}`,
          refs: { from: result.from, state: result.state },
          actor: actorFromRequest(req),
        });
        res.json(result);
      } catch (err) {
        if (err instanceof OnboardingStateConflictError) {
          res.status(409).json({
            error: "onboarding_state_conflict",
            state: err.current,
          });
          return;
        }
        next(err);
      }
    },
  );

  router.post(
    "/business-onboarding/commit",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const userId = (req as AuthedRequest).user?.username;
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const parsed = commitSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "invalid_commit_payload",
            details: parsed.error.flatten(),
          });
          return;
        }
        const result = await commitOnboarding(prisma, userId, parsed.data);
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "building-2",
          what: "business_onboarding_commit",
          sub: `profile saved · ${result.factsSaved} facts` +
            (result.factsSuperseded > 0
              ? ` · ${result.factsSuperseded} superseded`
              : ""),
          refs: {
            factsSaved: result.factsSaved,
            factsSuperseded: result.factsSuperseded,
            fieldsSaved: Object.keys(parsed.data.profile ?? {}),
            summarySaved: parsed.data.summary !== undefined,
          },
          actor: actorFromRequest(req),
        });
        res.json(result);
      } catch (err) {
        if (err instanceof OnboardingStateConflictError) {
          res.status(409).json({
            error: "onboarding_state_conflict",
            state: err.current,
          });
          return;
        }
        if (err instanceof OnboardingPayloadError) {
          res.status(400).json({
            error: "invalid_commit_payload",
            message: err.message,
          });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
