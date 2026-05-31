/**
 * Phone-home egress routes (WARP-613, ADR-012).
 *
 * Declarative desired-state surface — like the schedule routes, these write
 * settings/flags and let the egress reconciler enforce on the router within one
 * tick. No immediate router dispatch here, so no Tier-2 confirmation token: the
 * settings write is the user's confirmation (owner/admin only). The LLM-facing
 * path (`set_phone_home_blocking` tool) carries `requiresConfirmation`.
 *
 *   GET   /network/phone-home → { enabled, cameras, groups:[{id,name,blockPhoneHome}] }
 *   PATCH /network/phone-home   { enabled?, cameras? } → updated state
 *
 * Per-group flags toggle via the existing PATCH /network/groups/:id
 * (network-devices.routes.ts), which accepts `blockPhoneHome`.
 */
import type { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import {
  getPhoneHomeSettings,
  getPhoneHomeView,
  setPhoneHomeSetting,
  MASTER_SETTING_KEY,
  CAMERAS_SETTING_KEY,
} from "../services/egress.service.js";

export interface PhoneHomeDeps {
  prisma: PrismaClient;
}

export function registerPhoneHomeRoutes(router: Router, deps: PhoneHomeDeps): void {
  const { prisma } = deps;

  // Read is owner/admin/family (family sees the posture read-only, same as the
  // settings tree); writes below stay owner/admin only.
  router.get(
    "/network/phone-home",
    requireRole("owner", "admin", "family"),
    async (_req, res, next) => {
      try {
        // WARP-613 option A: returns per-scope desired + applied + appliedAt so
        // the dashboard can show "Applying… → Blocked" and "enforced {ago}".
        res.json(await getPhoneHomeView(prisma));
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/network/phone-home",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return res.status(400).json({ error: "Invalid body" });
        }
        if (body.enabled === undefined && body.cameras === undefined) {
          return res
            .status(400)
            .json({ error: "Send at least one of `enabled`, `cameras`" });
        }
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
          return res.status(400).json({ error: "`enabled` must be a boolean" });
        }
        if (body.cameras !== undefined && typeof body.cameras !== "boolean") {
          return res.status(400).json({ error: "`cameras` must be a boolean" });
        }

        if (body.enabled !== undefined) {
          await setPhoneHomeSetting(prisma, MASTER_SETTING_KEY, body.enabled);
        }
        if (body.cameras !== undefined) {
          await setPhoneHomeSetting(prisma, CAMERAS_SETTING_KEY, body.cameras);
        }

        const settings = await getPhoneHomeSettings(prisma);
        res.json({ status: "ok", ...settings });
      } catch (err) {
        next(err);
      }
    },
  );
}
