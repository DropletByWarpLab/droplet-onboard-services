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
import { requireRole, requireRoleOrMcpService, type AuthUser } from "../middleware/auth.js";
import {
  plannedToolNames,
  runToolSpec,
  type StepDispatcher,
  type Summarizer,
} from "../services/tool-spec-runner.service.js";
import { createToolSpecSummarizer } from "../services/tool-spec-summarizer.service.js";
import { createSandboxTransformer, type Transformer } from "../services/sandbox.client.js";
import {
  DAILY_REPORT_SLUG,
  seedDailyReportSpec,
} from "../services/daily-report-spec.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import type { McpCallContext } from "../services/mcp-client.service.js";
import {
  firstToolDeniedForPrincipal,
  hasWriteTool,
  resolveToolAccessScope,
} from "../services/tool-access.service.js";
import {
  createDraftSpecTx,
  createSpecSchema,
  reconcileWrites,
  stepReferenceError,
  stepSchema,
  storedArgsFor,
  toStoredShape,
  writeToolNamesIn,
  writesDisagreementBody,
} from "../services/tool-spec-draft.service.js";
import { isSupportedRrule, nextFireFromRrule } from "../utils/rrule.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tools-route");

const MCP_PRINCIPAL_ID = "_service:mcp";

/** The roles that may list, draft and run routines — the `requireRole` floor
 *  the three tool-reachable routes carry, restated so the mcp principal's
 *  acting human is held to exactly the same bar. */
const ROUTINE_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "family"]);

interface Actor {
  id: string;
  username: string;
  role: string;
}

/**
 * WARP-2894 — the person this request acts for.
 *
 * The `routine_*` tools reach these routes as `_service:mcp`, and
 * `requireRoleOrMcpService` admits that principal BEFORE any role check
 * (middleware/auth.ts). A route that then reads `req.user` filters on the
 * literal string `_service:mcp`: `ownerId` matches no row that can exist,
 * `resolveToolAccessScope` sees role `service` and returns the un-narrowed
 * scope, and `triggeredBy` records a robot. That is the WARP-2810 defect
 * class (`/api/brain/*` answered empty 200s to everyone for this reason),
 * so the resolution is done here, once, the way `routes/agent-runs.ts` does
 * it: the mcp-server's orchestrator client stamps `X-Nextcloud-User` on
 * every call (`context.ts withActingUser`); an explicit `onBehalfOf` wins
 * when both are present; `null` when nobody can be established, and the
 * caller answers 403 — never a wider identity, never an empty 200.
 *
 * A browser caller is themselves, byte-for-byte as before.
 */
async function resolveActor(
  prisma: PrismaClient,
  req: Request,
  onBehalfOf: unknown,
): Promise<Actor | null> {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) return null;
  if (user.id === MCP_PRINCIPAL_ID && user.role === "service") {
    const header = req.header("x-nextcloud-user");
    const explicit =
      typeof onBehalfOf === "string" && onBehalfOf.trim().length > 0 ? onBehalfOf.trim() : undefined;
    const named = explicit ?? (header && header.trim().length > 0 ? header.trim() : undefined);
    if (!named) return null;
    const row = (await prisma.user.findFirst({
      where: { username: named },
      select: { id: true, username: true, role: true },
    })) as Actor | null;
    return row;
  }
  return { id: user.id, username: user.username, role: user.role };
}

/** Resolve the actor or answer 403 — the mcp principal passed the role guard
 *  on its own account; the PERSON it acts for must clear the same bar. */
async function actorOr403(
  prisma: PrismaClient,
  req: Request,
  res: Response,
  onBehalfOf: unknown,
): Promise<Actor | null> {
  const actor = await resolveActor(prisma, req, onBehalfOf);
  if (!actor) {
    res.status(403).json({ error: "Forbidden: no principal to act for" });
    return null;
  }
  if (!ROUTINE_ROLES.has(actor.role)) {
    res.status(403).json({ error: "Forbidden: role not permitted to use routines" });
    return null;
  }
  return actor;
}

const SPEC_STATUSES = ["live", "draft", "suggested"] as const;
type SpecStatus = (typeof SPEC_STATUSES)[number];


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
  /**
   * WARP-2895 — injected so tests can drive a `transform` / `when` step
   * without a sandbox container, the same reason `summarizer` is a
   * parameter. Defaults to the sandbox client; a spec with no such step
   * never calls it.
   */
  transformer: Transformer = createSandboxTransformer(),
): Router {
  const router = Router();

  /**
   * Every by-slug lookup goes through here. The `daily-report` spec is
   * box-provided rather than user-authored, so when it is missing the fix is
   * to create it, not to tell the person "Spec not found" about a thing they
   * never made. Seed-then-retry; a genuinely unknown slug still returns null.
   */
  async function findSpec<T>(
    slug: string,
    query: (where: { slug: string }) => Promise<T | null>,
  ): Promise<T | null> {
    const found = await query({ slug });
    if (found || slug !== DAILY_REPORT_SLUG) return found;
    await seedDailyReportSpec(prisma);
    return query({ slug });
  }

  /**
   * The identity a run-now executes as — the same three fields chat forwards
   * on every tool call, so a spec run can read what the person has connected
   * (calendar, email, memory are all `ctx.userId`-gated in tools-core).
   *
   * WARP-2894 — `routine_run` reaches the route as the mcp principal acting
   * for a person, so the identity is the resolved ACTOR, never `req.user`:
   * the robot has no calendar, no mail and no memory, and role `service`
   * would reach every `userRole`-keyed tool as nobody. The Nextcloud token is
   * still the request's own — the robot carries none, and the person's is
   * never borrowed on their behalf.
   */
  async function runCallContext(
    req: Request,
    actor: Pick<Actor, "username" | "role">,
  ): Promise<McpCallContext | undefined> {
    const userId = actor.username;
    const role = actor.role;
    const ncToken = (await resolveNcToken(req).catch(() => null)) ?? undefined;
    if (!userId && !role && !ncToken) return undefined;
    return {
      ...(userId ? { userId } : {}),
      ...(role ? { userRole: role } : {}),
      ...(ncToken ? { ncToken } : {}),
    };
  }

  router.get(
    "/tools",
    // WARP-2894 — `routine_list` reaches this as the mcp principal.
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = await actorOr403(prisma, req, res, req.query.onBehalfOf);
        if (!actor) return;
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
        // WARP-2894 — schedules ride on the list row (additive). The model's
        // routine_list needs them to answer "when does this run" without a
        // call per slug, and the dashboard's list ignores keys it does not
        // read. Select, not include-all: the row shape is the wire contract.
        const rows = (await prisma.toolSpec.findMany({
          where: where as any,
          orderBy: { updatedAt: "desc" },
          include: {
            _count: { select: { steps: true, runs: true } },
            schedules: { select: { rrule: true, timezone: true, enabled: true, nextFireAt: true } },
          },
        })) as unknown as Array<
          SpecRow & {
            _count: { steps: number; runs: number };
            schedules?: Array<{ rrule: string; timezone: string; enabled: boolean; nextFireAt: Date }>;
          }
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
            schedules: r.schedules ?? [],
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
        const spec = (await findSpec(req.params.slug, (where) =>
          prisma.toolSpec.findUnique({
            where,
            include: { steps: { orderBy: { idx: "asc" } } },
          }),
        )) as unknown as (SpecRow & { steps: StepRow[] }) | null;
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
    // WARP-2894 — `routine_draft` reaches this as the mcp principal. It can
    // only ever CREATE a draft: `createSpecSchema` has no `status` field and
    // `createDraftSpecTx` writes `status: "draft"` explicitly (WARP-2897), so
    // the model has no path to `live` short of a person pressing Promote on
    // /routines.
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = createSpecSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid spec", details: parsed.error.flatten() });
          return;
        }
        const who = await actorOr403(prisma, req, res, parsed.data.onBehalfOf);
        if (!who) return;

        // WARP-2897 — the validators and the create live in ONE service
        // (tool-spec-draft.service.ts) so slice I-1's seeded drafts pass the
        // same checks. WARP-485: ownerId is the User.id, never the username.
        // No runtime tool sets: the walker dispatches compiled tools only.
        const created = await createDraftSpecTx<SpecRow & { steps: StepRow[] }>(
          prisma,
          parsed.data,
          who.id,
        );
        if (!created.ok) {
          res.status(created.refusal.status).json(created.refusal.body);
          return;
        }
        res.status(201).json(projectSpec(created.spec));
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
        const existing = (await findSpec(req.params.slug, (where) =>
          prisma.toolSpec.findUnique({
            where,
            include: { steps: { orderBy: { idx: "asc" } } },
          }),
        )) as unknown as (SpecRow & { steps: StepRow[] }) | null;
        if (!existing) {
          res.status(404).json({ error: "Spec not found" });
          return;
        }

        // WARP-2670 — only when the steps are being replaced. A patch that
        // leaves them alone cannot have introduced a bad reference, and
        // re-validating stored steps would turn an unrelated rename into a
        // 400 on a spec that has been running fine.
        if (parsed.data.steps) {
          const refError = stepReferenceError(parsed.data.steps);
          if (refError) {
            res.status(400).json(refError);
            return;
          }
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
              // WARP-2665 — an explicit `writes` wins (the reconcile above
              // has already refused one the steps contradict); otherwise a
              // PATCH may only RAISE the flag: `existing.writes ||
              // reconciled.writes` lets the derivation add a write flag and
              // never clears a conservative `writes: true` an author set by
              // hand. Always persisted, never a Prisma skip — the body that
              // promotes a mined suggestion is a bare `{"status":"live"}`,
              // and the WARP-464 miner used to mint those rows `writes:
              // false`, so a skip here published a spec whose own steps
              // contradicted the flag the ticker's gate trusts.
              writes: parsed.data.writes ?? (existing.writes || reconciled.writes),
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
    // WARP-2894 — `routine_run` reaches this as the mcp principal. The
    // interceptor has already confirmed THAT call (Tier-2); the 409 below for
    // a destructive, non-reversible spec is a second, separate gate the tool
    // does not pass on the person's behalf — it relays it.
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const actor = await actorOr403(prisma, req, res, req.body?.onBehalfOf ?? req.query.onBehalfOf);
        if (!actor) return;
        const spec = (await findSpec(req.params.slug, (where) =>
          prisma.toolSpec.findUnique({
            where,
            include: { steps: { orderBy: { idx: "asc" } } },
          }),
        )) as unknown as (SpecRow & { steps: StepRow[] }) | null;
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
        //
        // WARP-2665 — "writes" is the stored column OR what the steps call,
        // the same derivation the ticker's gate reads. A spec stored before
        // the derivation existed (or seeded outside the routes) can carry
        // `writes: false` while its steps call a write tool; trusting the
        // column alone here would let a person fire that spec from the Live
        // tab without the confirmation the ticker would have withheld.
        const effectiveWrites =
          spec.writes || hasWriteTool(plannedToolNames(spec.steps));
        if (effectiveWrites && !spec.reversible) {
          const confirmed =
            String(req.query.confirm ?? "").toLowerCase() === "true";
          if (!confirmed) {
            res.status(409).json({
              error: "confirmation_required",
              detail:
                "this spec writes and is not reversible — re-POST with ?confirm=true",
              specId: spec.id,
              slug: spec.slug,
              writes: effectiveWrites,
              writesSource: spec.writes ? "stored" : "derived",
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
        // WARP-2894 — the ACTOR, never `req.user`: for the mcp principal that
        // would be role `service`, which the resolver treats as un-narrowed.
        const scope = await resolveToolAccessScope(prisma, actor);
        // Pre-flight so a forbidden spec is refused with an honest 403 and
        // NO ToolRun row, rather than half-running to the offending step.
        const denied = firstToolDeniedForPrincipal(
          plannedToolNames(spec.steps),
          actor.role,
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

        const triggeredBy = actor.username;
        const { runId, outcome } = await runToolSpec(prisma, dispatcher, {
          specId: spec.id,
          specName: spec.name,
          steps: spec.steps,
          triggeredBy,
          scope,
          summarizer,
          callContext: await runCallContext(req, actor),
          transformer,
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
        const spec = (await findSpec(req.params.slug, (where) =>
          prisma.toolSpec.findUnique({ where }),
        )) as unknown as SpecRow | null;
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
        // A run executes AS the person who pressed Run, so its trace holds
        // their calendar titles, meeting links and file paths. The archive is
        // shared across owner/admin/family, so only the runs this person
        // triggered — plus the ticker's, which run with no session and hold
        // no per-user data — may come back. Never the newest run regardless.
        const rows = (await prisma.toolRun.findMany({
          where: {
            specId: spec.id,
            triggeredBy: { in: [req.user?.username ?? "", "scheduler"] },
          },
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
    const spec = (await findSpec(req.params.slug, (where) =>
      prisma.toolSpec.findUnique({ where }),
    )) as unknown as SpecRow | null;
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

        // Same rule as run-now: a draft or a suggestion cannot be put on a
        // timer. The ticker already skips a non-live spec, but silently —
        // an operator who scheduled a draft would otherwise wait for a fire
        // that never comes with nothing telling them why.
        if (found.spec.status !== "live") {
          res.status(400).json({
            error: "Only live specs can be scheduled",
            status: found.spec.status,
          });
          return;
        }

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
