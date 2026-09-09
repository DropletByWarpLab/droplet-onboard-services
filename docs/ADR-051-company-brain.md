# ADR-051: The company brain is a table the box writes offline, not a prompt it reads at question time

- **Status:** Accepted for §1–§11. Every section describes code on `stage` **except** the fourth row of §6's detector slate, which is in review as [#2092](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/2092) and is marked as such in place. §9.9's consent posture is built as of WARP-2838 — the switch, the consent row and the owner-facing control; the remaining half is **scope** (company/department corpus), which is WARP-2753. §11 is the operational contract as shipped.
- **Epic:** [WARP-2745](https://warp-lab.atlassian.net/browse/WARP-2745) · slices [WARP-2748](https://warp-lab.atlassian.net/browse/WARP-2748) (tables), [WARP-2749](https://warp-lab.atlassian.net/browse/WARP-2749) (passes), [WARP-2751](https://warp-lab.atlassian.net/browse/WARP-2751) (money time axis), [WARP-2752](https://warp-lab.atlassian.net/browse/WARP-2752) (`/brief` + delivery), [WARP-2754](https://warp-lab.atlassian.net/browse/WARP-2754) (detectors), [WARP-2825](https://warp-lab.atlassian.net/browse/WARP-2825) (the first history detector), [WARP-2838](https://warp-lab.atlassian.net/browse/WARP-2838) (the on switch)
- **Builds on:** [`ADR-044`](ADR-044-business-ecosystem-customer-spine.md) (the customer spine findings hang off), [`ADR-049`](ADR-049-revenue-cycle-documents.md) (`ErpDocument`, the ledger the money detectors read), WARP-1264 (department corpora), WARP-2177 (the one sanctioned cron runtime)
- **Number:** claimed here, in `docs/`. The design brief that preceded this work called itself "provisional ADR-049" and that number was taken by [`ADR-049`](ADR-049-revenue-cycle-documents.md) before the brief was filed. A provisional number in a brief reserves nothing.

> **Why this document is late.** **Forty-one** files across the orchestrator, the dashboard, the migrations and the test suites cite `ADR-051`, five of them by section number, and until now no such file existed. This ADR is written **against those citations**: every section below is the decision the code already assumes was made. Where two areas of the codebase assumed *different* things, this document picks one and says which code is now wrong — see the Consequences, which cash **one** such correction and record a second candidate that turned out to be this document's own error rather than the code's.

## Context

### A question cannot scan the company

The numbers that decide this design are properties of the shipped box, not estimates:

| | value | where |
|---|---|---|
| model context window | **16,384** tokens | `config.ts:187` (`OLLAMA_CONTEXT_LENGTH`) |
| per-tool-result cap | **8,000 chars**, `.max(8000)` — an operator **cannot raise it** | `config.ts:243` |
| agent iterations, per turn | 10 | `config.ts` (`AGENT_MAX_ITER_DEFAULT` / `_CAP`) |

Ten tool results at 8,000 characters is **80,000 characters — roughly 78 KB** — and that is the ceiling *before* anything else competes for the window. What actually survives is smaller: `brain-corpus.service.ts:5-10` measures **40–45 KB** of readable text per turn, net of ~2,950 characters of system blocks and ~3,426 of tool schemas against a 13,824-token force-finalize. A small company's document corpus is five orders of magnitude larger than either figure.

So "the assistant reads the company and answers" is not a feature that needs tuning. It is **arithmetically impossible**, and no amount of prompt engineering, retrieval tuning or model upgrade changes the shape of it.

The box already had one answer to "what is this business", and it is not self-knowledge: `BusinessProfile` is **1,500 characters a human typed once** during onboarding and nothing has refreshed since. It cannot notice anything.

### The consequence

If the reading cannot happen at question time, it has to happen **before** the question. That is the whole decision, and everything below is its shape.

## Decision

### 1. A derived corpus in tables, written offline and read cheaply

The intelligence moves **off the query path**. A scheduled pass reads a little at a time and writes rows; a question reads rows.

This inverts the cost. Scanning is incremental, bounded, and happens when nothing is waiting on it. Reading is a `SELECT` that is always in budget, however large the business gets.

The rows are **workspace-wide and carry no `workspaceId`**. `Workspace` is a singleton (`id = 1`), and these tables follow the `MemoryFact` precedent. Visibility is `scope` plus the reader's role (§9), not a tenancy key — inventing a second, unenforced tenancy column would be a filter every future query has to remember and no constraint would ever check.

### 2. The data model

Four tables:

- **`BrainDigest`** — a *claim*. What the box worked out by reading something.
- **`BrainFinding`** — a claim **with a consequence and a status a human moves**. Separate from `BrainDigest` because their lifecycles differ: a digest is superseded by a better one, a finding is acknowledged, actioned or dismissed *by a person*, and one table with a nullable status column would make every read ask which kind of row it was holding.
- **`BrainPass`** — one row per pass. **The row *is* the cursor**; there is no separate progress table.
- **`MoneySnapshot`** — the time axis money never had (§10).

Subject pointers (`subjectType` / `subjectId`) are **loose, with no foreign key** — the posture `EntityLink` takes toward `File`. A subject pointer may dangle and the UI shows that. There is deliberately **no `subjectState` column**: a liveness field nothing maintains is a column that always lies.

### 3. Provenance and honesty

**A row nobody can trace to a source is a hallucination that has been given a row id** — strictly worse than no row, because it reads as fact, survives restarts, and gets spliced into later prompts.

So provenance is enforced **by a database CHECK, in the migration, not in the service**:

- `BrainDigest.sources` — a non-empty JSON **array** of `{sourceKind, sourceId, quote}`.
- `BrainFinding.evidence` — a non-empty JSON **object** `{digestIds, sources}` whose `sources` array is itself non-empty.
- Both check `jsonb_typeof`, because `'[]'::jsonb` and `'{}'::jsonb` are both valid JSON and only one of them is an array.

The constraint *is* the feature: a detector with a bug fails loudly at write time instead of quietly poisoning the corpus.

Two more honesty rules with the same character:

- **`confidence` is an integer 0–100**, never a 0..1 float, matching `EntityLink.confidence` and `CrmPipelineStage.probability`. Two confidence scales in one schema is how a `0.85` gets rendered as "85%" beside an `85` rendered as "8500%".
- **`impactMinor` and `currency` are all-or-nothing, and null is a supported state.** A detector that cannot compute an impact leaves both null and reports the finding without a number. **A fabricated number is worse than no number** — and this rule has already been paid for once: the first money detector converted every currency to hundredths, which is wrong by 100× on a yen ledger.

### 4. Idempotency, accumulation, and the human's decision

Every row keys on one **NOT NULL, derived `dedupeKey`** with a plain unique index.

Not a compound `@@unique` over nullable subject columns — in Postgres, `NULL` is distinct from `NULL`, so such a key constrains nothing exactly when the subject is absent. Not a partial index either: `prisma.upsert` cannot address one, which is a tax `EntityLink` already paid.

The key is **readable rather than hashed** (`':'`-joined, `'-'` for an absent part), so a human debugging a duplicate can see what collided.

Accumulation rules:

- `lastConfirmedAt` advances on every re-confirmation; **`firstSeenAt` never moves**. "We have known this since March" is the interesting half.
- A digest is **superseded, not deleted** — the reason a claim changed stays readable.
- Status is an **explicit enum**, never derived from a null timestamp.
- **A human's dismissal is never resurrected.** A machine-set `stale` *is* revived when the condition recurs, with `notifiedAt` cleared so it can be announced again.
- **A dismissal requires a reason**, enforced both by CHECK and by the API (`dismissal_needs_reason`). Without it, a dismissal is indistinguishable from a detector bug, and the reason is the only thing that lets the next pass tell "a human decided this is fine" from "nobody has looked".

### 5. The passes: two producers, one clock

Two passes, deliberately unlike each other:

| | detector pass | corpus pass |
|---|---|---|
| model call | **none** | one document at a time |
| cursor | none — stateless | `updatedAt\|userId\|path` |
| default tick | 1 h (`BRAIN_DETECTOR_TICK_MS`) | 1 h (`BRAIN_CORPUS_TICK_MS`) |
| bound | ordered indexed `take`, 500 | 10 units (`BRAIN_CORPUS_UNITS_PER_RUN`) |

**Both run on the one sanctioned `cronRuntime`**, each with its own advisory lock key. No second scheduler, and a guard test pins that.

🔴 **The cadence is HOURLY, and the word "nightly" in several docstrings is legacy.** Both are ticks, not night jobs. Hourly is safe for three separate reasons that need to be read together: the detector pass makes **no model call**, so it never contends for the box's single inference slot; every detector query is bounded by an ordered indexed `take`; and `notifiedAt` plus the batching policy (§8) **decouple delivery from cadence entirely**, so an hourly pass still produces a weekly digest. Only the `MoneySnapshot` maintenance leg is genuinely nightly (`45 3 * * *`).

The corpus cursor **advances in the same transaction as the rows it produced**, so a crash cannot skip a document it never digested. A per-unit failure **advances past the unit and ends the tick**: one poison document must not stop the brain forever, and re-trying it every hour is how a feature becomes a log full of the same error.

**Coverage counters are on the surface on purpose** (§7). Partial runs never advance `lastSucceededAt`; `lastError` clears on success. Pass rows are seeded at boot, never from `prisma/seed.ts`, and **seeding never re-enables a pass an operator disabled**.

### 6. Detectors: what earns a place

A detector is a **deterministic query over rows the box already holds**. It makes no model call, and that is a decision rather than an economy: "is this invoice 90 days overdue" is arithmetic, and asking a 20B model to do arithmetic over rows you already have is slower, costlier and less reliable than asking Postgres. The model's job in this feature is understanding **unstructured text** (the corpus pass), not counting.

Detectors are **stateless**. Each returns everything currently true; the runner diffs against the open findings and marks the disappeared ones `stale`. No detector remembers last night. The staleness sweep touches only `new` and `acknowledged` — it must never overwrite a human's `actioned` or `dismissed`.

**The admission bar is high, and the reason is the failure mode.** It is not "no findings". It is *three hundred findings, mostly from one detector*, after which the operator mutes `/brief` and the whole feature is dead. A detector earns its place by being right about something a human would have wanted to know.

The current slate — ⏳ marks a detector that is **in review, not yet on `stage`**:

| key | kind | reads |
|---|---|---|
| `money.overdue-receivable` | `loss` | `ErpDocument` at rest |
| `money.overdue-payable` | `risk` | `ErpDocument` at rest |
| `crm.deal-slipping` | `risk` | `CrmDeal` expected close dates |
| `money.receivables-ageing` ⏳ | `risk` | **`MoneySnapshot` — the first to read history** (WARP-2825) |

`DETECTORS` on `stage` registers the first three. The fourth lands with [#2092](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/2092); until it merges, a `git grep money.receivables-ageing` finds this table and no implementation, which is why the row is marked rather than simply listed.

All money detectors sweep `origin: "LANDED"` only. A `LOCAL` document is one somebody on this box wrote, is born `DRAFT`, and must never be reported to its own author as an unchased debt.

### 7. Surfaces: where the brain is read

Three, and no more:

**`/brief`** — the operator surface. **The coverage line comes first, before any finding**, because an operator who assumes the brain has read everything stops trusting it the moment it misses something. Open findings follow, biggest money first, and **every finding shows its evidence**. Two distinct empty states: "nothing needs your attention" on a *running* brain is good news; on a brain that has never run it is a setup step, and conflating them tells an owner they are clear when nothing has looked.

**`/api/brain/*`** — four endpoints (`findings`, `digests`, `coverage`, and the `PATCH` lifecycle route). Minor units cross the wire as **strings**, because `BigInt` does not survive JSON and Express throws on it — a finding with money would otherwise 500 the whole list, and only on boxes that actually have money in them. Stable error codes map to HTTP status here rather than falling through to the error handler.

**`business_find` with `entity: finding | digest`** — two more enum values, **not two more tools**. The chat tool pool is a scarce, measured resource; a verb-shaped tool that already exists is the cheap place to add a noun.

Plus the **brain block**: a bounded splice of the standing understanding into the system prompt on every chat turn. It is built from open findings and non-superseded digests, ranked **last** of the three droppable blocks, spliced *after* degradation, skipped when the turn sets `tool_choice: "none"`, and **required to declare itself a partial summary** that points at `business_find` for the full list. A block that presented itself as complete would be a confident, wrong answer every time the corpus outgrew it.

### 8. Delivery: how a finding reaches a human, and how often it does not

**A muted brain is a deleted brain**, so the delivery policy matters more to whether this feature survives than the detectors do.

Three tiers:

- **IMMEDIATE** — a `loss` whose impact clears `DEFAULT_MIN_IMPACT_MINOR` (1,000.00). **Once ever**: `notifiedAt` is stamped, so a condition that persists for a month is announced one time.
- **BATCHED** — everything else, as one digest no more often than `DEFAULT_DIGEST_INTERVAL_MS` (7 days), rate-limited on **its own clock** via a `SystemFlag` and therefore independent of pass cadence. Twenty findings in a week produce one notification.
- **NEVER** — a finding with no impact and no severity is not worth a phone buzz. It waits on `/brief` for someone to come looking.

**Told to the owner**, a singleton role — not broadcast to every admin, which would turn one finding into N notifications and re-create the noise problem from the other direction.

`notifiedAt` is stamped **per send, immediately after its own send**, never in a batch after the loop: a batch stamp would re-announce everything if the process died midway. Findings a digest **declined** to send are left unstamped, or holding them would silently swallow them forever. No owner means a total no-op with the queue intact.

Delivery runs **inside the detector pass's own lock**, so two instances cannot double-announce the window between one stamping `notifiedAt` and the other reading it.

The brain adds **no notification channel of its own**: `sendNotification` carries it. That path is keyed on **`User.username`** end to end — the broker topic, the ws-bridge subscription and both `NotificationLog` readers — and a caller passing `User.id` reaches nobody at all (WARP-2813).

### 9. Visibility, scope and consent

> **The pinned section.** Cited by `config.ts:263`, `routes/brain.ts:12`, `brain-notify.service.ts:23`, `brief.test.ts:11` and `nav-config.ts:298`.

**9.1 — Scope is *derived-from*, not *shown-to*.** Every brain row carries a `scope` recording the corpus it was derived **from**, and that bounds the widest audience it may be shown **to**. The corpus that produced a row is the only thing that knows how wide it was, so this column — not a route, not a role list — is the enforcement point.

**9.2 — The three scopes and their audiences.**

| scope | derived from | readable by |
|---|---|---|
| `personal` | one user's own space | that user alone |
| `department` | a groupfolder | members of **that** department |
| `company` | the whole-business corpus | **owner and admin only** |

A `personal` row **must** name its owner (`ownerId`, the local `User.id` UUID — never a Nextcloud username), and a `department` row **must** name its department; both by CHECK. An enum value nothing can enforce is the same defect as a column nothing maintains.

**9.3 — Two gates, doing two different jobs.** These are not redundancy, and conflating them is what made one comment in the codebase wrong.

- **(a) The CAPABILITY gate.** The brain's own HTTP surface (`/api/brain/*`, including the `PATCH`) and the `/brief` nav entry are **owner/admin**. A `family` or `guest` arriving **as themselves over HTTP** is refused with a **403** and the nav does not advertise the door. Refusing a capability leaks nothing, because the capability's *existence* is not the secret. 🔴 **This gate does not fire on the tool path.** `requireRoleOrMcpService` (`middleware/auth.ts:864-870`) short-circuits `next()` for `_service:mcp` **before any role check**, so a `family` or `guest` reaching these routes through `business_find` is *admitted*, and (b) is the only thing that withholds company rows from them.
- **(b) The ROW rule.** Wherever a non-owner/admin can legitimately reach brain rows, visibility is a **filter composed into the query** — `visibleScopeFilter`, resolving readable departments through the existing `readableDepartmentIdsFor`, admitting `company` only for owner/admin, and qualifying the `personal` arm by the caller's **own** id. Rows are **omitted, never refused**, and any reported total is the **post-filter** count: a total that counted hidden rows would leak exactly the existence the filter exists to hide.

The `_service:mcp` principal may reach these routes on behalf of a chat user. **The middleware admits the principal; it does not turn it into a person** — the route resolves `X-Nextcloud-User` to a `User` row and scopes on *that* human's id and role, failing closed with a 403 when no human can be established (WARP-2810). Before that resolution existed, the filter received the literal string `_service:mcp`, whose role is not privileged and whose id matches no row, so every brain read through `business_find` returned an empty list on every box — a silence indistinguishable from good news.

**9.4 — Tier (b) does real work in two places,** and both have the same caller set — `family`, `guest` and service principals: the brain block spliced into `/llm/chat`, and `/api/brain/*` reached via the `_service:mcp` principal, which §9.3(a) admits without a role check. Scoping the block is therefore load-bearing, not defence in depth. The first draft OR'd in a bare `{ scope: "personal" }` when neither table had an owner column, which meant *every personal row on the box* for every reader — a guest received other people's document digests in their system prompt every turn. That is why `ownerId` exists and why the filter reads it back.

**9.5 — The filter lives in the service, next to the data**, never in route middleware. A future route can forget middleware; it cannot forget a filter that is part of the query. Role resolution is **fail-restrictive**: `family`, `guest` and any unrecognised role never receive the company arm, and an empty department set emits **no department arm at all** rather than `in: []`, which invites a later refactor to read "no departments" as "all departments".

**9.6 — Fail closed.** If a caller's scope cannot be resolved, the brain block is empty and no read is issued. An enhancement that fails *open* here shows a family member company-wide findings.

**9.7 — Visibility is re-checked on the write path.** A caller who cannot **read** a finding must not be able to acknowledge, action, dismiss or assign it by guessing its id. A list filter is not an authorization check for a mutation.

**9.8 — Access keys cascade; provenance does not.** `ownerId` and `departmentId` are **access-control** keys and are `onDelete: Cascade`, because a row naming a deleted owner or department falls through the membership test that gates it, and an access key that dangles is a leak. `assigneeId` is **provenance** and `SetNull`s: removing a person must not delete the business's findings.

**9.9 — Consent: the brain is opted into, not upgraded into.** Because the corpus pass reads a person's documents *through the model* and writes rows derived from them, this is a capability an operator switches on — **not one that appears on upgrade**.

**WARP-2838 gave that switch a mechanism.** As first shipped it had none: `BRAIN_ENABLED` was read in one place, written nowhere, and present in no deployment file, while `/brief` told every owner to "turn the brain on to start reading your business". A call to action with no control behind it reads as a broken feature, and it kept the whole of this ADR off every box. The identical shape had already been found and fixed for auto-filing (WARP-2733), by giving the off state its own door.

**The decision now lives in a row.** `BrainSetting` is a singleton carrying `enabled` plus the actor pair `enabledById`/`enabledAt`, under a **biconditional** CHECK — an enabled row names who consented and when, a disabled row carries neither. That is the `AutoFilingSetting_enabled_has_actor` shape, and it exists because the alternative was found the hard way there: writing the off state while leaving the pair populated fails the CHECK, rolls back, and leaves a row still saying on, so the off switch does not turn it off. The row is **never created by a read** — a consent record that exists because something looked at it is not consent.

**Two sources, one resolution.** `brain-switch.service.ts` is the only place the environment and the row are reconciled, and every caller goes through it:

| `BRAIN_ENABLED` | who decides | what the owner sees |
|---|---|---|
| set (non-empty) | the environment, in **both** directions | the state, and a line saying the box is pinned |
| unset or empty | the `BrainSetting` row | the switch, with the consent language beside it |

A **pinned box refuses the write** (`PUT /api/brain/settings` → 409) rather than accepting it and not reading it — storing `enabled: true` under a pin would leave a consent record claiming an owner switched on a brain that cannot run, and the next reader would believe it. An **empty** value counts as unset: `${BRAIN_ENABLED:-}` from a compose file is a defined-but-empty string, and reading that as a pin would disable the owner's switch with nothing on screen able to explain why.

`BRAIN_ENABLED` is parsed by an explicit string→bool transform accepting only `"1"` / `"true"`: `z.coerce.boolean()` runs `Boolean(...)`, so an operator writing `BRAIN_ENABLED=false` to opt **out** would have switched it **on**.

**The passes are now scheduled whenever the brain *could* be on, and each tick asks whether it *is*.** Gating registration on the boot-time value made the switch a lie — flipping it changed a row nothing would read until the next restart. A box pinned **off** registers nothing at all: the pin is policy, not a per-tick early return, and a forbidden feature should not be touching the database hourly to re-discover that it is forbidden.

**Where the control lives, and why `/brief` is not capability-gated.** The switch is on `/brief` itself, not in Settings: the person who reads "the brain is off" is the person who has to be able to act on it, which is the whole of WARP-2733's lesson. That settles the open question of whether `/brief` should hide until the brain is on, the way `/messages` hides behind `team_chat` — **it stays visible**. Gating the nav entry on the brain being on would make the only on-switch reachable only once it no longer needed pressing.

**The consent language is the deliverable, not the button.** It is stated at the moment of the click and is deliberately unflattering: the pass reads *with whichever model the box is set to use, and if that is a cloud model the text is sent to that provider*; it is *slow on purpose* (~240 documents/day against one inference slot); and turning it off *stops the passes without deleting what has already been written*. The first of those three is the one that must never be softened into "it stays on the box" — the corpus pass resolves `DEFAULT_MODEL ?? LLM_MODEL` through the AI gateway, which routes cloud model names to cloud providers.

The **read** surface is deliberately *not* gated. A disabled brain is a readable-but-empty brain that explains itself through `/coverage`, not an absent surface — and `/coverage` reports `enabled` for exactly that reason, so `/brief` can tell "quiet" from "never ran" (WARP-2812).

**Turning the brain off hides nothing it already wrote.** `GET /api/brain/findings` is role-gated, never brain-gated — `listFindings` filters by scope, status and kind and does not ask whether the brain is enabled — so the rows survive the switch, and `/brief` renders them whatever the switch says. Hiding them would break, in the same screenful, the consent sentence that promises "what it has already written stays until you delete it": an owner would watch their findings vanish on the click and conclude the box had deleted them. The off state changes the sentence above the list, not the list.

**And "the box did not answer" is a third state, not a synonym for off.** `/coverage` failing — a one-off 500, an expired session, a momentarily unreachable orchestrator — is not evidence of anything about the brain. The dashboard carries reachability alongside the body (`CoverageResult`) rather than inferring it from a null, because collapsing the two let a transient fetch failure render the one message that names `BRAIN_ENABLED` and sends the owner to their administrator over a pin nobody had set. Only a box that **answered** `canToggle: false` may be described as pinned.

The consent statement covers the **corpus pass** specifically. The deterministic detector pass and the `MoneySnapshot` capture read the business's own ERP and CRM rows, which the product already treats as household-shared, and the snapshot capture today runs on the ERP legs outside this switch. **WARP-2753 owns the operator-facing consent posture.** Until it lands, corpus digests are written at `personal` scope, and a file whose owner cannot be resolved is **skipped rather than written unscoped** — an unattributable digest is precisely the row that would leak.

### 10. Money: two representations, one rule

The rule is **never mix them**, and the two representations exist for different reasons:

- **Computed values** — `BrainFinding.impactMinor` — are **minor units plus currency**, all-or-nothing, crossing the wire as a string.
- **Copied ledger values** — `MoneySnapshot.amount` / `balance` — are **`Decimal(20,6)` major units**, mirroring `ErpDocument` exactly, because a ledger's exponent is unknowable when its currency is null and guessing 2 is wrong by 100× on a yen ledger.

`MoneySnapshot` is **the time axis money never had**. `ErpDocument` holds one row per document carrying only its latest state, because `land-money.ts` overwrites `amount` / `balance` / `vendorStatus` in place on every sync tick — **yesterday is destroyed 96 times a day**. Ageing, "our overdue balance has doubled since June", "which customers slowed down" are all structurally unanswerable against that, however good the model is.

Its design in four rules:

- **Grain is one DAY** (`@db.Date`, not a timestamp), and the unique key `(capturedOn, subjectType, subjectId)` **is** the design: a document synced twelve times in one day produces **one** row, converging on the day's closing value.
- **A snapshot, not an audit log.** An audit log answers "what changed"; this answers "what was it worth on this date", which is the shape every trend question has and the shape a `GROUP BY capturedOn` serves cheaply.
- **No foreign key to `ErpDocument`.** A snapshot must survive the document it describes, or the series ends the moment a vendor deletes an invoice — which is exactly the history worth keeping.
- **Retention thins, it does not truncate.** Daily rows inside `DROPLET_MONEY_SNAPSHOT_DAILY_DAYS` (90); beyond it, each subject-month keeps that month's **last** row. Keeping the *first* would shift every historical series by up to a month, which is the kind of wrong that looks right.

### 11. Operational contract

- **Env surface:** `BRAIN_ENABLED` (off), `BRAIN_DETECTOR_TICK_MS` (1 h), `BRAIN_CORPUS_TICK_MS` (1 h), `BRAIN_CORPUS_UNITS_PER_RUN` (10), `DROPLET_MONEY_SNAPSHOT_DAILY_DAYS` (90). The first four are documented in `.env.example`; **`DROPLET_MONEY_SNAPSHOT_DAILY_DAYS` is not** — it exists only at `config.ts:838`, and adding it is outstanding. The principle stands and indicts the gap: a flag an owner is told to turn on and cannot discover the name of is not a switch.
- **`BrainPass.enabled`** is a second, per-pass axis under the master switch — the "one noisy producer off without touching the others" control the detector contract promises.
- **No dedicated brain model.** `DEFAULT_MODEL` then `LLM_MODEL`, through `ai-gateway`; with neither set the corpus pass is **skipped**, rather than scheduled to fail hourly and fill `lastError` with noise.
- **Migration hygiene:** a pushed migration is immutable; DDL is copied verbatim from `prisma migrate diff`.
- **Test policy, two lanes.** Anything a mocked Prisma cannot prove needs a `*.pg.test.ts`: whether the SQL parses, whether parameters have inferable types, whether `ON CONFLICT` names the right index, whether a join counts what it claims. This is not theoretical — a money detector shipped a query naming a **retired enum value** and stayed green, because its unit test handed it a `findMany` mock that ignores `where`. Fixtures are prefix-scoped; never a `TRUNCATE`, never an unscoped `deleteMany`.

## What this ADR does NOT decide

- **Retention and deletion for `BrainDigest` / `BrainFinding`.** `MoneySnapshot` has a retention policy; the brain tables do not. Nothing currently deletes a finding, ever.
- **Whether the delivery thresholds are operator-tunable.** `brain-notify.service.ts` names `BRAIN_NOTIFY_MIN_IMPACT_MINOR` and `BRAIN_DIGEST_INTERVAL_MS` in its docstring as the operator's volume controls, and **neither exists as an env var**. An operator drowning in buzzes has no knob.
- **Whether corpus digests ever widen to `company` scope**, and what happens to rows already written at `personal` if they do. Blocked on WARP-2753 and WARP-2026.
- **Whether a non-owner ever gets an HTTP read of their own `personal` rows.** Today a family member's digests, derived from their own documents, reach them **only** as brain-block prompt text — the capability gate refuses them at `/api/brain/digests`. That is a consequence of §9.3(a), not a decision anyone made deliberately, and it is worth revisiting.
- **A per-unit retry budget** for a document that fails every pass. Today it is skipped once and never retried.
- **What a disabled pass does to its outstanding findings.** They neither refresh nor stale.
- **`MoneySnapshot`'s remaining subject vocabulary** (`crm_deal`, `pipeline`) and whether its capture belongs inside the consent gate.
- **Payments.** There is no `ErpPayment` model, no allocation, nothing that records money *arriving*. Without it, true DSO is not computable and unprofitability is undetectable by construction — every number in the schema is a price the business charged or owes, and nothing records what anything **cost**.

## Alternatives considered and rejected

| alternative | why not |
|---|---|
| **A bigger prompt / just retrieve harder** | The window is 16,384 and the per-result cap is `.max(8000)`. The gap to a company corpus is five orders of magnitude — not a tuning problem. |
| **A `workspaceId` column** | `Workspace` is a singleton. A second, unenforced tenancy key is a filter every future query must remember and no constraint ever checks. |
| **An FK on the subject pointer** | A digest must survive the thing it describes. |
| **A `subjectState` column** | A liveness field nothing maintains is a column that always lies. |
| **A compound `@@unique` over nullable subject columns** | In Postgres `NULL` is distinct from `NULL`, so it constrains nothing exactly when the subject is absent. |
| **A partial unique index** | `prisma.upsert` cannot address one — the `EntityLink` tax. |
| **A 0..1 confidence float** | Two scales in one schema is how `0.85` renders beside `85`. |
| **Provenance enforced in the service only** | A detector bug then poisons the corpus quietly instead of failing at write time. |
| **One table for digests and findings** | Their lifecycles differ; every read would have to ask which kind it was holding. |
| **State derived from a null timestamp** | The repo's standing rule: an explicit enum, not `IS NULL`. |
| **Modelling a pass as an `AgentRun`** | A pass is a cursor, not a run with a transcript. |
| **A second scheduler** | One `cronRuntime`, own lock keys — pinned by a guard test. |
| **Batching the cursor advance** | A crash would skip documents that were never digested. |
| **Stopping the tick on a poison document** | One bad file must not stop the brain forever. |
| **Notifying on every finding** | The same overdue invoice every hour; muted inside a week. |
| **Broadcasting to every admin** | One finding becomes N notifications — the noise problem from the other side. |
| **Minor units for `MoneySnapshot`** | The exponent is unknowable when the currency is null. |
| **`ON CONFLICT DO NOTHING` for the snapshot** | The row must converge on the day's **last-seen** value. |
| **Keeping each month's FIRST row on downsample** | Shifts every historical series by up to a month. |
| **`z.coerce.boolean()` for `BRAIN_ENABLED`** | `Boolean("false")` is `true` — an operator opting out would have opted in. |

## Consequences

**Good.** The expensive part is bounded and off the query path. Every claim is traceable to a quote by database constraint. The privacy line is one column and one filter, next to the data. Coverage is a first-class response, so the operator is never invited to believe the brain read everything.

**Costly.** Findings are only as good as the detector slate, which is deliberately short. The corpus pass digests ~10 documents an hour by design, so a 5,000-document business is weeks from first-pass coverage — which is exactly why `/brief` leads with the coverage line.

🔴 **One correction this ADR forces on existing code:**

1. Several docstrings call the detector pass **"nightly"**. Per §5 it is **hourly** and operator-tunable. The word should go, because it makes the delivery policy in §8 look like over-engineering when it is the thing that makes an hourly pass survivable.

⚠️ **A second correction was drafted here and is withdrawn, because the code was right and this document was wrong.** An earlier revision instructed that `packages/tools-core/src/handlers/business/find.ts` be corrected: it says a company-scope row "never reaches a family or guest caller even though the model asked on their behalf" and attributes that to `visibleScopeFilter`, and the draft claimed the **capability gate** was the real protection.

It is not. `requireRoleOrMcpService` short-circuits for `_service:mcp` before any role check, `resolveCaller` then resolves the acting human from `X-Nextcloud-User`, and `listFindings` **filters** on that human's id and role. The only 403 on that path is `noActor`, when no human resolves at all. So on the tool path `visibleScopeFilter` is precisely and solely what withholds those rows, and `find.ts` is accurate as written — as is `brain-block.service.ts`, which says the same thing. Applying the withdrawn correction would have put two files into disagreement and taught the next reader to trust a gate that does not fire.

This is recorded rather than deleted because §9.5's argument — *"a future route can forget middleware; it cannot forget a filter"* — is exactly what the mistake ran against, and the near-miss is the best evidence for it.
