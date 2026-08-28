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

export type ToolSelectionMode = "off" | "domains";

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
 * all excluded upstream and legitimately advertise nothing — `pm` is exactly
 * that case today, and `erp`/`switch` have no rules at all. The two layers
 * answer different questions (policy vs relevance) and the interaction is
 * asserted by `chat-tool-scope.test.ts` rather than left for someone to
 * rediscover. Remote tools registered into such a domain are NOT affected:
 * the exclusion list names local tools, so an Atlassian `pm` tool matched by
 * the `pm` rule is advertised even though every local `pm_*` tool is not.
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
  // `rename`/`relabel` claims files AND cameras (below): "rename Blue Eye
  // to Kitchen" names the target only by its label, so the verb is the
  // ONLY signal. A false-positive domain is cheap (see the rule comment).
  { pattern: /\b(files?|documents?|docs?|pdf|photos?|images?|pictures?|notes?|folders?|receipts?|invoices?|csv|spreadsheets?|uploads?|attachments?|downloads?|scans?|presentations?|slides?|renam(e[sd]?|ing)|re-?label(s|l?ed|l?ing)?)\b/i, domains: ["files"] },
  { pattern: /\b(lights?|lamps?|scenes?|thermostat|plugs?|sockets?|outlets?|switch(es)?|heating|cooling|air-?con(ditioning)?|fans?|temperature|dim|brightness|blinds?|curtains?|locks?|unlock|routines?|turn (on|off))\b/i, domains: ["smart-home"] },
  { pattern: /\b(wi-?fi|network|internet|router|dhcp|firewall|ssid|block(ed|s)?|unblock|bandwidth|devices?|online|offline|connected|guest|ethernet|vpn|slow)\b/i, domains: ["network"] },
  // The places a household points cameras, and the things it looks for —
  // NOT just the word "camera". See the WARP-1921 note above. Rename verbs
  // included (WARP-1893): "rename Blue Eye to Kitchen" identifies the
  // camera by display name alone, so without the verb the turn would never
  // advertise rename_camera.
  { pattern: /\b(cameras?|clips?|recordings?|footage|motion|doorbell|snapshots?|surveillance|nvr|frigate|live view|people|person|someone|somebody|anybody|anyone|intruders?|visitors?|packages?|parcels?|deliver(y|ies)|driveway|porch|doorstep|front door|back door|garage|yard|gate|who (was|were|came|is|has been)|renam(e[sd]?|ing)|re-?label(s|l?ed|l?ing)?)\b/i, domains: ["cameras"] },
  { pattern: /\b(calendar|meetings?|appointments?|events?|schedule|agenda|busy|free time|what'?s on)\b/i, domains: ["calendar"] },
  { pattern: /\b(remind(er)?s?|tasks?|to-?dos?|don'?t forget|shopping list)\b/i, domains: ["reminders"] },
  { pattern: /\b(notifications?|notify|alerts?)\b/i, domains: ["notifications"] },
  // WARP-2058 — the `pm` domain had NO rule, so under the shipping
  // `domains` default not one `pm_*` tool was ever advertised: the whole
  // project tracker was unreachable from chat regardless of RBAC. Kept
  // distinct from the `reminders` rule above, which owns bare
  // "tasks"/"to-dos" — a household to-do is not a tracker work item, and
  // both domains matching a sentence that mentions each is the intended
  // generous behaviour, not a collision.
  { pattern: /\b(projects?|backlogs?|sprints?|milestones?|work items?|tickets?|issues?|kanban|epics?|tracker|scope of work|statement of work)\b/i, domains: ["pm"] },
  { pattern: /\b(e-?mails?|inbox|newsletters?|unread|spam|replied?|sent)\b/i, domains: ["email"] },
  { pattern: /\b(remember|memory|forget|know about me)\b/i, domains: ["memory"] },
  { pattern: /\b(business|company|opening hours|customers?)\b/i, domains: ["business"] },
  { pattern: /\b(time|date|today|tomorrow|yesterday|weather|calculate|convert|translate|timestamp)\b/i, domains: ["data"] },
  // `memory usage`, never bare `memory` — that word belongs to the memory
  // domain above ("what do you remember about me"), and claiming it here
  // would drag the system tools into every recall question.
  { pattern: /\b(storage|disks?|drives?|updates?|system|health|audit|cpu|ram|gpu|memory usage|backups?|uptime|logs?|disk space|how much (room|space))\b/i, domains: ["system"] },
];

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
  DOMAIN_RULES.flatMap((r) => r.domains),
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
 */
export function selectAdvertisedTools(opts: {
  mode: ToolSelectionMode;
  userMessage: string;
  pool: string[];
  conversationToolNames: string[];
  /** WARP-2443 — runtime-registered tools with no TOOL_CATALOG entry. */
  runtimeTools?: readonly RuntimeToolDescriptor[];
}): { advertised: string[]; matchedDomains: ToolDomain[] } {
  if (opts.mode === "off") {
    return { advertised: opts.pool, matchedDomains: [] };
  }
  const runtimeDomains = indexRuntimeDomains(opts.runtimeTools);
  const domains = new Set<ToolDomain>();
  for (const rule of DOMAIN_RULES) {
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
