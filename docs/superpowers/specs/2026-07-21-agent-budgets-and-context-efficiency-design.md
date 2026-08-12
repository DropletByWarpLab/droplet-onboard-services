# Agent step-budget & context-window tuning + context-efficiency work

**Date:** 2026-07-21
**Status:** Approved design (Romain, 2026-07-21) — awaiting implementation plan
**Repos touched:** droplet-onboard-services (orchestrator, tools-core, docker compose)

## Context and problem

The chat agent loop has two hard-coded budgets that limit capability:

- **Step limit:** `DEFAULT_MAX_ITER = 5`, hard cap 10, enforced in two places that
  must agree — `apps/orchestrator/src/services/llm-agent.service.ts` (const +
  `Math.min(req.max_iter ?? 5, 10)` clamp) and the zod bound
  `max_iter: z.number().int().min(1).max(10)` in
  `apps/orchestrator/src/routes/llm.ts`. Exhaustion ends the turn with
  `stop_reason: "iteration_limit"`. The staging eval already attributes real
  failures to this ("step-limit flake" blocked C02/C04 in run 7).
- **Context window:** `OLLAMA_CONTEXT_LENGTH`, one env token defaulting to
  16384, consumed by the `ollama` service and the orchestrator
  (`docker/docker-compose.yml`, `config.ts`, mirrored by
  `DEFAULT_CONTEXT_WINDOW` in `context-budget.service.ts`). 16384 was the
  WARP-854 fix, sized so gpt-oss:20b's KV cache stays fully resident on the
  single box's 16 GB GPU. The request estimator budgets against
  `window − OUTPUT_RESERVE` (1024) and degrades deterministically
  (drop business → drop persona → trim history/attachments).

The dominant inefficiency: the owner-role loop advertises **~80 tool schemas
≈ 11k tokens every turn** — about two-thirds of the 16k window — leaving
roughly 4k tokens for system prompt, memory facts, pins, attachments, history,
and all accumulated tool results. The only narrowing that exists today
(`narrowAllowedToolsForRole`) is security narrowing (role/RBAC), not relevance
narrowing. Long-list tool choice is also a known model-quality failure mode
(WARP-1334 agent-skips-retrieval; run-7 "read_file instead of search_content
for PDFs").

The two knobs are coupled: each extra iteration appends tool results to the
transcript, so raising the step limit without widening the window (or shrinking
what fills it) just converts step budget into history-trimming pressure.

## Goal

Make the agent more capable — more steps, more usable context — while keeping
turn latency and VRAM inside the single-box envelope. Values are chosen from
measurements on the staging box, not guesses.

## Non-goals

- No model swap; the One-Model Rule is untouched.
- No prompt/quality work on memory extraction (WARP-1393) — separate track.
- No embedding- or LLM-based tool routing; selection stays deterministic.
- `OUTPUT_RESERVE` stays a constant (deliberately not env-configurable).
- No change to RBAC/write-tool gating semantics anywhere.

## Design

### 1. Configurable step limit

Two new env vars in the orchestrator `config.ts` zod schema, following the
`OLLAMA_CONTEXT_LENGTH` pattern (`z.coerce.number().int().positive()` with
defaults):

- `AGENT_MAX_ITER_DEFAULT` — default **5** (today's behavior).
- `AGENT_MAX_ITER_CAP` — default **10** (today's behavior).

Both enforcement points read from config so they cannot drift: the
`llm-agent.service.ts` clamp becomes
`Math.max(1, Math.min(req.max_iter ?? config.AGENT_MAX_ITER_DEFAULT, config.AGENT_MAX_ITER_CAP))`,
and the route-level zod bound uses `config.AGENT_MAX_ITER_CAP` (schema built at
module init; config is resolved at boot, so this is safe).

Boot-time sanity: if `CAP < DEFAULT`, clamp `DEFAULT` down to `CAP` and emit a
structured warning. Zod already rejects non-positive values. A misconfigured
env must not silently break chat (same philosophy as
`voiceReasoningEffortDefault`).

Callers with explicit values keep them: `email-analysis.service.ts` stays at
`max_iter: 1`; voice inherits the default (it already runs low reasoning
effort, and the §2 guard bounds its worst case).

### 2. Token-aware iteration guard

Before each iteration after the first, re-estimate the live transcript —
serialized messages plus `toolSchemasJson` — using the existing pure
`estimateTokensFromChars` from `context-budget.service.ts`. If

```
(window − OUTPUT_RESERVE) − estimatedTranscriptTokens < ITERATION_MIN_HEADROOM
```

stop dispatching tools and run **one finalization pass**: the request is sent
with tools stripped and a system nudge appended ("context budget reached —
answer from the information already gathered; do not call tools"). New
`ITERATION_MIN_HEADROOM` constant in `prompt-budget.consts.ts`, initial value
**1536 tokens** (~one more tool result plus margin; revisit with §6 data).

New `stop_reason: "context_budget"` surfaced in the SSE `done` event and the
trace — honest surfacing, never a silent trim. Stripping `tools[]` changes the
prompt prefix and costs one full re-prefill; acceptable for a single final
pass.

This guard is what makes raising the step default safe: effective steps
self-limit under window pressure instead of converting into history-trimming.

### 3. Relevance-based tool selection

A new `tool-selection.service.ts` in the orchestrator, invoked **after**
`narrowAllowedToolsForRole` and **before** the agent loop.

**Invariant: selection only ever subsets the role-allowed list.** RBAC,
`WRITE_TOOLS`, `replayedWriteToolAttempt`, and the interview write-strip are
untouched.

Selection is deterministic and free of extra model calls. The advertised set is
the union of:

- **Core set** (always advertised): `search_content`, `read_file`,
  `list_files`, and the memory read tools.
- **Rule-matched domains:** keyword/intent rules map the latest user message to
  `ToolDomain` groups. The taxonomy is **reused, not invented**: tools-core
  already declares every tool's domain in `TOOL_CATALOG` / `DOMAIN_GROUPS`
  (`packages/tools-core/src/catalog.ts`, completeness CI-enforced by
  `catalog.test.ts`).
- **Conversation continuity:** the domains of any tools already called earlier
  in the conversation stay advertised for the rest of that conversation.

**Self-healing wrong guesses:** the WARP-642 hallucinated-tool guard in the
agent loop gains one branch. If the model calls a tool that exists in the
role-allowed set but was filtered by selection, the guard does not emit
`UNKNOWN_TOOL`; it adds that tool's entire domain (via the catalog's
name→domain index) to the advertised set — which then persists via the
continuity rule above — and lets the next iteration proceed.
Cost of a bad guess: one iteration, not a failed turn. The guard's existing
behavior for genuinely unknown / role-forbidden names is unchanged.

**Kill switch:** `TOOL_SELECTION_MODE` env token, values `off | domains`.
Ships as `off`; flipped to `domains` per-deployment for the §6 phase-3
measurement, and the shipped default is decided by that data.

`buildBaseSystemPrompt` already composes tool guidance from the effective tool
set, so the system prompt automatically mentions only advertised tools —
consistent with the existing WARP-642 rationale (never instruct a tool the
model can't call).

Expected effect: advertised schemas shrink from ~11k tokens to ~3–5k, freeing
more usable context than a 16k→32k window bump at zero VRAM cost, and
shortening the list the model chooses from (targets the WARP-1334 class).

### 4. Repetition early-stop

The loop tracks a hash of each executed `(tool name, canonicalized args)`.

- First exact repeat: execute nothing; inject one corrective system nudge
  referencing the prior result.
- Second identical repeat: finalize early (same finalization pass as §2) with
  `stop_reason: "repetition"`.

No exemption list initially — legitimate identical-args retries do not exist in
this tool set (transient tool errors produce different error payloads, and the
model changing its mind produces different args).

### 5. Compose / infrastructure levers

Two new mirrored env tokens on the `ollama` service in
`docker/docker-compose.yml`, defaults preserving today's behavior:

- `OLLAMA_FLASH_ATTENTION` (default unset) — prerequisite for KV quantization.
- `OLLAMA_KV_CACHE_TYPE` (default unset = f16) — `q8_0` roughly halves KV-cache
  VRAM, buying window headroom on the 16 GB GPU.

`OLLAMA_CONTEXT_LENGTH` remains the single window token; any raised value is
set in `.env` per-deployment after §6 gates it.

### 6. Measurement protocol (staged, on the staging box)

Harness: the `/staging-suite` eval (36 rows). Established noise band: single-run
deltas < 4 rows are noise, so each phase's winner needs a ≥ 4-row delta or two
confirming runs. Full 3×3 cross-product is too expensive; three sequential
phases, each holding everything else constant:

1. **Window sweep** (steps = 5): 16k → 24k → 32k-with-`q8_0`-KV.
   **VRAM gate:** after a long-prompt probe, `ollama ps` must show 100% GPU
   residency; a config that spills to CPU is rejected on latency grounds before
   eval runs.
2. **Step sweep** (winning window, §2 guard live): 5 → 8 → 10.
3. **Tool selection on/off** (§3) at the winning window+steps config.

Recorded per cell: eval pass rate, per-row wall-clock, VRAM split,
degradation/trim warning counts, stop-reason distribution.

Outputs: shipped defaults for `AGENT_MAX_ITER_DEFAULT`, `OLLAMA_CONTEXT_LENGTH`
(per-deployment `.env`), and `TOOL_SELECTION_MODE`; findings logged and
ticketed per the standing staging protocol. Constraint: staging box creds are
per-session from Romain, so measurement runs are scheduled with him.

## Build order

1. §1 configurable step limit (small, immediately useful)
2. §2 token-aware iteration guard (makes higher steps safe)
3. §6 phases 1–2 (window + step sweeps)
4. §3 tool selection
5. §4 repetition early-stop (ride-along)
6. §6 phase 3 (selection on/off), then set shipped defaults

## Error handling

- Misconfigured step-limit env: clamp + structured boot warning (§1).
- All new stop reasons (`context_budget`, `repetition`) surface in SSE `done`
  and the trace — no silent caps anywhere.
- Selection failure mode (rules match nothing): advertised set = core set +
  continuity domains; the §3 guard branch recovers anything else.
- Estimator remains conservative (rounds up; under-fills rather than
  over-fills the real window).

## Testing

- **Unit:** config parse/clamp cases for the two new env vars; selection
  invariants (result ⊆ role-allowed, core set always present, continuity
  domains retained, `off` mode is a pass-through); guard self-heal branch
  (filtered-but-allowed vs genuinely unknown vs role-forbidden); §2 trigger on
  synthetic near-full transcripts (headroom boundary ±1 token); §4 nudge on
  first repeat and stop on second.
- **Existing canaries stay green:** base-prompt-budget CI test, catalog
  completeness test, WARP-854 empty-completion contract tests.
- **Integration:** `llm.test.ts` gains env-override cases for the step limit;
  SSE contract tests for the two new stop reasons.
- **Acceptance:** the §6 protocol itself — quality, latency, VRAM measured on
  the box before defaults change.

## Risks

- **Mis-filtered tools (§3):** mitigated by core set, continuity domains,
  self-healing guard, kill switch, and phase-3 eval before the default flips.
- **Window raise spills KV to CPU:** caught by the §6 phase-1 VRAM gate before
  any eval time is spent.
- **Higher step default inflates latency:** bounded by §2 (window pressure) and
  §4 (repetition); phase-2 records wall-clock so the default is chosen with
  latency visible.
- **Zod-at-module-init reading config:** config must be importable before the
  route module — already true today (`config.ts` is imported throughout at
  boot); noted for the implementer.

## Corrections (2026-07-21, implementation review)

1. **§2 formula corrected to transcript-only accounting.** The design text
   above ("serialized messages plus `toolSchemasJson`") was implemented as
   written and turned out to be wrong: the shipping 70-tool chat scope
   serializes to ~12k tokens of schemas on its own, so folding that into the
   in-loop guard's estimate left almost no headroom for the transcript at the
   16k default window — the guard fired on iteration 1 of essentially every
   tool turn, capping the agent at one iteration. The shipped guard estimates
   `JSON.stringify(messages).length` only. This is not a gap: the route-side
   WARP-1118 estimator (`context-budget.service.ts`, invoked from
   `routes/llm.ts` before the agent loop starts) already budgets the FULL
   initial request — system blocks + tool schemas + history — against the
   same window. The in-loop guard's job is narrower: bound mid-turn
   transcript growth on top of that already-budgeted starting point.

2. **§3 conversation continuity is inert through `/api/llm/chat`.** The
   continuity rule ("the domains of any tools already called earlier in the
   conversation stay advertised") reads `tool_calls` off replayed assistant
   messages in `req.messages` — but `/api/llm/chat`'s request schema
   (`chatRequestSchema` in `routes/llm.ts`) has no `tool_calls` field on its
   message objects, so zod strips it from every replayed turn before
   `agentMessages` is built. Continuity therefore only ever works *within* a
   single turn's own iterations (where the loop pushes the model's raw
   message object, tool_calls intact) — never *across* separate HTTP
   requests replaying prior history. Fixing this needs route-side
   reconstruction of `tool_calls` from the persisted trace, which is
   DE-SCOPED from this branch and is a prerequisite to flipping
   `TOOL_SELECTION_MODE` in the §6 phase-3 measurement (a cross-turn
   follow-up would otherwise eat a self-heal iteration on every turn that
   needs a previously-used domain). Within-turn domain expansion via the
   WARP-642 self-heal guard is unaffected by this gap.

3. **§4's stated no-exemption rationale doesn't hold.** The reasoning above
   ("transient tool errors produce different error payloads, and the model
   changing its mind produces different args") is wrong on its own terms: the
   repetition key (`canonicalCallKey`) is computed from the call's `(tool
   name, canonicalized args)` — never from the result/error payload — so a
   transient failure followed by an identical retry is indistinguishable from
   a genuine duplicate call by construction, regardless of what the two
   error payloads looked like. The no-exemption decision itself still
   stands (no legitimate identical-args retry pattern has surfaced in this
   tool set), but that stated justification must not be relied on or cited
   again — a future change that wants an exemption needs its own analysis of
   the args-only key, not this paragraph.

## Measurement outcome (2026-07-21, §6 protocol executed)

The staged protocol ran the same evening the branch merged (7 × 36-row cells,
`staging-seed/eval/findings-2026-07-21-tuning.md`):

1. **§1 step limit — shipped default flipped 5 → 10** (phase-2 winner,
   two confirming runs at 23/36 vs 21 at 5; iteration_limit endings 4→0;
   typical turns unaffected at ~3.6 iterations).
2. **§6 window — 16384 kept.** 24k and 32k+q8_0 both pass the VRAM gate
   (100% GPU on the 16 GB card) but bought no quality at any step count;
   zero `context_budget` finalizations in 252 rows.
3. **§3 selection — stays `off` shipped** (continuity prerequisite stands),
   but the phase-3 cell scored 24/36 — best of the sweep — with zero
   self-heals and zero degradation drops; re-decide after continuity lands.

## §3 re-decision (2026-08-12, WARP-1921) — shipped default flipped to `domains`

The continuity prerequisite named above has landed, so the re-decide is due.

**Prerequisite closed.** Correction #2 (§3 continuity inert through
`/api/llm/chat`) is fixed by reading the prior turns' tool names from the
persisted trace — `ChatPersistenceService.getConversationToolNames`, passed to
the loop as `prior_tool_names` — rather than from `tool_calls` on replayed
messages, which `chatRequestSchema` never declared and zod therefore stripped.
Reading the trace is also authoritative: a client cannot claim to have used a
tool it did not. Within-turn `tool_calls` continuity is unchanged and still
required (a turn's own calls are not persisted until it finalizes).

**Why flip now, beyond the 24/36 cell.** The advertisement had run out of
room. Measured on `bf30e753`, the default chat turn carried 71 tools = 50,665
chars = **12,666 tokens**, against a 15,360-token ceiling — leaving 28 tokens.
WARP-1893's `rename_camera` could not fit at *any* description length (244
chars minimum vs 112 free), and the WARP-1892 epic needs ~8 more tools. The
canary was blocking every new tool while real turns had ~10K tokens spare.

**Measured effect of `domains` (2026-08-12):**

| Turn | Tools | tools[] chars | Worst-case turn |
| --- | --- | --- | --- |
| `off` (previous default) | 71 | 50,665 | 15,617 tok — over ceiling |
| "rename the driveway camera…" | 15 | 10,421 | 5,556 tok |
| "what's in my documents folder?" | 13 | 8,635 | 5,109 tok |
| "hey, how are you?" | 4 | 3,165 | 3,742 tok |

That matches the §3 prediction ("~11k → ~3–5k"). Prompt prefill drops
proportionally on every turn, which is the latency win on a local GPU.

**Two defects fixed alongside the flip.**

1. The keyword rules were written from tool names, not from how people talk:
   *"show me people at the front door yesterday"* matched **nothing** and
   advertised zero camera tools. Vocabulary widened across domains, and the
   suite now drives whole sentences a household would type — asserting with
   the pattern's own words is the tautology that let this ship green.
2. The WARP-1118 canary measured the full static pool, so with selection
   shipped it would have stayed red against ~10K tokens of real headroom. It
   now asserts the worst-case **selected** turn (largest domain + core), with
   the full pool kept as a growth tripwire.

**Honest limit on the rollback.** `TOOL_SELECTION_MODE=off` no longer fits the
16K window alongside the full fixed blocks — the pool passed the ceiling
during WARP-1893 and is not expected to come back under it. `off` is a
diagnostic/rollback mode that leans on the runtime `degradeToFit` gate, not a
supported steady state.
