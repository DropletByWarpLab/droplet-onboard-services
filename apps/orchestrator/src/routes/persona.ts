/**
 * WARP-1118 — the personality API (§7.3, §12).
 *
 *   GET   /api/persona   Role-split read. owner/admin get ALL raw fields
 *                        (incl. customInstructions — sensitive steering text
 *                        a lesser role has no business reading); every other
 *                        role gets `preset` + `verbosity` only. Returns the
 *                        RAW persona fields, never the composed prompt block
 *                        (that is /api/persona/prompt, Phase 1).
 *   PATCH /api/persona   owner/admin only. zod-validated partial update (incl.
 *                        the 1200-char customInstructions cap enforced BOTH
 *                        here and as a DB constraint). Audited as a `system`
 *                        activity row (`what: persona_update`, before/after
 *                        preset in refs — D-10). Effective on the next turn;
 *                        no restart, no cache invalidation (§7.2).
 *
 *   GET /api/persona/prompt   WARP-1119 (§12, §14). The COMPOSED persona
 *                        block as plain text — consumed by voice-io's
 *                        greeting path at session start with its service
 *                        credential. owner/admin may read it too (debugging).
 *                        family/guest are 403: the composed block embeds the
 *                        raw customInstructions text the role-split GET
 *                        deliberately withholds from them.
 *
 * PRIVACY: persona rows are LOCAL box state, never sent off the box (§5-12).
 * RBAC via the shared requireRole middleware — never bypassed (§5-8).
 */
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import {
  composePersonaBlock,
  getPersona,
  updatePersona,
  type PersonaRow,
} from "../services/persona.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

/** Must match the Prisma PersonaPreset / PersonaVerbosity enums verbatim. */
const presetEnum = z.enum([
  "warm_friendly",
  "professional_precise",
  "founder",
  "direct_technical",
]);
const verbosityEnum = z.enum(["concise", "balanced", "detailed"]);

/** PATCH body — every field optional (partial update), but at least one
 *  required. customInstructions capped at 1200 to match the DB
 *  `@db.VarChar(1200)` constraint; over-length is a 400, never a silent
 *  truncation. */
const patchSchema = z
  .object({
    preset: presetEnum.optional(),
    verbosity: verbosityEnum.optional(),
    useFirstNames: z.boolean().optional(),
    customInstructions: z.string().max(1200).optional(),
  })
  .refine(
    (d) =>
      d.preset !== undefined ||
      d.verbosity !== undefined ||
      d.useFirstNames !== undefined ||
      d.customInstructions !== undefined,
    { message: "At least one field is required" },
  );

/** Owner/admin see every raw field; everyone else sees style only. */
function readView(row: PersonaRow, role: string | undefined) {
  if (role === "owner" || role === "admin") {
    return {
      preset: row.preset,
      verbosity: row.verbosity,
      useFirstNames: row.useFirstNames,
      customInstructions: row.customInstructions,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
  // family/guest/service: the reply style is observable anyway, but the raw
  // customInstructions text is not exposed (§7.3).
  return { preset: row.preset, verbosity: row.verbosity };
}

export function createPersonaRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/persona",
    requireRole("owner", "admin", "family", "guest", "service"),
    async (req, res, next) => {
      try {
        const persona = await getPersona(prisma);
        const role = (req as AuthedRequest).user?.role;
        res.json(readView(persona, role));
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-1119 — voice threading (§14). Plain text (not JSON) so voice-io can
  // prepend the body to its greeting prompt verbatim, no parsing to drift.
  // The block is composed fresh per request (single-row read, §7.2), so a
  // persona change is live on the next voice session without a restart.
  router.get(
    "/persona/prompt",
    requireRole("owner", "admin", "service"),
    async (_req, res, next) => {
      try {
        const persona = await getPersona(prisma);
        res.type("text/plain").send(composePersonaBlock(persona));
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/persona",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const parsed = patchSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid persona patch", details: parsed.error.flatten() });
          return;
        }
        // Capture the before-preset for the audit refs (§7.3). getPersona
        // also materialises the singleton on first PATCH.
        const before = await getPersona(prisma);
        const userId = (req as AuthedRequest).user?.id ?? null;

        const updated = await updatePersona(prisma, {
          ...parsed.data,
          updatedBy: userId,
        });

        // Audit — D-10: kind `system`, action in `what`, ids/before-after in
        // refs. Never a new ActivityKind (recordSafely would swallow the
        // unknown-kind throw and drop the row silently).
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "sliders-horizontal",
          what: "persona_update",
          sub: `preset ${before.preset} → ${updated.preset}`,
          refs: {
            surface: "settings-persona",
            before: before.preset,
            after: updated.preset,
            changed: Object.keys(parsed.data),
          },
          actor: actorFromRequest(req),
        });

        res.json(readView(updated, (req as AuthedRequest).user?.role));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
