# Durable agent runs — design (WARP-2176)

**Status:** Accepted for child 1 (WARP-2177); §6–§9 describe children 2–4 as
scoped in their tickets and are updated as each lands.
**Tickets:** epic WARP-2176; WARP-2177 (this document's as-built half),
WARP-2178 (tool-result summarisation), WARP-2179 (Tier-2 park-and-confirm),
WARP-2180 (API, Activity view, scheduling, LLM tools).
**Supersedes:** the `agent-runs-design-draft.md` the tickets cite, which was
never committed anywhere; the tickets' acceptance criteria were treated as the
spec.

## 1. The problem, in one paragraph

`runAgent()` (`apps/orchestrator/src/services/llm-agent.service.ts`) runs a
whole turn inside one HTTP request. It streams SSE and checks `req.signal`
between iterations and before each tool dispatch. Close the laptop and the turn
dies; redeploy the box and every in-flight turn dies with the container. That
single property is what stops Droplet doing agentic *work* rather than agentic
*chat*: "reconcile these invoices", "sweep last night's clips and tell me what
changed" are 5-to-40-minute jobs, and none survives today's runtime.

## 2. Decision: no agent framework

Evaluated and rejected, with the reasons recorded on the epic: OpenClaw
(disqualified on security history), Mastra (`ee/` directories under a
non-permissive licence), LangGraph.js (a graph runtime carries none of the
loop's value — RBAC narrowing, tiered safety, the signed activity chain — so it
would all be re-implemented on top), Temporal (a second server and datastore
for a problem `pg_try_advisory_xact_lock` already solves in this codebase),
and, on 2026-09-04, **Strands Agents (TypeScript)** — licence-clean, but its
persistence is per invocation with no lease, no lock and no mid-turn resume,
it has no Ollama provider and no per-call MCP `_meta` (which `ncToken` rides),
and it carries the Bedrock runtime client as a hard dependency. Its
conversation managers are the reference shape for §6.

What is built instead: **one table, one worker, one checkpoint**, on the
scheduler the orchestrator already has. The loop is not rewritten.

## 3. Shape

```
POST /api/agent-runs (WARP-2180)          cronRuntime.scheduleInterval (index.ts)
        │                                    │                      │
        ▼                                    ▼                      ▼
   AgentRun row ──── queued ──▶ tickOnce() claims ──▶ execute() ◀── heartbeatOnce()
                     ▲              (under advisory lock)   │          (per process)
                     │                                       ▼
                reclaim (stale heartbeat)          runAgent(…, { checkpoint })
                                                             │
                                          ┌──────────────────┼──────────────────┐
                                          ▼                  ▼                  ▼
                                    onIteration()     beforeToolCall()    afterToolCall()
                                    {iteration,        persist intent,     persist wire
                                     messages}         maybe REPLAY        result
```

## 4. `AgentRun` (WARP-2177)

`apps/orchestrator/prisma/schema.prisma`, migration
`20260904120000_warp_2177_agent_run`. Pattern: `ToolSpec` / `ToolRun` — same
explicit-status, `trace` Json shape; the difference is that the steps are
chosen by the model, not authored.

| Column | Role |
| --- | --- |
| `status` | explicit `AgentRunStatus` enum: `queued · running · awaiting_confirmation · succeeded · failed · cancelled`. Never derived from `endedAt IS NULL`. |
| `userId` | the attributed principal. Reach is re-resolved from it at **every** claim. |
| `runAfter` | not-before; delay and backoff without a second queue. |
| `claimedBy · claimedAt · heartbeatAt` | the lease. |
| `startedAt · deadlineAt` | first claim, and the wall-clock ceiling stamped from it. A column, not `startedAt + constant`, so a config change cannot move a live run's goalposts. |
| `attempts` | reclaim count (see §5). |
| `maxIter · iteration · messages` | the checkpoint: `iteration` is the next iteration to execute, `messages` the complete conversation at its top. |
| `trace` | the replay guard: every dispatched tool call, written **before** dispatch, completed after. |
| `result · stopReason · error` | terminal outcome. |

Indexes: `[status, runAfter]` (claim scan), `[status, heartbeatAt]` (reclaim
scan), `[userId, createdAt desc]` (my runs), `[sessionId]`.

### Why the iteration boundary is the checkpoint unit

At the top of `for (let iter = 0; iter < maxIter; iter++)` the message array
is a complete, valid conversation — every `tool_calls` has its `role: "tool"`
replies. Handed back to `runAgent()` verbatim, the loop resumes with
`maxIter − N` iterations and no reconstruction. Cost: one row update per
iteration; typical turns finish in ~3.6 iterations.

### The replay guard

A checkpoint alone re-runs the interrupted iteration on resume, and the model
re-issues its tool calls. Without a guard a redeploy mid-run silently re-sends
every notification the run already sent. So `beforeToolCall` persists the
call (`tool_call_id`, tool, args, absolute iteration) **before** dispatch and
`afterToolCall` completes it with the wire result. On resume, a call for the
same tool with the same canonical args in the same iteration whose entry is
complete is **replayed** from the trace: the loop receives the stored text
through the same parse, bounding, trace and SSE path as a live result, and
`mcp.callTool` is never reached. An entry with no result (dispatched, outcome
never recorded) is re-dispatched and logged as `agent_run_redispatch_unknown_outcome`
— it may have had its side effect and we cannot know; re-dispatching is the
only way to make progress, so it is loud, not silent.

## 5. Worker (WARP-2177)

`apps/orchestrator/src/services/agent-run-worker.service.ts`.

**Two ticks on the one clock.** Both ride `cronRuntime.scheduleInterval`;
`agent-run-worker.no-queue-dependency.guard.test.ts` asserts no queue package
enters `package.json`.

- `tickOnce()` runs under the `droplet:agent-run-worker` advisory lock:
  reclaim stale leases, then claim queued rows up to `AGENT_RUN_CONCURRENCY`.
- `heartbeatOnce()` runs per process, unlocked: beat every run this process is
  executing and observe cancellation / the deadline.

**The run executes outside the tick.** cron-runtime's lock is
transaction-scoped inside a `$transaction` with a 60 s timeout — right for a
tick, wrong for a forty-minute run. The tick claims and launches; execution is
a tracked promise. The lock serialises *claiming* across replicas; the claim
itself is a conditional `updateMany` on `status = queued`, so two unlocked
racers still cannot both win a row (`agent-run-claim.pg.test.ts`, real
Postgres).

**Fencing.** Every executor write is conditioned on `claimedBy = workerId AND
status = running`. A run reclaimed by another worker while this process was
paused is one this process can no longer touch: its next checkpoint returns
`count: 0`, it aborts, and the successor continues from the row.

**Heartbeat and reclaim.** The heartbeat is timer-driven (`AGENT_RUN_HEARTBEAT_MS`,
15 s) and independent of iteration length, so a run parked in a slow model
call still holds its lease. That is what lets the reclaim threshold be derived
from the heartbeat (`AGENT_RUN_RECLAIM_AFTER_MS`, 60 s = 4 beats; clamped to at
least 2 beats by `resolveAgentRunLimits`) rather than from a guess at how long
an iteration takes. `onIteration` beats too, so "at least once per iteration"
holds as well.

**`attempts` counts reclaims, not claims.** A graceful shutdown
(`releaseAll()` on SIGTERM) hands in-flight runs back to `queued` without
charging an attempt, so routine deploys cannot fail a healthy long run. A stale
lease at `attempts ≥ AGENT_RUN_MAX_ATTEMPTS` (3) is failed with an error naming
the count and the last worker, never re-queued for a fourth crash.

**Whose access.** `resolveAttributedToolAccess(prisma, run.userId)` at every
claim — the WARP-1580 ticker rule. An unresolvable principal (missing,
deactivated, read failed) does not run: the run fails with
`attribution_failed:<reason>` and a `tool_run` activity row, the ToolSpec
ticker's skip-and-audit posture, rather than running at DENY_ALL reach and
burning GPU on a turn that can call nothing. The scope passed to the loop is
always the resolved one, never `null` standing in for "unknown".

**Pool.** Tier-1 only until WARP-2179: the chat pool minus every
`requiresConfirmation` tool, narrowed per principal across both axes
(`narrowToolNamesForPrincipal`). One deliberate re-admission:
`send_notification` is excluded from chat as a window-budget/UX call, not a
safety tier; a run has no reader, so a notification is its completion channel,
and it is Tier-1 in the catalog. A model that reaches for a Tier-2 tool hits
the loop's unknown-tool guard; the worker turns that into a failed run naming
the tool and WARP-2179 rather than letting the model spend iterations around
the refusal.

**Bounds.** `maxIter` (clamped to `config.agentMaxIter.capIter`, 10, because
the loop itself clamps there — longer runs are §6's problem, as the epic says)
**and** `deadlineAt`. Cancellation flips `status = cancelled`; the executor
observes it at the next heartbeat or checkpoint and maps it onto the loop's
own `AbortController`, so the existing `req.signal?.aborted` checks stop it
before the next dispatch.

**Audit.** Each dispatch carries `agentRunId` on its `McpCallContext`, and
`mcp-client.service.ts` writes it as `refs.agentRunId` on the existing
`tool_call` ActivityRow. No new kind: `KNOWN_KINDS` is a closed allow-list that
throws. Terminal outcomes write a `tool_run` row with the same ref.

### The one loop change

`AgentRequest.checkpoint?: AgentCheckpointPort` — three awaited hooks
(`onIteration`, `beforeToolCall`, `afterToolCall`). Absent, the loop is
byte-for-byte what it was (`llm-agent.checkpoint-port.test.ts` asserts identical
requests, dispatches and result). The ticket says `runAgent()` is not modified;
this is the deliberate exception, for a reason a wrapper cannot meet: the
iteration boundary and the `tool_call_id` both live inside the function, and a
resume needs both.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_RUN_CONCURRENCY` | 1 | in-flight runs per process. Background runs yield to interactive turns; raising it is a measured latency decision. |
| `AGENT_RUN_TICK_MS` | 5000 | claim/reclaim scan |
| `AGENT_RUN_HEARTBEAT_MS` | 15000 | lease heartbeat |
| `AGENT_RUN_RECLAIM_AFTER_MS` | 60000 | stale-lease threshold (≥ 2 × heartbeat, clamped) |
| `AGENT_RUN_MAX_ATTEMPTS` | 3 | reclaims before a run is failed |
| `AGENT_RUN_MAX_WALL_MS` | 2400000 | wall-clock ceiling (40 min) |

## 6. Tool-result summarisation (WARP-2178) — scoped

Context is the real ceiling, not durability. `OLLAMA_CONTEXT_LENGTH` is 16384
and `context-budget.service.ts` has no history compaction; a run's message
array grows monotonically with every tool result. Planned shape, borrowed from
Strands' conversation managers: a tool result over a measured byte threshold is
reduced before it is appended — head and tail kept around a
`<truncated chars="N"/>` marker, ids/paths/counts preserved so the next
iteration can chain — while the **full payload stays in `trace`**. Tool-use /
tool-result pairs are never broken. Extend `context-budget.service.ts`'s drop
ladder; do not add a second sizing path. Resumed messages are already reduced,
so a resume is never more expensive than the original. This is also what lets
`maxIter` rise above the chat cap: the worker can then drive the loop in
segments, each resumed from the checkpoint.

## 7. Tier-2 park-and-confirm (WARP-2179) — scoped

A Tier-2 call transitions the run to `awaiting_confirmation` and persists the
pending call bound to `{ service, action, resourceId }` — the shape the
interceptor's token binds. The run is parked, not cancelled, and releases its
lease. The token is minted **when the human opens the notification**, so the
60 s TTL starts at human attention. Notification rides the ws-bridge
(`droplet/notifications/<user>`) the desktop app already consumes. Deny yields
a tool result the loop sees, so the model adapts. Tier-3 stays refused — no new
bypass. Confirmation is not an escalation: RBAC still applies per dispatch. The
worker's approvals port maps onto the existing `ChatApprovalStore` shape
(`register` / `claimGrant`) so the round-trip reuses WARP-2469's mechanism.

## 8. API, Activity view, scheduling, LLM tools (WARP-2180) — scoped

`POST /api/agent-runs`, `GET /api/agent-runs`, `GET /api/agent-runs/:id`,
`POST /api/agent-runs/:id/cancel`, `POST /api/agent-runs/:id/confirm`, all
owner/admin-gated via `requireRoleOrMcpService`; a user sees only their own
runs. Recurring runs reuse `ToolSchedule`'s RRULE vocabulary on
`cronRuntime.scheduleInterval` with a distinct lock key — no second clock.
Runs appear under **Activity**, grouped by `refs.agentRunId`, not as a nav
item. `start_agent_run` (Tier-2 — it spends compute unattended) and
`list_agent_runs` (Tier-1) in `packages/tools-core`, in a `DOMAIN_GROUPS`
entry so domain selection can find them; a run whose goal is to start runs is
refused explicitly.

## 9. Out of scope for the epic

Parallel tool dispatch within an iteration; sub-agents / delegation; the
ADR-014 client-target axis; the trigger→action automation engine (WARP-1448).
