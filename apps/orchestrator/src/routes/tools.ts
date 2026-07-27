/**
 * WARP-462 (C1) — productized workflow CRUD + run-now + run history.
 *
 * Routes owned by this file:
 *   GET    /api/tools?status=&category=         — list filterable
 *   GET    /api/tools/:slug                     — full spec + ordered steps
 *   POST   /api/tools                           — create draft
 *   PATCH  /api/tools/:slug                     — edit + publish draft→live
 *   POST   /api/tools/:slug/runs                — imperative run-now
 *   GET    /api/tools/:slug/runs                — paginated history
 *
 * The §7 spec model lives in this orchestrator, NOT in
 * `packages/tools-core` — that registry is the capability source of
 * truth. Specs *compose* capabilities; they don't replace them.
 *
 * `POST /:slug/runs` walks the spec imperatively via the singleton
 * MCP-backed dispatcher. The agent loop's run-time tool advertisement
 * is unaffected — chat still calls `runAgent` directly; this route
 * is for the dashboard's Live tab + future scheduler (C2).
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import {
  plannedToolNames,
  runToolSpec,
  type StepDispatcher,
} from "../services/tool-spec-runner.service.js";
import {
  firstToolDeniedForPrincipal,
  resolveToolAccessScope,
} from "../services/tool-access.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tools-route");

const SPEC_STATUSES = ["live", "draft", "suggested"] as const;
type SpecStatus = (typeof SPEC_STATUSES)[number];

// Per-tool slug shape — lowercase kebab, 2..80 chars. Tight enough to
// be URL-safe in `/api/tools/:slug` without escaping; loose enough for
// operator-typed names.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const stepSchema = z.object({
  kind: z.literal("call").default("call"),
  tool: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
});

const createSpecSchema = z.object({
  slug: z.string().min(2).max(80).regex(SLUG_RE),
  name: z.string().min(1).max(200),
  category: z.string().max(64).optional(),
  description: z.string().max(2000).optional(),
  share: z.string().max(64).optional(),
  safety: z.number().int().min(1).max(3).optional(),
  writes: z.boolean().optional(),
  reversible: z.boolean().optional(),
  steps: z.array(stepSchema).min(1).max(32),
});

const patchSpecSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.string().max(64).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  share: z.string().max(64).nullable().optional(),
  safety: z.number().int().min(1).max(3).optional(),
  writes: z.boolean().optional(),
  reversible: z.boolean().optional(),
  steps: z.array(stepSchema).min(1).max(32).optional(),
  status: z.enum(SPEC_STATUSES).optional(),
});

interface StepRow {
  id: string;
  specId: string;
  idx: number;
  kind: string;
  args: unknown;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  version: number;
  status: SpecStatus;
  ownerId: string | null;
  share: string | null;
  safety: number;
  writes: boolean;
  reversible: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface RunRow {
  id: string;
  specId: string;
  triggeredBy: string | null;
  startedAt: Date;
  endedAt: Date | null;
  status: "ok" | "failed" | "cancelled";
  error: string | null;
  trace: unknown;
}

/**
 * Materialize a clean DTO for a spec + its ordered steps. The
 * underlying Prisma row carries the same shape; this projects out
 * internal-only fields (`ownerId` stays, but `id` is the primary
 * identity surface — `slug` is the dashboard / API key).
 */
function projectSpec(
  spec: SpecRow & { steps: StepRow[] },
): Record<string, unknown> {
  return {
    id: spec.id,
    slug: spec.slug,
    name: spec.name,
    category: spec.category,
    description: spec.description,
    version: spec.version,
    status: spec.status,
    ownerId: spec.ownerId,
    share: spec.share,
    safety: spec.safety,
    writes: spec.writes,
    reversible: spec.reversible,
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
    steps: spec.steps.map((s) => ({
      id: s.id,
      idx: s.idx,
      kind: s.kind,
      args: s.args,
    })),
  };
}

export function createToolsRouter(
  prisma: PrismaClient,
  dispatcher: StepDispatcher,
): Router {
  const router = Router();

  router.get(
    "/tools",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const status = req.query.status;
        const category = req.query.category;
        const where: { status?: SpecStatus; category?: string } = {};
        if (typeof status === "string") {
          if (!(SPEC_STATUSES as readonly string[]).includes(status)) {
            res
              .status(400)
              .json({ error: "Invalid status filter", allowed: SPEC_STATUSES });
            return;
          }
          where.status = status as SpecStatus;
        }
        if (typeof category === "string" && category.length > 0) {
          where.category = category;
        }
        const rows = (await prisma.toolSpec.findMany({
          where: where as any,
          orderBy: { updatedAt: "desc" },
          include: { _count: { select: { steps: true, runs: true } } },
        })) as unknown as Array<
          SpecRow & { _count: { steps: number; runs: number } }
        >;
        res.json({
          specs: rows.map((r) => ({
            id: r.id,
            slug: r.slug,
            name: r.name,
            category: r.category,
            description: r.description,
            version: r.version,
            status: r.status,
            ownerId: r.ownerId,
            share: r.share,
            safety: r.safety,
            writes: r.writes,
            reversible: r.reversible,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            stepCount: r._count.steps,
            runCount: r._count.runs,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/tools/:slug",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const spec = (await prisma.toolSpec.findUnique({
          where: { slug: req.params.slug },
          include: { steps: { orderBy: { idx: "asc" } } },
        })) as unknown as (SpecRow & { steps: StepRow[] }) | null;
        if (!spec) {
          res.status(404).json({ error: "Spec not found" });
          return;
        }
        res.json(projectSpec(spec));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/tools",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = createSpecSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid spec", details: parsed.error.flatten() });
          return;
        }
        // WARP-485: ownerId is a UUID (User.id), not the Nextcloud
        // username. Storing the username would break any
        // `WHERE ownerId = <User.id>` join (returns zero rows) and
        // diverge from cameras / network-firewall / reminders which
        // all key on req.user.id.
        const actor = req.user?.id ?? null;
        try {
          const created = (await prisma.toolSpec.create({
            data: {
              slug: parsed.data.slug,
              name: parsed.data.name,
              category: parsed.data.category ?? null,
              description: parsed.data.description ?? null,
              share: parsed.data.share ?? null,
              safety: parsed.data.safety ?? 1,
              writes: parsed.data.writes ?? false,
              reversible: parsed.data.reversible ?? true,
              ownerId: actor,
              steps: {
                create: parsed.data.steps.map((s, idx) => ({
                  idx,
                  kind: s.kind,
                  args: { tool: s.tool, args: s.args ?? {} } as any,
                })),
              },
            },
            include: { steps: { orderBy: { idx: "asc" } } },
          })) as unknown as SpecRow & { steps: StepRow[] };
          res.status(201).json(projectSpec(created));
        } catch (err) {
          // Prisma surfaces unique-constraint violations as P2002. Convert
          // to a 409 so the dashboard can render "slug already in use".
          if ((err as { code?: string }).code === "P2002") {
            res
              .status(409)
              .json({ error: "Slug already in use", slug: parsed.data.slug });
            return;
          }
          throw err;
        }
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/tools/:slug",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = patchSpecSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid patch", details: parsed.error.flatten() });
          return;
        }
        const existing = (await prisma.toolSpec.findUnique({
          where: { slug: req.params.slug },
        })) as unknown as SpecRow | null;
        if (!existing) {
          res.status(404).json({ error: "Spec not found" });
          return;
        }

        // WARP-1580 — attribution at promotion. The WARP-464 pattern miner
        // writes `suggested` specs with NO ownerId (no human authored them),
        // so a promoted suggestion would carry no principal for a scheduled
        // fire to run as, and the ticker's fail-closed gate would refuse it
        // forever. The operator who publishes it is taking ownership, so
        // stamp them — but ONLY when the field is still empty; a promotion
        // must never re-attribute someone else's spec.
        const adoptOwnerId =
          parsed.data.status === "live" &&
          existing.ownerId === null &&
          typeof req.user?.id === "string"
            ? req.user.id
            : undefined;

        // Bump version on every PATCH that actually mutates the spec —
        // simple, conservative: even a description-only edit bumps. The
        // dashboard's run-detail drawer pins runs to the spec version
        // they were dispatched against.
        //
        // Step replacement (drag-reorder UX) MUST be transactional with
        // the spec update: a crash between deleteMany + update would
        // leave a spec with zero steps, silently producing empty-trace
        // runs on the next run-now. $transaction is on the same client
        // so the deleteMany is rolled back on update failure.
        //
        // For nullable string fields (category/description/share) we
        // pass `parsed.data.X` directly — Zod's `.nullable().optional()`
        // surfaces `undefined` when the key is absent (Prisma skip) and
        // `null` when the operator explicitly clears it (Prisma sets
        // column to NULL). The previous `?? undefined` collapse mapped
        // both cases to skip and made clears impossible.
        const updated = (await prisma.$transaction(async (tx) => {
          if (parsed.data.steps) {
            await tx.toolStep.deleteMany({ where: { specId: existing.id } });
          }
          return tx.toolSpec.update({
            where: { slug: req.params.slug },
            data: {
              ownerId: adoptOwnerId,
              name: parsed.data.name,
              category: parsed.data.category,
              description: parsed.data.description,
              share: parsed.data.share,
              safety: parsed.data.safety,
              writes: parsed.data.writes,
              reversible: parsed.data.reversible,
              status: parsed.data.status as any,
              version: { increment: 1 },
              steps: parsed.data.steps
                ? {
                    create: parsed.data.steps.map((s, idx) => ({
                      idx,
                      kind: s.kind,
                      args: { tool: s.tool, args: s.args ?? {} } as any,
                    })),
                  }
                : undefined,
            },
            include: { steps: { orderBy: { idx: "asc" } } },
          });
        })) as unknown as SpecRow & { steps: StepRow[] };

        res.json(projectSpec(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/tools/:slug/runs",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const spec = (await prisma.toolSpec.findUnique({
          where: { slug: req.params.slug },
          include: { steps: { orderBy: { idx: "asc" } } },
        })) as unknown as (SpecRow & { steps: StepRow[] }) | null;
        if (!spec) {
          res.status(404).json({ error: "Spec not found" });
          return;
        }
        // Drafts and suggested specs CANNOT run-now from the dashboard's
        // Live tab — the operator must publish a draft (status=live) or
        // accept a suggestion first. This keeps the Live tab the only
        // surface a misclick can fire a real action from.
        if (spec.status !== "live") {
          res.status(400).json({
            error: "Only live specs can run",
            status: spec.status,
          });
          return;
        }

        // (writes && !reversible) is the destructive non-undoable class —
        // the schema docstring explicitly assigns the gate to the route
        // layer (+ C2 scheduler). Without a `confirm=true` query param
        // we refuse with 409 + a confirmation token shape the dashboard
        // can re-POST. This keeps imperative run-now in lockstep with
        // the C2 scheduler's `safeRun` skip-and-warn posture.
        if (spec.writes && !spec.reversible) {
          const confirmed =
            String(req.query.confirm ?? "").toLowerCase() === "true";
          if (!confirmed) {
            res.status(409).json({
              error: "confirmation_required",
              detail:
                "this spec writes and is not reversible — re-POST with ?confirm=true",
              specId: spec.id,
              slug: spec.slug,
              writes: spec.writes,
              reversible: spec.reversible,
            });
            return;
          }
        }

        // The `requireRole` floor above only asks WHICH ROLES may press Run
        // at all. It says nothing about which TOOLS this person may invoke,
        // and the ToolSpec surface must answer that identically to chat —
        // otherwise a stored spec is a laundering path around the narrowing
        // chat enforces. Two axes, both required, resolved once here and
        // handed to the runner (which re-checks per step for the
        // args-dependent lock rule):
        //
        //   A. ADR-004 write tier (WARP-1621). Non-privileged tiers lose
        //      every `requiresWrite` tool. This is what chat's
        //      `narrowAllowedToolsForRole` has always applied and what this
        //      route never did: a `family` user — i.e. every family user on
        //      every box in the field, because AccessRoles are new — could
        //      press Run on a live spec calling `control_device` and it
        //      fired, while the same tool was stripped from their chat turn
        //      before the model saw it.
        //   B. WARP-1580 / §3 per-role tool domains, for the people who
        //      actually hold an AccessRole. `null` for the owner, service
        //      principals, and everyone with no AccessRole — that resolver
        //      path is byte-for-byte unchanged, and axis A is deliberately
        //      the layer UNDERNEATH it.
        //
        // Same predicate as chat, from the same module (never a second copy
        // — two copies of a tool filter is how these two surfaces came to
        // disagree in the first place).
        const scope = await resolveToolAccessScope(prisma, req.user);
        // Pre-flight so a forbidden spec is refused with an honest 403 and
        // NO ToolRun row, rather than half-running to the offending step.
        const denied = firstToolDeniedForPrincipal(
          plannedToolNames(spec.steps),
          req.user?.role,
          scope,
        );
        if (denied !== null) {
          res.status(403).json({
            error: "forbidden_tool_for_role",
            detail:
              denied.axis === "write_tier"
                ? "this spec uses a tool your role may not run — " +
                  "ask an owner or admin to run it"
                : "this spec uses a tool your access role does not permit — " +
                  "ask your administrator",
            slug: spec.slug,
            tool: denied.tool,
            axis: denied.axis,
          });
          return;
        }

        const triggeredBy = req.user?.username ?? null;
        const { runId, outcome } = await runToolSpec(prisma, dispatcher, {
          specId: spec.id,
          specName: spec.name,
          steps: spec.steps,
          triggeredBy,
          scope,
        });

        res.status(outcome.status === "ok" ? 200 : 207).json({
          runId,
          specId: spec.id,
          slug: spec.slug,
          status: outcome.status,
          error: outcome.error,
          trace: outcome.trace,
        });
      } catch (err) {
        logger.warn(
          { err, slug: req.params.slug },
          "tool run dispatch failed",
        );
        next(err);
      }
    },
  );

  router.get(
    "/tools/:slug/runs",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const spec = (await prisma.toolSpec.findUnique({
          where: { slug: req.params.slug },
        })) as unknown as SpecRow | null;
        if (!spec) {
          res.status(404).json({ error: "Spec not found" });
          return;
        }
        const limit = Math.max(
          1,
          Math.min(
            100,
            Number.parseInt(String(req.query.limit ?? "20"), 10) || 20,
          ),
        );
        const rows = (await prisma.toolRun.findMany({
          where: { specId: spec.id },
          orderBy: { startedAt: "desc" },
          take: limit,
        })) as unknown as RunRow[];

        res.json({
          slug: spec.slug,
          runs: rows.map((r) => ({
            id: r.id,
            triggeredBy: r.triggeredBy,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
            status: r.status,
            error: r.error,
            trace: r.trace,
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
