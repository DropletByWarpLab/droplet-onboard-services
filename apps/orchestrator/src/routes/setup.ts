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
 * BOTH endpoints are PUBLIC — mounted BEFORE the auth middleware in app.ts
 * and allow-listed in middleware/auth.ts. First-run happens before any
 * user exists, exactly like the existing public POST /auth/setup. The
 * wire shape is snake_case to match the spec contract; the service speaks
 * camelCase internally.
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
  type SetupState,
} from "../services/setup.service.js";

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

      // Apply the requested transitions. Order is deliberate: persist the
      // step first (resumability), then the terminal flips. Each helper
      // upserts the singleton and returns the latest state, so the last
      // one wins as the response.
      let latest: SetupState | null = null;
      if (body.setup_step !== undefined) {
        latest = await setSetupStep(prisma, body.setup_step);
      }
      if (body.appliance === "ready") {
        latest = await markApplianceReady(prisma);
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
      logger.error({ err }, "Failed to update setup state");
      next(err);
    }
  });

  return router;
}
