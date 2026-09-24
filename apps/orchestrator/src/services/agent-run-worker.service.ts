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
 * re-queued. On resume the worker runs THE STORED CALL ITSELF, before the
 * model is asked anything (WARP-3044): the tool and args exactly as parked,
 * checked against the parked binding and against the principal's reach at
 * this claim, redeemed through the interceptor handshake — one dispatch
 * without a token to obtain a FRESH challenge (minted now, seconds after the
 * human decided, redeemed in the same breath) and one with it. The
 * interceptor stays the single gate; the human's decision is what authorises
 * this worker to redeem. The call and its result are appended to the
 * conversation and the checkpoint advanced past the parked iteration, so the
 * model resumes with the result in front of it. On denial the same happens
 * with a `CONFIRMATION_DENIED` result and nothing dispatched.
 *
 * The model is never asked to re-issue the call. It used to be, and the
 * binding matched only a byte-identical re-issue: gpt-oss rewords free text
 * on every ask, so on the house unit a run re-parked after each of three
 * approvals and never ran the call (run 1efa11c8). A byte-identical re-issue
 * AFTER the decided call is answered from the trace, never dispatched or
 * parked again (`decidedBefore` in `beforeToolCall`).
 *
 * Tier-3 (a tool outside the run's pool, or one the interceptor's deny tier
 * refuses) is refused exactly as in chat, never parked.
 *
 * ── A LOST TOOL OUTCOME IS NOT A RETRY (WARP-2877) ────────────────────
 *
 * Die between `mcp.callTool` returning and the completion write and the trace
 * entry has no `text`: the call may have done its whole job, and nothing on
 * the box can say. Resuming used to re-dispatch it anyway after logging
 * `agent_run_redispatch_unknown_outcome`. {@link redispatchSafe} decides now,
 * off the catalog's own tier flags: a read repeats, an ungated write (in a
 * run's pool, `send_notification`) does NOT — the run ends `failed` with
 * `stopReason = "unknown_outcome"` and a message naming the tool — and a call
 * whose approval was already spent re-parks with a notification that says so
 * instead of "Nothing has been done yet".
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
import {
  TOOL_CATALOG,
  TOOL_ROUTES,
  confirmationBindingHash,
  confirmationOwnerOf,
  redactConfirmationTokensForModel,
  type ToolDomain,
} from "@droplet/tools-core";
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
  toolDispatchDenial,
} from "./tool-access.service.js";
import { boundToolResultForModel } from "./tool-result-bounding.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import { recordActivity } from "./activity.singleton.js";
import { sendNotification } from "./notifications.service.js";
import { summarizeToolArguments } from "./confirmation-summary.js";
import { decideCloudTurn, resolveOffLanProvider } from "./cloud-access.service.js";
import {
  OFF_LAN_WITHHELD_NOTICE,
  withholdStoredContentTools,
} from "./stored-content-egress.service.js";

const logger = createLogger("agent-run-worker");

/** WARP-2909 — a run's deep link. `/workshop?run=` is the canonical run view
 *  (WARP-2925; `/admin/audit?run=` only forwards there). `run` is the only
 *  query key, and the tag collapses every notification about one run. */
function agentRunLink(runId: string): { url: string; tag: string } {
  return { url: `/workshop?run=${encodeURIComponent(runId)}`, tag: `agent-run:${runId}` };
}

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
 * WARP-2896 (ADR-056 slice G) — the workshop's tools, derived from the
 * tool→route manifest rather than named: every tool whose EVERY hop lands
 * under `/api/workspace/`. That prefix is the sandbox's git store, reached
 * through routes/workspace.ts, where "run owns workspace" is enforced —
 * the blast radius of `workspace_write` is one checkout on the internal-
 * only network, not the box. So these are the one family of ungated writes
 * a run may carry (see {@link runToolPool}), and only a run that HAS a
 * workspace carries them. A tool that adds a hop elsewhere leaves the set
 * by itself; `agent-run-worker.workshop.test.ts` enumerates the members.
 */
export const WORKSPACE_TOOLS: ReadonlySet<string> = new Set(
  TOOL_ROUTES.filter(
    (e) => e.hops.length > 0 && e.hops.every((h) => h.pathPattern.startsWith("/api/workspace/")),
  ).map((e) => e.tool),
);

/**
 * WARP-2896 — the selection domains of {@link WORKSPACE_TOOLS}, read off the
 * catalog (today exactly `["workspace"]`). A workshop run hands them to the
 * loop as `bound_tool_domains` so "domains" selection advertises the
 * workshop's tools on every turn: no keyword rule reaches them (chat must
 * never be promised them) and a workshop goal need not name them. Without
 * this the bench-box live proof (2026-09-23) offered the model none of the
 * eight and the run ended `model_done` with zero tool calls.
 */
export const WORKSPACE_TOOL_DOMAINS: readonly ToolDomain[] = [
  ...new Set(TOOL_CATALOG.filter((t) => WORKSPACE_TOOLS.has(t.name)).map((t) => t.domain)),
];

/**
 * WARP-2749 — a run's inference requests carry the gateway's "background"
 * priority (`X-Request-Priority`: 0 user-initiated, 5 automation, 10
 * background) so an interactive turn is served first. The gateway REJECTS a
 * priority ≥ 5 request with 429 while five or more requests are pending. That
 * is chat being busy, not the run failing: on a 429 the worker hands the row
 * back to the queue at the same checkpoint (`RUN_YIELD_MS` later, no attempt
 * charged) and tries again. `deadlineAt` still stands, so a run that keeps
 * yielding ends on its wall clock with an honest reason.
 */
const RUN_INFERENCE_PRIORITY = 10;
const RUN_YIELD_MS = 60_000;

/** The run's gateway: the caller's functions, each request stamped background priority. */
function runGateway(gw: AgentDeps["aiGateway"]): AgentDeps["aiGateway"] {
  const opts = { priority: RUN_INFERENCE_PRIORITY };
  return {
    chat: (r, s) => gw.chat(r, s, undefined, opts),
    ...(gw.chatStream ? { chatStream: (r, s) => gw.chatStream!(r, s, undefined, opts) } : {}),
  };
}

/**
 * Both shapes a 429 takes: the real client throws (`chat()` throws on a
 * non-OK blocking response), a mocked gateway returns `ok: false` and the loop
 * reports `ai-gateway 429`.
 */
function gatewayBusy(threw: unknown, result: AgentResult | null): boolean {
  if (threw instanceof Error && /^AI Gateway error 429\b/.test(threw.message)) return true;
  return result?.stop_reason === "error" && result.error === "ai-gateway 429";
}

/**
 * The pool a run starts from, before per-principal narrowing: the chat pool
 * (chat-tool-scope.ts) plus {@link RUN_READMITTED_TOOLS}, minus
 * {@link RUN_EXCLUDED_TOOLS}. Confirming (Tier-2) tools are IN — the
 * interceptor challenges them and the run parks (WARP-2179). What chat
 * excludes on policy grounds ("chat must not delete camera evidence") stays
 * out: that is the run's Tier-3.
 *
 * NON-CONFIRMING WRITES ARE OUT (Romain, 2026-09-04). A Tier-1 write in
 * chat happens in front of the person who asked for it; in a run nobody is
 * watching, and the interceptor (WARP-2305) challenges only what the catalog
 * declares `requiresConfirmation`, so a Tier-1 write would simply happen.
 * The confirmation story is being made a mechanism end to end under
 * WARP-2002 (self-attested `confirmed` flags) and WARP-2008 (declared-but-
 * ungated tools); until both are Done and the eighteen Tier-1 writes have
 * been judged for unattended use, the pool is reads plus confirming writes.
 * The one Tier-1 write kept is the notification channel. Lift this clause —
 * and its test — when that is done.
 *
 * ROUTE-OWNED CONFIRMATIONS ARE OUT (WARP-2744 item 2). Ten tools declare
 * `confirmationOwner: "route"` (WARP-2472, tool-confirmation-contract §13):
 * the interceptor stands down and the orchestrator route asks, answering 202
 * with a token redeemable only at its dashboard-only confirm endpoint. A run
 * has no dashboard in the loop, so the interceptor never parks it and the
 * route's envelope comes back as an ordinary result the model cannot act on
 * — iterations burned, nobody notified. Until a run can park on a route
 * token (its own ticket), the honest answer is not to offer the tool.
 * `confirmationOwnerOf` is the one reader of that flag; the exclusion is
 * structural, so a newly declared route-owned tool leaves the pool by itself.
 *
 * Computed from the static catalog at module load, on purpose: runtime
 * (remote, ADR-043) tools are never in a run's `allowed_tools`, so a tool the
 * catalog does not know cannot reach a run at all.
 */
export function runToolPool(opts: { workspace?: boolean } = {}): string[] {
  return TOOL_CATALOG.filter(
    (t) =>
      !RUN_EXCLUDED_TOOLS.has(t.name) &&
      confirmationOwnerOf(t) !== "route" &&
      (RUN_READMITTED_TOOLS.has(t.name) ||
        // WARP-2896 — the workshop's tools ride a run bound to a workspace and
        // no other: their writes land on that workspace's checkout alone.
        (opts.workspace === true && WORKSPACE_TOOLS.has(t.name)) ||
        (!EXCLUDED_FROM_CHAT_TOOLS.has(t.name) &&
          !WORKSPACE_TOOLS.has(t.name) &&
          !(t.requiresWrite && !t.requiresConfirmation))),
  ).map((t) => t.name);
}

/**
 * WARP-2877 — may this lost call be dispatched a SECOND time?
 *
 * A worker that dies between `mcp.callTool` returning and the trace-completion
 * write leaves an entry with no `text`. The outcome is genuinely unknown: the
 * call may have had its full side effect. The old answer was to re-dispatch
 * regardless, having logged `agent_run_redispatch_unknown_outcome` first —
 * "we told you in the log" is not a safety property.
 *
 * The answer is the catalog's own tier metadata plus what the prior entry
 * records, never a hand-kept list, so a tool declared tomorrow is covered
 * with nothing to remember here:
 *
 *   - A READ (`!requiresWrite && !requiresConfirmation`) repeats harmlessly.
 *     Re-dispatch, loudly.
 *   - An UNGATED WRITE (`requiresWrite && !requiresConfirmation`) is the real
 *     duplicate. Nothing stands between the call and its effect, so a second
 *     dispatch is a second effect. In a run's pool that is `send_notification`
 *     today (see {@link RUN_READMITTED_TOOLS}) — two toasts, not one — and it
 *     is every Tier-1 write the pool admits if WARP-2002/2008 ever widen it.
 *     Never repeat it.
 *   - A GATED WRITE (`requiresConfirmation`) has the WARP-2305 interceptor in
 *     front of it, and the token is what makes it run. So it depends on which
 *     dispatch was lost:
 *       · no `confirmation` marker — the lost dispatch carried NO token, so
 *         the interceptor answered it with a challenge and the tool did not
 *         run. Re-dispatching challenges again. Safe.
 *       · `confirmation: "confirmed"` — the human's approval was already
 *         spent on that dispatch (consumed BEFORE it, by design), so the
 *         write may well have happened. A re-dispatch cannot repeat it
 *         silently — with no decision left on the row it goes out without a
 *         token and the run PARKS again (WARP-2179) — but the person is asked
 *         a question whose honest answer nobody has. Not safe; see the caller,
 *         which keeps the re-park and fixes what it tells them.
 *   - A tool the catalog does not know is not safe. Runs only ever see
 *     catalog tools (`runToolPool`), so this is unreachable in practice;
 *     refusing to repeat an unknown call is the honest default if it is not.
 */
export function redispatchSafe(tool: string, prior: { confirmation?: string }): boolean {
  const entry = TOOL_CATALOG.find((t) => t.name === tool);
  if (!entry) return false;
  if (!entry.requiresWrite && !entry.requiresConfirmation) return true;
  // WARP-2896 — a workspace write repeats onto the same checkout: `write`
  // is idempotent by contract (same bytes, `changed: false`), `commit` finds
  // nothing to commit, `run` runs the tests again. Re-dispatch, loudly (the
  // caller logs `agent_run_redispatch_unknown_outcome`). `propose` is gated
  // and takes the confirming branch below.
  if (WORKSPACE_TOOLS.has(tool) && !entry.requiresConfirmation) return true;
  if (!entry.requiresConfirmation) return false;
  return prior.confirmation !== "confirmed";
}

/**
 * WARP-2179 — the parked-call columns, always cleared together: by the write
 * that consumes a decision, and by EVERY terminal write, so no decision
 * outlives the run it was made for (WARP-2720).
 */
const CLEAR_PENDING: Prisma.AgentRunUpdateManyMutationInput = {
  pendingTool: null,
  pendingBindingHash: null,
  pendingArgs: Prisma.DbNull,
  pendingToolCallId: null,
  pendingDecision: null,
  pendingDecidedAt: null,
  pendingDecidedBy: null,
  parkedAt: null,
};

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
  /**
   * WARP-2877 — dispatched, then the worker died before the outcome was
   * written, and {@link redispatchSafe} says this tool must not be repeated.
   * The run stops on this entry; the step is marked so the run-detail view
   * can say so rather than showing an eternal "dispatched…".
   */
  unknownOutcome?: true;
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

/**
 * WARP-2997 — the run's system prompt for where its model runs. A cloud run
 * gets chat's `OFF_LAN_WITHHELD_NOTICE` so it says plainly that stored
 * content stays on the box instead of inventing a reason it cannot help.
 *
 * The prompt carries none of the stored-content blocks chat injects (memory,
 * brain, business profile, pins), so `withholdPromptBlocksForOffLan` has
 * nothing to blank here. Any such block added to a run MUST go through it.
 */
export function runSystemPrompt(offLan: boolean): string {
  return offLan ? `${AGENT_RUN_SYSTEM_PROMPT}\n\n${OFF_LAN_WITHHELD_NOTICE}` : AGENT_RUN_SYSTEM_PROMPT;
}

export function initialRunMessages(goal: string, offLan = false): ChatMessage[] {
  return [
    { role: "system", content: runSystemPrompt(offLan) },
    { role: "user", content: goal },
  ];
}

/**
 * The non-terminal statuses — a run that is still going to do something.
 * Cancellation targets exactly these, and so does WARP-2877's schedule
 * overlap guard: "the previous fire has not finished" is the same question
 * both times, and it must not be answered from two lists that can drift.
 */
export const ACTIVE_AGENT_RUN_STATUSES = ["queued", "running", "awaiting_confirmation"] as const;

export interface EnqueueAgentRunInput {
  userId: string;
  goal: string;
  model: string;
  sessionId?: string | null;
  /** Clamped to the run cap (config.agentRuns.maxIter — WARP-2749, not the chat cap). */
  maxIter?: number;
  runAfter?: Date;
  /** WARP-2877 — set by the schedule ticker, so its overlap guard can find
   *  this run on the next fire. Absent for a run started from chat. */
  scheduleId?: string | null;
  /** WARP-2896 — the workshop workspace this run works in. Absent for every
   *  ordinary run; the route checked it exists and belongs to the person. */
  workspaceId?: string | null;
}

/** Create a `queued` run. The worker's next tick claims it. */
export async function enqueueAgentRun(
  // A transaction client too: the schedule ticker enqueues and advances in
  // one transaction so a failed advance cannot leave a fired-but-unadvanced
  // schedule behind to fire again.
  prisma: PrismaClient | Prisma.TransactionClient,
  input: EnqueueAgentRunInput,
): Promise<{ id: string }> {
  const cap = config.agentRuns.maxIter;
  const maxIter = Math.max(1, Math.min(input.maxIter ?? cap, cap));
  const row = await prisma.agentRun.create({
    data: {
      userId: input.userId,
      goal: input.goal,
      model: input.model,
      sessionId: input.sessionId ?? null,
      maxIter,
      scheduleId: input.scheduleId ?? null,
      workspaceId: input.workspaceId ?? null,
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
    where: { id, status: { in: [...ACTIVE_AGENT_RUN_STATUSES] } },
    // A parked run can be cancelled: the terminal write clears the parked
    // call too, like every other terminal write.
    data: { status: "cancelled", endedAt: now, ...CLEAR_PENDING },
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
 * consumes it on resume by running — or, denied, answering — the STORED call
 * itself (WARP-3044). A second decision finds the run no longer parked and
 * changes nothing. `deadlineAt` is extended by the time spent parked,
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
type StopReason = "cancelled" | "deadline" | "fenced" | "parked" | "unknown_outcome" | "proposed";

/**
 * WARP-2896 — `workspace_propose` ENDS the run. A proposal is the workshop
 * run's terminal act: the manifest is written, the commit tagged, the
 * review surface (slice I) takes it from there, and nothing the model does
 * after that belongs to the same run. The worker reads the tool's own
 * result — a successful, non-envelope `workspace_propose` — and stops the
 * loop with `proposed`, which the terminal write records as `succeeded`
 * with the proposal as the run's result. The model is not asked to stop
 * itself; it would not, reliably.
 */
const PROPOSE_TOOL = "workspace_propose";

/**
 * WARP-2899 — what a proposal IS, read off the tool's own result: an
 * extension, or a connector draft (no manifest, nothing to install) with the
 * readback sentence the propose route composed. A result that does not
 * parse is an extension, as before.
 */
function proposalKindOf(text: string): { kind: "extension" } | { kind: "connector-draft"; readback: string | null } {
  try {
    const parsed = JSON.parse(text) as { data?: { kind?: unknown; readback?: unknown } } | null;
    if (parsed?.data?.kind === "connector-draft") {
      return { kind: "connector-draft", readback: typeof parsed.data.readback === "string" ? parsed.data.readback : null };
    }
  } catch {
    /* not JSON: an extension, as before */
  }
  return { kind: "extension" };
}

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

/** Any `status: "confirmation_required"` envelope — a challenge or a refused token. */
function isConfirmationEnvelope(text: string): boolean {
  try {
    return (JSON.parse(text) as { status?: unknown })?.status === "confirmation_required";
  } catch {
    return false;
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

/** `pendingArgs` as the park wrote it: a JSON object, or nothing usable. */
function storedArgs(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** WARP-2179 — what the model is handed for a call the human declined. */
function deniedResultText(tool: string): string {
  return JSON.stringify({
    status: "error",
    error: {
      code: "CONFIRMATION_DENIED",
      message:
        `The user declined '${tool}' for this run. Do not retry it; ` +
        "adapt, or finish with what you have and say what was not done.",
    },
  });
}

/**
 * WARP-3044 — what the model is handed when it re-issues, byte for byte, a
 * call that was approved and has already run. The loop's own vocabulary for
 * a repeated call (`REPEATED_CALL`), so the model reads it the way it reads
 * the loop's nudge.
 */
function alreadyRunText(tool: string): string {
  return JSON.stringify({
    status: "error",
    error: {
      code: "REPEATED_CALL",
      message:
        `'${tool}' was approved by the user and has already run with these exact arguments; ` +
        "its result is in the conversation above. Do not call it again — use that result or finish.",
    },
  });
}

export function createAgentRunWorker(deps: AgentRunWorkerDeps): AgentRunWorker {
  const { prisma } = deps;
  const limits = deps.limits ?? config.agentRuns;
  const maxIterCap = deps.maxIterCap ?? config.agentRuns.maxIter;
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
  /**
   * runId → the `claimedAt` this process stamped when it won the row. A lease
   * is the (workerId, claimedAt) pair, not the worker id alone: a row that
   * was reclaimed and then claimed again — by a same-named process, or by
   * this one after a stall — carries a later `claimedAt`, so the zombie
   * execution's next fenced write returns `count: 0` (WARP-2744 item 1).
   */
  const leases = new Map<string, Date>();
  const leaseFence = (id: string) => {
    const lease = leases.get(id);
    return lease ? { claimedAt: lease } : {};
  };

  function stop(runId: string, reason: StopReason): void {
    if (!stopReasons.has(runId)) stopReasons.set(runId, reason);
    controllers.get(runId)?.abort();
  }

  /** The fence every executor write carries. */
  const owned = (id: string) => ({ id, claimedBy: workerId, status: "running" as const, ...leaseFence(id) });

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
            // WARP-2720 — a run claimed with a decided park it never got to
            // consume must not end with that decision still on the row.
            ...CLEAR_PENDING,
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
    const won = await prisma.$transaction(async (tx) => {
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
    if (won) leases.set(runId, at);
    return won;
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
        leases.delete(runId);
      });
    inFlight.set(runId, p);
  }

  async function tickOnce(): Promise<TickCounts> {
    const at = now();
    const { reclaimed, failed } = await reclaimStale(at);
    let claimed = 0;
    const capacity = limits.concurrency - inFlight.size;
    if (capacity > 0) {
      // A row this process is still executing is never a candidate, even if
      // the reclaim above just re-queued it (a stalled heartbeat on our own
      // run): re-claiming it here would put two executions on one row.
      const candidates = (await prisma.agentRun.findMany({
        where: { status: "queued", runAfter: { lte: at }, id: { notIn: [...inFlight.keys()] } },
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
      select: { status: true, claimedBy: true, claimedAt: true, deadlineAt: true },
    })) as
      | { status: string; claimedBy: string | null; claimedAt: Date | null; deadlineAt: Date | null }
      | null;
    const lease = leases.get(runId);
    if (
      !row ||
      row.claimedBy !== workerId ||
      row.status !== "running" ||
      (lease !== undefined && row.claimedAt?.getTime() !== lease.getTime())
    ) {
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
      where: { id: runId, claimedBy: workerId, status: { in: [...fenceStatuses] }, ...leaseFence(runId) },
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
          claimedAt: Date | null;
          deadlineAt: Date | null;
          maxIter: number;
          iteration: number;
          messages: unknown;
          trace: unknown;
          pendingTool: string | null;
          pendingBindingHash: string | null;
          pendingArgs: unknown;
          pendingToolCallId: string | null;
          pendingDecision: "approved" | "denied" | null;
          workspaceId: string | null;
        }
      | null;
    const lease = leases.get(runId);
    if (
      !run ||
      run.status !== "running" ||
      run.claimedBy !== workerId ||
      (lease !== undefined && run.claimedAt?.getTime() !== lease.getTime())
    ) {
      return;
    }

    const controller = new AbortController();
    controllers.set(runId, controller);

    // ── Access, resolved NOW, from the attributed principal ─────────────
    const access = await resolveAccess(prisma, run.userId);
    if (access.unresolved !== null) {
      await finish(runId, {
        status: "failed",
        endedAt: at,
        error: `attribution_failed:${access.unresolved}`,
        ...CLEAR_PENDING,
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
    if (!user) {
      // The row vanished between the attribution read and this one (a
      // deleted account with a queued run). Refuse like an unresolvable
      // principal rather than dispatch with no attribution on the rows
      // (Stefan, #2011 review).
      await finish(runId, {
        status: "failed",
        endedAt: at,
        error: "attribution_failed:user_missing",
        ...CLEAR_PENDING,
      });
      await recordActivity({
        kind: "tool_run",
        severity: "warn",
        sourceIcon: "shield",
        what: "Agent run refused (access)",
        actor: { type: "system" },
        sub: `run ${runId}: no resolvable owner (user_missing)`,
        refs: { agentRunId: runId, userId: run.userId, reason: "user_missing" },
      });
      return;
    }

    // ── WARP-2997: the cloud gate and the stored-content gate ──────────
    // Here, at EVERY claim, not at enqueue: a start, a resume after a park,
    // a reclaim and every schedule fire all come through this line, so a
    // revoked cloud grant stops the next fire and no enqueue caller (the
    // schedule ticker, the morning briefing) can skip it. The same two
    // questions chat asks, asked the same way (routes/llm.ts): "may this
    // person use cloud?" and, separately, "is this request leaving the box?".
    const principal = { id: run.userId, role: user.role };
    const cloudDecision = await decideCloudTurn({ user: principal, model: run.model });
    if (cloudDecision.kind === "refused") {
      const cloudGate = cloudDecision.status === 451 ? "cloud_refused" : "cloud_unverified";
      const error = `${cloudDecision.body.error}: ${cloudDecision.body.message}`;
      await finish(runId, {
        status: "failed",
        endedAt: at,
        stopReason: cloudGate,
        cloudGate,
        offLanProvider: cloudDecision.body.provider,
        error,
        ...CLEAR_PENDING,
      });
      await audit(runId, run.userId, "failed", "Agent run refused (cloud access)", error,
        { username: user.username, goal: run.goal },
        { cloudGate, offLanProvider: cloudDecision.body.provider });
      return;
    }
    const offLanProvider = await resolveOffLanProvider({ user: principal, model: run.model });
    const principalTools = narrowToolNamesForPrincipal(
      runToolPool({ workspace: run.workspaceId !== null }),
      access.tier ?? undefined,
      access.scope,
    );
    const allowedTools = offLanProvider ? withholdStoredContentTools(principalTools) : principalTools;
    const offLanWithheldTools = principalTools.filter((t) => !allowedTools.includes(t));
    const cloudGate = offLanProvider ? "cloud_allowed" : "local";
    if (!(await finish(runId, { cloudGate, offLanProvider, offLanWithheldTools }))) return;
    const offLanRefs = offLanProvider ? { cloudGate, offLanProvider, offLanWithheldTools } : { cloudGate };
    const toolCallContext = {
      ...(user ? { userId: user.username, userRole: user.role } : {}),
      agentRunId: runId,
      // WARP-2896 — the workshop's tools read this to address their
      // workspace; the route re-checks the binding from the run id.
      ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
    };
    // WARP-2896 — set when `workspace_propose` succeeds; the terminal write
    // below turns it into the run's result.
    let proposal: string | null = null;
    const endOnProposal = (tool: string, text: string, isError: boolean): void => {
      if (tool !== PROPOSE_TOOL || isError || isConfirmationEnvelope(text)) return;
      proposal = text;
      stop(runId, "proposed");
      throw new AgentRunStopped("proposed", "the run proposed its extension");
    };

    // ── Resume state ────────────────────────────────────────────────────
    // `let`: consuming a decided park completes the parked iteration and
    // advances the checkpoint past it (WARP-3044, `resumeDecidedCall`).
    let base = run.iteration;
    const messages = Array.isArray(run.messages)
      ? (run.messages as ChatMessage[])
      : initialRunMessages(run.goal, offLanProvider !== null);
    // A resumed run re-derives its system prompt from THIS claim's verdict,
    // never from the checkpoint: the notice follows where the model runs now.
    if (messages[0]?.role === "system") {
      messages[0] = { role: "system", content: runSystemPrompt(offLanProvider !== null) };
    }
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
        ...CLEAR_PENDING,
      });
      return;
    }

    // ── WARP-2179: a decided park to consume, and a park to record ──────
    // The STORED call, exactly as the park wrote it (WARP-3044): the worker
    // runs this, never whatever the model would say on being asked again.
    const decided =
      run.pendingTool && run.pendingDecision
        ? {
            tool: run.pendingTool,
            args: storedArgs(run.pendingArgs),
            bindingHash: run.pendingBindingHash,
            toolCallId: run.pendingToolCallId,
            decision: run.pendingDecision,
          }
        : null;
    let lastDispatch: { tool: string; tool_call_id: string; iteration: number } | null = null;
    // WARP-2877 — the tool whose outcome was lost, named in the terminal row.
    let unknownOutcomeTool: string | null = null;
    const park: {
      request: {
        tool: string;
        args: Record<string, unknown>;
        bindingHash: string;
        tool_call_id: string | null;
      } | null;
    } = { request: null };

    // `confirmed_failed`: the human approved but the redeem leg did not run the
    // tool (refused token, deny tier, dispatch error). The label follows what
    // happened, not what was decided (Stefan, #2013 review).
    const auditConfirmation = (
      tool: string,
      outcome: "parked" | "confirmed" | "confirmed_failed" | "denied",
    ) =>
      recordActivity({
        kind: "tool_call",
        severity: outcome === "confirmed" ? "ok" : outcome === "parked" ? "info" : "warn",
        sourceIcon: "shield",
        what:
          outcome === "parked"
            ? `${tool} parked for approval`
            : outcome === "confirmed"
              ? `${tool} approved and run`
              : outcome === "confirmed_failed"
                ? `${tool} approved but did not run`
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

    const fenced = (): never => {
      stop(runId, "fenced");
      throw new AgentRunStopped("fenced", "lease no longer held");
    };

    // Wrapped the way the loop wraps a live dispatch (ORCH-05): a thrown
    // dispatch is a bounded tool error the model can recover from, never the
    // death of a run whose whole point is surviving transient failures.
    const dispatch = async (
      tool: string,
      args: Record<string, unknown>,
      ctx: typeof toolCallContext & { confirmationToken?: string },
    ): Promise<{ text: string; isError: boolean }> => {
      try {
        const r = await deps.agent.mcp.callTool(tool, args, ctx);
        return { text: r.content[0]?.text ?? "{}", isError: Boolean(r.isError) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          text: JSON.stringify({ error: "tool_dispatch_failed", tool, message: message.slice(0, 500) }),
          isError: true,
        };
      }
    };

    // The interceptor handshake, both legs here. Leg 1 asks without a token
    // and receives a FRESH challenge — minted now, seconds after the human
    // decided. Leg 2 presents it. Anything other than a challenge on leg 1
    // (deny tier, a tool that no longer confirms, an error) is the box's
    // honest answer and is handed back as-is. A refused token on leg 2 comes
    // back as the interceptor's `confirmation_required` envelope, which is an
    // error for this run's purposes: the tool did not run.
    const redeem = async (
      tool: string,
      args: Record<string, unknown>,
    ): Promise<{ text: string; isError: boolean }> => {
      const first = await dispatch(tool, args, toolCallContext);
      const token = first.isError ? null : interceptorTokenOf(first.text);
      const outcome = token
        ? await dispatch(tool, args, { ...toolCallContext, confirmationToken: token })
        : first;
      const ran = !outcome.isError && !isConfirmationEnvelope(outcome.text);
      return { text: outcome.text, isError: !ran };
    };

    // The loop's two dispatch-time predicates, applied to the stored call: the
    // run's pool as narrowed for the principal at THIS claim (the approval is
    // not an escalation path, and reach can shrink between decision and
    // claim), then the args-dependent rule (§3 locks).
    const reachRefusal = (
      tool: string,
      args: Record<string, unknown>,
    ): { code: string; message: string } | null => {
      const denial = toolDispatchDenial(tool, args, access.scope);
      if (denial || allowedTools.includes(tool)) return denial;
      return {
        code: "TOOL_UNAVAILABLE",
        message:
          `'${tool}' is no longer available to this run, so the approved call was not run. ` +
          "Do not retry it; finish and say what was not done.",
      };
    };

    // What the model is handed as the stored call's result: the loop's own
    // treatment of a tool result (llm-agent.service.ts) — no confirmation
    // token ever (WARP-2002), bounded at the same cap (WARP-2203).
    const modelFacing = (tool: string, text: string): string =>
      boundToolResultForModel(
        isConfirmationEnvelope(text) ? redactConfirmationTokensForModel(text) : text,
        tool,
        (refusal) => {
          logger.warn(
            { runId, tool, input_chars: refusal.inputChars, reason: refusal.reason },
            "agent_tool_result_refused",
          );
        },
        config.AGENT_TOOL_RESULT_CAP_CHARS,
      );

    /**
     * WARP-3044 — consume a decided park BEFORE the model is asked anything.
     *
     * The checkpoint is the top of the parked iteration. The model's call is
     * not in it and is not asked for again: the worker takes the STORED call
     * (tool, args and `tool_call_id` as parked), runs it on an approval or
     * answers it with `CONFIRMATION_DENIED` on a denial, and appends the call
     * and its result to the conversation. The checkpoint then advances past
     * the parked iteration, so the loop resumes with the result in front of
     * the model — one iteration later, as if the call had run when first made.
     *
     * An approved call must still be the call that was parked (its stored
     * args carry the parked binding) and still in the principal's reach at
     * this claim. Either failing, nothing is dispatched: the model is told,
     * and the audit row says "approved but did not run".
     *
     * CRASH SAFETY. A dispatch is preceded by a write that records the entry
     * and clears the pending columns (the replay guard's discipline), so a
     * crash can never leave `pendingDecision = approved` behind for a resumed
     * worker to redeem a second time. The result, the conversation and the
     * advanced checkpoint then land in ONE write. A crash between the two
     * leaves a `confirmed` entry with no result at the checkpoint's iteration;
     * the next claim finds it here and re-parks THAT call — not the model's
     * rewording of it — with the notification saying it may already have run
     * (WARP-2877). A denial or a refusal dispatches nothing, so it needs only
     * the one write.
     *
     * Returns false when the run must not enter the loop (it re-parked).
     */
    const resumeDecidedCall = async (): Promise<boolean> => {
      if (!decided) {
        const lost = trace.find(
          (e) =>
            e.iteration === base &&
            e.confirmation === "confirmed" &&
            e.text === undefined &&
            !e.unknownOutcome,
        );
        if (!lost) return true;
        lost.unknownOutcome = true;
        park.request = {
          tool: lost.tool,
          args: lost.args,
          bindingHash: confirmationBindingHash(lost.tool, lost.args),
          tool_call_id: lost.tool_call_id,
        };
        logger.warn(
          { runId, tool: lost.tool, priorCallId: lost.tool_call_id, iteration: base },
          "agent_run_reask_unknown_outcome",
        );
        stop(runId, "parked");
        return false;
      }

      const observed = await observe(runId, now());
      if (observed) throw new AgentRunStopped(observed, `run stopped: ${observed}`);

      const { tool, args, decision } = decided;
      const toolCallId = decided.toolCallId ?? `${runId}:${base}:decided`;
      const entry: AgentRunTraceEntry = {
        tool_call_id: toolCallId,
        tool,
        args: args ?? {},
        iteration: base,
        dispatchedAt: now().toISOString(),
        confirmation: decision === "approved" ? "confirmed" : "denied",
      };
      trace.push(entry);

      let outcome: { text: string; isError: boolean };
      if (decision === "denied") {
        outcome = { text: deniedResultText(tool), isError: true };
      } else {
        // What runs is what the human was shown: the stored args must still
        // carry the binding the park computed.
        const verified =
          args !== null &&
          decided.bindingHash !== null &&
          confirmationBindingHash(tool, args) === decided.bindingHash
            ? args
            : null;
        const refusal =
          verified === null
            ? {
                code: "APPROVED_CALL_MISMATCH",
                message:
                  `The approved '${tool}' call no longer matches what was parked, so it was not run. ` +
                  "Do not retry it; finish and say what was not done.",
              }
            : reachRefusal(tool, verified);
        if (verified !== null && refusal === null) {
          const consumed = await finish(runId, {
            trace: trace as unknown as Prisma.InputJsonValue,
            heartbeatAt: now(),
            ...CLEAR_PENDING,
          });
          if (!consumed) fenced();
          outcome = await redeem(tool, verified);
        } else {
          outcome = { text: JSON.stringify({ status: "error", error: refusal }), isError: true };
        }
      }

      entry.text = scrubInterceptorToken(outcome.text);
      entry.isError = outcome.isError;
      entry.completedAt = now().toISOString();
      messages.push(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: toolCallId, type: "function", function: { name: tool, arguments: JSON.stringify(entry.args) } },
          ],
        },
        { role: "tool", tool_call_id: toolCallId, content: modelFacing(tool, outcome.text) },
      );
      base += 1;
      const completed = await finish(runId, {
        trace: trace as unknown as Prisma.InputJsonValue,
        messages: messages as unknown as Prisma.InputJsonValue,
        iteration: base,
        heartbeatAt: now(),
        ...CLEAR_PENDING,
      });
      if (!completed) fenced();
      await auditConfirmation(
        tool,
        decision === "denied" ? "denied" : outcome.isError ? "confirmed_failed" : "confirmed",
      );
      if (decision === "approved" && !outcome.isError) {
        logger.info({ runId, tool, iteration: entry.iteration }, "agent_run_tool_confirmed");
      }
      // WARP-2896 — an approved `workspace_propose` that ran ENDS the run
      // here, before the model is asked anything: it throws the `proposed`
      // stop, which the caller's `try` hands to the terminal write.
      endOnProposal(tool, outcome.text, outcome.isError);
      return true;
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

        // ── WARP-3044: a call the owner already decided is not put to them again ──
        // The decided call ran (or was declined) before the model resumed, and
        // its result is in the conversation. A model that sends it again with
        // the binding the owner decided on (`confirmed` aside, as the
        // interceptor binds) gets the recorded answer: never a second
        // dispatch, never a second park. A REWORDED call is a different call
        // and parks for its own approval, as any new write does — and so does
        // an identical call whose approved dispatch did NOT run the tool: that
        // approval is spent and nothing happened, so a person decides again.
        const binding = confirmationBindingHash(call.tool, call.args);
        const decidedBefore = trace.find(
          (e) =>
            e.tool === call.tool &&
            e.text !== undefined &&
            (e.confirmation === "denied" || (e.confirmation === "confirmed" && e.isError === false)) &&
            confirmationBindingHash(e.tool, e.args) === binding,
        );
        if (decidedBefore) {
          const text =
            decidedBefore.confirmation === "denied" ? decidedBefore.text! : alreadyRunText(call.tool);
          const servedAt = now().toISOString();
          trace.push({
            tool_call_id: call.tool_call_id,
            tool: call.tool,
            args: call.args,
            iteration: abs,
            dispatchedAt: servedAt,
            text,
            isError: true,
            completedAt: servedAt,
            replayOf: decidedBefore.tool_call_id,
          });
          await persistTrace();
          logger.info(
            { runId, tool: call.tool, decidedCallId: decidedBefore.tool_call_id, iteration: abs },
            "agent_run_decided_call_not_repeated",
          );
          return { text, isError: true };
        }

        // Replay: a completed entry from an interrupted segment of THIS
        // iteration, same tool, same args, not yet served. A confirmation
        // envelope is never a result: a park's challenge entry must not be
        // served back, or the model would be told the tool is "waiting for
        // approval" while the decision on it is already spent.
        const hit = trace.find(
          (e) =>
            e.iteration === abs &&
            e.text !== undefined &&
            !isConfirmationEnvelope(e.text) &&
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
          // had its side effect; we cannot know.
          //
          // WARP-2877 — the old code logged this and re-dispatched anyway, so
          // an approved delete could run twice and one `send_notification`
          // became two toasts. {@link redispatchSafe} decides instead, from
          // the catalog's tier flags and what this entry already records.
          if (!redispatchSafe(call.tool, unknownOutcome)) {
            // Marked either way: this step has no result and never will, and
            // both the run-detail view and the park notification below read
            // the mark rather than guessing from an absent `text`.
            unknownOutcome.unknownOutcome = true;
            await persistTrace();
            // An APPROVED call that was lost still re-parks, because that is
            // strictly better than stopping: with no decision left on the row
            // the re-dispatch carries no token, the interceptor challenges,
            // and the human gets to decide whether to run it again knowing it
            // may already have run. (The park notification says exactly that
            // — "Nothing has been done yet" would be a lie here.) Halting
            // would take that choice away and leave a dead run.
            //
            // WARP-3044 — an approved call is now consumed before the loop and
            // a lost one re-parked THERE, as the stored call
            // (`resumeDecidedCall`), so a model's rewording cannot dodge it.
            // This branch is the backstop should a `confirmed` entry without
            // a result ever surface at a loop iteration.
            if (unknownOutcome.confirmation === "confirmed") {
              logger.warn(
                { runId, tool: call.tool, priorCallId: unknownOutcome.tool_call_id, iteration: abs },
                "agent_run_reask_unknown_outcome",
              );
            } else {
              // Nothing gates this tool, so a second dispatch is a second
              // effect and no human is in the loop to catch it. Stop.
              unknownOutcomeTool = call.tool;
              logger.error(
                { runId, tool: call.tool, priorCallId: unknownOutcome.tool_call_id, iteration: abs },
                "agent_run_halted_unknown_outcome",
              );
              stop(runId, "unknown_outcome");
              throw new AgentRunStopped(
                "unknown_outcome",
                `${call.tool} may already have run before the restart`,
              );
            }
          } else {
            // A read, or a gated call whose lost dispatch carried no token.
            // Repeating it is safe — say so loudly rather than silently.
            logger.warn(
              { runId, tool: call.tool, priorCallId: unknownOutcome.tool_call_id, iteration: abs },
              "agent_run_redispatch_unknown_outcome",
            );
          }
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
        endOnProposal(call.tool, call.text, call.isError);
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
      // Redemption happens in `resumeDecidedCall`, on the stored call, before
      // the loop runs (WARP-3044); the loop never attaches a token itself.
      claimGrant() {
        return null;
      },
    };

    // ── Drive the loop ──────────────────────────────────────────────────
    let result: AgentResult | null = null;
    let stopped: AgentRunStopped | null = null;
    let threw: unknown = null;
    try {
      if (await resumeDecidedCall()) {
        // The decided call completed the parked iteration. If that was the
        // run's last, there is no iteration left to ask the model in: the run
        // ends on its cap, as a turn whose last iteration dispatched a tool
        // does — never one model call past it.
        const left = maxIter - base;
        result =
          left > 0
            ? await runAgent(
                { mcp: deps.agent.mcp, aiGateway: runGateway(deps.agent.aiGateway), approvals, maxIterCap },
                {
                  model: run.model,
                  messages,
                  max_iter: left,
                  allowed_tools: allowedTools,
                  toolAccessScope: access.scope,
                  toolCallContext,
                  context_window: contextWindow,
                  tool_selection_mode: toolSelectionMode,
                  // WARP-2896 — the run's binding, not its sentence, admits the
                  // workshop's tools to every turn's advertisement.
                  ...(run.workspaceId ? { bound_tool_domains: WORKSPACE_TOOL_DOMAINS } : {}),
                  signal: controller.signal,
                  checkpoint,
                },
              )
            : { message: { role: "assistant", content: "" }, trace: [], iterations: 0, stop_reason: "iteration_limit" };
      }
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
        { iteration: base + (result?.iterations ?? 0), stopReason: "cancelled", ...CLEAR_PENDING },
        ["cancelled"],
      );
      await audit(runId, run.userId, "cancelled", "Agent run cancelled", undefined,
        user ? { username: user.username, goal: run.goal } : undefined, offLanRefs);
      return;
    }
    if (reason === "parked" && park.request) {
      const parkRequest = park.request;
      // The iteration's own checkpoint already holds the conversation at its
      // top, so `iteration` is left alone: the resume consumes the decision on
      // the stored call and completes this iteration with it (WARP-3044). The
      // lease is released; a parked run holds nothing. The challenge's trace
      // entry is marked so the run-detail view can show where the run
      // stopped — only an entry with no decision on it: a re-park of a lost
      // approved call keeps that entry's `confirmed`.
      for (const e of trace) {
        if (e.tool_call_id === parkRequest.tool_call_id && e.confirmation === undefined) {
          e.confirmation = "parked";
        }
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
        // WARP-2877 — "Nothing has been done yet" is TRUE for an ordinary
        // park and FALSE for a re-park after an approved call whose outcome
        // was lost to a restart: that dispatch spent the approval and may
        // have written. The trace mark is what tells the two apart, and the
        // person deciding is the one who needs to know.
        const mayHaveRun = trace.some((e) => e.unknownOutcome && e.tool === parkRequest.tool);
        await sendNotification(prisma, {
          username: user.username,
          kind: "ai",
          title: `Approval needed: ${parkRequest.tool}`,
          body:
            `Background run "${goal}" wants to run ${parkRequest.tool}` +
            (fields ? ` (${fields})` : "") +
            (mayHaveRun
              ? ". You approved this before and the run was interrupted mid-call, so it MAY ALREADY " +
                "have happened — check before approving it again."
              : ". Open the run to approve or deny it. Nothing has been done yet."),
          // WARP-2909 — the link opens the run; approving it is redeemed ONLY
          // by POST /api/agent-runs/:id/confirm from that page. No token, no
          // hash, no args (they can carry customer data) ride on the payload.
          ...agentRunLink(runId),
          data: { agentRunId: runId, pendingTool: parkRequest.tool, needsDecision: true },
        }).catch((err) => {
          logger.warn({ err, runId }, "agent_run_park_notification_failed");
        });
      }
      logger.info({ runId, tool: parkRequest.tool }, "agent_run_parked");
      return;
    }
    if (reason === "proposed") {
      // WARP-2896 — the run's terminal act. `succeeded`, with the proposal
      // (the tool's own result: commit, tag, manifest) as the run's result,
      // and `stopReason: proposed` so the workshop page can say which
      // ending this was without parsing the result.
      const text = proposal ?? "{}";
      await finish(runId, {
        status: "succeeded",
        endedAt,
        iteration: base + (result?.iterations ?? 0),
        stopReason: "proposed",
        result: text,
        error: null,
        ...CLEAR_PENDING,
      });
      // WARP-2899 — a connector draft is not an extension: say which.
      const proposed = proposalKindOf(text);
      const draft = proposed.kind === "connector-draft";
      await audit(runId, run.userId, "succeeded", draft ? "Agent run proposed a connector draft" : "Agent run proposed an extension", undefined,
        user ? { username: user.username, goal: run.goal, result: text } : undefined);
      if (user) {
        const goal = run.goal.length > 120 ? `${run.goal.slice(0, 117)}…` : run.goal;
        await sendNotification(prisma, {
          username: user.username,
          kind: "ai",
          title: draft ? "Connector draft proposed" : "Extension proposed",
          body:
            proposed.kind === "connector-draft"
              ? `Background run "${goal}" finished with a connector draft${proposed.readback ? `: ${proposed.readback}` : ""}. An owner exports it from the Workshop for a Warp Lab PR.`
              : `Background run "${goal}" finished with a proposal. Open the Workshop to review it.`,
        }).catch((err) => {
          logger.warn({ err, runId }, "agent_run_proposal_notification_failed");
        });
      }
      return;
    }
    if (reason === "unknown_outcome") {
      // WARP-2877 — terminal and explicit. `status` is the enum column, as it
      // is for every other ending; `stopReason` names WHICH ending, the same
      // typed slot `deadline` and `cancelled` already use, so the run-detail
      // view and the notification can say what happened without a human
      // reading a log. Not `awaiting_confirmation`: that status offers
      // Approve/Deny, and there is nothing left to approve — the tool may
      // already have run. Honest is `failed` plus the reason why.
      const error =
        `unknown_outcome: ${unknownOutcomeTool ?? "a tool"} was dispatched before this run was ` +
        "interrupted and its result was never recorded, so it may already have taken effect. " +
        "It was NOT run again. Check whether it happened, then start a new run if it did not.";
      await finish(runId, {
        status: "failed",
        endedAt,
        iteration: base + (result?.iterations ?? 0),
        stopReason: "unknown_outcome",
        error,
        ...CLEAR_PENDING,
      });
      await audit(runId, run.userId, "failed", "Agent run halted (outcome unknown)", error,
        user ? { username: user.username, goal: run.goal } : undefined, offLanRefs);
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
        ...CLEAR_PENDING,
      });
      await audit(runId, run.userId, "failed", "Agent run failed", error,
        user ? { username: user.username, goal: run.goal } : undefined, offLanRefs);
      return;
    }
    if (gatewayBusy(threw, result)) {
      // Interactive chat has the box (see RUN_INFERENCE_PRIORITY). Hand the
      // row back to the queue at the same checkpoint — `iteration` and
      // `messages` were written at the top of the iteration that could not
      // start, so the resume re-runs exactly it — and try again later. Not a
      // lease loss: `attempts` is untouched. `deadlineAt` still stands.
      const ok = await finish(runId, {
        status: "queued",
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        runAfter: new Date(endedAt.getTime() + RUN_YIELD_MS),
      });
      if (ok) {
        logger.info(
          { runId, iteration: base + (result?.iterations ?? 0), yieldMs: RUN_YIELD_MS },
          "agent_run_yielded_to_chat",
        );
      }
      return;
    }
    if (threw !== null || result === null) {
      const error = threw instanceof Error ? threw.message : String(threw ?? "no result");
      await finish(runId, { status: "failed", endedAt, error: error.slice(0, 2000), ...CLEAR_PENDING });
      await audit(runId, run.userId, "failed", "Agent run failed", error,
        user ? { username: user.username, goal: run.goal } : undefined, offLanRefs);
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
          ...CLEAR_PENDING,
        });
        await audit(runId, run.userId, "succeeded", "Agent run completed", undefined,
          user ? { username: user.username, goal: run.goal, result: text } : undefined, offLanRefs);
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
          ...CLEAR_PENDING,
        });
        await audit(runId, run.userId, "failed", "Agent run failed", error,
          user ? { username: user.username, goal: run.goal } : undefined, offLanRefs);
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
          ...CLEAR_PENDING,
        });
        await audit(runId, run.userId, "failed", "Agent run failed", error,
          user ? { username: user.username, goal: run.goal } : undefined, offLanRefs);
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
    // WARP-2997 — the cloud gate's verdict and what it withheld, on the
    // signed row, as chat records `offLanProvider` on its turn row.
    offLan?: Record<string, unknown>,
  ): Promise<void> {
    // The person who cancelled a run does not need a toast saying so; the
    // cancel route's audit row records it (WARP-2744 item 6).
    if (notify && status !== "cancelled") {
      const goal = notify.goal.length > 80 ? `${notify.goal.slice(0, 77)}…` : notify.goal;
      const body =
        status === "succeeded"
          ? (notify.result ?? "").slice(0, 300) || "Finished."
          : `Failed: ${(error ?? "unknown error").slice(0, 300)}`;
      await sendNotification(prisma, {
        username: notify.username,
        kind: "ai",
        title: status === "succeeded" ? `Background run finished: ${goal}` : `Background run failed: ${goal}`,
        body,
        // WARP-2909 — same link and tag as the park, so the finish replaces
        // the approval prompt in the tray. No `needsDecision` here.
        ...agentRunLink(runId),
        data: { agentRunId: runId, status },
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
      refs: { agentRunId: runId, status, workerId, ...offLan },
    });
  }

  async function releaseAll(): Promise<void> {
    const ids = [...inFlight.keys()];
    // Captured before the executions settle: `launch` drops a lease when its
    // execution ends, and the release must still name the lease it held.
    const held = new Map(ids.map((id) => [id, leases.get(id)] as const));
    for (const id of ids) stop(id, "fenced");
    await Promise.allSettled(ids.map((id) => inFlight.get(id)));
    const at = now();
    for (const id of ids) {
      const lease = held.get(id);
      await prisma.agentRun.updateMany({
        where: { id, claimedBy: workerId, status: "running", ...(lease ? { claimedAt: lease } : {}) },
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
