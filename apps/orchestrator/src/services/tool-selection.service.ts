/**
 * 2026-07-21 agent-budgets spec §3 — relevance-based tool selection.
 * WARP-2443 / WARP-2444 — extended to a DYNAMIC tool universe.
 *
 * The owner-role chat loop once advertised every in-scope tool schema on
 * every turn, which both starves history/memory of context and measurably
 * degrades tool CHOICE on small local models (the WARP-1334 skips-retrieval
 * class). This service narrows the advertisement per-turn.
 *
 * ── the strategy, stated (WARP-2442) ───────────────────────────────
 *
 * RELEVANCE SIGNAL: case-insensitive keyword rules over the latest user
 * message, mapping to `ToolDomain` groups, unioned with the domains of tools
 * already called in this conversation (continuity).
 *
 * Chosen over the alternatives on latency and determinism, not on accuracy:
 *
 *   • Embedding similarity over tool descriptions — needs an embedding call
 *     on the critical path of every turn. The single-box shares one GPU
 *     between inference and indexing; a second model round-trip per turn is
 *     not affordable.
 *   • An LLM "which tools do I need" pre-pass — doubles time-to-first-token
 *     and, on a 20B local model, is itself the thing that gets tool choice
 *     wrong. Using the failing faculty to fix its own failure.
 *   • Static per-role shelves — cannot respond to the turn at all, which is
 *     the entire problem.
 *
 * Keyword rules are worse at ranking and better at everything else that
 * matters here: zero added latency, deterministic (WARP-2443 requires the
 * same input to yield the same subset), and inspectable — a wrong selection
 * is a regex someone can read, not an embedding nobody can.
 *
 * AMBIGUITY / TIEBREAK: there is no ranking and therefore no tiebreak to get
 * wrong. Every matched domain is admitted WHOLE. A sentence matching three
 * domains advertises all three; a sentence matching none falls back to the
 * floor alone. The bias is deliberate and asymmetric — a false-positive
 * domain costs a few hundred schema tokens, a false NEGATIVE costs a whole
 * iteration to self-heal — so the rules are written generously and the budget
 * gate (tool-budget.service.ts) is what stops generosity becoming overflow.
 *
 * FLOOR: {@link CORE_TOOL_NAMES}, an explicit named set, not an emergent
 * property of the scoring. It is applied by name before any domain logic and
 * cannot be outvoted by relevance.
 *
 * TARGET SUBSET SIZE: derived, not chosen. `toolAdvertisementCeilingTokens()`
 * computes window − OUTPUT_RESERVE − fixed blocks; at the shipping 16384
 * window that is ~12.4K tokens for `tools[]`, and the measured mean tool
 * serialises to ~700 chars (~176 tokens), so a turn's ceiling is roughly 70
 * tools. Floor ∪ one domain sits far under it — the largest single domain
 * plus the floor measures well inside budget (see base-prompt-budget.test.ts,
 * which asserts the real number rather than this prose).
 *
 * Wrong guesses self-heal in the agent loop (a filtered-but-allowed call
 * expands its domain next iteration; see llm-agent.service.ts).
 *
 * ── the dynamic half (WARP-2443) ───────────────────────────────────
 *
 * The taxonomy was `TOOL_CATALOG` and nothing else, which was correct while
 * the tool universe was fixed at build time. It is not correct once a remote
 * MCP server registers tools at runtime (WARP-2300): such a tool has no
 * catalog entry, so `DOMAIN_BY_NAME` misses it, so it is NEVER SELECTED — and
 * it never errors either, so the symptom is an agent that quietly declines to
 * use an integration the operator can see is connected.
 *
 * Selection therefore reads a two-layer universe: the static catalog, plus an
 * optional list of `RuntimeToolDescriptor`s supplied by the caller. The static
 * catalog WINS on a name collision — a remote server must not be able to
 * repoint a local tool's domain by registering the same name.
 *
 * When no runtime tools are supplied (the shipping state until WARP-2300
 * lands) the behaviour is byte-identical to the pre-WARP-2443 implementation.
 *
 * INVARIANT: the result is always a subset of `pool`. RBAC narrowing
 * (narrowAllowedToolsForRole / WRITE_TOOLS) has already been applied to the
 * pool before this runs; this layer must never widen it.
 */
import { TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";
import type { RuntimeToolDescriptor } from "./runtime-tool-registry.service.js";
// WARP-2582 — the pin block's domains. `context-pin-prompt` imports nothing
// but a tools-core type, so this direction cannot cycle.
import { pinnedToolDomainsFromMessages } from "./context-pin-prompt.js";
// WARP-3116 — the tools the navigation rules exist to reach. A leaf module
// (shared-types only), so this direction cannot cycle either.
import { DASHBOARD_NAVIGATION_TOOLS } from "./dashboard-navigation.js";

/**
 * How a turn's advertised tools are derived from its pool.
 *
 *   • `domains` — keyword/continuity selection (the shipping default).
 *   • `off` — the whole pool, no budget assert. The operator's diagnostic and
 *     rollback lever (`TOOL_SELECTION_MODE=off`).
 *   • `explicit` — WARP-3125. The whole pool, because the CALLER already named
 *     it: the voice principal's own `allowed_tools`, after RBAC. Never set by
 *     an operator (config admits only `off`/`domains`); the chat route picks
 *     it per turn through `resolveTurnToolSelectionMode`. Unlike `off`, the
 *     tool budget is still asserted (`selectionAssertsToolBudget`).
 */
export type ToolSelectionMode = "off" | "domains" | "explicit";

/**
 * WARP-3125 — the selection mode for ONE chat turn.
 *
 * The voice principal, when it sends its own `allowed_tools`, has already
 * chosen its tools. Running keyword selection on top of that list changed the
 * advertised `tools[]` with every sentence. llama-server reuses the KV cache
 * only for the prompt prefix that is byte-identical to the previous request,
 * and the tool block sits near the front, so the change cost a re-prefill of
 * everything after it on every voice turn. It also dropped tools the sentence
 * needed ("is everything working?" matched no rule, so `get_system_health`
 * was not advertised), and each miss cost a self-heal iteration out of
 * voice's two.
 *
 * Scoped to the VOICE principal WITH a list, and to nothing else:
 *   • Dashboard callers keep `domains`. Their `allowed_tools` is a request
 *     filtered by role, and the setup wizard's `[]` is zero tools either way.
 *   • The other service tokens (`_service:mcp`, `_service:email`, ...) keep
 *     `domains` too. `/api/llm/chat` admits every one of them, but none has
 *     opted in, and none is sized to a fixed list. Widen this deliberately,
 *     per caller, not by sharing the `service` role.
 *   • The voice principal with no list gets the whole chat scope, which does
 *     not fit the window unselected (WARP-1893), so it keeps `domains`.
 *   • Agent and durable runs never reach this. `agent-run-worker.service.ts`
 *     calls `runAgent` directly with `runToolPool()` and the configured mode,
 *     and relies on selection to fit the budget.
 *   • `off` stays `off`, so the rollback lever keeps meaning "whole pool, no
 *     assert" for every caller.
 */
export function resolveTurnToolSelectionMode(opts: {
  configured: ToolSelectionMode;
  callerSuppliedAllowedTools: boolean;
  voicePrincipal: boolean;
}): ToolSelectionMode {
  if (
    opts.configured === "domains" &&
    opts.callerSuppliedAllowedTools &&
    opts.voicePrincipal
  ) {
    return "explicit";
  }
  return opts.configured;
}

/**
 * Whether the agent loop asserts the assembled advertisement against the
 * tool budget (`assertToolAdvertisementFitsBudget`) for this mode.
 *
 * `off` deliberately does not: it is the lever that advertises the whole chat
 * pool, which has not fitted the window since WARP-1893. `explicit` does,
 * because a caller-named set is expected to fit. If it ever stops fitting,
 * that must fail loudly rather than go on the wire unmeasured.
 */
export function selectionAssertsToolBudget(
  mode: ToolSelectionMode | undefined,
): boolean {
  return mode === "domains" || mode === "explicit";
}

/** Reverse index over the CI-complete catalog: tool name → its domain. */
const DOMAIN_BY_NAME: ReadonlyMap<string, ToolDomain> = new Map(
  TOOL_CATALOG.map((e) => [e.name, e.domain]),
);

/**
 * Resolve a tool name's domain across the two-layer universe.
 *
 * Static catalog first, runtime second. That order is a trust decision, not a
 * performance one: a runtime tool arrives from outside the box, and letting it
 * shadow a registered name would let a remote server move a local tool into a
 * domain the turn happens to match. `runtime-tool-registry.service.ts` has the
 * matching rationale for its own precedence chain.
 */
function resolveDomain(
  name: string,
  runtimeDomains?: ReadonlyMap<string, ToolDomain>,
): ToolDomain | undefined {
  return DOMAIN_BY_NAME.get(name) ?? runtimeDomains?.get(name);
}

/** Index a runtime descriptor list by name. First registration wins, matching
 *  `RuntimeToolRegistry.list()`'s stable server-then-declaration order. */
function indexRuntimeDomains(
  runtimeTools: readonly RuntimeToolDescriptor[] | undefined,
): ReadonlyMap<string, ToolDomain> | undefined {
  if (!runtimeTools?.length) return undefined;
  const m = new Map<string, ToolDomain>();
  for (const t of runtimeTools) if (!m.has(t.name)) m.set(t.name, t.domain);
  return m;
}

/**
 * THE FLOOR (WARP-2442) — always advertised when present in the pool,
 * regardless of what the relevance rules say: retrieval + memory-read.
 *
 * An explicit named set, deliberately not an emergent property of the
 * scoring. These are the tools nearly every knowledge turn needs, and the
 * eval's worst failure class is the model NOT reaching for them — a turn that
 * cannot search or read is broken rather than merely narrow, so no relevance
 * signal is permitted to vote them out.
 *
 * `selectAdvertisedTools` applies this by NAME before any domain logic, which
 * is what makes the guarantee unconditional. The floor is still bounded by
 * `pool`: RBAC has already narrowed the pool, and selection never widens it.
 *
 * Kept small on purpose — the floor is paid on every single turn, so each
 * addition is permanent context cost. `base-prompt-budget.test.ts` measures
 * floor ∪ largest-domain, so growing this set moves that number.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_content",
  "read_file",
  // WARP-2057 — must be core for the same reason `read_file` is, and
  // more urgently: `read_file` REJECTS PDFs and scans outright. Leaving
  // its only PDF-capable sibling behind a domain match is the worst of
  // both worlds — every turn advertises the reader that cannot open the
  // file, and the one that can is absent unless the user happened to
  // type a files-domain word.
  "read_document_text",
  "list_files",
  "memory_recall",
]);

/**
 * Keyword/intent rules → domains. Case-insensitive test against the latest
 * user message. Deliberately generous: a false-positive domain costs a few
 * hundred schema tokens; a false NEGATIVE costs an iteration (self-heal).
 *
 * TWO-LAYER NOTE (WARP-2448): matching a domain here does not by itself make
 * a tool reachable. `chat-tool-scope.ts` removes whole groups from the POOL
 * before selection runs, so a rule can match a domain whose local tools were
 * all excluded upstream and legitimately advertise nothing — `notifications`
 * is exactly that case today, and `erp`/`switch` have no rules at all. The two
 * layers answer different questions (policy vs relevance) and the interaction
 * is asserted by `chat-tool-scope.test.ts` rather than left for someone to
 * rediscover. Remote tools registered into such a domain are NOT affected:
 * the exclusion list names local tools, so an Atlassian `pm` tool matched by
 * the `pm` rule is advertised even though nine of ten local `pm_*` tools are not.
 *
 * ⚠ This paragraph has now been wrong twice, in opposite directions, and the
 * lesson is the same both times: the answer is measured, not remembered.
 * WARP-2580 corrected an older claim that `pm` was the dead-rule example (one
 * local tool had survived in it). ADR-045 slice C then deleted every local
 * `pm_*` and `crm_*` tool, so `catalog.ts` now carries `pm: []` and `crm: []`
 * and BOTH rules are dead after all — along with `notifications`.
 * `chat-tool-scope.test.ts` computes `deadRules` from the catalog rather than
 * asserting a list, which is why it stayed green through both changes while
 * this comment did not. Read the test, not this paragraph (WARP-2823).
 *
 * WARP-1921 — vocabulary widened from the original WARP-1207 cut, which was
 * written from the TOOL NAMES rather than from how people talk. The tell:
 *
 *     "show me people at the front door yesterday"
 *
 * matched NOTHING — not `cameras?`, not `clips?`, not `doorbell` — so the
 * turn advertised the core four tools and no camera tools at all. That is
 * the single most likely camera sentence a household will type. The rules
 * below add the NOUNS people actually use (what they are looking for, and
 * the places they look) alongside the system's own words.
 *
 * TESTING DISCIPLINE: `tool-selection.service.test.ts` drives these from
 * whole sentences a household member would plausibly type. Asserting with
 * the vocabulary already inside the pattern is a tautology — it is exactly
 * what let the `people` gap ship green.
 */
const DOMAIN_RULES: ReadonlyArray<{ pattern: RegExp; domains: ToolDomain[] }> = [
  { pattern: /\b(connect|disconnect|reconnect|connections?|integrations?|link|unlink|hook up|sign in|set up|add|available services)\b/i, domains: ["connections"] },
  // `rename`/`relabel` claims files AND cameras (below): "rename Blue Eye
  // to Kitchen" names the target only by its label, so the verb is the
  // ONLY signal. A false-positive domain is cheap (see the rule comment).
  { pattern: /\b(files?|documents?|docs?|pdf|photos?|images?|pictures?|notes?|folders?|receipts?|invoices?|csv|spreadsheets?|uploads?|attachments?|downloads?|scans?|presentations?|slides?|renam(e[sd]?|ing)|re-?label(s|l?ed|l?ing)?)\b/i, domains: ["files"] },
  // WARP-2664 — the CLEANUP vocabulary. "what's cluttering my drive, get rid
  // of the junk" names no file, folder or document; without these verbs the
  // turn advertised the core four and none of the cleanup tools.
  { pattern: /\b(organi[sz](e|ed|es|ing)|clean(s|ed|ing)?[ -]?up|cleanup|tid(y|ied|ying)|declutter(ed|ing)?|clutter(ed|ing)?|duplicates?|junk|free up|disk space|storage space|taking up space)\b/i, domains: ["files"] },
  // WARP-2454 — DOCUMENTS NAMED BY WHAT THEY ARE, not by a container word.
  //
  // THE DESIGN LIMIT, WRITTEN DOWN. The rule above lists CONTAINERS
  // (file/document/pdf/invoice). "find the signed lease agreement" names the
  // thing by its subject and matched nothing, and no regex can close that in
  // general: the subject of a document is unbounded vocabulary. That part is
  // structurally the retrieval layer's job, and it is already covered —
  // `search_content` ("Search inside your files for what you need") is in
  // CORE_TOOL_NAMES, so it is advertised on EVERY turn regardless of this
  // rule. A subject-named file is therefore never un-findable; what it lost
  // was the other 15 files tools, `search_files` above all.
  //
  // What IS closeable is the common case, and it is closed the way WARP-1921
  // closed the cameras `people` gap: by adding the nouns people actually use.
  // These are document TYPES an SMB or household names out loud.
  //
  // REJECTED — a verb fallback (`find|locate|where is|open` + a noun phrase).
  // It cannot separate "find the signed lease agreement" from "find me a good
  // plumber" on anything better than the determiner, which is an accident of
  // grammar dressed up as intent; and `files` is the LARGEST domain in the
  // catalog (20 tools), so firing it on every `find`/`where is` turn is the
  // most expensive over-match available. tool-selection.service.test.ts
  // asserts those three negatives so the fallback cannot be reintroduced
  // quietly.
  { pattern: /\b(leases?|agreements?|contracts?|statements?|warrant(y|ies)|quotes?|estimates?|reports?|manuals?|certificates?|licen[cs]es?|permits?|insurance|tax returns?)\b/i, domains: ["files"] },
  // WARP-3538 — FILES NAMED BY THE PLACE THEY LIVE, not by a container word.
  //
  // `search_cloud_files` (the person's own cloud-drive file lists: OneDrive and
  // SharePoint today) is in this domain, and the two rules above list
  // CONTAINERS and document TYPES. "what did Dana change in the SharePoint this
  // week" and "anything Sam edited in my OneDrive since Monday" name neither,
  // so they matched nothing:
  // the turn advertised the core four and not the one tool that can answer it —
  // registered, budgeted and advertised on no relevant turn (WARP-2058 / 2454 /
  // 2497 / 2546, again).
  //
  // THE TRADE-OFF, RECORDED. `files` is the largest domain in the catalog, so
  // this rule is held to the two product names and nothing wider:
  //   • `one-?drive` — OneDrive and One-Drive. NOT `one drive`: with a space it
  //     is a disk in an array ("one drive in the raid failed"), a `system`
  //     question that must not also buy this domain.
  //   • `share-?point` — SharePoint and Share-Point.
  //   • NOT `microsoft 365` / `m365` / `office 365`. They are mail and calendar
  //     as much as files, and a calendar question that names the suite would
  //     buy a whole domain of file schemas for nothing. A file sentence that
  //     names the suite still carries a file or document word, and one that
  //     does not can say OneDrive or SharePoint.
  //   • NOT `document librar(y|ies)`. The `document` in it is already claimed
  //     by the first rule, so naming it would be a second spelling that cannot
  //     change an outcome.
  //   • NOT `cloud`, `cloud drive` or `cloud files`. The tool is provider-
  //     agnostic, but "cloud" is a word this product's customers type about
  //     backups, cameras and "is my data sent to the cloud?" as often as about
  //     files, and every one of those would buy this whole domain. The product
  //     names are what a person who wants the tool actually types.
  //   • Google Drive and Dropbox are not named YET: no connector exists to find
  //     their files with. Each later connector's PR adds its own product name to
  //     this rule, with its own whole-sentence positives and negatives, measured
  //     the same way.
  // Whole-sentence positives and negatives in tool-selection.service.test.ts.
  { pattern: /\b(one-?drive|share-?point)\b/i, domains: ["files"] },
  { pattern: /\b(lights?|lamps?|scenes?|thermostat|plugs?|sockets?|outlets?|switch(es)?|heating|cooling|air-?con(ditioning)?|fans?|temperature|dim|brightness|blinds?|curtains?|locks?|unlock|routines?|turn (on|off))\b/i, domains: ["smart-home"] },
  { pattern: /\b(wi-?fi|network|internet|router|dhcp|firewall|ssid|block(ed|s)?|unblock|bandwidth|devices?|online|offline|connected|guest|ethernet|vpn|slow)\b/i, domains: ["network"] },
  // The places a household points cameras, and the things it looks for —
  // NOT just the word "camera". See the WARP-1921 note above. Rename verbs
  // included (WARP-1893): "rename Blue Eye to Kitchen" identifies the
  // camera by display name alone, so without the verb the turn would never
  // advertise rename_camera.
  { pattern: /\b(cameras?|clips?|recordings?|footage|motion|doorbell|snapshots?|surveillance|nvr|frigate|live view|people|person|someone|somebody|anybody|anyone|intruders?|visitors?|packages?|parcels?|deliver(y|ies)|driveway|porch|doorstep|front door|back door|garage|yard|gate|who (was|were|came|is|has been)|renam(e[sd]?|ing)|re-?label(s|l?ed|l?ing)?)\b/i, domains: ["cameras"] },
  { pattern: /\b(calendar|meetings?|appointments?|events?|schedule|agenda|busy|free time|what'?s on)\b/i, domains: ["calendar"] },
  // WARP-2454 — AVAILABILITY, BOUNDED TO A TEMPORAL CUE.
  //
  // The rule above carried the literal `free time`, so "am I free Thursday
  // afternoon?" — the most natural availability question there is — matched
  // nothing. Bare `\bfree\b` is NOT the fix: it fires on "is the free trial
  // still on" and "how much free space is left", and calendar tools on a
  // billing question are pure waste.
  //
  // So the availability word must be FOLLOWED by a time reference, allowing
  // an optional preposition and determiner between them ("free on Friday",
  // "free at the weekend", "available next week", "free at 3", "free on the
  // 12th"). That ordering is deliberate, and the negative cases in
  // tool-selection.service.test.ts are what hold it: the reverse direction
  // ("is Thursday free?") is knowingly NOT matched, because a cue-then-word
  // alternative would re-admit "is this free trial still on" through `this`.
  // A missed "is Thursday free?" costs one self-heal iteration; the guard is
  // worth more than the case it gives up.
  { pattern: /\b(free|available|availability|unavailable)\s+(up\s+)?((on|at|for|in|this|next|any)\s+)?(the\s+)?(\b(today|tonight|tomorrow|later|soon|morning|afternoon|evening|weekend|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thurs?|fri|sat|sun)\b|\d{1,2}(st|nd|rd|th)?\b)/i, domains: ["calendar"] },
  { pattern: /\b(remind(er)?s?|tasks?|to-?dos?|don'?t forget|shopping list)\b/i, domains: ["reminders"] },
  { pattern: /\b(notifications?|notify|alerts?)\b/i, domains: ["notifications"] },
  // WARP-2058 — the `pm` domain had NO rule, so under the shipping
  // `domains` default not one `pm_*` tool was ever advertised: the whole
  // project tracker was unreachable from chat regardless of RBAC. Kept
  // distinct from the `reminders` rule above, which owns bare
  // "tasks"/"to-dos" — a household to-do is not a tracker work item, and
  // both domains matching a sentence that mentions each is the intended
  // generous behaviour, not a collision.
  //
  // ADR-045 slice C — this rule now opens `business` as well as `pm`, and it
  // MUST. The project and work-item READS moved into `business_find`; leaving
  // the rule at `["pm"]` would mean "what's left on the kitchen job" advertised
  // the pm WRITE tools and not the one tool that can answer it — a tool
  // registered, budgeted, and advertised on zero relevant turns, which is the
  // WARP-2058 / WARP-2454 / WARP-2546 defect exactly.
  //
  // The vocabulary is NOT duplicated into the business rule above instead:
  // `pm` still needs its own rule (pm_create_project, and the remote Atlassian
  // catalog that registers into this domain, WARP-2316), and two rules
  // carrying the same words is two places to keep in step.
  { pattern: /\b(projects?|backlogs?|sprints?|milestones?|work items?|tickets?|issues?|kanban|epics?|tracker|scope of work|statement of work)\b/i, domains: ["pm", "business"] },
  // WARP-2719 — DEPARTMENT vocabulary, and why `teams?` is not simply in the
  // list above.
  //
  // The department filter needs the words a person uses to name a group of
  // people. `departments?` is safe as a bare word — outside "department
  // store" nobody says it about their house — but a bare `teams?` is NOT.
  // Dropped into the alternation above it matched, among others, this
  // repo's own team_chat continuity fixture:
  //
  //     "and post that where the team will see it"
  //
  // a turn that must reach Slack and nothing else. It opened `pm` and
  // `business` on it, and the harness stayed green because that turn only
  // ever asserted that `slack_send_message` was PRESENT — an over-match adds
  // tools, it does not remove them, so no assertion in the file could see it.
  // "the team is coming over for dinner" and "my football team lost again"
  // did the same. That is the WARP-2454 `\bfree\b` mistake in a new word: the
  // domain is admitted WHOLE, so one incidental noun buys two whole domains
  // of schema on a turn that wanted none of them.
  //
  // So `team` is admitted only in a department-ish frame, and each frame is
  // pinned by a positive in tool-selection.service.test.ts:
  //
  //   `which/whose team`      — the question is about the team itself
  //   `the <name> team`, after `on`/`in` — membership in a NAMED team;
  //                             "in the team meeting" has no name and is out
  //   `team('s) <work noun>`  — the team as an owner of work
  //
  // Everything else about a team's work already has a rule: "what is Front
  // Desk working on?" and "what is assigned to the Clinical team right now?"
  // — the ticket's own two acceptance sentences — are carried by the
  // `work(ing|ed) on` / `assigned to` rule below, NOT by this one. Narrowing
  // here costs the ticket nothing.
  { pattern: /\bdepartments?\b(?!\s+stores?)|\b(which|whose)\s+teams?\b|\bteams?('|’)?s?\s+(workloads?|capacity|roster|members?|backlogs?|boards?|sprints?|queue|work)\b|\b(on|in)\s+the\s+[a-z][\w-]*(\s+[a-z][\w-]*)?\s+teams?\b/i, domains: ["pm", "business"] },
  // WARP-2719 — the question the department filter exists to answer, and the
  // one the vocabulary above does NOT match.
  //
  // "What is Front Desk working on?" contains no project, no ticket, no work
  // item and no department — `working` is not `work items?`, and the name of
  // the department is a proper noun no rule can enumerate. With no match,
  // `selectAdvertisedTools` falls back to core-only and `business_find` is
  // never advertised, so shipping the filter without this line would be a
  // filter reachable only by a model that had already used the domain for some
  // other reason. Fourth instance of the WARP-2058 / WARP-2454 / WARP-2546
  // class, and the one the ticket's own acceptance sentence sits on.
  //
  // Deliberately narrow, and its false positives are named rather than
  // discovered: "what am I working on", "who is working on the kitchen" and
  // "what is Sam working on" all advertise the project tools, which is what a
  // person asking any of them wants. `assigned to` is the same question asked
  // the other way round. What it must NOT catch is the household sense — "the
  // dishwasher is not working" has no `on` after it — and the negatives in
  // tool-selection.service.test.ts pin that.
  { pattern: /\b(work(ing|ed) on|workloads?|assigned to)\b/i, domains: ["pm", "business"] },
  // WARP-2454 — `repl(y|ies|ied|ying)`, never `replied?`. The original was
  // "replie" plus an OPTIONAL "d": it matched `replied` and the non-word
  // `replie`, and missed `reply` and `replies` entirely — so "did the
  // accountant ever reply" advertised no email tool at all. Every other
  // alternative is unchanged.
  //
  // WARP-3280 — CONTACTS. `search_contacts` lives in this domain, yet
  // "look up the contact alice@example.com" matched nothing: no rule named
  // the address book, so the model searched memory and files and told the
  // user "no contact record found", a false negative stated as fact. Added:
  //   • `contacts?` and `address book`. The VERB sense ("contact me later",
  //     "who should I contact about the boiler") is knowingly admitted:
  //     reaching a person is what this domain's tools do, and it is six
  //     schemas. `contact lens(es)` and `contact-lens` are excluded, and
  //     `contactless` never matches the word boundary. The cloud rule still
  //     does NOT claim `contact` (see WARP-2497 below), so this is the
  //     word's only owner.
  //   • a bare email ADDRESS. Someone who types an address is asking about
  //     that person. It needs a dotted domain, so a handle ("@dropletbox")
  //     or "meet me @ 5" stays out. Negatives pin both. Any `user@host.tld`
  //     token counts, so `git@github.com:org/repo` and `ssh root@droplet.local`
  //     admit this domain too: the cheap direction (six schemas), pinned by
  //     tests so it reads as a choice, not an accident.
  //     LINEAR BY CONSTRUCTION: the lookbehind lets a match start only at the
  //     head of a run, and the RFC bounds (local part 64, label 63) cap each
  //     attempt. The earlier unbounded `[\w.+-]+@…` restarted at every
  //     position and backtracked O(n²): 40k chars took ~3 s on the event loop.
  //     The linear-time test in tool-selection.service.test.ts guards every rule.
  { pattern: /\b(e-?mails?|inbox|newsletters?|unread|spam|repl(y|ies|ied|ying)|sent|contacts?(?![\s-]+lens(es)?\b)|address book)\b|(?<![\w.+-])[\w.+-]{1,64}@(?:[\w-]{1,63}\.)+[a-z]{2,}\b/i, domains: ["email"] },
  // WARP-2454 — team_chat had NO rule at all, so its tools were reachable
  // only by continuity: a conversation that had not already used the domain
  // could never start using it. Same defect class WARP-2058 fixed for `pm`,
  // and the one that would have made WARP-2397's Slack connector look
  // working-in-tests and dead-in-conversation.
  //
  // THE TRADE-OFF, RECORDED: this rule is deliberately NARROWER than the
  // others in this file, which is a departure from the module's
  // false-positives-are-cheap bias stated above. The reason is size. Every
  // other domain costs a handful of local schemas; `team_chat` is the domain
  // a remote Slack catalog registers into (15 tools in the WARP-2446
  // fixture), so an over-match here is the most expensive one available and
  // it is paid on turns that have nothing to do with work chat.
  //
  // So the ambiguous words are qualified rather than taken bare:
  //   • `channel` alone means TV/YouTube far more often than Slack, so it
  //     needs a workplace qualifier ("slack/team/work/group/company channel").
  //   • `thread` alone is sewing, forums, or a mail thread; same treatment.
  //   • `mention` was dropped entirely — it is an ordinary English verb
  //     ("did anyone mention the plumber") and no qualifier made it pay.
  // `slack`, `standup`, `huddle` and `dm` carry no such ambiguity and are
  // taken bare. The negatives in tool-selection.service.test.ts pin this.
  { pattern: /\b(slack|stand-?ups?|huddles?|dms?|direct messages?|group chats?|team chats?|(slack|team|work|group|company) channels?|(slack|stand-?up|chat|message|comment) threads?)\b/i, domains: ["team_chat"] },
  // WARP-3340 — "message someone". Team chat is the default way to reach a
  // colleague (Romain, 2026-09-29: email only when the person asks for it),
  // yet the rule above never named the verb. "Before messaging
  // dave@example.com, …" (agent-loop eval seed-028) matched only the email
  // rule, through the address, so the model could pick nothing but email.
  //
  // Held to the narrowness above: the bare noun is NOT admitted. "the message
  // in the file", "voice message", "message queue", "Kafka messages",
  // "read Dana's message" are not asking anyone to send anything, and each
  // would buy this domain's schemas for nothing. Only the PERSON frame is:
  //   • message/messaging, tell, ping or text + a person: him/her/them,
  //     everyone, the team, an address, or a name followed by that / about /
  //     saying / ":" ("message Priya that…"). A leading determiner or noun
  //     ("the message them…", "voice message Bob left") makes it a noun.
  //   • send (someone) a/an (…) message ("send Bob a quick message", "send the
  //     team a message", "send a status message to ops"). "send the error
  //     message to the log" has no article and stays out.
  //   • let <someone> know, except me/us/you/it.
  // "tell Priya the backup finished" (a bare name, no that/about) is not
  // matched: a name is indistinguishable from an object here. The base
  // prompt's guidance line names team_chat_send_message, so a call still
  // self-heals. Every lookbehind is bounded, so the rule stays linear.
  { pattern: /(?<!\b(?:the|a|an|this|that|these|those|my|your|his|her|their|our|its|any|each|every|last|latest|new|first|voice|error|warning|status|commit|log|exit|e-?mail|text|out-of-office)\s{1,3})\b(?:messag(?:e|ing)|tell|ping|text(?:ing)?)\s+(?:(?:him|her|them|everyone|everybody|(?:the|my|our)\s+(?:whole\s+)?team)\b|[\w.+-]{1,64}@[\w-]|(?!(?:me|us|you|it|what|which|who|whom|whether|if|how|when|why|where|the|a|an|this|that|these|those|about|to|for|in|on|of|from|with|and|or)\b)[a-z][\w'-]{0,30}(?:\s*:|\s+(?:that|about|saying|to say)\b))|\bsend\s+(?:(?:the\s+)?[\w.@+-]{1,64}\s+)?an?\s+(?:[\w-]{1,20}\s+)?messages?\b|\blet\s+(?!(?:me|us|it|you)\b)(?:the\s+(?:whole\s+)?)?[a-z][\w'-]{0,30}\s+know\b/i, domains: ["team_chat"] },
  { pattern: /\b(remember|memory|forget|know about me)\b/i, domains: ["memory"] },
  // ADR-045 slice C — ONE business rule, replacing WARP-2552's pair.
  //
  // WARP-2552 shipped two rules because the tools lived in two domains: a
  // `business` rule for the profile and a `crm` rule for the seven `crm_*`
  // tools. Slice C collapsed the CRM and PM READS into `business_find` /
  // `business_timeline`, which live in `business` — so one vocabulary now
  // reaches one place, and keeping two rules would mean two places to add a
  // word and one of them silently not mattering.
  //
  // `domains` is still BOTH, and the reason has changed. This used to say
  // `crm` is "not vestigial: `crm_log_activity` is in the chat pool and
  // `crm_move_deal_stage` is registered" — true until slice D, which deleted
  // both. `catalog.ts` now carries `crm: []`, so the rule advertises no LOCAL
  // tool at all. It is kept because a domain is also the unit a REMOTE tool
  // registers into (`extraDomains`, `runtimeTools`): dropping the word would
  // make a future connector's CRM tools unreachable by the only vocabulary a
  // person would use for them. Measured, not remembered — WARP-2823.
  //
  // WARP-2552 — `customers` claimed both domains on purpose, and still does.
  // The word is the natural way to ask either "what does Droplet know about my
  // business" or "show me my customers"; picking one owner would make the
  // other unreachable by the only word a human uses for it.
  //
  // WARP-2556 — `won` / `win` / `lost` are NOT claimed. They matched "did we
  // win the game last night" and "I lost my keys", advertising schemas on a
  // turn that wanted none. Real sentences still land: "which deals did we win
  // last quarter" matches `deals?`.
  //
  // 🔴 THE OVERLAP WITH `cloud` IS STILL DELIBERATE. That rule also claims
  // `crm`, `deals?` and `pipelines?`, so "what deals are in the pipeline"
  // matches both. By the cloud rule's own stated test — drop a word when
  // ANOTHER DOMAIN OWNS IT — those three should move here once the connector
  // landing seam exists. VERIFIED at ADR-045 slice C: WARP-2549 is NOT on
  // `stage` (no commit, no branch; docs/ADR-044 still lists it as future
  // work), so a HubSpot customer's deals are not in Crm* and
  // `cloud_query_dataset` is still the only tool that can answer for them.
  // Moving the words now would break that customer and turn two of WARP-2497's
  // pinned positives red. When 2549 lands, move them and re-point 2497's
  // positives — not before.
  {
    pattern: /\b(business|company|opening hours|customers?|crm|deals?|pipelines?|leads?|opportunit(y|ies)|prospects?|clients?|follow-?ups?)\b/i,
    domains: ["business", "crm"],
  },
  // WARP-3280 — THE CALCULATOR. The rule had the literal `calculate` and
  // nothing else, so "what is 187 * 43?" and even "use the calculator to
  // work out 2+2" advertised no `calculate`; the model did the arithmetic in
  // its head. Added `calculat\w*` (calculator, calculation), `math(s)`,
  // `arithmetic`, `N% of`, and an arithmetic EXPRESSION. The expression is
  // split on purpose: `+ * × ÷ ^` between digits count with or without
  // spaces, but `-`, `/` and `x` count only with a space on each side,
  // because tight they are dates (2026-10-03, 9/11), phone numbers
  // (555-0142) and resolutions (1920x1080). Bare `sum` is not claimed:
  // "sum up the thread" is a summary. Negatives pin those shapes. A time
  // range such as "3 - 4 pm" still admits this domain; that is the cheap
  // direction, and the date tools live here anyway.
  { pattern: /\b(time|date|today|tomorrow|yesterday|weather|calculat\w*|maths?|mathematics|arithmetic|convert|translate|timestamp)\b|\d\s*[+*×÷^]\s*\d|\d\s+[-/x]\s+\d|\d\s*%\s*of\b/i, domains: ["data"] },
  // (WARP-3116's navigation rule is NOT in this list — see NAVIGATION_RULES
  // below the array, which is evaluated only for a pool that can use it.)
  // WARP-3074 — bulk labelling (`classify_items`) lives in `data`. The
  // verbs are qualified by a batch object, never taken bare: `data` is one
  // of the larger domains, and a bare `label` fires on "print a shipping
  // label", a bare `sort` on "sort the files by newest", a bare `classif…`
  // on "the security classification of this file". Whole-sentence
  // positives and negatives in tool-selection.service.test.ts.
  {
    pattern: /\b((classif(y|ying)|categori[sz](e|ing)|triage|sort|label|tag|group|bucket) (these|them|those|each|all|every)|(classif(y|ying)|categori[sz](e|ing)|triage) (this|the|my) (batch|pile|list|inbox|queue)|which (team|department|category) (each|every))\b/i,
    domains: ["data"],
  },
  // WARP-2497 — the cloud SaaS datasets (Stripe / HubSpot / Mailchimp).
  //
  // The defect this closes is the one WARP-2058 closed for `pm` and WARP-2454
  // for `team_chat`, in its most expensive form: an owner could paste a Stripe
  // key, watch the row go CONNECTED, see charges sync — and the assistant
  // still could not answer "what did we bill last week", because the only
  // domain the data lived in was `erp`, which is excluded from chat AND
  // ruleless. Registering the tool without this rule would have advertised it
  // exactly never.
  //
  // THE TRADE-OFF, RECORDED. This domain costs ONE tool, so the size argument
  // that made `team_chat` narrow does not apply with the same force — an
  // over-match here costs ~1.2K chars, not fifteen schemas. What it does cost
  // is ANSWER QUALITY: a turn that drags a Stripe reader into a question about
  // the household is a turn where the model has a plausible wrong tool in
  // reach. So the bias is still narrow, and four words are deliberately NOT
  // claimed even though this domain genuinely serves their datasets:
  //   • `ticket` — `pm` owns it (WARP-2058). HubSpot tickets are reachable via
  //     `crm`/`hubspot`; stealing the bare word would drag a SaaS reader into
  //     every project-tracker sentence.
  //   • `company`, `customers` — `business` owns both, and `business_profile_get`
  //     is the right answer to "what are our opening hours".
  //   • `newsletter` — `email` owns it, and it means the inbox far more often
  //     than a Mailchimp campaign.
  //   • `contact` — `search_contacts` is the on-box answer to "find Dana's
  //     number"; a CRM lookup is what `crm`/`hubspot` is for.
  // Losing those is the deliberate half of the trade, pinned by negatives in
  // tool-selection.service.test.ts.
  //
  // TWO words are taken bare knowingly, and the distinction matters: the four
  // above are dropped because ANOTHER DOMAIN OWNS THEM, which is a collision.
  // `bill` and `deal` are merely ambiguous ENGLISH, which is not:
  //   • `bill` — "what did we bill last week" is the sentence this whole story
  //     exists to answer, and no qualifier covers it without covering nothing
  //     else. The cost is a false positive on the given name "Bill".
  //   • `deal` — first written as `(sales|open|won|…) deals?`, which the test
  //     sentence "which deals did we win in Q2?" then failed: the qualifier is
  //     rarely adjacent to the noun in a real question. Narrowing that a
  //     person cannot phrase their way into is not narrowness, it is a rule
  //     that does not work. The cost is "that's a good deal".
  // Both cost ONE 842-char schema on a turn that did not want it, which is the
  // cheap direction to be wrong in. Neither steals a word another rule needs.
  //
  // `refunds?` and `payouts?` are claimed although the Stripe track REFUSES
  // their dedicated datasets by design (no entry in
  // STRIPE_READABLE_COLLECTIONS; `stripe.test.ts` pins the refusal at zero
  // calls). Claimed anyway, for two reasons: a refund question is often
  // answerable from the `charge` dataset the track DOES serve — a charge row
  // carries `amount_refunded` — and for the rest, advertising the reader is
  // what lets the model receive `DatasetNotServedError`'s "this connection
  // will never have that data" and say so, instead of finding no tool and
  // inventing an outage. Dropping the words would trade an honest refusal
  // for a hallucinated one.
  //
  // WARP-2296 adds the commerce half. Same bias, same trade, one new judgement:
  //   • `shopify`, `storefront`, `skus?`, `restock`, `(low|out of|in) stock`
  //     and `inventory` are unambiguous and nothing else claims them.
  //   • `orders?` is claimed as the PLURAL only. Bare `order` matches "in order
  //     to" and "order of magnitude", which are ordinary English on turns that
  //     want nothing from a storefront — the same reason WARP-2556 unclaimed
  //     `won`/`win`/`lost`. "Which orders shipped last week" and "recent
  //     orders" are the sentences this exists to answer and both are plural.
  //   • `products?` is NOT claimed. It is the word a person uses about their
  //     own business in almost any sentence ("what products do we make"), the
  //     `business` domain owns that shape, and `catalogue`/`inventory`/`stock`
  //     already reach the same dataset from the questions that actually want
  //     it.
  //
  // WARP-2383 added `xero` and `suppliers?`/`vendors?`. The bill words were
  // ALREADY claimed here and had nothing to answer them — no cloud track
  // served the `bill` dataset — so "what do we owe?" selected this reader and
  // met an enum with no way to ask. The Xero track serves it, and the enum
  // now carries it; the words did not change, the answer did.
  // WARP-2832 added the scheduling, people and projects words alongside the
  // `booking`, `employee` and `task` datasets — in the SAME commit, because
  // WARP-2383's lesson is that neither half is any use alone: words claimed
  // here with nothing behind them select this reader and then meet an enum
  // that cannot answer, and datasets added to the enum with no words here are
  // never advertised on the turns that want them.
  // WARP-2919 added `loyverse`, the vendor name, exactly as `shopify` and
  // `square` are here — and NOT `receipts?`. That word is already claimed by
  // the `files` domain ("file this receipt"), and Loyverse's receipts are not
  // served as a dataset (no per-row currency; see `rest/vendors/loyverse.ts`),
  // so claiming it here would advertise the whole cloud tool set on a filing
  // turn for a question nothing behind it can answer. The day `order` ships
  // from Loyverse, the word is a double-claim with `invoices?` as precedent.
  //
  // Bare `appointment` and bare `ticket` are deliberately NOT claimed. The
  // first belongs to the practice track's own tools and the second is already
  // the support-ticket vocabulary; taking either would drag the cloud reader
  // into questions another tool answers better.
  //
  // WARP-2916 added `github` and `pull requests?` alongside the GitHub
  // profile, which serves `task` — a dataset whose words (`tasks?`,
  // `backlog`) were already claimed by WARP-2832. Bare `issues?` is
  // deliberately NOT claimed: "there's an issue with the printer" is a
  // household sentence, not a question about a repository.
  //
  // WARP-2917 added the vendor name `gitlab` beside the `task` dataset it
  // serves. Bare `issues?` — GitLab's own word for a work item — is
  // deliberately NOT claimed, for `ticket`'s reason: "is there an issue with
  // the printer" is not a tracker question, and the `tasks?|backlog|sprints?`
  // words already carry the tracker-shaped ones.
  { pattern: /\b(stripe|hubspot|mailchimp|shopify|github|gitlab|storefront|loyverse|xero|crm|invoices?|invoicing|bill|bills|billed|billing|suppliers?|vendors?|charges|refunds?|payouts?|revenue|takings|mrr|subscriptions?|pipelines?|deals?|campaigns?|audiences?|subscribers?|orders|skus?|inventory|catalogue|catalog|restock|(low|out of|in) stock|(open|click|bounce) rates?|bookings?|calendar|schedule|staff|employees?|headcount|team members?|who works|tasks?|backlog|sprints?|pull requests?)\b/i, domains: ["cloud"] },
  // `memory usage`, never bare `memory` — that word belongs to the memory
  // domain above ("what do you remember about me"), and claiming it here
  // would drag the system tools into every recall question.
  { pattern: /\b(storage|disks?|drives?|updates?|system|health|audit|cpu|ram|gpu|memory usage|backups?|uptime|logs?|disk space|how much (room|space))\b/i, domains: ["system"] },
  // WARP-2180 — durable background runs. Word boundaries on purpose; the
  // vocabulary is how a person hands work off, not the work's subject.
  { pattern: /\b(background (run|task|job)s?|agent runs?|in the background|while (i'?m|i am) (away|out|asleep|gone)|keep working on (this|it)|work on (this|it) (later|overnight)|long[- ]running (task|job))\b/i, domains: ["agent_runs"] },
  // WARP-3302 — stopping a run by its plain name. "How is it going?" needs no
  // rule: a chat that started a run carries start_agent_run in its prior tool
  // names, so continuity already advertises the domain on the follow-up.
  { pattern: /\b(stop|cancel|abort|kill) (the|that|this|my) (task|run|job)\b/i, domains: ["agent_runs"] },
  // WARP-2894 (ADR-056 §5.1) — routines. The vocabulary is how a person asks
  // for something RECURRING or AUTOMATED, not the word "routine" alone:
  // "every morning", "each Friday", "automate this", "set this up to run",
  // "schedule this". Word-bounded; `every`/`each` needs a cadence noun after
  // it, so "every file" or "every camera" stays with its own domain.
  // `schedule` alone belongs to calendar; here it needs `this|it|that` after
  // it — "schedule this" is an automation ask, "my schedule" is not.
  { pattern: /\b(routines?|automat(e|ed|ion|ically)|(every|each)\s+(day|morning|evening|night|week|weekday|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour|\d+\s*(minutes?|hours?|days?|weeks?))|daily|weekly|nightly|monthly|schedule\s+(this|it|that)|set\s+(this|it|that)\s+up\s+to\s+run|on\s+a\s+schedule|recurring)\b/i, domains: ["routines"] },
];

/**
 * WARP-3116 — getting AROUND the dashboard: find_dashboard_page and
 * open_dashboard_page live in `data`. The words are how a person asks to be
 * moved or pointed somewhere ("take me to it", "where do I change…"), not what
 * the page is about — "take me to it" names no page at all, and it is the
 * sentence this rule exists for.
 *
 * THE GATE. A separate list, evaluated only for a pool that carries one of the
 * two tools (`rulesForPool`), because a match admits the WHOLE `data` domain
 * and buys nothing unless the turn can use the two this rule is for. Measured
 * with `measureToolSpecs` on the owner's chat pool: 9 tools, ~8.8K chars, ~2.2K
 * tokens (17 tools and ~3.9K counting the eight utilities the chat scope
 * leaves out). Both are withheld from every turn with no dashboard page list —
 * voice, phones, background runs — at both places the pool is built
 * (`routes/llm.ts` for the estimate, `llm-agent.service.ts` for the wire), so a
 * pool that holds one came from a turn with a page list, and no caller has to
 * pass a flag that could drift between the two. As one of `DOMAIN_RULES` this
 * ran on every turn, and off the dashboard it could only ever admit the OTHER
 * seven tools (~1.8K tokens).
 *
 * EXPLICIT ONLY. Every alternative is a request to be moved or pointed. The
 * bare forms were dropped after they admitted the domain on ordinary
 * sentences — "I am going to need a summary of my inbox" and "before I go to
 * sleep" (`go(ing) to`), "send the link to Bob" (`link to`), "what is on the
 * front page of the report" (`the <word> page`) — and `head to` and
 * `page/screen/tab/section for/with` went with them, being the same shape:
 * a motion verb or a UI noun with no destination. A phrasing lost this way
 * still gets there: the guidance line names find_dashboard_page on a dashboard
 * turn, and a call to a filtered-but-allowed tool expands its domain next
 * iteration — one lost iteration, not a failed turn.
 *
 * What stays bare is deliberate. `where is / are / do I …` is the ticket's own
 * question, and in the dashboard chat the place a person asks after is usually
 * a page ("where are my deleted files?" → Trash). `settings` is NOT claimed
 * bare: "change the wifi settings to WPA3" is an action for the network tools,
 * not a trip, so it counts only after "open" / "show me".
 */
const NAVIGATION_RULES: typeof DOMAIN_RULES = [
  {
    pattern: /\b(take me|bring me|navigate|jump to|link me|where (is|are|can i|do i|would i|should i)|how do i get to|(open|show me) (the |my )?(\w+ ){0,2}(settings|page|screen|tab))\b/i,
    domains: ["data"],
  },
];

const ALL_RULES: typeof DOMAIN_RULES = [...DOMAIN_RULES, ...NAVIGATION_RULES];

/**
 * The rules worth evaluating for this pool: every ordinary rule, plus the
 * navigation rules only when the pool holds a tool they exist to reach.
 */
function rulesForPool(pool: readonly string[]): typeof DOMAIN_RULES {
  return pool.some((name) => DASHBOARD_NAVIGATION_TOOLS.has(name))
    ? ALL_RULES
    : DOMAIN_RULES;
}

/**
 * A tool name's domain. `runtimeTools` extends the lookup to the dynamic half
 * of the universe; omit it for a local-only question (the pre-WARP-2443
 * signature, kept working for every existing caller).
 */
/**
 * Every domain some keyword rule can match. Exported so the policy/relevance
 * overlap is ASSERTABLE rather than a comment someone has to trust: a domain
 * with a rule but no in-scope tools advertises nothing, and
 * `chat-tool-scope.test.ts` recomputes that set on every run so a new dead
 * overlap fails CI instead of shipping (WARP-2448).
 */
export const RULED_DOMAINS: ReadonlySet<ToolDomain> = new Set(
  ALL_RULES.flatMap((r) => r.domains),
);

export function domainOfTool(
  name: string,
  runtimeTools?: readonly RuntimeToolDescriptor[],
): ToolDomain | undefined {
  return resolveDomain(name, indexRuntimeDomains(runtimeTools));
}

/**
 * Every tool name in a domain, across both layers. Runtime tools are appended
 * after the catalog's, so the agent loop's self-heal branch expands a remote
 * tool's whole domain the same way it expands a local one's.
 */
export function toolNamesForDomain(
  domain: ToolDomain,
  runtimeTools?: readonly RuntimeToolDescriptor[],
): string[] {
  const local = TOOL_CATALOG.filter((e) => e.domain === domain).map(
    (e) => e.name,
  );
  if (!runtimeTools?.length) return local;
  const seen = new Set(local);
  const remote = runtimeTools
    .filter((t) => t.domain === domain && !seen.has(t.name))
    .map((t) => t.name);
  return [...local, ...remote];
}

/**
 * Compute the per-turn advertised subset: floor ∪ rule-matched domains ∪
 * domains of tools already called in this conversation (continuity). Pure —
 * no I/O, no clock, safe to call per turn.
 *
 * `runtimeTools` supplies the dynamic half. Absent or empty, this behaves
 * exactly as it did before WARP-2443 — the local-only path is unchanged, so
 * any shift in agent behaviour is attributable to the new universe rather
 * than to a refactor.
 *
 * WARP-3116 — the navigation rules join the ordinary ones only when `pool`
 * carries a navigation tool; see `NAVIGATION_RULES` for why the pool is the
 * gate.
 */
export function selectAdvertisedTools(opts: {
  mode: ToolSelectionMode;
  userMessage: string;
  pool: string[];
  conversationToolNames: string[];
  /** WARP-2443 — runtime-registered tools with no TOOL_CATALOG entry. */
  runtimeTools?: readonly RuntimeToolDescriptor[];
  /**
   * WARP-2582 — domains admitted for a reason that is not the SENTENCE.
   *
   * The relevance rules read the last user message, and a context pin is not
   * one. So "summarise the last month" with a customer pinned matched no rule,
   * the `crm` domain went unadvertised, and the model was handed a customer id
   * with no tool to spend it on. Seeded into the same set the rules write to,
   * so a pin's domain behaves exactly like a matched one — admitted WHOLE,
   * still filtered by `pool`, and therefore still unable to widen past the
   * RBAC/chat-scope ceiling this layer must never breach.
   */
  extraDomains?: readonly ToolDomain[];
}): { advertised: string[]; matchedDomains: ToolDomain[] } {
  // WARP-3125 — `explicit` advertises the caller's named set as-is, like
  // `off`. The two differ only in whether the loop asserts the budget.
  if (opts.mode === "off" || opts.mode === "explicit") {
    return { advertised: opts.pool, matchedDomains: [] };
  }
  const runtimeDomains = indexRuntimeDomains(opts.runtimeTools);
  const domains = new Set<ToolDomain>(opts.extraDomains ?? []);
  for (const rule of rulesForPool(opts.pool)) {
    if (rule.pattern.test(opts.userMessage)) {
      for (const d of rule.domains) domains.add(d);
    }
  }
  for (const name of opts.conversationToolNames) {
    const d = resolveDomain(name, runtimeDomains);
    if (d) domains.add(d);
  }
  const advertised = opts.pool.filter((name) => {
    if (CORE_TOOL_NAMES.has(name)) return true;
    const d = resolveDomain(name, runtimeDomains);
    return d !== undefined && domains.has(d);
  });
  return { advertised, matchedDomains: [...domains] };
}

// ── The ONE derivation of "what will this turn advertise" (WARP-2552) ───────
//
// `selectAdvertisedTools` is pure and takes already-derived inputs, which
// means every caller has to derive `userMessage` and `conversationToolNames`
// itself — and two callers deriving them differently is how the estimate and
// the wire stopped agreeing.
//
// They HAD stopped agreeing. `routes/llm.ts` sized the whole chat pool while
// `llm-agent.service.ts` advertised a per-turn subset, so the budget gate
// charged ~14,986 tokens of tool schemas on a turn that ships ~3,426. The
// helpers below exist so both sites ask the same question through the same
// code path; `tool-selection.parity.test.ts` asserts they return the same set
// for the same turn, and that test is the reason this is one function rather
// than a convention.

/**
 * The structural slice of a chat message this module reads.
 *
 * Deliberately structural rather than importing `ChatMessage`: the route holds
 * `ChatMessage[]` and the agent loop holds its own request type, and coupling
 * this module to either would make the shared helper unusable from the other.
 */
export interface SelectionMessage {
  role: string;
  content?: unknown;
  tool_calls?: ReadonlyArray<{ function: { name: string } }>;
}

/**
 * The latest user message as plain text, or `""`.
 *
 * `content` is an array on multimodal turns (an image attachment), and rule
 * matching only understands text — those turns yield `""` and fall back to
 * core-only advertisement. That is an accepted gap rather than a silent
 * failure: the WARP-642 self-heal branch re-admits any real tool the model
 * still names, at the cost of one iteration.
 */
export function lastUserMessageText(messages: readonly SelectionMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return typeof lastUser?.content === "string" ? lastUser.content : "";
}

// WARP-3302 (box finding, 2026-09-28) — "Yes, go ahead" after a turn that
// matched a domain but called nothing (the model asked first) matched no
// rule, so the tool it meant to call was not advertised and it claimed a run
// it never started. A short affirmation carries the previous user message's
// words forward; anything longer is judged on its own.
const AFFIRMATION = /^\s*(yes|yeah|yep|sure|ok(ay)?|please|go ahead|do it|start it|sounds good)\b[\s\w,.!']{0,40}$/i;

/** The text selection rules read: the last user message, plus the one before it when the last is a bare "yes, go ahead". */
export function selectionUserText(messages: readonly SelectionMessage[]): string {
  const last = lastUserMessageText(messages);
  if (!AFFIRMATION.test(last) || last.trim().split(/\s+/).length > 6) return last;
  const users = messages.filter((m) => m.role === "user");
  const prev = users.at(-2)?.content;
  return typeof prev === "string" ? `${prev}\n${last}` : last;
}

/**
 * Continuity: every tool name this conversation has already called.
 *
 * Spans BOTH sources, and needs both (WARP-1921):
 *   • `priorToolNames` — earlier TURNS, read from the persisted trace by the
 *     route. `messages` cannot supply these, because `chatRequestSchema`
 *     declares no `tool_calls` field and zod strips it from every replayed
 *     assistant message.
 *   • `messages` — earlier ITERATIONS of THIS turn, where the loop pushes the
 *     model's raw message object with `tool_calls` intact. Not yet persisted.
 */
export function conversationToolNamesFor(
  priorToolNames: readonly string[] | undefined,
  messages: readonly SelectionMessage[],
): string[] {
  return [
    ...(priorToolNames ?? []),
    ...messages.flatMap((m) =>
      m.role === "assistant" && m.tool_calls
        ? m.tool_calls.map((tc) => tc.function.name)
        : [],
    ),
  ];
}

/**
 * The names this turn will actually advertise, derived once.
 *
 * Under `off` and `explicit` the whole pool genuinely IS the wire payload, so
 * it is returned unnarrowed — a budget estimate for those modes must charge
 * for all of it.
 */
export function effectiveAdvertisedToolNames(opts: {
  mode: ToolSelectionMode;
  messages: readonly SelectionMessage[];
  priorToolNames?: readonly string[];
  pool: readonly string[];
  runtimeTools?: readonly RuntimeToolDescriptor[];
  /**
   * WARP-2896 — domains the CALLER's binding admits for every turn, whatever
   * the sentence says. Today: the `workspace` domain of a workshop run, set by
   * the agent-run worker from `run.workspaceId` and by nothing else.
   *
   * Why not a keyword rule: chat must never be promised the workshop's tools
   * (`chat-tool-scope.test.ts` keeps `workspace` ruleless), and a workshop goal
   * need not name them — "add a lines field to the word counter" is a workshop
   * sentence with no workshop word in it. Found live on the bench box
   * (2026-09-23): the run's pool carried all eight tools, selection advertised
   * none, and the model answered that it had no way to edit, test or propose.
   *
   * Why not "the pool carries them": chat's explicit `allowed_tools` is a
   * request filtered by role/scope only, never by the chat exclusion, so pool
   * membership is NOT the binding — a chat client listing `workspace_run` would
   * have had it advertised. The binding is the run's column; this is its echo.
   *
   * Parity (WARP-2552) is unaffected by construction: the only estimate site,
   * routes/llm.ts, is chat, which has no binding and passes none. Still only
   * ever a subset of `pool` — a bound domain admits nothing the pool lacks.
   */
  boundDomains?: readonly ToolDomain[];
}): Set<string> {
  // WARP-2556 — no `off` short-circuit here on purpose. `selectAdvertisedTools`
  // already returns the whole pool for `off`, and duplicating that branch meant
  // two places to keep in step if its off-mode handling ever changed. This
  // wrapper's job is to own the DERIVATION of the inputs, not to answer the
  // question itself.
  const { advertised } = selectAdvertisedTools({
    mode: opts.mode,
    userMessage: selectionUserText(opts.messages),
    pool: [...opts.pool],
    conversationToolNames: conversationToolNamesFor(opts.priorToolNames, opts.messages),
    runtimeTools: opts.runtimeTools,
    // WARP-2582 — derived HERE, from `messages`, rather than passed in by each
    // caller. That is the whole reason it is safe: the pin block is spliced
    // onto `agentMessages`, and `agentMessages` is what BOTH routes/llm.ts
    // (budget estimate) and llm-agent.service.ts (wire payload) hand in as
    // `messages`. A new PARAMETER would have needed both sites to pass it and
    // would have re-opened the WARP-2552 split the moment one of them didn't.
    // Deriving it inside the one shared function makes the parity invariant
    // structural instead of a convention.
    extraDomains: [
      ...pinnedToolDomainsFromMessages(opts.messages),
      ...(opts.boundDomains ?? []),
    ],
  });
  return new Set(advertised);
}
