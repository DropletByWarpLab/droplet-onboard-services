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
 * all excluded upstream and legitimately advertise nothing — `notifications`
 * is exactly that case today, and `erp`/`switch` have no rules at all. The two
 * layers answer different questions (policy vs relevance) and the interaction
 * is asserted by `chat-tool-scope.test.ts` rather than left for someone to
 * rediscover. Remote tools registered into such a domain are NOT affected:
 * the exclusion list names local tools, so an Atlassian `pm` tool matched by
 * the `pm` rule is advertised even though nine of ten local `pm_*` tools are not.
 *
 * ⚠ WARP-2580 — this paragraph named `pm` as the dead-rule example and had
 * been wrong since 2026-08-17, when `pm_create_project` landed and was not
 * added to the exclusion block beside its nine siblings. `pm` is NOT dead:
 * exactly one local tool survives in it. `chat-tool-scope.test.ts` has pinned
 * that ("the pm rule is NOT dead — WARP-2058's comment is stale") since before
 * this correction; the comment simply never followed. `notifications` is the
 * genuine dead-rule case and is what that test's `deadRules` set contains.
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
  { pattern: /\b(projects?|backlogs?|sprints?|milestones?|work items?|tickets?|issues?|kanban|epics?|tracker|scope of work|statement of work)\b/i, domains: ["pm"] },
  // WARP-2454 — `repl(y|ies|ied|ying)`, never `replied?`. The original was
  // "replie" plus an OPTIONAL "d": it matched `replied` and the non-word
  // `replie`, and missed `reply` and `replies` entirely — so "did the
  // accountant ever reply" advertised no email tool at all. Every other
  // alternative is unchanged.
  { pattern: /\b(e-?mails?|inbox|newsletters?|unread|spam|repl(y|ies|ied|ying)|sent)\b/i, domains: ["email"] },
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
  { pattern: /\b(remember|memory|forget|know about me)\b/i, domains: ["memory"] },
  // WARP-2552 — `customers` claims BOTH domains on purpose. The word is the
  // natural way to ask either "what does Droplet know about my business"
  // (business profile) or "show me my customers" (the CRM). A false-positive
  // domain is cheap here, and picking one owner would make the other
  // unreachable by the only word a human uses for it.
  { pattern: /\b(business|company|opening hours|customers?)\b/i, domains: ["business", "crm"] },
  // WARP-2552 — the CRM's own vocabulary. Without a rule the seven crm_* tools
  // sit in the chat pool, are charged to the budget, and are advertised on
  // ZERO turns — the same defect WARP-2058 fixed for `pm` and WARP-2454 fixed
  // for `team_chat`. `chat-tool-scope.test.ts` now fails if a domain with
  // in-scope tools has no rule, so a fourth instance cannot ship quietly.
  //
  // WARP-2556 — `won` / `win` / `lost` were claimed bare and are not any more.
  // They matched "did we win the game last night" and "I lost my keys",
  // advertising six schemas on a turn that wanted none — the per-turn cost
  // WARP-2552 exists to avoid. Real CRM sentences still land: "which deals did
  // we win last quarter" matches `deals?`.
  //
  // 🔴 THE OVERLAP WITH `cloud` IS DELIBERATE, FOR NOW. That rule also claims
  // `crm`, `deals?` and `pipelines?`, so "what deals are in the pipeline"
  // matches both. By the cloud rule's own stated test — drop a word when
  // ANOTHER DOMAIN OWNS IT — those three should move here now that a native
  // CRM exists. They must not move YET: until WARP-2549 lands the connector
  // landing seam, a HubSpot customer's deals are not in Crm* at all, and
  // `cloud_query_dataset` is the ONLY tool that can answer the question for
  // them. Moving the words early would break that customer and turn two of
  // WARP-2497's deliberately pinned positives red. When 2549 lands and those
  // deals reach Crm*, move them and re-point 2497's positives.
  { pattern: /\b(crm|deals?|pipelines?|leads?|opportunit(y|ies)|prospects?|clients?|follow-?ups?)\b/i, domains: ["crm"] },
  { pattern: /\b(time|date|today|tomorrow|yesterday|weather|calculate|convert|translate|timestamp)\b/i, domains: ["data"] },
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
  { pattern: /\b(stripe|hubspot|mailchimp|shopify|storefront|crm|invoices?|invoicing|bill|billed|billing|charges|refunds?|payouts?|revenue|takings|mrr|subscriptions?|pipelines?|deals?|campaigns?|audiences?|subscribers?|orders|skus?|inventory|catalogue|catalog|restock|(low|out of|in) stock|(open|click|bounce) rates?)\b/i, domains: ["cloud"] },
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
 * Under `off` the whole pool genuinely IS the wire payload, so it is returned
 * unnarrowed — a budget estimate for that mode must charge for all of it.
 */
export function effectiveAdvertisedToolNames(opts: {
  mode: ToolSelectionMode;
  messages: readonly SelectionMessage[];
  priorToolNames?: readonly string[];
  pool: readonly string[];
  runtimeTools?: readonly RuntimeToolDescriptor[];
}): Set<string> {
  // WARP-2556 — no `off` short-circuit here on purpose. `selectAdvertisedTools`
  // already returns the whole pool for `off`, and duplicating that branch meant
  // two places to keep in step if its off-mode handling ever changed. This
  // wrapper's job is to own the DERIVATION of the inputs, not to answer the
  // question itself.
  const { advertised } = selectAdvertisedTools({
    mode: opts.mode,
    userMessage: lastUserMessageText(opts.messages),
    pool: [...opts.pool],
    conversationToolNames: conversationToolNamesFor(opts.priorToolNames, opts.messages),
    runtimeTools: opts.runtimeTools,
  });
  return new Set(advertised);
}
