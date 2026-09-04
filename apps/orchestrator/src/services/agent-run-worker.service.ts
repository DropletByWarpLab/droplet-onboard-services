/**
 * WARP-2177 — the durable agent-run worker (epic WARP-2176).
 *
 * `runAgent()` runs a whole turn inside one HTTP request: close the laptop
 * and the turn dies, redeploy the box and every in-flight turn dies with the
 * container. This file is what lets a run outlive the request that started
 * it. It adds ONE table (`AgentRun`), ONE worker, and a checkpoint at the
 * loop's iteration boundary. The loop is not rewritten — the worker calls
 * it with a resumed message array and the `checkpoint` port it grew for
 * this purpose. Design: `docs/agent-runs-design.md`.
 *
 * ── Two ticks, one clock ──────────────────────────────────────────────
 *
 * Both ride `cronRuntime.scheduleInterval` (index.ts). No Redis, no BullMQ,
 * no second scheduler — `agent-run-worker.no-queue-dependency.test.ts` pins
 * that.
 *
 *   tickOnce()      — under the `droplet:agent-run-worker` advisory lock:
 *                     reclaim stale leases, then CLAIM queued rows up to
 *                     `AGENT_RUN_CONCURRENCY`. Fast, DB-only.
 *   heartbeatOnce() — per process, no lock: beat every run this process is
 *                     executing, and observe cancellation / the deadline.
 *
 * THE RUN ITSELF EXECUTES OUTSIDE THE TICK. cron-runtime's advisory lock is
 * transaction-scoped (`pg_try_advisory_xact_lock` inside a `$transaction`
 * with a 60 s timeout), which is exactly right for a tick and exactly wrong
 * for a forty-minute run. So the tick claims and launches; the execution is
 * a tracked promise that finishes on its own. The lock serialises CLAIMING
 * across replicas; the claim itself is a conditional `updateMany` on
 * `status = queued`, so even two unlocked racers cannot both win a row
 * (`agent-run-claim.pg.test.ts` proves it on a real Postgres).
 *
 * ── Fencing ───────────────────────────────────────────────────────────
 *
 * Every write an executor makes is conditioned on `claimedBy = workerId AND
 * status = running`. A run whose lease was reclaimed by another worker (this
 * process paused longer than the reclaim threshold) is therefore a run this
 * process can no longer touch: its next checkpoint returns `count: 0`, it
 * aborts, and the successor carries on from the row. Without the fence the
 * zombie would overwrite the successor's checkpoint with an older one.
 *
 * ── Whose access ──────────────────────────────────────────────────────
 *
 * A run executes as its attributed `userId`, and that identity's CURRENT
 * reach is resolved at every claim through `resolveAttributedToolAccess`
 * (the WARP-1580 ticker rule): a run must not outlive a role change with
 * stale reach. An identity that cannot be resolved does not run — it fails
 * with the attribution reason, the same skip-and-audit posture as the
 * ToolSpec ticker — rather than running at DENY_ALL reach and burning GPU
 * on a turn that can call nothing. Where a resolved scope IS passed to the
 * loop it is `attributed.scope`, never `null`-for-unknown.
 *
 * ── Tier-2: park, never auto-confirm (WARP-2179) ──────────────────────
 *
 * A background run is an unattended privileged actor. The user authorised a
 * GOAL, not each destructive act the model later chose, so a confirming tool
 * is never auto-confirmed on the grounds that "the user started the run".
 * When the WARP-2305 interceptor challenges a Tier-2 call, the loop hands the
 * challenge to this worker's approvals port, and the run is PARKED:
 * `status = awaiting_confirmation`, the lease released, the pending call
 * recorded in explicit columns bound exactly as the interceptor binds its
 * token (tool + `confirmationBindingHash(args)`), the interceptor's token
 * DROPPED, and the owner notified over the same ws-bridge topic the desktop
 * app already consumes. No confirmation inside any window leaves it parked.
 *
 * On approval (`decideAgentRun`, which re-checks the run's principal can
 * still reach the tool — confirmation is not an escalation path) the run is
 * re-queued and resumed from its checkpoint. The model re-issues the call;
 * `beforeToolCall` recognises the approved binding and performs the
 * interceptor handshake itself — one dispatch without a token to obtain a
 * FRESH challenge (minted now, seconds after the human decided, redeemed in
 * the same breath) and one with it. The interceptor stays the single gate;
 * the human's decision is what authorises this worker to redeem. On denial
 * the model receives a `CONFIRMATION_DENIED` tool result and adapts.
 *
 * Tier-3 (a tool outside the run's pool, or one the interceptor's deny tier
 * refuses) is refused exactly as in chat, never parked.
 *
 * ── `attempts` ────────────────────────────────────────────────────────
 *
 * Counts RECLAIMS (a lease found stale), not claims: a graceful redeploy
 * releases its runs back to `queued` without charging them an attempt, so
 * three routine deploys cannot fail a healthy long run. Past
 * `AGENT_RUN_MAX_ATTEMPTS` a stale run is failed with an error naming the
 * count instead of being re-queued for a fourth crash.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { TOOL_CATALOG, confirmationBindingHash } from "@droplet/tools-core";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import type { ChatMessage } from "../types/index.js";
import { contentToText } from "../types/index.js";
import {
  runAgent,
  type AgentCheckpointPort,
  type AgentDeps,
  type AgentResult,
  type ChatApprovalPort,
} from "./llm-agent.service.js";
import {
  narrowToolNamesForPrincipal,
  resolveAttributedToolAccess,
  toolAllowedForPrincipal,
} from "./tool-access.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import { recordActivity } from "./activity.singleton.js";
import { sendNotification } from "./notifications.service.js";
import { summarizeToolArguments } from "./confirmation-summary.js";

const logger = createLogger("agent-run-worker");

export const AGENT_RUN_LOCK_KEY = "droplet:agent-run-worker";

/**
 * Tools chat excludes that a background run gets back.
 *
 * `EXCLUDED_FROM_CHAT_TOOLS` is a window-budget and UX list, not a safety
 * tier: `send_notification` sits there under "box-admin writes + misc"
 * because a person reading a chat answer does not also need a toast. A run
 * has no reader, so a notification is its natural completion channel — and
 * it is Tier-1 in the catalog (`requiresConfirmation: false`), so
 * re-admitting it widens no trust boundary. Nothing else is re-admitted:
 * every other exclusion is policy ("chat must not delete camera evidence")
 * and applies with MORE force to an unattended actor.
 */
export const RUN_READMITTED_TOOLS: ReadonlySet<string> = new Set(["send_notification"]);

/**
 * WARP-2180 — tools a run may never see. `start_agent_run` is how a chat
 * turn hands work off; inside a run it is how one prompt spawns a fleet that
 * saturates the model. Structural refusal here; the handler refuses too.
 */
export const RUN_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["start_agent_run"]);

/**
 * The pool a run starts from, before per-principal narrowing: the chat pool
 * (chat-tool-scope.ts) plus {@link RUN_READMITTED_TOOLS}. Confirming (Tier-2)
 * tools are IN — the interceptor challenges them and the run parks
 * (WARP-2179). What chat excludes on policy grounds ("chat must not delete
 * camera evidence") stays out: that is the run's Tier-3.
 */
export function runToolPool(): string[] {
  return TOOL_CATALOG.filter(
    (t) =>
      !RUN_EXCLUDED_TOOLS.has(t.name) &&
      (RUN_READMITTED_TOOLS.has(t.name) || !EXCLUDED_FROM_CHAT_TOOLS.has(t.name)),
  ).map((t) => t.name);
}

/** One dispatched tool call, as persisted in `AgentRun.trace`. */
export interface AgentRunTraceEntry {
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  /** Absolute iteration within the run (checkpoint base + loop iteration). */
  iteration: number;
  dispatchedAt: string;
  /** Raw wire text of the result. Absent = dispatched, outcome never recorded. */
  text?: string;
  isError?: boolean;
  completedAt?: string;
  /** Set when this entry was served from a prior entry rather than dispatched. */
  replayOf?: string;
  /** WARP-2179 — how a Tier-2 call was resolved, for the run-detail view. */
  confirmation?: "parked" | "confirmed" | "denied";
}

/**
 * The system prompt for a background run. Deliberately minimal and
 * deliberately different from chat: nobody is watching, so the model must
 * not ask, and it must end with a report. Persona / identity blocks are a
 * chat-route concern and are not assembled here.
 */
export const AGENT_RUN_SYSTEM_PROMPT =
  "You are Droplet, working on a background task on behalf of the user. " +
  "Nobody is watching this run and you cannot ask questions: make reasonable " +
  "assumptions, use the tools available to you, and finish the task. When it " +
  "is done, reply with a concise final report of what you did and what you " +
  "found. If it cannot be completed, say exactly what blocked you.";

export function initialRunMessages(goal: string): ChatMessage[] {
  return [
    { role: "system", content: AGENT_RUN_SYSTEM_PROMPT },
    { role: "user", content: goal },
  ];
}

export interface EnqueueAgentRunInput {
  userId: string;
  goal: string;
  model: string;
  sessionId?: string | null;
  /** Clamped to the loop's own cap (config.agentMaxIter.capIter). */
  maxIter?: number;
  runAfter?: Date;
}

/** Create a `queued` run. The worker's next tick claims it. */
export async function enqueueAgentRun(
  prisma: PrismaClient,
  input: EnqueueAgentRunInput,
): Promise<{ id: string }> {
  const cap = config.agentMaxIter.capIter;
  const maxIter = Math.max(1, Math.min(input.maxIter ?? cap, cap));
  const row = await prisma.agentRun.create({
    data: {
      userId: input.userId,
      goal: input.goal,
      model: input.model,
      sessionId: input.sessionId ?? null,
      maxIter,
      ...(input.runAfter ? { runAfter: input.runAfter } : {}),
    },
    select: { id: true },
  });
  return row;
}

/**
 * Request cancellation. A `queued` run is terminal immediately; a `running`
 * one is observed by its executor at the next heartbeat or checkpoint, which
 * maps it onto the loop's own `AbortController` so no further tool
 * dispatches happen. Returns false when the run was already terminal.
 */
export async function cancelAgentRun(
  prisma: PrismaClient,
  id: string,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await prisma.agentRun.updateMany({
    where: { id, status: { in: ["queued", "running", "awaiting_confirmation"] } },
    data: { status: "cancelled", endedAt: now },
  });
  return res.count === 1;
}

export type AgentRunDecision = "approved" | "denied";

export type DecideAgentRunResult =
  | { ok: true; tool: string; decision: AgentRunDecision }
  | {
      ok: false;
      reason: "not_found" | "not_parked" | "not_owner" | "attribution_failed" | "forbidden_tool_for_role";
    };

/**
 * WARP-2179 — the human's decision on a parked Tier-2 call.
 *
 * Approval is NOT an escalation path: the run's attributed principal must
 * still be able to reach the tool NOW (both axes, the same predicate the
 * loop applies at dispatch), or the approval is refused and the run stays
 * parked. Only the run's owner (or an `owner`-role principal) may decide.
 * The decision is recorded on the row and the run re-queued; the worker
 * consumes it on resume. `deadlineAt` is extended by the time spent parked,
 * so waiting for a human is not charged against the wall clock.
 */
export async function decideAgentRun(
  prisma: PrismaClient,
  input: {
    id: string;
    decision: AgentRunDecision;
    decidedBy: { id: string; role?: string; username?: string };
    resolveAccess?: typeof resolveAttributedToolAccess;
    now?: Date;
  },
): Promise<DecideAgentRunResult> {
  const now = input.now ?? new Date();
  const run = (await prisma.agentRun.findUnique({
    where: { id: input.id },
    select: {
      userId: true,
      status: true,
      pendingTool: true,
      parkedAt: true,
      deadlineAt: true,
    },
  })) as {
    userId: string;
    status: string;
    pendingTool: string | null;
    parkedAt: Date | null;
    deadlineAt: Date | null;
  } | null;
  if (!run) return { ok: false, reason: "not_found" };
  if (run.status !== "awaiting_confirmation" || !run.pendingTool) {
    return { ok: false, reason: "not_parked" };
  }
  if (input.decidedBy.id !== run.userId && input.decidedBy.role !== "owner") {
    return { ok: false, reason: "not_owner" };
  }
  if (input.decision === "approved") {
    const access = await (input.resolveAccess ?? resolveAttributedToolAccess)(prisma, run.userId);
    if (access.unresolved !== null) return { ok: false, reason: "attribution_failed" };
    if (!toolAllowedForPrincipal(run.pendingTool, access.tier ?? undefined, access.scope)) {
      return { ok: false, reason: "forbidden_tool_for_role" };
    }
  }
  const parkedMs = run.parkedAt ? Math.max(0, now.getTime() - run.parkedAt.getTime()) : 0;
  const res = await prisma.agentRun.updateMany({
    where: { id: input.id, status: "awaiting_confirmation" },
    data: {
      status: "queued",
      runAfter: now,
      pendingDecision: input.decision,
      pendingDecidedAt: now,
      pendingDecidedBy: input.decidedBy.id,
      ...(run.deadlineAt ? { deadlineAt: new Date(run.deadlineAt.getTime() + parkedMs) } : {}),
    },
  });
  if (res.count !== 1) return { ok: false, reason: "not_parked" };
  await recordActivity({
    kind: "tool_call",
    severity: input.decision === "approved" ? "info" : "warn",
    sourceIcon: input.decision === "approved" ? "shield-check" : "shield-off",
    what:
      input.decision === "approved"
        ? `${run.pendingTool} approved for background run`
        : `${run.pendingTool} refused for background run`,
    sub: input.decidedBy.username ? `by ${input.decidedBy.username}` : null,
    actor: { type: "user", id: input.decidedBy.id },
    refs: {
      agentRunId: input.id,
      name: run.pendingTool,
      confirmation: input.decision === "approved" ? "user_approved" : "user_denied",
      ticket: "WARP-2179",
    },
  });
  return { ok: true, tool: run.pendingTool, decision: input.decision };
}

/** Why an execution stopped before the loop finished on its own. */
type StopReason = "cancelled" | "deadline" | "fenced" | "parked";

class AgentRunStopped extends Error {
  constructor(
    readonly reason: StopReason,
    message: string,
  ) {
    super(message);
    this.name = "AgentRunStopped";
  }
}

export interface AgentRunWorkerDeps {
  prisma: PrismaClient;
  /** The loop's own ports. Production: the MCP multiplexer + ai-gateway. */
  agent: Pick<AgentDeps, "mcp" | "aiGateway">;
  /** Test seams. Production leaves every one of these unset. */
  limits?: typeof config.agentRuns;
  maxIterCap?: number;
  contextWindow?: number;
  toolSelectionMode?: "off" | "domains";
  workerId?: string;
  now?: () => Date;
  resolveAccess?: typeof resolveAttributedToolAccess;
}

export interface TickCounts {
  reclaimed: number;
  failed: number;
  claimed: number;
}

export interface AgentRunWorker {
  readonly workerId: string;
  /** Reclaim stale leases, then claim up to capacity. Runs under the lock. */
  tickOnce(): Promise<TickCounts>;
  /** Beat every in-flight run; observe cancellation and the deadline. */
  heartbeatOnce(): Promise<number>;
  /** Execute one run this worker has already claimed. Exposed for tests. */
  execute(runId: string): Promise<void>;
  inFlight(): ReadonlySet<string>;
  /**
   * Graceful shutdown: abort every in-flight loop and hand the rows back to
   * `queued` (not charged as an attempt) so the restarted process resumes
   * them on its next tick instead of after the reclaim threshold.
   */
  releaseAll(): Promise<void>;
}

/**
 * The interceptor's challenge, as the mcp-server puts it on the wire
 * (`interceptOutcomeToToolResult`): `status: "confirmation_required"` with
 * `error.details.interceptor.outcome === "confirmation_required"` and the
 * minted token. Anything else — a rejection, a deny-tier refusal, a real
 * result — yields `null`.
 */
function interceptorTokenOf(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as {
      status?: unknown;
      error?: { details?: { interceptor?: { outcome?: unknown; confirmationToken?: unknown } } };
    };
    if (parsed?.status !== "confirmation_required") return null;
    const block = parsed.error?.details?.interceptor;
    if (block?.outcome !== "confirmation_required") return null;
    return typeof block.confirmationToken === "string" && block.confirmationToken.length > 0
      ? block.confirmationToken
      : null;
  } catch {
    return null;
  }
}

/**
 * WARP-2179 — a challenge payload carries the interceptor's minted token
 * (twice: nested and, for the WARP-640 chip, flat). Nothing persisted about
 * a run may hold it — "no token exists while the run sits parked" — so the
 * trace stores the challenge with the secret removed. The shape is
 * otherwise intact, so the run-detail view still shows what was asked.
 */
function scrubInterceptorToken(text: string): string {
  if (interceptorTokenOf(text) === null) return text;
  try {
    const parsed = JSON.parse(text) as {
      error?: { details?: { confirmationToken?: unknown; interceptor?: { confirmationToken?: unknown } } };
    };
    const details = parsed.error?.details;
    if (details) {
      if ("confirmationToken" in details) details.confirmationToken = "[dropped]";
      if (details.interceptor && "confirmationToken" in details.interceptor) {
        details.interceptor.confirmationToken = "[dropped]";
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return text;
  }
}

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

export function createAgentRunWorker(deps: AgentRunWorkerDeps): AgentRunWorker {
  const { prisma } = deps;
  const limits = deps.limits ?? config.agentRuns;
  const maxIterCap = deps.maxIterCap ?? config.agentMaxIter.capIter;
  const contextWindow = deps.contextWindow ?? config.OLLAMA_CONTEXT_LENGTH;
  const toolSelectionMode = deps.toolSelectionMode ?? config.TOOL_SELECTION_MODE;
  const now = deps.now ?? (() => new Date());
  const resolveAccess = deps.resolveAccess ?? resolveAttributedToolAccess;
  const workerId =
    deps.workerId ?? `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;

  /** runId → the execution promise. */
  const inFlight = new Map<string, Promise<void>>();
  /** runId → the abort controller mapped onto the loop's `signal`. */
  const controllers = new Map<string, AbortController>();
  /** runId → why it was told to stop, so the terminal write names it. */
  const stopReasons = new Map<string, StopReason>();

  function stop(runId: string, reason: StopReason): void {
    if (!stopReasons.has(runId)) stopReasons.set(runId, reason);
    controllers.get(runId)?.abort();
  }

  /** The fence every executor write carries. */
  const owned = (id: string) => ({ id, claimedBy: workerId, status: "running" as const });

  async function reclaimStale(at: Date): Promise<{ reclaimed: number; failed: number }> {
    const cutoff = new Date(at.getTime() - limits.reclaimAfterMs);
    const stale = (await prisma.agentRun.findMany({
      where: { status: "running", heartbeatAt: { lt: cutoff } },
      select: { id: true, attempts: true, claimedBy: true, heartbeatAt: true },
      take: 50,
    })) as Array<{
      id: string;
      attempts: number;
      claimedBy: string | null;
      heartbeatAt: Date | null;
    }>;
    let reclaimed = 0;
    let failed = 0;
    for (const row of stale) {
      // Conditioned on the SAME claimedBy we read, so a row that was
      // legitimately re-claimed between the read and this write is left
      // alone (its claimedBy no longer matches).
      const fence = { id: row.id, status: "running" as const, claimedBy: row.claimedBy };
      if (row.attempts >= limits.maxAttempts) {
        const res = await prisma.agentRun.updateMany({
          where: fence,
          data: {
            status: "failed",
            endedAt: at,
            error:
              `worker lease lost ${row.attempts + 1} time(s) ` +
              `(AGENT_RUN_MAX_ATTEMPTS=${limits.maxAttempts}); last worker ` +
              `${row.claimedBy ?? "unknown"} stopped heartbeating at ` +
              `${row.heartbeatAt?.toISOString() ?? "unknown"}`,
          },
        });
        if (res.count === 1) {
          failed += 1;
          logger.error(
            { runId: row.id, attempts: row.attempts + 1, lastWorker: row.claimedBy },
            "agent_run_failed_max_attempts",
          );
        }
        continue;
      }
      const res = await prisma.agentRun.updateMany({
        where: fence,
        data: {
          status: "queued",
          attempts: { increment: 1 },
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          runAfter: at,
        },
      });
      if (res.count === 1) {
        reclaimed += 1;
        logger.warn(
          { runId: row.id, attempts: row.attempts + 1, lastWorker: row.claimedBy },
          "agent_run_reclaimed",
        );
      }
    }
    return { reclaimed, failed };
  }

  /**
   * The claim. One transaction: the conditional flip to `running` and the
   * first-claim stamps (`startedAt`, `deadlineAt`) commit together or not at
   * all. `count !== 1` means another worker won the row.
   */
  async function claim(runId: string, at: Date): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const won = await tx.agentRun.updateMany({
        where: { id: runId, status: "queued" },
        data: { status: "running", claimedBy: workerId, claimedAt: at, heartbeatAt: at },
      });
      if (won.count !== 1) return false;
      await tx.agentRun.updateMany({
        where: { id: runId, startedAt: null },
        data: { startedAt: at, deadlineAt: new Date(at.getTime() + limits.maxWallMs) },
      });
      return true;
    });
  }

  function launch(runId: string): void {
    const p = execute(runId)
      .catch((err) => {
        logger.error({ err, runId }, "agent_run_executor_threw");
      })
      .finally(() => {
        inFlight.delete(runId);
        controllers.delete(runId);
        stopReasons.delete(runId);
      });
    inFlight.set(runId, p);
  }

  async function tickOnce(): Promise<TickCounts> {
    const at = now();
    const { reclaimed, failed } = await reclaimStale(at);
    let claimed = 0;
    const capacity = limits.concurrency - inFlight.size;
    if (capacity > 0) {
      const candidates = (await prisma.agentRun.findMany({
        where: { status: "queued", runAfter: { lte: at } },
        orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
        take: capacity,
        select: { id: true },
      })) as Array<{ id: string }>;
      for (const c of candidates) {
        if (inFlight.size >= limits.concurrency) break;
        if (!(await claim(c.id, at))) continue;
        claimed += 1;
        launch(c.id);
      }
    }
    return { reclaimed, failed, claimed };
  }

  /**
   * Read the row's liveness as this worker sees it and stop the execution
   * when the row says so. Shared by the heartbeat and the checkpoint hooks
   * so cancellation, the deadline and a lost lease are observed at every
   * point the run touches the DB — never only between iterations.
   */
  async function observe(runId: string, at: Date): Promise<StopReason | null> {
    const row = (await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true, claimedBy: true, deadlineAt: true },
    })) as { status: string; claimedBy: string | null; deadlineAt: Date | null } | null;
    if (!row || row.claimedBy !== workerId || row.status !== "running") {
      const reason: StopReason = row?.status === "cancelled" ? "cancelled" : "fenced";
      stop(runId, reason);
      return reason;
    }
    if (row.deadlineAt && row.deadlineAt.getTime() <= at.getTime()) {
      stop(runId, "deadline");
      return "deadline";
    }
    return null;
  }

  async function heartbeatOnce(): Promise<number> {
    const at = now();
    let beaten = 0;
    for (const runId of inFlight.keys()) {
      if ((await observe(runId, at)) !== null) continue;
      const res = await prisma.agentRun.updateMany({
        where: owned(runId),
        data: { heartbeatAt: at },
      });
      if (res.count === 1) beaten += 1;
      else stop(runId, "fenced");
    }
    return beaten;
  }

  async function finish(
    runId: string,
    data: Prisma.AgentRunUpdateManyMutationInput,
    fenceStatuses: ReadonlyArray<"running" | "cancelled"> = ["running"],
  ): Promise<boolean> {
    const res = await prisma.agentRun.updateMany({
      where: { id: runId, claimedBy: workerId, status: { in: [...fenceStatuses] } },
      data,
    });
    return res.count === 1;
  }

  async function execute(runId: string): Promise<void> {
    const at = now();
    const run = (await prisma.agentRun.findUnique({ where: { id: runId } })) as
      | {
          id: string;
          userId: string;
          goal: string;
          model: string;
          status: string;
          claimedBy: string | null;
          deadlineAt: Date | null;
          maxIter: number;
          iteration: number;
          messages: unknown;
          trace: unknown;
          pendingTool: string | null;
          pendingBindingHash: string | null;
          pendingArgs: unknown;
          pendingDecision: "approved" | "denied" | null;
        }
      | null;
    if (!run || run.status !== "running" || run.claimedBy !== workerId) return;

    const controller = new AbortController();
    controllers.set(runId, controller);

    // ── Access, resolved NOW, from the attributed principal ─────────────
    const access = await resolveAccess(prisma, run.userId);
    if (access.unresolved !== null) {
      await finish(runId, {
        status: "failed",
        endedAt: at,
        error: `attribution_failed:${access.unresolved}`,
      });
      await recordActivity({
        kind: "tool_run",
        severity: "warn",
        sourceIcon: "shield",
        what: "Agent run refused (access)",
        actor: { type: "system" },
        sub: `run ${runId}: no resolvable owner (${access.unresolved})`,
        refs: { agentRunId: runId, userId: run.userId, reason: access.unresolved },
      });
      return;
    }
    const user = (await prisma.user.findUnique({
      where: { id: run.userId },
      select: { username: true, role: true },
    })) as { username: string; role: string } | null;

    const allowedTools = narrowToolNamesForPrincipal(
      runToolPool(),
      access.tier ?? undefined,
      access.scope,
    );
    const toolCallContext = {
      ...(user ? { userId: user.username, userRole: user.role } : {}),
      agentRunId: runId,
    };

    // ── Resume state ────────────────────────────────────────────────────
    const base = run.iteration;
    const messages = Array.isArray(run.messages)
      ? (run.messages as ChatMessage[])
      : initialRunMessages(run.goal);
    const trace: AgentRunTraceEntry[] = Array.isArray(run.trace)
      ? (run.trace as AgentRunTraceEntry[])
      : [];
    const replayed = new Set<string>();
    const maxIter = Math.min(run.maxIter, maxIterCap);
    const remaining = maxIter - base;
    if (remaining <= 0) {
      await finish(runId, {
        status: "failed",
        endedAt: at,
        stopReason: "iteration_limit",
        error: `iteration_limit: ${base} of ${maxIter} iterations used, no final answer`,
      });
      return;
    }

    // ── WARP-2179: a decided park to consume, and a park to record ──────
    let pending: { tool: string; bindingHash: string; decision: "approved" | "denied" } | null =
      run.pendingTool && run.pendingBindingHash && run.pendingDecision
        ? { tool: run.pendingTool, bindingHash: run.pendingBindingHash, decision: run.pendingDecision }
        : null;
    let lastDispatch: { tool: string; tool_call_id: string; iteration: number } | null = null;
    const park: {
      request: {
        tool: string;
        args: Record<string, unknown>;
        bindingHash: string;
        tool_call_id: string | null;
      } | null;
    } = { request: null };

    const auditConfirmation = (tool: string, outcome: "parked" | "confirmed" | "denied") =>
      recordActivity({
        kind: "tool_call",
        severity: outcome === "confirmed" ? "ok" : outcome === "denied" ? "warn" : "info",
        sourceIcon: "shield",
        what:
          outcome === "parked"
            ? `${tool} parked for approval`
            : outcome === "confirmed"
              ? `${tool} approved and run`
              : `${tool} declined by user`,
        sub: user ? `for ${user.username}` : null,
        actor: { type: "ai", id: run.userId },
        refs: {
          agentRunId: runId,
          name: tool,
          confirmation: outcome,
          ...(user ? { userId: user.username } : {}),
          ticket: "WARP-2179",
        },
      });

    const persistTrace = async (): Promise<void> => {
      const ok = await finish(runId, {
        trace: trace as unknown as Prisma.InputJsonValue,
        heartbeatAt: now(),
      });
      if (!ok) {
        stop(runId, "fenced");
        throw new AgentRunStopped("fenced", "lease no longer held");
      }
    };

    const checkpoint: AgentCheckpointPort = {
      async onIteration(iter, msgs) {
        const observed = await observe(runId, now());
        if (observed) throw new AgentRunStopped(observed, `run stopped: ${observed}`);
        const ok = await finish(runId, {
          iteration: base + iter,
          messages: msgs as unknown as Prisma.InputJsonValue,
          heartbeatAt: now(),
        });
        if (!ok) {
          stop(runId, "fenced");
          throw new AgentRunStopped("fenced", "lease no longer held");
        }
      },
      async beforeToolCall(call) {
        const observed = await observe(runId, now());
        if (observed) throw new AgentRunStopped(observed, `run stopped: ${observed}`);
        const abs = base + call.iteration;
        lastDispatch = { tool: call.tool, tool_call_id: call.tool_call_id, iteration: abs };
        const key = canonical(call.args);

        // ── WARP-2179: the model re-issued the call a human decided on ──
        if (
          pending &&
          pending.tool === call.tool &&
          pending.bindingHash === confirmationBindingHash(call.tool, call.args)
        ) {
          const decision = pending.decision;
          pending = null;
          // The challenge entries the park left behind must never be
          // replayed as a live result.
          for (const e of trace) {
            if (e.iteration === abs && e.tool === call.tool && canonical(e.args) === key) {
              replayed.add(e.tool_call_id);
            }
          }
          const record = async (
            text: string,
            isError: boolean,
            confirmation: "confirmed" | "denied",
          ) => {
            trace.push({
              tool_call_id: call.tool_call_id,
              tool: call.tool,
              args: call.args,
              iteration: abs,
              dispatchedAt: now().toISOString(),
              text,
              isError,
              completedAt: now().toISOString(),
              confirmation,
            });
            const ok = await finish(runId, {
              trace: trace as unknown as Prisma.InputJsonValue,
              heartbeatAt: now(),
              pendingTool: null,
              pendingBindingHash: null,
              pendingArgs: Prisma.DbNull,
              pendingToolCallId: null,
              pendingDecision: null,
              pendingDecidedAt: null,
              pendingDecidedBy: null,
              parkedAt: null,
            });
            if (!ok) {
              stop(runId, "fenced");
              throw new AgentRunStopped("fenced", "lease no longer held");
            }
            await auditConfirmation(call.tool, confirmation);
          };
          if (decision === "denied") {
            const text = JSON.stringify({
              status: "error",
              error: {
                code: "CONFIRMATION_DENIED",
                message:
                  `The user declined '${call.tool}' for this run. Do not retry it; ` +
                  "adapt, or finish with what you have and say what was not done.",
              },
            });
            await record(text, true, "denied");
            return { text, isError: true };
          }
          // Approved: the interceptor handshake, both legs here. Leg 1 asks
          // without a token and receives a FRESH challenge — minted now,
          // seconds after the human decided. Leg 2 presents it. Anything
          // other than a challenge on leg 1 (deny tier, a tool that no
          // longer confirms, an error) is the box's honest answer and is
          // handed back as-is.
          const first = await deps.agent.mcp.callTool(call.tool, call.args, toolCallContext);
          const firstText = first.content[0]?.text ?? "{}";
          const token = interceptorTokenOf(firstText);
          if (!token) {
            await record(firstText, Boolean(first.isError), "confirmed");
            return { text: firstText, isError: Boolean(first.isError) };
          }
          const second = await deps.agent.mcp.callTool(call.tool, call.args, {
            ...toolCallContext,
            confirmationToken: token,
          });
          const text = second.content[0]?.text ?? "{}";
          await record(text, Boolean(second.isError), "confirmed");
          logger.info({ runId, tool: call.tool, iteration: abs }, "agent_run_tool_confirmed");
          return { text, isError: Boolean(second.isError) };
        }

        // Replay: a completed entry from an interrupted segment of THIS
        // iteration, same tool, same args, not yet served.
        const hit = trace.find(
          (e) =>
            e.iteration === abs &&
            e.text !== undefined &&
            e.tool === call.tool &&
            !replayed.has(e.tool_call_id) &&
            canonical(e.args) === key,
        );
        if (hit) {
          replayed.add(hit.tool_call_id);
          trace.push({
            tool_call_id: call.tool_call_id,
            tool: call.tool,
            args: call.args,
            iteration: abs,
            dispatchedAt: now().toISOString(),
            text: hit.text,
            isError: hit.isError,
            completedAt: now().toISOString(),
            replayOf: hit.tool_call_id,
          });
          await persistTrace();
          logger.info(
            { runId, tool: call.tool, replayOf: hit.tool_call_id, iteration: abs },
            "agent_run_tool_replayed",
          );
          return { text: hit.text!, isError: Boolean(hit.isError) };
        }
        const unknownOutcome = trace.find(
          (e) =>
            e.iteration === abs &&
            e.text === undefined &&
            e.tool === call.tool &&
            canonical(e.args) === key,
        );
        if (unknownOutcome) {
          // Dispatched before the crash, outcome never recorded. It may have
          // had its side effect; we cannot know. Re-dispatching is the only
          // way to make progress — say so loudly rather than silently.
          logger.warn(
            { runId, tool: call.tool, priorCallId: unknownOutcome.tool_call_id, iteration: abs },
            "agent_run_redispatch_unknown_outcome",
          );
        }
        trace.push({
          tool_call_id: call.tool_call_id,
          tool: call.tool,
          args: call.args,
          iteration: abs,
          dispatchedAt: now().toISOString(),
        });
        await persistTrace();
        return undefined;
      },
      async afterToolCall(call) {
        const abs = base + call.iteration;
        const entry = trace.find(
          (e) => e.tool_call_id === call.tool_call_id && e.iteration === abs,
        );
        if (entry) {
          entry.text = scrubInterceptorToken(call.text);
          entry.isError = call.isError;
          entry.completedAt = now().toISOString();
        }
        await persistTrace();
      },
    };

    // ── WARP-2179: the approvals port — a challenge PARKS the run ───────
    //
    // The loop calls `register` synchronously when the interceptor
    // challenged a call. The token it hands over is deliberately dropped: no
    // token exists while the run sits parked. The park's writes happen after
    // the loop has returned (below), so `register` only records the request
    // and stops the loop through the same signal cancellation uses.
    const approvals: ChatApprovalPort = {
      register(input) {
        park.request = {
          tool: input.tool,
          args: input.args,
          bindingHash: confirmationBindingHash(input.tool, input.args),
          tool_call_id: lastDispatch?.tool === input.tool ? lastDispatch.tool_call_id : null,
        };
        stop(runId, "parked");
        return {
          challengeId: runId,
          tool: input.tool,
          status: "pending",
          expiresAt: input.expiresAt,
          summary: summarizeToolArguments(input.tool, input.args),
        };
      },
      // Redemption happens inside `beforeToolCall`, where the decision and
      // the binding are both known; the loop never attaches a token itself.
      claimGrant() {
        return null;
      },
    };

    // ── Drive the loop ──────────────────────────────────────────────────
    let result: AgentResult | null = null;
    let stopped: AgentRunStopped | null = null;
    let threw: unknown = null;
    try {
      result = await runAgent(
        { mcp: deps.agent.mcp, aiGateway: deps.agent.aiGateway, approvals },
        {
          model: run.model,
          messages,
          max_iter: remaining,
          allowed_tools: allowedTools,
          toolAccessScope: access.scope,
          toolCallContext,
          context_window: contextWindow,
          tool_selection_mode: toolSelectionMode,
          signal: controller.signal,
          checkpoint,
        },
      );
    } catch (err) {
      if (err instanceof AgentRunStopped) stopped = err;
      else threw = err;
    }

    const endedAt = now();
    // The FIRST recorded cause wins. A cancelled run loses its fence on its
    // very next write (the canceller changed `status`), so the loop's thrown
    // reason is "fenced" — but the row says why, and that is what the
    // terminal write must name.
    const reason = stopReasons.get(runId) ?? stopped?.reason ?? null;

    if (reason === "fenced") {
      // Someone else owns the row now. Nothing to write; the successor does.
      logger.warn({ runId }, "agent_run_lease_lost");
      return;
    }
    if (reason === "cancelled") {
      // The canceller already set `cancelled` + `endedAt`; record where the
      // loop got to. Fence on `cancelled` so this cannot resurrect the row.
      await finish(
        runId,
        { iteration: base + (result?.iterations ?? 0), stopReason: "cancelled" },
        ["cancelled"],
      );
      await audit(runId, run.userId, "cancelled", "Agent run cancelled", undefined,
        user ? { username: user.username, goal: run.goal } : undefined);
      return;
    }
    if (reason === "parked" && park.request) {
      const parkRequest = park.request;
      // The iteration's own checkpoint already holds the conversation at its
      // top, so `iteration` is left alone: the resume re-runs this iteration
      // and the model re-issues the call. The lease is released; a parked
      // run holds nothing. The challenge's trace entry is marked so the
      // run-detail view can show where the run stopped.
      for (const e of trace) {
        if (e.tool_call_id === parkRequest.tool_call_id) e.confirmation = "parked";
      }
      const ok = await finish(runId, {
        status: "awaiting_confirmation",
        trace: trace as unknown as Prisma.InputJsonValue,
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        parkedAt: endedAt,
        pendingTool: parkRequest.tool,
        pendingBindingHash: parkRequest.bindingHash,
        pendingArgs: parkRequest.args as unknown as Prisma.InputJsonValue,
        pendingToolCallId: parkRequest.tool_call_id,
        pendingDecision: null,
        pendingDecidedAt: null,
        pendingDecidedBy: null,
      });
      if (!ok) return;
      await auditConfirmation(parkRequest.tool, "parked");
      if (user) {
        const summary = summarizeToolArguments(parkRequest.tool, parkRequest.args);
        const fields = summary.fields.map((f) => `${f.key}: ${f.detail}`).join("; ");
        const goal = run.goal.length > 120 ? `${run.goal.slice(0, 117)}…` : run.goal;
        await sendNotification(prisma, {
          userId: user.username,
          kind: "ai",
          title: `Approval needed: ${parkRequest.tool}`,
          body:
            `Background run "${goal}" wants to run ${parkRequest.tool}` +
            (fields ? ` (${fields})` : "") +
            ". Open the run to approve or deny it. Nothing has been done yet.",
        }).catch((err) => {
          logger.warn({ err, runId }, "agent_run_park_notification_failed");
        });
      }
      logger.info({ runId, tool: parkRequest.tool }, "agent_run_parked");
      return;
    }
    if (reason === "deadline") {
      const error = `wall_clock_ceiling: run exceeded AGENT_RUN_MAX_WALL_MS (${limits.maxWallMs} ms)`;
      await finish(runId, {
        status: "failed",
        endedAt,
        iteration: base + (result?.iterations ?? 0),
        stopReason: reason,
        error,
      });
      await audit(runId, run.userId, "failed", "Agent run failed", error,
        user ? { username: user.username, goal: run.goal } : undefined);
      return;
    }
    if (threw !== null || result === null) {
      const error = threw instanceof Error ? threw.message : String(threw ?? "no result");
      await finish(runId, { status: "failed", endedAt, error: error.slice(0, 2000) });
      await audit(runId, run.userId, "failed", "Agent run failed", error,
        user ? { username: user.username, goal: run.goal } : undefined);
      return;
    }

    const iteration = base + result.iterations;
    switch (result.stop_reason) {
      case "model_done":
      case "context_budget":
      case "repetition": {
        const text = contentToText(result.message.content);
        await finish(runId, {
          status: "succeeded",
          endedAt,
          iteration,
          stopReason: result.stop_reason,
          result: text,
          error: null,
        });
        await audit(runId, run.userId, "succeeded", "Agent run completed", undefined,
          user ? { username: user.username, goal: run.goal, result: text } : undefined);
        return;
      }
      case "iteration_limit": {
        const error = `iteration_limit: no final answer within ${maxIter} iterations`;
        await finish(runId, {
          status: "failed",
          endedAt,
          iteration,
          stopReason: result.stop_reason,
          error,
        });
        await audit(runId, run.userId, "failed", "Agent run failed", error,
          user ? { username: user.username, goal: run.goal } : undefined);
        return;
      }
      case "error":
      default: {
        const error = result.error ?? "agent loop error";
        await finish(runId, {
          status: "failed",
          endedAt,
          iteration,
          stopReason: result.stop_reason,
          error,
        });
        await audit(runId, run.userId, "failed", "Agent run failed", error,
          user ? { username: user.username, goal: run.goal } : undefined);
        return;
      }
    }
  }

  async function audit(
    runId: string,
    userId: string,
    status: "succeeded" | "failed" | "cancelled",
    what: string,
    error?: string,
    // WARP-2180 — on a terminal status the owner is told over the same
    // ws-bridge topic the park notification uses, with the result summary.
    notify?: { username: string; goal: string; result?: string | null },
  ): Promise<void> {
    if (notify) {
      const goal = notify.goal.length > 80 ? `${notify.goal.slice(0, 77)}…` : notify.goal;
      const body =
        status === "succeeded"
          ? (notify.result ?? "").slice(0, 300) || "Finished."
          : status === "cancelled"
            ? "Cancelled."
            : `Failed: ${(error ?? "unknown error").slice(0, 300)}`;
      await sendNotification(prisma, {
        userId: notify.username,
        kind: "ai",
        title:
          status === "succeeded"
            ? `Background run finished: ${goal}`
            : status === "cancelled"
              ? `Background run cancelled: ${goal}`
              : `Background run failed: ${goal}`,
        body,
      }).catch((err) => {
        logger.warn({ err, runId }, "agent_run_terminal_notification_failed");
      });
    }
    await recordActivity({
      kind: "tool_run",
      severity: status === "succeeded" ? "ok" : status === "cancelled" ? "info" : "err",
      sourceIcon: "bot",
      what,
      // The attributed principal is a canonical User.id, so it may sit in
      // `actorId` (unlike the dispatch rows, whose `userId` is a username).
      actor: { type: "ai", id: userId },
      sub: error ? error.slice(0, 200) : null,
      refs: { agentRunId: runId, status, workerId },
    });
  }

  async function releaseAll(): Promise<void> {
    const ids = [...inFlight.keys()];
    for (const id of ids) stop(id, "fenced");
    await Promise.allSettled(ids.map((id) => inFlight.get(id)));
    const at = now();
    for (const id of ids) {
      await prisma.agentRun.updateMany({
        where: { id, claimedBy: workerId, status: "running" },
        data: { status: "queued", claimedBy: null, claimedAt: null, heartbeatAt: null, runAfter: at },
      });
    }
  }

  return {
    workerId,
    tickOnce,
    heartbeatOnce,
    execute,
    inFlight: () => new Set(inFlight.keys()),
    releaseAll,
  };
}
