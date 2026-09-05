/**
 * WARP-2582 (ADR-045 slice E) - the context-pin PROMPT CONTRACT.
 *
 * `ContextPin` shipped in WARP-460 able to name a folder, a file, an email
 * thread or a camera. Its own model docstring says the agent loop "reads them
 * on every turn and prepends pin descriptions to the system prompt so
 * retrieval/tool calls are scoped accordingly" - which was true, and useless
 * for the half of the product that sells: the scoping machinery could not
 * name a customer.
 *
 * This module owns BOTH halves of one contract, deliberately:
 *
 *   - `renderContextPinBlock` writes the system message routes/llm.ts splices
 *     in at index 0.
 *   - `pinnedToolDomainsFromMessages` reads that same block back out and says
 *     which `ToolDomain`s the turn must advertise BECAUSE of it.
 *
 * They live together because they ARE one format. Splitting them would put a
 * producer in a route and a consumer in tool selection with a prose string
 * between them and nothing asserting the two agree - the exact drift shape
 * WARP-2552 spent a ticket undoing for the advertised-tool set.
 *
 * WHY THE READ-BACK EXISTS AT ALL. Per-turn selection matches DOMAIN_RULES
 * against the LAST USER MESSAGE (`lastUserMessageText` filters role==="user").
 * A pin is not a user message. So on "summarise the last month", with a
 * customer pinned, no rule fires, `business` is not advertised, and the model
 * is handed a customer id it has no tool to spend. That is the worthless-pin
 * outcome this slice exists to prevent, and no wording of the pin line fixes
 * it - the tool simply is not on the wire.
 *
 * WHY READ IT BACK OUT OF THE BLOCK rather than thread a new argument through
 * `effectiveAdvertisedToolNames`: the block is already inside `agentMessages`,
 * and `agentMessages` is what BOTH the route's budget estimate
 * (routes/llm.ts) and the agent loop (llm-agent.service.ts) pass as
 * `messages`. So both sites see the identical input, with no new parameter
 * one of them could forget to pass. The WARP-2552 parity invariant holds by
 * construction instead of by convention.
 *
 * BUDGET. The block rides inside `historyText` for the runtime gate
 * (context-budget.service.ts) and `degradeToFit` does NOT trim
 * `agentMessages`, so an unbounded pin block is an unbounded prompt. It was
 * unbounded before this ticket; `CONTEXT_PIN_BLOCK_MAX_CHARS` closes that.
 *
 * PURE. No I/O, no clock, no Prisma. Database resolution lives in
 * `context-pin-targets.service.ts`; this module only formats what it is given.
 */
import type { ToolDomain } from "@droplet/tools-core";

/** The pin kinds that name a BUSINESS RECORD rather than a path or a device. */
export const BUSINESS_PIN_KINDS = [
  "customer",
  "deal",
  "project",
  "work_item",
] as const;

export type BusinessPinKind = (typeof BUSINESS_PIN_KINDS)[number];

const BUSINESS_PIN_KIND_SET: ReadonlySet<string> = new Set(BUSINESS_PIN_KINDS);

export function isBusinessPinKind(kind: string): kind is BusinessPinKind {
  return BUSINESS_PIN_KIND_SET.has(kind);
}

/**
 * Pin kind -> the tools-core `ToolDomain` that can act on it.
 *
 * All four resolve to `business`, and this stays a written-out map rather
 * than a constant for the reason it was one before: the answer is a fact
 * about the CATALOG, not about the pin, and the catalog has moved once
 * already. WARP-2582 shipped customer/deal -> `crm` and project/work_item ->
 * `pm`, which was right while `crm_get_customer` and `pm_get_work_item`
 * existed. ADR-045 (WARP-2583) collapsed every CRM and PM tool into
 * `business_find` / `business_timeline` / `business_create` /
 * `business_update`, all in the `business` domain, and left `crm` and `pm`
 * declared but EMPTY - landing slots for a remote HubSpot/Atlassian catalog.
 *
 * Why an empty domain is worse than no domain here: `selectAdvertisedTools`
 * seeds its domain set from this map and then keeps a pool tool only if
 * `resolveDomain(name)` is in that set. No local tool resolves to `crm` or
 * `pm` any more, so a pin pointing there admitted NOTHING - the exact
 * worthless-pin outcome this module exists to prevent, reintroduced with
 * every test green because the tests pinned the map, not the wire. The
 * selection-level case in context-pin-prompt.test.ts now holds this end to
 * end: it goes red if a pinned customer stops admitting `business_find`.
 *
 * Not `crm`/`pm` as well. A pin names a LOCAL row by id, and a remote
 * catalog cannot spend a local id; the sentence rules in
 * tool-selection.service.ts are what open those two domains for remote
 * tools, and a pin has no business widening past what it can use.
 */
export const PIN_KIND_TOOL_DOMAIN: Readonly<Record<BusinessPinKind, ToolDomain>> = {
  customer: "business",
  deal: "business",
  project: "business",
  work_item: "business",
};

/**
 * How a pin's target stands RIGHT NOW. An explicit enum on the wire, per
 * CLAUDE.md's no-guessing rule - a client must never have to infer "deleted"
 * from a null label.
 *
 * This is a per-request VIEW, not a stored column, and deliberately so: a
 * stored status would go stale the moment somebody archived the record from
 * another surface, and a pin block naming a customer who was archived an hour
 * ago is the failure this enum exists to make impossible.
 *
 *   active      - the row exists and is not archived.
 *   archived    - the row exists and `isArchived` is true. Still named, and
 *                 SAID to be archived, because "what happened with the account
 *                 we shelved" is a real question.
 *   missing     - the caller may read this kind, and the row is gone.
 *   unavailable - the caller may NOT read this kind (module off, or the
 *                 person's AccessRole does not grant the domain). NEVER
 *                 rendered into the prompt and never labelled: the dashboard
 *                 shows it only so the pin can be removed.
 */
export type ContextPinTargetState =
  | "active"
  | "archived"
  | "missing"
  | "unavailable";

export interface ContextPinTarget {
  state: ContextPinTargetState;
  /** Human name. `null` for `missing`/`unavailable` - we never invent one and
   *  never echo a name the caller may not read. */
  label: string | null;
  /** Secondary identity: a deal's customer, a work item's project key. */
  sublabel: string | null;
}

/** The structural slice of a persisted pin this module reads. Structural
 *  rather than the Prisma row type so the pure half stays importable from
 *  anywhere, including tool selection. */
export interface RenderablePin {
  id: string;
  kind: string;
  ref: string;
  meta?: unknown;
}

/**
 * The block's first words. Kept BYTE-IDENTICAL to what WARP-460 shipped so
 * anything grepping box logs for it keeps matching, and used as the marker
 * `pinnedToolDomainsFromMessages` identifies the block by.
 */
export const PIN_BLOCK_HEADER =
  "Context pins for this conversation \u2014 prefer these as scope hints when " +
  "calling retrieval tools:";

/**
 * Appended only when at least one business pin survived resolution. It costs
 * ~190 chars and buys the model the one thing it cannot infer: that the
 * bracketed uuid is the argument, not decoration.
 *
 * Names `business_find` and `business_timeline` because those are what is on
 * the wire (ADR-045; both are in the chat pool, unlike the `pm_*` reads they
 * replaced, which is why the WARP-2582 wording told the model a project pin
 * could not be opened). A pin kind IS a `business_find` entity, so the model
 * needs no translation table.
 */
const BUSINESS_PIN_GUIDANCE =
  "\nBusiness pins carry the record's id in brackets - pass it straight to " +
  "business_find as id, with the matching entity (customer, deal, project or " +
  "work_item), and to business_timeline for what has happened on it.";

/**
 * Ceiling on the whole rendered block.
 *
 * Derivation, not a round number: a business line measures ~75 chars, the
 * per-session cap is 24 pins (MAX_PINS_PER_SESSION), and 24 * 75 + the header
 * and guidance is ~2100 - which on a 16384-token window is ~525 tokens of
 * never-dropped prompt riding in `historyText`. 1400 holds ~16 lines, past
 * which a "working set" has stopped being one. Lines beyond it are dropped
 * with a COUNTED note rather than silently, because a silently truncated pin
 * is a pin the user believes is in force.
 */
export const CONTEXT_PIN_BLOCK_MAX_CHARS = 1400;

/** Per-session pin cap, enforced at create time (routes/llm.ts). Advisory by
 *  design - the enforcing gate is the char budget above, which no concurrent
 *  insert can get around. */
export const MAX_PINS_PER_SESSION = 24;

function businessLine(
  kind: BusinessPinKind,
  ref: string,
  target: ContextPinTarget,
): string | null {
  // An unavailable target is OMITTED, not described. Rendering "customer:
  // (you may not see this)" would still tell the model a customer is in play
  // on a box whose operator turned the CRM off. The dashboard shows it; the
  // prompt does not.
  if (target.state === "unavailable") return null;
  if (target.state === "missing") {
    return `- ${kind}: (this record no longer exists - ignore this pin) [id ${ref}]`;
  }
  const archived = target.state === "archived" ? " (archived)" : "";
  const sub = target.sublabel ? ` - ${target.sublabel}` : "";
  return `- ${kind}: ${target.label ?? "(unnamed)"}${sub}${archived} [id ${ref}]`;
}

function plainLine(pin: RenderablePin): string {
  // Unchanged from WARP-460: a folder/file/camera ref is self-describing, and
  // `meta` carries the camera window.
  const metaSuffix =
    pin.meta && typeof pin.meta === "object" ? ` ${JSON.stringify(pin.meta)}` : "";
  return `- ${pin.kind}: ${pin.ref}${metaSuffix}`;
}

/**
 * Render the system message. Returns `null` when nothing survives - a header
 * with no lines under it is noise the model has to read on every turn.
 *
 * `targets` is keyed by pin id and may omit non-business pins entirely.
 */
export function renderContextPinBlock(
  pins: readonly RenderablePin[],
  targets: ReadonlyMap<string, ContextPinTarget>,
): string | null {
  const lines: string[] = [];
  let sawBusiness = false;
  for (const pin of pins) {
    if (isBusinessPinKind(pin.kind)) {
      const target = targets.get(pin.id);
      // No resolution for a business pin means the resolver could not run.
      // Fail CLOSED - omit it rather than fall through to `plainLine`, which
      // would print the bare uuid this whole ticket exists to stop printing.
      if (!target) continue;
      const line = businessLine(pin.kind, pin.ref, target);
      if (!line) continue;
      lines.push(line);
      sawBusiness = true;
    } else {
      lines.push(plainLine(pin));
    }
  }
  if (lines.length === 0) return null;

  const head = PIN_BLOCK_HEADER + (sawBusiness ? BUSINESS_PIN_GUIDANCE : "");
  // Oldest-first, matching the route's `orderBy: { addedAt: "asc" }`. Truncate
  // the TAIL so the set the user has been working with all session stays put
  // and the newest additions are what fall off - and say how many did.
  const kept: string[] = [];
  let used = head.length;
  for (const line of lines) {
    if (used + 1 + line.length > CONTEXT_PIN_BLOCK_MAX_CHARS) break;
    kept.push(line);
    used += 1 + line.length;
  }
  const dropped = lines.length - kept.length;
  if (dropped > 0) {
    kept.push(`- (${dropped} more pin(s) not shown - the pin block hit its char budget)`);
  }
  return [head, ...kept].join("\n");
}

/** The structural slice of a chat message this module reads. Matches
 *  `SelectionMessage` in tool-selection.service.ts on purpose - the same
 *  array is handed to both. */
export interface PinBlockMessage {
  role: string;
  content?: unknown;
}

const BUSINESS_LINE_RE = /^- (customer|deal|project|work_item):/;

/**
 * The domains a turn must advertise because of its pins.
 *
 * Reads the block back out of `messages`. Anything a `businessLine` printed
 * is by construction a target the caller is allowed to see (`unavailable`
 * never reaches the block), so admitting its domain widens nothing the two
 * authorization axes have not already permitted.
 *
 * A `missing` line still yields its domain, which is right: the record is
 * gone but the conversation is still about the CRM, and the model needs
 * `business_find` to offer the obvious next move.
 *
 * Deterministic and allocation-light. Returns `[]` on any turn with no pin
 * block, which is nearly all of them.
 */
export function pinnedToolDomainsFromMessages(
  messages: readonly PinBlockMessage[],
): ToolDomain[] {
  const out = new Set<ToolDomain>();
  for (const m of messages) {
    if (m.role !== "system") continue;
    const content = m.content;
    if (typeof content !== "string") continue;
    if (!content.startsWith(PIN_BLOCK_HEADER)) continue;
    for (const line of content.split("\n")) {
      const hit = BUSINESS_LINE_RE.exec(line);
      if (hit) out.add(PIN_KIND_TOOL_DOMAIN[hit[1] as BusinessPinKind]);
    }
  }
  return [...out];
}
