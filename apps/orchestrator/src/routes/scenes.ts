/**
 * WARP-474 (G2) — Smart-home scenes CRUD + batch-run.
 *
 * Routes owned by this file:
 *   GET    /api/scenes              — list with action counts (any role read)
 *   GET    /api/scenes/:id          — full scene + ordered actions
 *   POST   /api/scenes              — create (owner+admin per ADR-005 / schema)
 *   PATCH  /api/scenes/:id          — rename / change icon / replace actions
 *   DELETE /api/scenes/:id          — owner+admin
 *   POST   /api/scenes/:id/run      — batch-execute via Matter controller.
 *                                     Per-action failures captured + surfaced
 *                                     in the run result; one ActivityRow per
 *                                     run (in addition to the per-command
 *                                     rows recorded by sendMatterCommand
 *                                     internally). Requires `?confirm=true`
 *                                     server-side — mirrors run_scene's
 *                                     `requiresConfirmation: true` for any
 *                                     caller that bypasses the dashboard.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import {
  actorFromRequest,
  type ActivityActor,
} from "../services/activity.service.js";
import { executeScene } from "../services/scene-runner.service.js";
import {
  isSupportedRrule,
  isSupportedTimezone,
  nextFireFromRrule,
} from "../utils/rrule.js";
import { randomBytes } from "node:crypto";

const sceneActionInputSchema = z.object({
  deviceNodeId: z.string().min(1),
  command: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

const createSceneSchema = z.object({
  name: z.string().min(1).max(120),
  icon: z.string().max(64).optional(),
  actions: z.array(sceneActionInputSchema).min(1).max(64),
});

const patchSceneSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  icon: z.string().max(64).nullable().optional(),
  actions: z.array(sceneActionInputSchema).min(1).max(64).optional(),
});

// feat/scene-schedules — schedule a saved routine on an RRULE cadence.
// `rrule` is validated against the supported FREQ=DAILY|WEEKLY subset
// (isSupportedRrule) AFTER the shape check, so a malformed rule 400s at
// the boundary rather than persisting a row the ticker would immediately
// disable.
const createScheduleSchema = z.object({
  rrule: z.string().min(1).max(512),
  // KAN-6 — the IANA zone the rrule's wall-clock time is interpreted in.
  // Optional: omitted → "UTC", which is the column default and the
  // pre-KAN-6 behaviour, so an older client keeps working unchanged. The
  // value is validated as a resolvable IANA identifier below (a bad zone
  // 400s rather than persisting a row the ticker would immediately disable).
  timezone: z.string().min(1).max(64).optional(),
});
const patchScheduleSchema = z.object({
  enabled: z.boolean(),
});

interface SceneScheduleRow {
  id: string;
  sceneId: string;
  rrule: string;
  timezone: string;
  nextFireAt: Date;
  enabled: boolean;
  createdBy: string | null;
  lastFiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Serialised shape returned to the dashboard. */
function serializeSchedule(s: SceneScheduleRow) {
  return {
    id: s.id,
    sceneId: s.sceneId,
    rrule: s.rrule,
    timezone: s.timezone,
    nextFireAt: s.nextFireAt,
    enabled: s.enabled,
    createdBy: s.createdBy,
    lastFiredAt: s.lastFiredAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

interface SceneRow {
  id: string;
  name: string;
  icon: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SceneActionRow {
  id: string;
  sceneId: string;
  idx: number;
  deviceNodeId: string;
  command: string;
  args: unknown;
}

/**
 * Pluggable Matter dispatcher — tests inject a mock so the batch
 * executor is exercisable without standing up the Matter.js controller.
 * Production wiring imports the real `sendMatterCommand` (see app.ts /
 * createScenesRouter caller).
 */
export interface MatterDispatcher {
  sendCommand(
    nodeId: string,
    command: string,
    // WARP-1010: per-command activity rows carry the scene's actor
    // (the authed runner, or ai for the schedule ticker) instead of a
    // hardcoded {ai, null}. Position mirrors sendMatterCommand.
    actor: ActivityActor,
    args?: Record<string, unknown>,
  ): Promise<{ status: string; result?: unknown }>;
}

// TOOLS-01 / WARP-640 — scene-run confirmation tokens. A scene batches Tier-2
// device actions, so an unconfirmed run must NOT execute: it mints a single-use,
// scene-bound, TTL'd token and replies 202, so the chat "Approve & run" chip can
// echo the token back to actually run it. Mirrors network-safety.service's
// pendingConfirmations (single-use, bound, expiring) so a leaked/replayed token
// can't fire an arbitrary scene. The dashboard scenes page keeps using
// ?confirm=true (it pops its own confirm dialog).
const SCENE_CONFIRM_TTL_MS = 5 * 60_000; // 5 min — user must see the chip + click
const MAX_PENDING_SCENE_CONFIRMS = 200;
const pendingSceneConfirms = new Map<string, { sceneId: string; expiresAt: number }>();

function mintSceneConfirmToken(sceneId: string): string {
  const now = Date.now();
  for (const [t, p] of pendingSceneConfirms) {
    if (p.expiresAt <= now) pendingSceneConfirms.delete(t); // opportunistic GC
  }
  const token = randomBytes(32).toString("hex");
  pendingSceneConfirms.set(token, { sceneId, expiresAt: now + SCENE_CONFIRM_TTL_MS });
  return token;
}

/** Single-use: valid once, unexpired, and only for the scene it was minted for.
 *  Always deletes the token first (replay-proof), then validates. */
function consumeSceneConfirmToken(token: string, sceneId: string): boolean {
  const pending = pendingSceneConfirms.get(token);
  if (!pending) return false;
  pendingSceneConfirms.delete(token);
  return pending.expiresAt > Date.now() && pending.sceneId === sceneId;
}

export function createScenesRouter(
  prisma: PrismaClient,
  matter: MatterDispatcher,
): Router {
  const router = Router();

  router.get(
    "/scenes",
    requireRole("owner", "admin", "family", "guest"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const scenes = (await prisma.scene.findMany({
          orderBy: { createdAt: "asc" },
          include: { _count: { select: { actions: true } } },
        })) as unknown as Array<SceneRow & { _count: { actions: number } }>;
        res.json({
          scenes: scenes.map((s) => ({
            id: s.id,
            name: s.name,
            icon: s.icon,
            createdBy: s.createdBy,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            actionCount: s._count.actions,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/scenes/:id",
    requireRole("owner", "admin", "family", "guest"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scene = (await prisma.scene.findUnique({
          where: { id: req.params.id },
          include: { actions: { orderBy: { idx: "asc" } } },
        })) as unknown as
          | (SceneRow & { actions: SceneActionRow[] })
          | null;
        if (!scene) {
          res.status(404).json({ error: "Scene not found" });
          return;
        }
        res.json({
          id: scene.id,
          name: scene.name,
          icon: scene.icon,
          createdBy: scene.createdBy,
          createdAt: scene.createdAt,
          updatedAt: scene.updatedAt,
          actions: scene.actions.map((a) => ({
            id: a.id,
            idx: a.idx,
            deviceNodeId: a.deviceNodeId,
            command: a.command,
            args: a.args,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/scenes",
    // Schema docstring (and ADR-005) say scenes are owner+admin write
    // surfaces — family reads but does NOT author. The earlier guard
    // included family by accident and contradicted the documented
    // contract; tightening to match.
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = createSceneSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid scene", details: parsed.error.flatten() });
          return;
        }
        const actor = req.user?.username ?? null;
        const scene = (await prisma.scene.create({
          data: {
            name: parsed.data.name,
            icon: parsed.data.icon ?? null,
            createdBy: actor,
            actions: {
              create: parsed.data.actions.map((a, idx) => ({
                idx,
                deviceNodeId: a.deviceNodeId,
                command: a.command,
                args: (a.args ?? null) as any,
              })),
            },
          },
          include: { actions: { orderBy: { idx: "asc" } } },
        })) as unknown as SceneRow & { actions: SceneActionRow[] };

        await recordActivity({
          kind: "smart_home",
          severity: "info",
          sourceIcon: "home",
          what: "Scene created",
          sub: scene.name,
          refs: { sceneId: scene.id, actionCount: scene.actions.length, actor },
          actor: actorFromRequest(req),
        });

        res.status(201).json(scene);
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/scenes/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = patchSceneSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid patch", details: parsed.error.flatten() });
          return;
        }
        const existing = await prisma.scene.findUnique({
          where: { id: req.params.id },
        });
        if (!existing) {
          res.status(404).json({ error: "Scene not found" });
          return;
        }

        // If `actions` is in the patch, replace wholesale — simpler than
        // a diff per-action and matches the §2.7 editor UX (drag-reorder
        // + save round-trip rewrites the list).
        if (parsed.data.actions) {
          await prisma.sceneAction.deleteMany({
            where: { sceneId: req.params.id },
          });
        }

        // icon: pass parsed.data.icon directly — Zod's `.nullable().optional()`
        // surfaces `undefined` when the key is absent (Prisma skip) and
        // `null` when the operator explicitly clears it (Prisma sets
        // column to NULL). `?? undefined` would collapse the explicit
        // clear into skip and make icon impossible to remove once set.
        const updated = (await prisma.scene.update({
          where: { id: req.params.id },
          data: {
            name: parsed.data.name,
            icon: parsed.data.icon,
            actions: parsed.data.actions
              ? {
                  create: parsed.data.actions.map((a, idx) => ({
                    idx,
                    deviceNodeId: a.deviceNodeId,
                    command: a.command,
                    args: (a.args ?? null) as any,
                  })),
                }
              : undefined,
          },
          include: { actions: { orderBy: { idx: "asc" } } },
        })) as unknown as SceneRow & { actions: SceneActionRow[] };

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/scenes/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const existing = await prisma.scene.findUnique({
          where: { id: req.params.id },
        });
        if (!existing) {
          res.status(404).json({ error: "Scene not found" });
          return;
        }
        await prisma.scene.delete({ where: { id: req.params.id } });
        res.json({ id: req.params.id, deleted: true });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/scenes/:id/run",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scene = (await prisma.scene.findUnique({
          where: { id: req.params.id },
          include: { actions: { orderBy: { idx: "asc" } } },
        })) as unknown as
          | (SceneRow & { actions: SceneActionRow[] })
          | null;
        if (!scene) {
          res.status(404).json({ error: "Scene not found" });
          return;
        }

        // Server-side mirror of the tool's `requiresConfirmation: true`.
        // The dashboard already pops a confirm dialog before calling,
        // but a non-dashboard caller (HTTP MCP client, CLI, voice
        // bypassing lock-refusal) would otherwise fire actions on the
        // first call. Require `?confirm=true` so the LLM agent must
        // emit the confirmation flag — same posture as #294's run-now
        // gate.
        // TOOLS-01 / WARP-640 — confirmation gate. A scene batches Tier-2
        // device actions, so it must NOT run on an unconfirmed call. Confirmed
        // via either the dashboard scenes page's ?confirm=true (its own confirm
        // dialog) OR a valid single-use confirmationToken (body) this server
        // minted for THIS scene — the path the chat "Approve & run" chip uses.
        // Otherwise mint a token and reply 202 confirmation_required.
        const queryConfirmed =
          String(req.query.confirm ?? "").toLowerCase() === "true";
        const suppliedToken =
          typeof (req.body as { confirmationToken?: unknown } | undefined)
            ?.confirmationToken === "string"
            ? (req.body as { confirmationToken: string }).confirmationToken
            : "";
        const tokenConfirmed =
          suppliedToken !== "" && consumeSceneConfirmToken(suppliedToken, scene.id);
        if (!queryConfirmed && !tokenConfirmed) {
          if (suppliedToken !== "") {
            // Token supplied but invalid / expired / not for this scene.
            res.status(403).json({
              error: "confirmation_invalid",
              detail:
                "confirmation token is invalid, expired, or not for this scene",
              sceneId: scene.id,
            });
            return;
          }
          if (pendingSceneConfirms.size >= MAX_PENDING_SCENE_CONFIRMS) {
            res.status(429).json({ error: "too_many_pending_confirmations" });
            return;
          }
          const confirmationToken = mintSceneConfirmToken(scene.id);
          res.status(202).json({
            status: "confirmation_required",
            confirmationToken,
            sceneId: scene.id,
            name: scene.name,
            actionCount: scene.actions.length,
            message: `Running "${scene.name}" will run ${scene.actions.length} device action(s). Approve to run it.`,
          });
          return;
        }

        // Walk actions in idx order via the shared executor. Partial-
        // failure tolerant: a dead bulb on action 2 doesn't abort action
        // 3 (the lights that work still work). The same `executeScene`
        // path the scene-schedule ticker uses, so an interactive run and
        // an unattended scheduled run can't drift. The dashboard renders
        // per-action status from the `results` array.
        const run = await executeScene(prisma, matter, scene, {
          triggeredBy: "user",
          actor: req.user?.username ?? null,
          activityActor: actorFromRequest(req),
        });

        res.json(run);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── feat/scene-schedules — recurring routine schedules ──
  //
  // GET    /scenes/:id/schedules        owner/admin/family read
  // POST   /scenes/:id/schedules        owner/admin author; bad RRULE → 400
  // PATCH  /scenes/:id/schedules/:sid   owner/admin toggle enabled
  // DELETE /scenes/:id/schedules/:sid   owner/admin
  //
  // SAFETY: a scheduled fire bypasses the per-run scene confirm-token
  // (see the run handler above). That is OK ONLY because *creating a
  // schedule IS the owner/admin opt-in* — the same justification the
  // WARP-463 tool-schedule-ticker uses for "write-tier specs … pause
  // until accept": here the accept happens at schedule-creation time, and
  // every fire is audited by executeScene. So the author routes are
  // owner/admin only; family can read the cadence but not arm it.

  router.get(
    "/scenes/:id/schedules",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scene = await prisma.scene.findUnique({
          where: { id: req.params.id },
        });
        if (!scene) {
          res.status(404).json({ error: "Scene not found" });
          return;
        }
        const schedules = (await prisma.sceneSchedule.findMany({
          where: { sceneId: req.params.id },
          orderBy: { nextFireAt: "asc" },
        })) as unknown as SceneScheduleRow[];
        res.json({ schedules: schedules.map(serializeSchedule) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/scenes/:id/schedules",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = createScheduleSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid schedule",
            details: parsed.error.flatten(),
          });
          return;
        }
        // Validate the RRULE against the supported subset BEFORE the
        // scene lookup write so a bad rule never persists a row the
        // ticker would immediately disable. rrule.ts is UTC-only; the
        // dashboard editor converts local wall-clock → UTC.
        if (!isSupportedRrule(parsed.data.rrule)) {
          res.status(400).json({
            error: "Unsupported RRULE",
            detail:
              "Only FREQ=DAILY and FREQ=WEEKLY rules (with BYDAY/BYHOUR/BYMINUTE) are supported.",
          });
          return;
        }
        // KAN-6 — the rrule's wall-clock time is interpreted in this zone.
        // Default to UTC (the column default + pre-KAN-6 behaviour). Reject
        // an unresolvable identifier before any write so we never persist a
        // row the ticker would immediately disable.
        const timezone = parsed.data.timezone ?? "UTC";
        if (!isSupportedTimezone(timezone)) {
          res.status(400).json({
            error: "Invalid timezone",
            detail: "timezone must be a valid IANA identifier (e.g. America/Los_Angeles).",
          });
          return;
        }
        const scene = await prisma.scene.findUnique({
          where: { id: req.params.id },
        });
        if (!scene) {
          res.status(404).json({ error: "Scene not found" });
          return;
        }
        const now = new Date();
        const nextFireAt = nextFireFromRrule(parsed.data.rrule, now, timezone);
        if (nextFireAt === null) {
          // Defensive: isSupportedRrule passed but no future fire could be
          // computed. Treat as a bad rule rather than persist a NULL.
          res.status(400).json({ error: "Unsupported RRULE" });
          return;
        }
        const actor = req.user?.username ?? null;
        const created = (await prisma.sceneSchedule.create({
          data: {
            sceneId: req.params.id,
            rrule: parsed.data.rrule,
            timezone,
            nextFireAt,
            enabled: true,
            createdBy: actor,
          },
        })) as unknown as SceneScheduleRow;

        await recordActivity({
          kind: "smart_home",
          severity: "info",
          sourceIcon: "clock",
          what: "Scene schedule created",
          sub: `${scene.name} (${parsed.data.rrule})`,
          refs: {
            sceneId: req.params.id,
            scheduleId: created.id,
            rrule: parsed.data.rrule,
            actor,
          },
          actor: actorFromRequest(req),
        });

        res.status(201).json(serializeSchedule(created));
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/scenes/:id/schedules/:sid",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = patchScheduleSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid patch",
            details: parsed.error.flatten(),
          });
          return;
        }
        const existing = (await prisma.sceneSchedule.findUnique({
          where: { id: req.params.sid },
        })) as unknown as SceneScheduleRow | null;
        if (!existing || existing.sceneId !== req.params.id) {
          res.status(404).json({ error: "Schedule not found" });
          return;
        }

        // Re-enabling a (possibly long-stale) schedule recomputes a fresh
        // future nextFireAt so it fires on cadence rather than instantly
        // on the next tick. Disabling just flips the flag — state is the
        // explicit `enabled` column, never derived.
        const data: { enabled: boolean; nextFireAt?: Date } = {
          enabled: parsed.data.enabled,
        };
        if (parsed.data.enabled && !existing.enabled) {
          // KAN-6 — recompute against the row's stored zone so a re-enabled
          // schedule fires at the owner's local wall-clock, DST-correct.
          const next = nextFireFromRrule(
            existing.rrule,
            new Date(),
            existing.timezone,
          );
          if (next === null) {
            res.status(400).json({
              error: "Unsupported RRULE",
              detail: "This schedule's RRULE can no longer be advanced.",
            });
            return;
          }
          data.nextFireAt = next;
        }
        const updated = (await prisma.sceneSchedule.update({
          where: { id: req.params.sid },
          data,
        })) as unknown as SceneScheduleRow;
        res.json(serializeSchedule(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/scenes/:id/schedules/:sid",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const existing = (await prisma.sceneSchedule.findUnique({
          where: { id: req.params.sid },
        })) as unknown as SceneScheduleRow | null;
        if (!existing || existing.sceneId !== req.params.id) {
          res.status(404).json({ error: "Schedule not found" });
          return;
        }
        await prisma.sceneSchedule.delete({ where: { id: req.params.sid } });
        res.json({ id: req.params.sid, deleted: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
