/**
 * `/api/setup/state` — first-run setup state machine (PR #372 /
 * docs/ONBOARDING_STATE_MACHINE.md).
 *
 * Replaces the stateless, Nextcloud-`installed`-derived `setupRequired`
 * boolean with an explicit, resumable server-side state.
 *
 *   GET  /api/setup/state
 *     → { appliance: "unclaimed"|"ready", setup_step, user_tour_completed }
 *     The dashboard's AuthGate routes off this: unclaimed → wizard@step;
 *     ready + tour pending → tour; else dashboard.
 *
 *   PATCH /api/setup/state
 *     Body (any non-empty subset):
 *       { setup_step?: SetupStep,         // resumability — persist wizard step
 *         appliance?: "ready",            // wizard-finish transition
 *         user_tour_completed?: true }    // post-claim tour done
 *     → the updated state, same shape as GET.
 *
 * The router is mounted BEFORE the auth middleware in app.ts (allow-listed
 * in middleware/auth.ts) because first-run resumability happens before any
 * user exists, exactly like the existing public POST /auth/setup. The wire
 * shape is snake_case to match the spec contract; the service speaks
 * camelCase internally.
 *
 * AUTH POSTURE (M1/M2, PR #372 re-review):
 *   - GET is PUBLIC and SIDE-EFFECT-FREE (findUnique; never writes — M5).
 *   - PATCH of `setup_step` / `user_tour_completed` stays PUBLIC: these are
 *     low-sensitivity resumability hints that the wizard needs to persist
 *     pre-claim, and neither can claim the box.
 *   - PATCH of `appliance:"ready"` — the lifecycle-MUTATING claim transition
 *     — is GATED. It is honored only when the caller proves they're the
 *     legitimate owner: either a valid dashboard session cookie (the wizard
 *     authenticates at the account step, so the finish PATCH rides that
 *     cookie), or — the durable backstop — the service's M2 precondition
 *     that an admin account already exists (`markApplianceReady` rejects an
 *     account-less box with 409). An unauthenticated pre-claim caller can
 *     therefore neither take the box over (flip it ready early) nor lock the
 *     owner out.
 *
 * The GATE constraint (PR #372) keeps claim / org / team out of SetupStep,
 * so an unknown step is a 400 here (the service's InvalidSetupStepError),
 * never silently coerced onto a resume target the wizard can't render.
 */
import { Router, type Request } from "express";
import { type PrismaClient } from "@prisma/client";
import pino from "pino";
import { z } from "zod";
import {
  getSetupState,
  setSetupStep,
  markApplianceReady,
  markTourCompleted,
  isSetupStep,
  InvalidSetupStepError,
  SetupNotCompleteError,
  type SetupState,
} from "../services/setup.service.js";
import { verifyAccessToken } from "../services/jwt.service.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";

const logger = pino({ name: "setup-route" });

/** Map the camelCase domain object onto the snake_case wire contract. */
function toWire(state: SetupState): {
  appliance: "unclaimed" | "ready";
  setup_step: string;
  user_tour_completed: boolean;
} {
  return {
    appliance: state.appliance,
    setup_step: state.setupStep,
    user_tour_completed: state.userTourCompleted,
  };
}

// PATCH body: every field optional, but `.refine` requires at least one so
// an empty patch is a 400 rather than a silent no-op. `setup_step` is
// validated against the shipped enum by the service (isSetupStep);
// `appliance` only ever moves forward to "ready" (the wizard-finish
// transition) — "unclaimed" is the boot default and isn't a client-driven
// target. `user_tour_completed` only flips true (you can't un-see the tour).
const patchSchema = z
  .object({
    setup_step: z.string().min(1).optional(),
    appliance: z.literal("ready").optional(),
    user_tour_completed: z.literal(true).optional(),
  })
  .refine(
    (b) =>
      b.setup_step !== undefined ||
      b.appliance !== undefined ||
      b.user_tour_completed !== undefined,
    { message: "At least one of setup_step, appliance, user_tour_completed is required" },
  );

export function createSetupRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/setup/state ───────────────────────────────────────
  router.get("/setup/state", async (_req: Request, res, next) => {
    try {
      const state = await getSetupState(prisma);
      res.json(toWire(state));
    } catch (err) {
      next(err);
    }
  });

  // ── PATCH /api/setup/state ─────────────────────────────────────
  router.patch("/setup/state", async (req: Request, res, next) => {
    try {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid setup state update",
          code: "INVALID_SETUP_PATCH",
          details: parsed.error.flatten(),
        });
        return;
      }
      const body = parsed.data;

      // Pre-validate the step here so we 400 BEFORE any write — the service
      // would also reject it, but failing fast keeps the persisted row
      // untouched on a bad request.
      if (body.setup_step !== undefined && !isSetupStep(body.setup_step)) {
        res.status(400).json({
          error: `Unknown setup step "${body.setup_step}"`,
          code: "INVALID_SETUP_STEP",
        });
        return;
      }

      // M1 — the `appliance:"ready"` claim is the only lifecycle-MUTATING
      // transition, so it is the only one we gate. A request is allowed to
      // claim the box when EITHER:
      //   (a) it carries a valid dashboard session cookie (the wizard's
      //       account step authenticated the owner, so the finish PATCH
      //       rides that cookie — this router is mounted before
      //       authMiddleware so we verify the cookie inline, the same way
      //       routes/pm.ts does for the OIDC authorize endpoint), OR
      //   (b) an admin account already exists, in which case the box is
      //       genuinely claimable and `markApplianceReady` (M2) will honor
      //       it; the service itself fails CLOSED with 409 when no admin
      //       exists, so an anonymous pre-claim caller can never flip it.
      // The session check here is a fast 403 for the common anonymous case;
      // the M2 precondition in the service is the authoritative backstop.
      let claimAuthorized = false;
      if (body.appliance === "ready") {
        const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
        const session = sessionToken ? verifyAccessToken(sessionToken) : null;
        if (session) {
          claimAuthorized = true;
        } else if ((await prisma.user.count()) === 0) {
          res.status(403).json({
            error:
              "Claiming the appliance (appliance:\"ready\") requires an authenticated session or a completed setup.",
            code: "SETUP_CLAIM_FORBIDDEN",
          });
          return;
        }
      }

      // Apply the requested transitions. Order is deliberate: persist the
      // step first (resumability), then the terminal flips. Each helper
      // upserts the singleton and returns the latest state, so the last
      // one wins as the response.
      let latest: SetupState | null = null;
      if (body.setup_step !== undefined) {
        latest = await setSetupStep(prisma, body.setup_step);
      }
      if (body.appliance === "ready") {
        // `authorized` short-circuits the service's admin-count precondition
        // when a valid session proved ownership (covers the freshly-claimed
        // window); otherwise the service re-checks admin existence (M2).
        latest = await markApplianceReady(prisma, { authorized: claimAuthorized });
      }
      if (body.user_tour_completed === true) {
        latest = await markTourCompleted(prisma);
      }

      // `latest` is guaranteed non-null: the schema's refine() rejects an
      // empty patch, so at least one branch above ran.
      res.json(toWire(latest ?? (await getSetupState(prisma))));
    } catch (err) {
      if (err instanceof InvalidSetupStepError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      // M2 — claiming an account-less box is a 409 (well-formed request,
      // but the appliance isn't in a claimable state yet). Fail CLOSED:
      // the appliance stays unclaimed.
      if (err instanceof SetupNotCompleteError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      logger.error({ err }, "Failed to update setup state");
      next(err);
    }
  });

  return router;
}
