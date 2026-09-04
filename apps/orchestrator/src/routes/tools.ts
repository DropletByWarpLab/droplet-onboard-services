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
 *   GET    /api/tools/:slug/schedules           — WARP-2665 rrule schedules
 *   POST   /api/tools/:slug/schedules           — WARP-2665 create
 *   PATCH  /api/tools/:slug/schedules/:id       — WARP-2665 edit / enable
 *   DELETE /api/tools/:slug/schedules/:id       — WARP-2665 remove
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
  type Summarizer,
} from "../services/tool-spec-runner.service.js";
import { createToolSpecSummarizer } from "../services/tool-spec-summarizer.service.js";
import {
  firstToolDeniedForPrincipal,
  resolveToolAccessScope,
  WRITE_TOOLS,
} from "../services/tool-access.service.js";
import { isSupportedRrule, nextFireFromRrule } from "../utils/rrule.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tools-route");

const SPEC_STATUSES = ["live", "draft", "suggested"] as const;
type SpecStatus = (typeof SPEC_STATUSES)[number];

// Per-tool slug shape — lowercase kebab, 2..80 chars. Tight enough to
// be URL-safe in `/api/tools/:slug` without escaping; loose enough for
// operator-typed names.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A step is either a tool CALL or — since WARP-1996 — a SUMMARIZE, which
 * turns what the earlier steps gathered into prose. `call` stays the default
 * so every spec authored before this keeps parsing unchanged.
 *
 * A summarize step names no tool: there is nothing for the §3 scope check to
 * authorize, and it can only read the trace the run already produced under
 * that check.
 */
const callStepSchema = z.object({
  kind: z.literal("call").default("call"),
  tool: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
});

const summarizeStepSchema = z.object({
  kind: z.literal("summarize"),
  /** Optional framing; the runner supplies its default when absent. */
  prompt: z.string().min(1).max(4000).optional(),
});

const stepSchema = z.union([callStepSchema, summarizeStepSchema]);

type ParsedStep = z.infer<typeof stepSchema>;

/**
 * Shape a validated step for the `ToolStep.args` JSON column.
 *
 * The two kinds store different payloads, so this cannot be one literal:
 * a `call` keeps `{tool, args}` — the shape `parseCallStep` reads — and a
 * `summarize` keeps `{prompt}`. Writing a summarize step through the call
 * shape would persist `tool: undefined` and the runner would reject it as
 * malformed on the next run.
 */
function storedArgsFor(s: ParsedStep): Record<string, unknown> {
  if (s.kind === "summarize") {
    return s.prompt ? { prompt: s.prompt } : {};
  }
  return { tool: s.tool, args: s.args ?? {} };
}

/**
 * WARP-2665 — the write tools a step list actually calls.
 *
 * `ToolSpec.writes` gates two safety decisions: run-now's 409 confirmation
 * (`POST /tools/:slug/runs`) and the WARP-463 ticker's refusal to auto-fire a
 * `writes && !reversible` spec unattended. Until now it was whatever the
 * author put in the request body and was never checked against the steps, so
 * a spec calling a writing tool could be stored as `writes: false` and would
 * then fire with nobody watching. The ADR-004 write tier still applied at
 * fire time — this was never an escalation — but a gate that exists for
 * "destructive, and nobody is looking" was deciding on a self-declared field.
 *
 * Names come from `plannedToolNames`, the runner's OWN parser and the same one
 * the walker dispatches through, rather than a second reading of the step
 * shape that could drift from it. A step kind that dispatches no tool (today
 * `summarize`) contributes no name, so it can never make a spec look like it
 * writes — which is also what keeps a future non-dispatching kind correct here
 * without touching this function.
 *
 * `WRITE_TOOLS` is derived from each tool's `requiresWrite` in
 * `@droplet/tools-core`, so a write tool added to the registry is classified
 * here without anyone remembering to update a list.
 */
function writeToolNamesIn(
  steps: ReadonlyArray<{ kind: string; args: unknown }>,
): string[] {
  return plannedToolNames(steps).filter((tool) => WRITE_TOOLS.has(tool));
}

/** Parsed request steps in the stored `{kind, args}` shape `plannedToolNames` reads. */
function toStoredShape(
  steps: ParsedStep[],
): Array<{ kind: string; args: unknown }> {
  return steps.map((s) => ({ kind: s.kind, args: storedArgsFor(s) }));
}

/**
 * WARP-2665 — reconcile a declared `writes` against the derived one.
 *
 * Asymmetric on purpose. Declaring `writes: true` on a spec that calls no
 * write tool is a CONSERVATIVE disagreement: it can only add a confirmation
 * prompt and keep the scheduler's hands off, so it is accepted as authored.
 * Declaring `writes: false` on a spec that does call one is the only
 * direction that defeats a safety gate, and it is refused — loudly, at
 * authoring time while a human is present to read the error, rather than
 * silently at 03:00 when the schedule fires.
 *
 * Omitting the field derives it. That is what keeps existing clients and the
 * miner's draft→live promotion correct without asking either to change.
 */
function reconcileWrites(
  declared: boolean | undefined,
  writeTools: string[],
): { ok: true; writes: boolean } | { ok: false; writeTools: string[] } {
  if (declared === false && writeTools.length > 0) {
    return { ok: false, writeTools };
  }
  return { ok: true, writes: declared === true ? true : writeTools.length > 0 };
}

/** The 400 body for a `writes: false` declaration the steps contradict. */
function writesDisagreementBody(writeTools: string[]): Record<string, unknown> {
  return {
    error: "Declared writes:false, but these steps call write tools",
    detail:
      "omit `writes` to have it derived from the steps, or declare writes:true",
    writeTools,
  };
}

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

/**
 * WARP-2665 — schedule write schemas.
 *
 * `rrule` is validated by PARSING it (see the route), not by a regex: the
 * ticker's `nextFireFromRrule` is the only authority on what this box can
 * actually fire, and a rule it cannot read is auto-disabled on its first
 * tick. Refusing it here instead means the operator learns at the moment
 * they typed it.
 *
 * `timezone` is likewise validated by the parser, which rejects any zone
 * ECMA-402 does not know.
 */
const createScheduleSchema = z.object({
  rrule: z.string().min(3).max(512),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

const patchScheduleSchema = z
  .object({
    rrule: z.string().min(3).max(512).optional(),
    timezone: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "empty patch — pass at least one of rrule, timezone, enabled",
  });

interface ScheduleRow {
  id: string;
  specId: string;
  rrule: string;
  timezone: string;
  nextFireAt: Date;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function projectSchedule(row: ScheduleRow): Record<string, unknown> {
  return {
    id: row.id,
    specId: row.specId,
    rrule: row.rrule,
    timezone: row.timezone,
    nextFireAt: row.nextFireAt,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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
  /**
   * WARP-1996 — injected so tests can drive a `summarize` step without an
   * inference backend, the same reason `dispatcher` is a parameter. Defaults
   * to the on-box summarizer; a spec with no summarize step never calls it.
   */
  summarizer: Summarizer = createToolSpecSummarizer(),
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

        // WARP-2665 — classify from the steps, not from the body.
        const reconciled = reconcileWrites(
          parsed.data.writes,
          writeToolNamesIn(toStoredShape(parsed.data.steps)),
        );
        if (!reconciled.ok) {
          res.status(400).json(writesDisagreementBody(reconciled.writeTools));
          return;
        }

        try {
          const created = (await prisma.toolSpec.create({
            data: {
              slug: parsed.data.slug,
              name: parsed.data.name,
              category: parsed.data.category ?? null,
              description: parsed.data.description ?? null,
              share: parsed.data.share ?? null,
              safety: parsed.data.safety ?? 1,
              writes: reconciled.writes,
              reversible: parsed.data.reversible ?? true,
              ownerId: actor,
              steps: {
                create: parsed.data.steps.map((s, idx) => ({
                  idx,
                  kind: s.kind,
                  args: storedArgsFor(s) as any,
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
        // WARP-2665 — steps are loaded because the write classification is
        // derived from them. A patch that changes `writes` without touching
        // the steps must be checked against the steps already stored, and a
        // patch that replaces the steps must re-derive even when it says
        // nothing about `writes` — that second case is how a read-only spec
        // silently grew a write step before this.
        const existing = (await prisma.toolSpec.findUnique({
          where: { slug: req.params.slug },
          include: { steps: { orderBy: { idx: "asc" } } },
        })) as unknown as (SpecRow & { steps: StepRow[] }) | null;
        if (!existing) {
          res.status(404).json({ error: "Spec not found" });
          return;
        }

        const reconciled = reconcileWrites(
          parsed.data.writes,
          writeToolNamesIn(
            parsed.data.steps
              ? toStoredShape(parsed.data.steps)
              : existing.steps,
          ),
        );
        if (!reconciled.ok) {
          res.status(400).json(writesDisagreementBody(reconciled.writeTools));
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
              // WARP-2665 — a PATCH may only RAISE the write classification
              // implicitly; lowering it takes an explicit `writes: false`,
              // which the reconcile above has already checked against the
              // steps. `existing.writes || reconciled.writes` is that rule in
              // one expression: the derivation can add a write flag, and only
              // a deliberate declaration can take one away. That keeps a
              // conservative `writes: true` an author set by hand from being
              // cleared by an unrelated description edit (the flag can only
              // add a confirmation and hold the scheduler off).
              //
              // It is written WITHOUT a `parsed.data.steps` arm on purpose.
              // The previous shape skipped the column entirely (`undefined`
              // is a Prisma skip) on a body carrying neither `steps` nor
              // `writes` — and the body that promotes a mined suggestion is
              // exactly that: `{"status":"live"}`. The WARP-464 miner writes
              // its suggestions with `writes: false`, so such a spec went
              // live still claiming it does not write, and the ticker's
              // `writes && !reversible` gate, reading that stored value,
              // scheduled it unattended. `reconciled.writes` was already
              // derived from `existing.steps` a few lines up; persist it.
              writes: parsed.data.writes !== undefined
                ? reconciled.writes
                : existing.writes || reconciled.writes,
              reversible: parsed.data.reversible,
              status: parsed.data.status as any,
              version: { increment: 1 },
              steps: parsed.data.steps
                ? {
                    create: parsed.data.steps.map((s, idx) => ({
                      idx,
                      kind: s.kind,
                      args: storedArgsFor(s) as any,
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
          summarizer,
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

  // ── WARP-2665: schedules ─────────────────────────────────────────
  //
  // The WARP-463 ticker has scanned `ToolSchedule` every 60s since it
  // shipped and has never fired anything, because nothing in the repo could
  // create a row: no route, no seed, no tool. Its rrule parser, its
  // `writes && !reversible` safety gate, its per-fire principal resolution
  // (WARP-1580) and its malformed-rule auto-disable were reachable only by
  // hand-inserted SQL. These four routes are the missing write path.
  //
  // Owner/admin only for the mutating three — the same floor as draft→live
  // promotion, because scheduling a spec and publishing one are the same
  // decision: this now runs without anybody pressing a button.

  /**
   * Resolve `:slug` → spec, and (when `:id` is present) the schedule that
   * belongs to it. Returns null after answering 404, so callers just return.
   *
   * The spec-ownership check is not decoration: without it
   * `PATCH /tools/any-spec/schedules/<id-belonging-to-another-spec>` would
   * edit that other spec's schedule, and `:slug` would be advisory.
   */
  async function resolveSchedule(
    req: Request,
    res: Response,
  ): Promise<{ spec: SpecRow; schedule: ScheduleRow | null } | null> {
    const spec = (await prisma.toolSpec.findUnique({
      where: { slug: req.params.slug },
    })) as unknown as SpecRow | null;
    if (!spec) {
      res.status(404).json({ error: "Spec not found" });
      return null;
    }
    if (req.params.id === undefined) return { spec, schedule: null };

    const schedule = (await prisma.toolSchedule.findUnique({
      where: { id: req.params.id },
    })) as unknown as ScheduleRow | null;
    if (!schedule || schedule.specId !== spec.id) {
      res.status(404).json({ error: "Schedule not found" });
      return null;
    }
    return { spec, schedule };
  }

  /**
   * Compute the first fire, and in doing so validate the rule.
   *
   * `isSupportedRrule` goes first, and it is not a courtesy check: it is the
   * DAILY/WEEKLY, INTERVAL=1 subset `routes/scenes.ts` accepts, and it is
   * what BOUNDS the computation below. `nextFireFromRrule` walks
   * 8 x INTERVAL candidate days for a WEEKLY rule, synchronously, so an
   * INTERVAL taken from the request body (`INTERVAL=100000000` is 40 bytes,
   * well inside the 512-char cap) would hold the event loop for minutes.
   *
   * `nextFireFromRrule` then returns null for anything this box cannot
   * actually fire — a malformed segment, an unknown IANA zone. The ticker's
   * response to such a rule is to disable the schedule and audit it;
   * refusing at write time means the operator finds out while they are
   * still looking at the field they typed it into.
   */
  function firstFire(rrule: string, timezone: string): Date | null {
    if (!isSupportedRrule(rrule)) return null;
    return nextFireFromRrule(rrule, new Date(), timezone);
  }

  const UNSUPPORTED_RULE = {
    error: "Unsupported schedule rule",
    detail:
      "FREQ must be DAILY or WEEKLY (optionally with BYDAY/BYHOUR/BYMINUTE, " +
      "no INTERVAL), and timezone must be a valid IANA zone",
  };

  router.get(
    "/tools/:slug/schedules",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const found = await resolveSchedule(req, res);
        if (!found) return;
        const rows = (await prisma.toolSchedule.findMany({
          where: { specId: found.spec.id },
          orderBy: { nextFireAt: "asc" },
        })) as unknown as ScheduleRow[];
        res.json({
          slug: found.spec.slug,
          schedules: rows.map(projectSchedule),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/tools/:slug/schedules",
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
        const found = await resolveSchedule(req, res);
        if (!found) return;

        const timezone = parsed.data.timezone ?? "UTC";
        const nextFireAt = firstFire(parsed.data.rrule, timezone);
        if (nextFireAt === null) {
          res.status(400).json(UNSUPPORTED_RULE);
          return;
        }

        const created = (await prisma.toolSchedule.create({
          data: {
            specId: found.spec.id,
            rrule: parsed.data.rrule,
            timezone,
            nextFireAt,
            enabled: parsed.data.enabled ?? true,
          },
        })) as unknown as ScheduleRow;

        logger.info(
          { slug: found.spec.slug, scheduleId: created.id, timezone },
          "tool schedule created",
        );
        res.status(201).json(projectSchedule(created));
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/tools/:slug/schedules/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = patchScheduleSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid schedule patch",
            details: parsed.error.flatten(),
          });
          return;
        }
        const found = await resolveSchedule(req, res);
        if (!found || !found.schedule) return;
        const current = found.schedule;

        // Recompute the next fire only when the CADENCE changed. Toggling
        // `enabled` must not move it: re-enabling a schedule should resume
        // the rhythm it was paused on, not skip to the next slot from now.
        const rrule = parsed.data.rrule ?? current.rrule;
        const timezone = parsed.data.timezone ?? current.timezone;
        const cadenceChanged =
          rrule !== current.rrule || timezone !== current.timezone;

        let nextFireAt: Date | undefined;
        if (cadenceChanged) {
          const next = firstFire(rrule, timezone);
          if (next === null) {
            res.status(400).json(UNSUPPORTED_RULE);
            return;
          }
          nextFireAt = next;
        }

        const updated = (await prisma.toolSchedule.update({
          where: { id: current.id },
          data: {
            rrule: parsed.data.rrule,
            timezone: parsed.data.timezone,
            enabled: parsed.data.enabled,
            nextFireAt,
          },
        })) as unknown as ScheduleRow;

        res.json(projectSchedule(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    "/tools/:slug/schedules/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const found = await resolveSchedule(req, res);
        if (!found || !found.schedule) return;
        await prisma.toolSchedule.delete({ where: { id: found.schedule.id } });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
