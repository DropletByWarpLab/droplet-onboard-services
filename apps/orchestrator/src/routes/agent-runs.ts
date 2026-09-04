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
import {
  recordAccessDenied,
  requireRoleOrMcpService,
  type AuthUser,
} from "../middleware/auth.js";
import {
  cancelAgentRun,
  decideAgentRun,
  enqueueAgentRun,
  type AgentRunTraceEntry,
} from "../services/agent-run-worker.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { summarizeToolArguments } from "../services/confirmation-summary.js";
import {
  isSupportedRrule,
  isSupportedTimezone,
  nextFireFromRrule,
} from "../utils/rrule.js";

const MCP_PRINCIPAL_ID = "_service:mcp";
const RUN_STARTER_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const startRunSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  model: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
  maxIter: z.coerce.number().int().positive().optional(),
  /** Username the mcp principal acts for. Ignored for everyone else. */
  onBehalfOf: z.string().trim().min(1).max(200).optional(),
});

const listQuerySchema = z.object({
  status: z
    .enum(["queued", "running", "awaiting_confirmation", "succeeded", "failed", "cancelled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque: the previous page's tail `createdAt`, ISO. */
  cursor: z.string().datetime().optional(),
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

function defaultModel(): string | null {
  const m = (process.env.DEFAULT_MODEL ?? process.env.LLM_MODEL ?? "").trim();
  return m.length > 0 ? m : null;
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
    // WARP-2179 — the parked call with its provenance, for the confirm
    // surface: tool, a PHI-free argument summary, the raw args (the caller
    // is the run's owner), and when it parked.
    pending: r.pendingTool
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

  router.post("/agent-runs", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = startRunSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid run", details: parsed.error.flatten() });
        return;
      }
      const actor = await actorOr403(req, res, parsed.data.onBehalfOf);
      if (!actor) return;
      const model = parsed.data.model ?? defaultModel();
      if (!model) {
        res.status(400).json({ error: "model is required (no LLM_MODEL configured)" });
        return;
      }
      const { id } = await enqueueAgentRun(prisma, {
        userId: actor.id,
        goal: parsed.data.goal,
        model,
        sessionId: parsed.data.sessionId ?? null,
        maxIter: parsed.data.maxIter,
      });
      await recordActivity({
        kind: "tool_run",
        severity: "info",
        sourceIcon: "bot",
        what: "Agent run queued",
        sub: parsed.data.goal.length > 120 ? `${parsed.data.goal.slice(0, 117)}…` : parsed.data.goal,
        actor: actorFromRequest(req),
        refs: { agentRunId: id, userId: actor.username, status: "queued" },
      });
      res.status(201).json({ id, status: "queued" });
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
      const { status, limit, cursor } = parsed.data;
      const rows = (await prisma.agentRun.findMany({
        where: {
          userId: actor.id,
          ...(status ? { status } : {}),
          ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        select: RUN_SELECT,
      })) as unknown as RunRow[];
      res.json({
        items: rows.map((r) => serializeRun(r, false)),
        nextCursor: rows.length === limit ? rows[rows.length - 1]!.createdAt.toISOString() : null,
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
      const model = parsed.data.model ?? defaultModel();
      if (!model) {
        res.status(400).json({ error: "model is required (no LLM_MODEL configured)" });
        return;
      }
      const now = new Date();
      const nextFireAt = nextFireFromRrule(parsed.data.rrule, now, timezone);
      if (nextFireAt === null) {
        res.status(400).json({ error: "Unsupported RRULE" });
        return;
      }
      const cap = config.agentMaxIter.capIter;
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
