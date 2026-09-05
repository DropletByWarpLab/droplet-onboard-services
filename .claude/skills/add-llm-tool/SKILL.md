---
name: add-llm-tool
description: |
  Procedure for adding a new LLM-callable tool to the canonical
  @droplet/tools-core registry. Use when adding, registering, or wiring
  a new agent tool, when a tool ships but the model never calls it, or
  when wondering where tool handlers live and how the catalog, route
  manifest, chat scope, RBAC and prompt budget pick it up.
---

# Adding a new LLM tool

Registering a tool is not one edit. It is **ten sites across two workspaces**,
each guarded by a drift gate that goes red if you skip it. This file used to
list four; the missing two (`catalog.ts` and `INVENTORY.md`) cost WARP-2466 a
red suite it had no explanation for.

**When a gate goes red because you skipped a site, fix the site — never the
gate.** Every one of these gates exists because a tool once shipped dead,
uncopy-written, unbudgeted or unreachable. `add-llm-tool-skill.test.ts` in
`packages/tools-core` derives the table below from the gates themselves, so
this list cannot silently fall behind again.

## Step 0 — measure the prompt budget BEFORE you write anything

There is no spare room. This is not a caution, it is a measurement.

Run it yourself, do not take the number on faith:

```bash
cd apps/orchestrator && npx vitest run src/services/tool-budget.service.test.ts
```

At `b26ded91` that prints (WARP-2466's measurement, re-derived on every run):

```
  context window (OLLAMA_CONTEXT_LENGTH) = 16384 tokens
  output reserve                         =  1024 tokens
  fixed system blocks                    = 11800 chars (2950 tokens)
  => tools[] ceiling                     = 12410 tokens

  local registry (full)   137 tools   97330 chars   24333 tokens   196% of tools[] ceiling
  mean local tool = 710 chars
```

**The shipping advertisement is at 196 % of the 12,410-token `tools[]`
ceiling.** It only works at all because per-turn domain selection ships a
subset of the registry, never the whole thing. So the question is never "does
the registry have room" — it does not — it is "what does MY tool add to a turn
that already advertises it".

**Measure the dynamic-half delta first.** Run the canary before your registry
edit, then again after, and compare:

```bash
cd apps/orchestrator && npx vitest run src/services/base-prompt-budget.test.ts
```

Its `[DYNAMIC HALF]` assertion folds runtime-registered remote catalogs into
the worst-case selected turn — the half a static-only reading misses entirely
(WARP-2446). The number that matters is the **delta** on the worst-case domain
your tool lands in, not the absolute. A tool that adds nothing to that domain's
worst case is free; one that becomes the domain's largest schema is not.

Hard limits the same file enforces. **Never raise one to go green** — that
relocates the cliff instead of removing it:

| Limit | Value | Headroom today |
|---|---|---|
| `PER_TOOL_MAX_CHARS` — one serialized tool | 2 000 chars | `set_detection_zones` is already 2 576 and is out of chat scope for it |
| full chat pool | < 60 000 chars | — |
| full registry serialization | < 100 000 chars | 97 330 today — under four average tools left |

If your schema is too big, **cut prose or cut properties**. Do **not** add
`maxLength` / `pattern` / `enum` to shrink it: that is what blew llama.cpp's
GBNF grammar and took tool calling off the appliance entirely (WARP-1839).
The other legitimate answer is to scope the tool out of default chat — see
site 7.

## The sites

<!-- add-llm-tool:sites:begin -->

### Edit these — one new tool touches all of them

| # | File | What you add | What the gate asserts |
|---|---|---|---|
| 1 | `packages/tools-core/src/handlers` | The handler, one tool per file, under its domain sub-directory. | `tool-routes.test.ts` maps every registered tool to **exactly one** handler source file, and throws if a file declares two. |
| 2 | `packages/tools-core/src/registry.ts` | `import` the handler and append it to the `allTools` array, with `requiresWrite` / `requiresConfirmation` set on the `Tool` itself. | `registry.test.ts` asserts `TOOLS` equals `EXPECTED_TOOL_NAMES` exactly (missing **and** extra), that confirm ⇒ write, and that any tool whose name starts with a mutating verb (`set_`, `delete_`, `create_`, `share_`, …) is flagged `requiresWrite`. |
| 3 | `packages/tools-core/src/catalog.ts` | Two entries: the name in a `DOMAIN_GROUPS` group, **and** plain-language home copy in `HOME_DESCRIPTION_BY_NAME`. | A missing domain **throws at module load**, so every suite that imports the package dies. `catalog.test.ts` additionally asserts 1:1 with `TOOLS`, that every tool has explicit home copy (no silent humanized-name fallback, ADR-002), and that the home copy is never the agent-facing `description`. |
| 4 | `packages/tools-core/src/tool-routes.ts` | One `TOOL_ROUTES` row: `client` (`orchestrator`, `nextcloud`, `none`) plus every `admit` hop it calls. A pure-prisma / compute / `ctx.matter` tool is `none` with zero hops. | `tool-routes.test.ts` is the shipped-but-dead gate: bijection with the registry, shape rules (`none` ⇒ 0 hops, non-`none` ⇒ ≥ 1, `/api/` prefixed), and a **bidirectional** drift check that parses your handler source — the manifest cannot claim a route the handler never calls, and the handler cannot call one the manifest omits. Make sure the backing route admits the mcp principal (`requireRoleOrMcpService`). |
| 5 | `packages/tools-core/INVENTORY.md` | A row in the main table (name, domain, description, both flags, source) **and** the running total in the `## Counts` paragraph. | `registry.test.ts` is titled "registers every name in INVENTORY.md" and pins the count via `EXPECTED_TOOL_NAMES` + `TOOL_CATALOG.length === TOOLS.size`. The doc and the list move in lockstep or neither is trustworthy. |
| 6 | `packages/tools-core/__tests__/registry.test.ts` | The name in `EXPECTED_TOOL_NAMES`, in its domain block, with the ticket key in a comment. Add a flag assertion if the tier is interesting. | This file **is** the gate for site 2 — it is a hand-maintained list on purpose, so adding a tool is a decision someone signs rather than a diff nobody reads. |
| 7 | `apps/orchestrator/src/services/chat-tool-scope.ts` | A decision, not necessarily a line: leave the tool out of `EXCLUDED_FROM_CHAT_TOOLS` and it is advertised in default chat and costs budget on every matching turn; add it and only the dashboard and external MCP clients see it. | `chat-tool-scope.test.ts` recomputes the policy/relevance overlap every run: an excluded tool must be unreachable on **any** turn, no domain may be left with a selection rule that advertises nothing (the set is pinned to `["notifications"]`), no fully-excluded domain may keep a rule, and no `CORE_TOOL_NAMES` floor tool may be excluded. |
| 8 | `apps/orchestrator/src/services/tool-result-bounding.ts` | Only if your handler pages: your cursor key in `CURSOR_KEYS`. | `tool-result-bounding.canary.test.ts` greps the whole producer surface for cursor-SHAPED keys and fails on any that is neither in `CURSOR_KEYS` nor on the reviewed not-a-cursor list. A cursor it does not know about is left beside a truncated body — the exact WARP-2203 defect. It also packs every registered name into the WARP-642 recovery envelope, so the registry growing is itself tripwired. |
| 9 | `packages/tools-core/src/index.ts` | Only if you export a new symbol; the handler itself needs nothing here. | Every orchestrator-side gate imports `TOOLS` through this barrel, so an unexported addition is invisible to all of them. |
| 10 | `apps/orchestrator/src/services/tool-selection.service.ts` | **Only if your tool opens a NEW domain**: a `DOMAIN_RULES` entry whose pattern matches how a human would ask for it. Word boundaries (`\b`) are not optional — without them `won` fires inside `wondering`. | `chat-tool-scope.test.ts` fails when a domain has in-scope tools and no rule. **This step used to be documented here as "a ticket, not a quiet edit", and that was too weak: WARP-2546 shipped seven `crm_*` tools with no rule, so they were serialized into the pool, charged against the budget on every turn, and advertised on ZERO turns.** Third instance of the class after WARP-2058 (`pm`) and WARP-2454 (`team_chat`). The rule belongs in the same change as the tools. |

And, always, a **unit test for the handler** beside its peers in
`packages/tools-core/__tests__/handlers` — injected `fetch`, asserting on the
CALLS made and not only the return value. None of the gates below can tell you
your handler is wrong; they only tell you it is wired.

### Gates that must be green before you push

| Gate | Runs where | Catches |
|---|---|---|
| `packages/tools-core/__tests__/registry.test.ts` | `packages/tools-core` | sites 2, 5, 6 |
| `packages/tools-core/__tests__/catalog.test.ts` | `packages/tools-core` | site 3 |
| `packages/tools-core/__tests__/tool-routes.test.ts` | `packages/tools-core` | sites 1, 4 |
| `packages/tools-core/__tests__/confirmation-interceptor-compat.test.ts` | `packages/tools-core` | a `requiresConfirmation` tool is enrolled in the two-phase flow **by flag**, and must challenge exactly once — not zero, not twice |
| `apps/orchestrator/src/services/base-prompt-budget.test.ts` | `apps/orchestrator` | step 0: per-tool ceiling, chat-pool and full-registry growth, worst-case selected turn (static **and** dynamic halves) |
| `apps/orchestrator/src/services/tool-budget.service.test.ts` | `apps/orchestrator` | step 0's measurement, and that the ceiling stays derived rather than hand-picked |
| `apps/orchestrator/src/services/chat-tool-scope.test.ts` | `apps/orchestrator` | site 7 |
| `apps/orchestrator/src/services/tool-selection.regression.test.ts` | `apps/orchestrator` | your tool is actually selectable on a plausible sentence — the failure mode where a tool ships and the model simply never sees it |
| `apps/orchestrator/src/services/tool-result-bounding.canary.test.ts` | `apps/orchestrator` | site 8 |
| `apps/orchestrator/src/__tests__/write-tools-derivation.guard.test.ts` | `apps/orchestrator` | that nobody "helpfully" hand-listed your tool somewhere instead of letting `requiresWrite` derive it |
| `apps/orchestrator/src/__tests__/confirmation-owner-drift.guard.test.ts` | `apps/orchestrator` | that your tool's `confirmationOwner` still matches reality. `"route"` is a claim about a file in a DIFFERENT package, so it rots from either end — a safety tier moves and the descriptor keeps yesterday's answer, or a new pass-through tool ships undeclared and silently inherits `"interceptor"` against a route that already confirms. All three inputs are read at runtime (live registry, compiled call site, `classifyNetworkCommand`), so a name list cannot satisfy it. |
| `apps/orchestrator/src/__tests__/warp-2472-passthrough-single-prompt.test.ts` | `apps/orchestrator` | that one approved action costs the user **one** prompt. Nothing is stubbed between MCP dispatch and the route's confirmation decision, so the double prompt this pins (WARP-2472 — it shipped, and reached chat) cannot come back. It also pins the **count** of `requiresConfirmation` tools, so a new confirming tool is a number someone updates on purpose. |
| `apps/orchestrator/src/services/tool-selection.parity.test.ts` | `apps/orchestrator` | that the budget estimate and the wire payload are the **same set** (WARP-2552), and that every domain with in-scope tools is reachable by some rule. If you add a tool in a NEW domain, this is the gate that tells you the domain has no rule — see site 10. |
| `apps/orchestrator/src/services/cloud-dataset-tool.e2e.test.ts` | `apps/orchestrator` | that the cloud read tool's whole chain still holds — registry entry, RBAC scope, the route's role gate, and the closed dataset set — driven against the live registry and `erp.service`, so a name list cannot satisfy it (WARP-2497). If your tool serves a cloud dataset, this gate exercises it end to end. |

### Read-only — these gates read them; do not edit them to go green

| File | Why it is in your blast radius |
|---|---|
| `apps/orchestrator/src/services/tool-access.service.ts` | `WRITE_TOOLS` is **derived** from `requiresWrite` here (it is no longer in `apps/orchestrator/src/routes/llm.ts`). RBAC picks your tool up with no manual sync — adding a literal list is the thing the guard test exists to reject. |
| `packages/tools-core/src/interceptor.ts` | Enforces `requiresConfirmation` generically at dispatch. Setting the flag is the whole integration; do not hand-roll a prompt. |
| `apps/orchestrator/src/services/tool-selection.service.ts` | `CORE_TOOL_NAMES` (the always-advertised floor). Read-only for a tool in an EXISTING domain — but see **site 10** if your tool opens a new one. |
| `apps/orchestrator/src/services/tool-budget.service.ts` | The measurement machinery from step 0. Over-budget throws by design; there is no truncate path and adding one re-creates the silent capability loss WARP-2348 removed. |
| `apps/orchestrator/src/services/prompt-budget.consts.ts` | The fixed-block char caps the ceiling is derived from. |
| `apps/orchestrator/src/services/context-budget.service.ts` | `DEFAULT_CONTEXT_WINDOW` and the chars→tokens estimator. |
| `apps/orchestrator/src/services/identity-prompt.ts` | `IDENTITY_MAX_CHARS`, the largest fixed block. |
| `apps/orchestrator/src/config/network-safety-rules.ts` | The safety tiers the ownership gate classifies against, reached through `classifyNetworkCommand` — the same function the routes call. Restating a tier in your tool instead of consulting it is exactly what that gate rejects. |
| `apps/orchestrator/src/routes/network-firewall.routes.ts` | This route confirms Tier 2/3 operations itself. If your tool calls it, the ROUTE owns the prompt: declare `confirmationOwner: "route"` rather than letting the interceptor add a second one. |
| `apps/orchestrator/src/routes/network-phone-home.routes.ts` | Same ownership as the firewall routes — the confirmation lives here, so a pass-through tool must not re-ask. |
| `apps/orchestrator/src/services/erp.service.ts` | `CLOUD_DATASET_READ_ROLES` and the dataset dispatch the cloud e2e gate drives. The service re-checks the role after MCP admission by design — do not "simplify" the double check away to make a tool test pass. |
| `apps/orchestrator/src/__tests__/helpers/test-paths.ts` | Test-only path resolution. `apps/orchestrator/src/services/tool-selection.parity.test.ts` reads the route and the agent loop as SOURCE, and resolves both through this helper (WARP-2654) rather than from the runner's cwd — resolved from cwd it threw at import from the repo root and the gate reported "no tests", so all 23 of its assertions ran zero times. Nothing about a new tool goes in here; it is listed because the gate reads it. |

<!-- add-llm-tool:sites:end -->

## How a gate declares itself (WARP-2612)

The table above is not hand-written. `add-llm-tool-skill.test.ts` derives it by
finding the gates and collecting the repo files each one reads — so a gate has
to be findable. **A gate declares itself with a one-line pragma near the top of
the file:**

```ts
// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.
```

Every file that test imports is then demanded of the site block above. So put
the pragma on a test only if an agent adding a tool would have to edit what it
reads.

**If your test reads `TOOLS` for some other reason, take the opt-out:**

```ts
// add-llm-tool:not-a-gate — reads the registry for <reason>, not to gate
// adding a tool; its imports are not add-a-tool sites.
```

Neither pragma? Then a test that imports `TOOLS` **and** reads the whole thing
(`TOOLS.keys()` / `.values()` / `.size`) fails `add-llm-tool-skill.test.ts` with
a message naming which of the two it takes the file for and why. A test that
only looks a name up (`TOOLS.has("list_files")`) is left alone and needs
nothing. The classification is made from the PARSED CODE, so prose, a test
name, or an assertion message quoting `TOOLS.values()` never counts — do not
contort a test to dodge this file.

That contortion is the WARP-2612 finding: the first shape of this gate
classified any test that enumerated `TOOLS`, so PR #1944's outbound-MCP test
was told to add `mcp-multiplexer.service.ts`, `remote-mcp-servers.ts` and
`runtime-tool-registry.service.ts` to the table above — files a tool author
must never touch (runtime tools live outside `TOOLS`, ADR-043).

## What still happens automatically

- The MCP server picks the tool up from `TOOLS` with no registration of its own.
- RBAC write-intent tracking follows `requiresWrite` (see the read-only table).
- Confirmation follows `requiresConfirmation` through the generic interceptor.

## Running the gates

```bash
cd packages/tools-core && npx vitest run                 # sites 1-6, 9
cd apps/orchestrator  && npx vitest run src/services src/__tests__
cd packages/tools-core && npx tsc                        # vitest does NOT typecheck
```

`vitest` strips types with esbuild, so a green suite says nothing about `tsc`.
Finish with `./scripts/test/ship-check.sh tsc-full`.
