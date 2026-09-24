/**
 * WARP-2180 — durable agent runs over REST (epic WARP-2176).
 *
 *   POST   /api/agent-runs                  start a run
 *   GET    /api/agent-runs                  list mine (status filter, cursor)
 *   GET    /api/agent-runs/schedules        my recurring runs
 *   POST   /api/agent-runs/schedules        add a recurring run (RRULE)
 *   DELETE /api/agent-runs/schedules/:id    remove one
 *   GET    /api/agent-runs/:id              detail, including the trace
 *   POST   /api/agent-runs/:id/cancel       cancel
 *   POST   /api/agent-runs/:id/confirm      decide a parked Tier-2 call
 *
 * WHO. Every route is `requireRoleOrMcpService("owner", "admin")`, admitting
 * the pinned `_service:mcp` principal the way the scenes routes do — that is
 * how the `start_agent_run` / `list_agent_runs` tools reach here from chat.
 * The mcp principal never acts as ITSELF: it names the chat user it acts for
 * (`onBehalfOf`, a username — the same stdio-trusted identity `_meta.userId`
 * already carries, WARP-202), and that person's role is checked here exactly
 * as a browser caller's is. A run is attributed to that person, whose reach
 * the worker re-resolves at every claim (WARP-1580), so delegation through
 * the model cannot launder privilege: a `family` member cannot start a run
 * from chat, and an `admin` who could gets a run that reaches only what they
 * reach. A person sees only their own runs; another person's run is a 404,
 * a wrong role is a 403.
 *
 * WHAT IT DOES NOT DO. The worker owns every state transition
 * (agent-run-worker.service.ts); this file only enqueues, reads, and hands
 * `cancel` / `decide` to the worker's own functions. No second scheduler:
 * recurring runs ride `AgentRunSchedule` and the agent-run-schedule ticker on
 * `cronRuntime.scheduleInterval`.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { resolveActiveModel } from "../services/active-model.service.js";
import {
  recordAccessDenied,
  requireRoleOrMcpService,
  type AuthUser,
} from "../middleware/auth.js";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  cancelAgentRun,
  decideAgentRun,
  enqueueAgentRun,
  type AgentRunTraceEntry,
} from "../services/agent-run-worker.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { summarizeToolArguments } from "../services/confirmation-summary.js";
import { WORKSPACE_ID } from "../services/workspace.service.js";
import { decideCloudTurn } from "../services/cloud-access.service.js";
import {
  isSupportedRrule,
  isSupportedTimezone,
  nextFireFromRrule,
} from "../utils/rrule.js";

const MCP_PRINCIPAL_ID = "_service:mcp";
const RUN_STARTER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Prisma's unique-constraint failure (`P2002`), without importing the class
 *  — the unit suites stub the client, and a structural check is what a raw
 *  `Prisma.PrismaClientKnownRequestError` satisfies too. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

const startRunSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  model: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
  maxIter: z.coerce.number().int().positive().optional(),
  /** WARP-2896 — a WORKSHOP run: bound to this workspace for its whole life. */
  workspaceId: z.string().regex(WORKSPACE_ID).optional(),
  /** Username the mcp principal acts for. Ignored for everyone else. */
  onBehalfOf: z.string().trim().min(1).max(200).optional(),
});

const listQuerySchema = z.object({
  status: z
    .enum(["queued", "running", "awaiting_confirmation", "succeeded", "failed", "cancelled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque: `<createdAt ISO>|<id>` of the previous page's tail row. */
  cursor: z.string().min(1).max(300).optional(),
  /** WARP-2896 — only the runs that worked in this workspace. */
  workspaceId: z.string().regex(WORKSPACE_ID).optional(),
  onBehalfOf: z.string().trim().min(1).max(200).optional(),
});

const decideSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  onBehalfOf: z.string().trim().min(1).max(200).optional(),
});

const createScheduleSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  model: z.string().trim().min(1).max(200).optional(),
  maxIter: z.coerce.number().int().positive().optional(),
  rrule: z.string().trim().min(1).max(500),
  timezone: z.string().trim().min(1).max(64).optional(),
  onBehalfOf: z.string().trim().min(1).max(200).optional(),
});

interface Actor {
  id: string;
  username: string;
  role: string;
}

/**
 * The person this request acts for. The mcp principal must name one; a
 * browser caller is themselves. `null` when nobody can be established — the
 * caller answers 403, never falls back to a wider identity.
 */
async function resolveActor(
  prisma: PrismaClient,
  req: Request,
  onBehalfOf: string | undefined,
): Promise<Actor | null> {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) return null;
  if (user.id === MCP_PRINCIPAL_ID && user.role === "service") {
    // The mcp-server's orchestrator client stamps `X-Nextcloud-User` with the
    // acting user on every call (context.ts `withActingUser`), so a handler
    // need not repeat it; an explicit `onBehalfOf` wins when both are present.
    const header = req.header("x-nextcloud-user");
    const named = onBehalfOf ?? (header && header.trim().length > 0 ? header.trim() : undefined);
    if (!named) return null;
    const row = (await prisma.user.findFirst({
      where: { username: named },
      select: { id: true, username: true, role: true },
    })) as Actor | null;
    return row;
  }
  return { id: user.id, username: user.username, role: user.role };
}

/**
 * The list cursor is the tail row's `(createdAt, id)` tuple, matching the
 * `orderBy`. A `createdAt`-only cursor skipped rows created in the same
 * millisecond (the ticker enqueues up to fifty in one loop) when they
 * straddled a page boundary (Stefan, #2014 review).
 */
function parseCursor(raw: string): { createdAt: Date; id: string } | null {
  const sep = raw.lastIndexOf("|");
  if (sep <= 0 || sep === raw.length - 1) return null;
  const createdAt = new Date(raw.slice(0, sep));
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: raw.slice(sep + 1) };
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

/**
 * WARP-3047 — a run with no explicit `model` runs on the box's ACTIVE model
 * (tools-capable: an active model that states it cannot call tools falls back
 * to LLM_MODEL), not env DEFAULT_MODEL/LLM_MODEL — on DMR a run on another
 * model than chat is a second model competing for one GPU. Resolved when the
 * run is QUEUED and when a schedule is CREATED: `AgentRun.model` and
 * `AgentRunSchedule.model` are non-null columns, so resolving at claim/fire
 * time would need a schema change. A run is claimed seconds after it is
 * queued; a schedule keeps the model that was active when it was made.
 */
function defaultModel(prisma: PrismaClient): Promise<string | null> {
  return resolveActiveModel(prisma, { requireTools: true });
}

interface RunRow {
  id: string;
  userId: string;
  sessionId: string | null;
  goal: string;
  model: string;
  status: string;
  runAfter: Date;
  claimedBy: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  deadlineAt: Date | null;
  attempts: number;
  maxIter: number;
  iteration: number;
  trace: unknown;
  result: string | null;
  stopReason: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  pendingTool: string | null;
  pendingArgs: unknown;
  parkedAt: Date | null;
  pendingDecision: string | null;
  pendingDecidedAt: Date | null;
  workspaceId: string | null;
  cloudGate: string;
  offLanProvider: string | null;
  offLanWithheldTools: string[];
}

function serializeRun(r: RunRow, withTrace: boolean) {
  const pendingArgs =
    r.pendingArgs && typeof r.pendingArgs === "object" && !Array.isArray(r.pendingArgs)
      ? (r.pendingArgs as Record<string, unknown>)
      : {};
  return {
    id: r.id,
    goal: r.goal,
    model: r.model,
    status: r.status,
    sessionId: r.sessionId,
    iteration: r.iteration,
    maxIter: r.maxIter,
    attempts: r.attempts,
    runAfter: r.runAfter.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    deadlineAt: r.deadlineAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    result: r.result,
    stopReason: r.stopReason,
    error: r.error,
    // WARP-2896 — the workshop workspace, for the run list and the run page.
    workspaceId: r.workspaceId,
    // WARP-2997 — where the model ran, and what it was not given.
    cloudGate: r.cloudGate,
    offLanProvider: r.offLanProvider,
    offLanWithheldTools: r.offLanWithheldTools ?? [],
    // WARP-2179 — the parked call with its provenance, for the confirm
    // surface: tool, a PHI-free argument summary, the raw args (the caller
    // is the run's owner), and when it parked. Meaningful ONLY while the run
    // is parked: the worker clears the columns at every terminal write, and
    // this gate is the reader-side belt to that brace, so a consumer can
    // never be told a finished run still needs approval.
    pending: r.status === "awaiting_confirmation" && r.pendingTool
      ? {
          tool: r.pendingTool,
          args: pendingArgs,
          summary: summarizeToolArguments(r.pendingTool, pendingArgs),
          parkedAt: r.parkedAt?.toISOString() ?? null,
          decision: r.pendingDecision,
          decidedAt: r.pendingDecidedAt?.toISOString() ?? null,
        }
      : null,
    ...(withTrace
      ? { trace: Array.isArray(r.trace) ? (r.trace as AgentRunTraceEntry[]) : [] }
      : {}),
  };
}

const RUN_SELECT = {
  id: true,
  userId: true,
  sessionId: true,
  goal: true,
  model: true,
  status: true,
  runAfter: true,
  claimedBy: true,
  startedAt: true,
  endedAt: true,
  deadlineAt: true,
  attempts: true,
  maxIter: true,
  iteration: true,
  result: true,
  stopReason: true,
  error: true,
  createdAt: true,
  updatedAt: true,
  pendingTool: true,
  pendingArgs: true,
  parkedAt: true,
  pendingDecision: true,
  pendingDecidedAt: true,
  workspaceId: true,
  cloudGate: true,
  offLanProvider: true,
  offLanWithheldTools: true,
} as const;

export function createAgentRunsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const gate = requireRoleOrMcpService("owner", "admin");

  /** Actor + role, or the response already sent. */
  async function actorOr403(
    req: Request,
    res: Response,
    onBehalfOf: string | undefined,
  ): Promise<Actor | null> {
    const actor = await resolveActor(prisma, req, onBehalfOf);
    if (!actor) {
      recordAccessDenied(req, "agent-runs-no-principal");
      res.status(403).json({ error: "Forbidden: no principal to act for" });
      return null;
    }
    if (!RUN_STARTER_ROLES.has(actor.role)) {
      // The mcp principal passed the role guard on its own account; the
      // PERSON it acts for must clear the same bar.
      recordAccessDenied(req, "agent-runs-role");
      res.status(403).json({ error: "Forbidden: role not permitted to use background runs" });
      return null;
    }
    return actor;
  }

  /**
   * WARP-2997 — refuse a cloud model the person may not use up front, with
   * chat's own 451/503 body and no row written. A courtesy, not the gate:
   * the worker asks again at every claim, which is what holds for schedules
   * and for any caller that enqueues without coming through here.
   */
  async function cloudAllowedOr451(res: Response, actor: Actor, model: string): Promise<boolean> {
    const decision = await decideCloudTurn({ user: { id: actor.id, role: actor.role }, model });
    if (decision.kind === "allowed") return true;
    res.status(decision.status).json(decision.body);
    return false;
  }

  router.post("/agent-runs", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = startRunSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid run", details: parsed.error.flatten() });
        return;
      }
      const actor = await actorOr403(req, res, parsed.data.onBehalfOf);
      if (!actor) return;
      const model = parsed.data.model ?? (await defaultModel(prisma));
      if (!model) {
        res.status(400).json({ error: "model is required (no LLM_MODEL configured)" });
        return;
      }
      if (!(await cloudAllowedOr451(res, actor, model))) return;
      // WARP-2896 — a workshop run needs a workspace that exists, is still
      // active (a proposed one is read-only until reviewed) and has no other
      // run working in it: two runs on one checkout would commit over each
      // other. The binding is set once, here, and never changed. The count
      // below is the friendly answer; the DURABLE guard is the partial unique
      // index `AgentRun_workspaceId_active_key` (one active run per
      // workspace), whose P2002 the create maps onto the same 409 when two
      // starts race past the count.
      if (parsed.data.workspaceId) {
        const ws = await prisma.workshopWorkspace.findUnique({
          where: { id: parsed.data.workspaceId },
          select: { id: true, status: true },
        });
        if (!ws) {
          res.status(404).json({ error: "No such workspace" });
          return;
        }
        if (ws.status !== "active") {
          res.status(409).json({ error: `workspace is ${ws.status}; start a new one to keep working` });
          return;
        }
        const busy = await prisma.agentRun.count({
          where: { workspaceId: ws.id, status: { in: [...ACTIVE_AGENT_RUN_STATUSES] } },
        });
        if (busy > 0) {
          res.status(409).json({ error: "A run is already working in this workspace" });
          return;
        }
      }
      let id: string;
      try {
        ({ id } = await enqueueAgentRun(prisma, {
          userId: actor.id,
          goal: parsed.data.goal,
          model,
          sessionId: parsed.data.sessionId ?? null,
          maxIter: parsed.data.maxIter,
          workspaceId: parsed.data.workspaceId ?? null,
        }));
      } catch (err) {
        // The only unique constraint a workshop run's create can trip is the
        // one-active-run-per-workspace index: the row's own id is a fresh
        // cuid. So a P2002 here IS the race the count above could not see.
        if (parsed.data.workspaceId && isUniqueViolation(err)) {
          res.status(409).json({ error: "A run is already working in this workspace" });
          return;
        }
        throw err;
      }
      await recordActivity({
        kind: "tool_run",
        severity: "info",
        sourceIcon: "bot",
        what: "Agent run queued",
        sub: parsed.data.goal.length > 120 ? `${parsed.data.goal.slice(0, 117)}…` : parsed.data.goal,
        actor: actorFromRequest(req),
        refs: {
          agentRunId: id,
          userId: actor.username,
          status: "queued",
          ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
        },
      });
      res.status(201).json({ id, status: "queued", workspaceId: parsed.data.workspaceId ?? null });
    } catch (err) {
      next(err);
    }
  });

  router.get("/agent-runs", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
        return;
      }
      const actor = await actorOr403(req, res, parsed.data.onBehalfOf);
      if (!actor) return;
      const { status, limit, cursor, workspaceId } = parsed.data;
      const after = cursor ? parseCursor(cursor) : null;
      if (cursor && !after) {
        res.status(400).json({ error: "Invalid cursor" });
        return;
      }
      const rows = (await prisma.agentRun.findMany({
        where: {
          userId: actor.id,
          ...(status ? { status } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        select: RUN_SELECT,
      })) as unknown as RunRow[];
      res.json({
        items: rows.map((r) => serializeRun(r, false)),
        nextCursor: rows.length === limit ? encodeCursor(rows[rows.length - 1]!) : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── recurring runs (declared before `/:id` so "schedules" is not an id) ──

  router.get("/agent-runs/schedules", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const onBehalfOf = typeof req.query.onBehalfOf === "string" ? req.query.onBehalfOf : undefined;
      const actor = await actorOr403(req, res, onBehalfOf);
      if (!actor) return;
      const rows = (await prisma.agentRunSchedule.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
      })) as unknown as Array<{
        id: string;
        goal: string;
        model: string;
        maxIter: number;
        rrule: string;
        timezone: string;
        nextFireAt: Date;
        enabled: boolean;
        lastFiredAt: Date | null;
        createdAt: Date;
      }>;
      res.json({
        schedules: rows.map((s) => ({
          id: s.id,
          goal: s.goal,
          model: s.model,
          maxIter: s.maxIter,
          rrule: s.rrule,
          timezone: s.timezone,
          nextFireAt: s.nextFireAt.toISOString(),
          enabled: s.enabled,
          lastFiredAt: s.lastFiredAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agent-runs/schedules", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createScheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid schedule", details: parsed.error.flatten() });
        return;
      }
      const actor = await actorOr403(req, res, parsed.data.onBehalfOf);
      if (!actor) return;
      if (!isSupportedRrule(parsed.data.rrule)) {
        res.status(400).json({
          error: "Unsupported RRULE",
          detail: "Only FREQ=DAILY and FREQ=WEEKLY rules (with BYDAY/BYHOUR/BYMINUTE) are supported.",
        });
        return;
      }
      const timezone = parsed.data.timezone ?? "UTC";
      if (!isSupportedTimezone(timezone)) {
        res.status(400).json({ error: "Invalid timezone" });
        return;
      }
      const model = parsed.data.model ?? (await defaultModel(prisma));
      if (!model) {
        res.status(400).json({ error: "model is required (no LLM_MODEL configured)" });
        return;
      }
      if (!(await cloudAllowedOr451(res, actor, model))) return;
      const now = new Date();
      const nextFireAt = nextFireFromRrule(parsed.data.rrule, now, timezone);
      if (nextFireAt === null) {
        res.status(400).json({ error: "Unsupported RRULE" });
        return;
      }
      // WARP-2749 — a schedule's runs get the RUN cap, not the chat cap; the
      // ticker enqueues with this maxIter verbatim.
      const cap = config.agentRuns.maxIter;
      const created = (await prisma.agentRunSchedule.create({
        data: {
          userId: actor.id,
          goal: parsed.data.goal,
          model,
          maxIter: Math.max(1, Math.min(parsed.data.maxIter ?? cap, cap)),
          rrule: parsed.data.rrule,
          timezone,
          nextFireAt,
        },
        select: { id: true },
      })) as { id: string };
      res.status(201).json({ id: created.id, nextFireAt: nextFireAt.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/agent-runs/schedules/:id", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const onBehalfOf = typeof req.query.onBehalfOf === "string" ? req.query.onBehalfOf : undefined;
      const actor = await actorOr403(req, res, onBehalfOf);
      if (!actor) return;
      const deleted = await prisma.agentRunSchedule.deleteMany({
        where: { id: req.params.id, userId: actor.id },
      });
      if (deleted.count !== 1) {
        res.status(404).json({ error: "Schedule not found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── one run ──────────────────────────────────────────────────────────

  async function ownRun(req: Request, res: Response, actor: Actor): Promise<RunRow | null> {
    const row = (await prisma.agentRun.findUnique({
      where: { id: req.params.id },
      select: { ...RUN_SELECT, trace: true },
    })) as unknown as RunRow | null;
    if (!row || row.userId !== actor.id) {
      res.status(404).json({ error: "Run not found" });
      return null;
    }
    return row;
  }

  router.get("/agent-runs/:id", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const onBehalfOf = typeof req.query.onBehalfOf === "string" ? req.query.onBehalfOf : undefined;
      const actor = await actorOr403(req, res, onBehalfOf);
      if (!actor) return;
      const row = await ownRun(req, res, actor);
      if (!row) return;
      res.json(serializeRun(row, true));
    } catch (err) {
      next(err);
    }
  });

  router.post("/agent-runs/:id/cancel", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const onBehalfOf =
        typeof req.body?.onBehalfOf === "string" ? (req.body.onBehalfOf as string) : undefined;
      const actor = await actorOr403(req, res, onBehalfOf);
      if (!actor) return;
      const row = await ownRun(req, res, actor);
      if (!row) return;
      const ok = await cancelAgentRun(prisma, row.id);
      if (!ok) {
        res.status(409).json({ error: "Run is already finished", status: row.status });
        return;
      }
      await recordActivity({
        kind: "tool_run",
        severity: "info",
        sourceIcon: "bot",
        what: "Agent run cancelled by user",
        sub: `for ${actor.username}`,
        actor: actorFromRequest(req),
        refs: { agentRunId: row.id, userId: actor.username, status: "cancelled" },
      });
      res.json({ id: row.id, status: "cancelled" });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agent-runs/:id/confirm", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = decideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid decision", details: parsed.error.flatten() });
        return;
      }
      const actor = await actorOr403(req, res, parsed.data.onBehalfOf);
      if (!actor) return;
      const row = await ownRun(req, res, actor);
      if (!row) return;
      const decided = await decideAgentRun(prisma, {
        id: row.id,
        decision: parsed.data.decision,
        decidedBy: { id: actor.id, role: actor.role, username: actor.username },
      });
      if (!decided.ok) {
        const status =
          decided.reason === "not_found"
            ? 404
            : decided.reason === "not_owner" || decided.reason === "forbidden_tool_for_role"
              ? 403
              : 409;
        if (status === 403) recordAccessDenied(req, `agent-runs-confirm-${decided.reason}`);
        res.status(status).json({ error: decided.reason, id: row.id });
        return;
      }
      res.json({ id: row.id, tool: decided.tool, decision: decided.decision, status: "queued" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
