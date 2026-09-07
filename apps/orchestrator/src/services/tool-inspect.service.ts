/**
 * WARP-2823 (ADR-002 admin console, slice 3) — which tools a person's
 * assistant actually gets, and which gate withheld each of the rest.
 *
 * ── The problem this exists to end ─────────────────────────────────────────
 *
 * `GET /api/llm/tools/catalog` reports the registry through exactly one
 * predicate: privileged callers see all of it, everyone else sees the
 * non-write half. A real chat turn narrows six more times before the model is
 * shown a single schema. `GET /api/llm/tools` counts differently again, off
 * the live MCP child. So an admin looking at this box can read three numbers
 * that describe it and none of them names a reason.
 *
 * The narrowing itself is not the problem — it is layered, fail-closed, and
 * re-checked immediately before every dispatch. What has never existed is any
 * way to SEE it. That is the whole of this service: it renders, it never
 * decides.
 *
 * ── The one rule that keeps it honest ──────────────────────────────────────
 *
 * 🔴 EVERY VERDICT BELOW IS PRODUCED BY IMPORTING THE SHIPPED PREDICATE AND
 * CALLING IT. Not one gate is re-implemented here, and none may be. An
 * inspector that decides for itself what a gate would do is a second
 * implementation of the access model, and the first time the two disagree the
 * page is confidently wrong about a security boundary — which is worse than
 * having no page, because somebody would believe it.
 *
 * The gate order below is not a design choice either. It is the order the
 * shipped chain applies, read off the call sites in `routes/llm.ts` and
 * `llm-agent.service.ts`, and a test pins it.
 */
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG, type ToolCatalogEntry } from "@droplet/tools-core";

import {
  DENY_ALL_TOOL_SCOPE,
  WRITE_TOOLS,
  VOICE_WRITE_TOOLS,
  resolveAttributedToolAccess,
  toolAllowedForTier,
  toolAllowedInScope,
  type AttributedToolAccess,
  type AttributionFailure,
  type ToolAccessScope,
} from "./tool-access.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import { runtimeToolRegistry } from "./runtime-tool-registry.service.js";
import { isWithheldFromOffLan } from "./stored-content-egress.service.js";
import {
  CORE_TOOL_NAMES,
  effectiveAdvertisedToolNames,
  type ToolSelectionMode,
} from "./tool-selection.service.js";

/**
 * The gates, in the order the shipped chain applies them.
 *
 * 🔴 `write_tier` BEFORE `role_grant`, because that is what the code does:
 * `toolAllowedForPrincipal` (tool-access.service.ts) checks the tier first and
 * only then the scope, and `firstToolDeniedForPrincipal` documents why — a
 * role-less caller holds no scope at all, so checking scope first would report
 * "no grant" for somebody whose actual refusal is the ADR-004 write floor.
 * Reporting the gates in a tidier-looking order would misattribute exactly
 * that case.
 */
export const INSPECT_GATES = [
  "write_tier",
  "role_grant",
  "interview_strip",
  "off_lan_withhold",
  "chat_policy",
  "turn_relevance",
] as const;

export type InspectGate = (typeof INSPECT_GATES)[number];

export interface ToolInspectRow {
  name: string;
  domain: string;
  homeDescription: string;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  /** `true` ⇔ this tool reaches the model on the turn described by the inputs. */
  advertised: boolean;
  /** The FIRST gate that withheld it, in dispatch order. Null ⇔ advertised. */
  gate: InspectGate | null;
  /** One sentence, for a person, saying why. Null ⇔ advertised. */
  reason: string | null;
  /**
   * Every OTHER gate that would also have withheld it.
   *
   * Load-bearing rather than decorative: a tool withheld by exactly one gate
   * is one grant away from reaching the model, and a tool withheld by four is
   * not. Showing only the first would make those two look identical, and the
   * admin's next action after reading this page is usually to change a grant.
   */
  alsoWithheldBy: InspectGate[];
  /**
   * §3 `locks` is decided at DISPATCH, from resolved args, so it can never be
   * a verdict here. Set on the lock-capable tool when the target may not
   * operate locks, so the row can say "advertised, but a lock call is refused"
   * instead of implying the tool is fully available.
   */
  lockCaveat?: string;
}

export interface ToolInspectResult {
  targetUserId: string;
  /** The ADR-004 tier read off the User row. Null when unresolved. */
  tier: string | null;
  /**
   * Non-null ⇔ the identity could not be established and every row is
   * withheld. Rendered as its own state: "0 tools" and "we could not resolve
   * this person" look identical in a count and are entirely different facts.
   */
  unresolved: AttributionFailure | null;
  /**
   * `true` ⇔ `scope` is null, i.e. §3 applies no narrowing to this person.
   *
   * 🔴 NOT "this person is unrestricted". `resolveAttributedToolAccess`
   * returns a null scope for TWO different people: the owner, via the §3
   * bypass, and anybody holding no AccessRole at all. The second still loses
   * every write tool to the tier gate. `AttributedToolAccess`'s own doc says
   * this in as many words; reading it as "no narrowing" is the single most
   * likely way this page could lie.
   */
  noRoleNarrowing: boolean;
  counts: {
    registered: number;
    advertised: number;
    withheld: number;
    /** Withheld count per gate — first-gate attribution, so these sum to `withheld`. */
    byGate: Record<InspectGate, number>;
  };
  rows: ToolInspectRow[];
}

export interface ToolInspectInput {
  /** Whose assistant to inspect. Never the caller's own id by default. */
  targetUserId: string;
  /**
   * The user message to size turn-relevance against. Empty string is a
   * legitimate input and means "a turn with no matched domain" — the core
   * tools plus whatever the pins open.
   */
  message?: string;
  /** Model an off-LAN turn (WARP-1983 stored-content withholding). */
  offLan?: boolean;
  /** Model an interview turn (write tools stripped). */
  interview?: boolean;
  /** Model the voice principal, whose one permitted write tool is control_device. */
  voice?: boolean;
  /**
   * Defaults to `"domains"`, which is what the wire path hardcodes
   * (`llm-agent.service.ts`). `"off"` models the diagnostic path, where the
   * whole pool is advertised and `turn_relevance` can never fire.
   */
  selectionMode?: ToolSelectionMode;
}

const REASONS: Record<InspectGate, (e: ToolCatalogEntry, tier: string | null) => string> = {
  write_tier: (_e, tier) =>
    `It changes something, and ${tier ?? "this person"} is not owner or admin. ` +
    `The assistant can read on their behalf; it cannot act on their behalf.`,
  role_grant: (e) =>
    `Their role does not reach the "${e.domain}" area` +
    (e.requiresWrite ? `, or reaches it read-only.` : `.`),
  interview_strip: () =>
    `This is a setup conversation. Nothing that changes anything runs during setup.`,
  off_lan_withhold: () =>
    `They are off the home network, and this tool reads stored content. ` +
    `It comes back when they are on the LAN.`,
  chat_policy: () =>
    `Withheld from chat by policy — it is reachable from its own screen, or ` +
    `from an external client, but not by asking.`,
  turn_relevance: () =>
    `Nothing in this message matched its area. It would come back on a message that did.`,
};

/**
 * Evaluate every gate for one tool. Returns them in dispatch order, so the
 * head of the list is the gate that actually fired.
 *
 * Note the deliberate absence of any short-circuit: the caller wants the whole
 * set, not the first hit, and evaluating them all is what makes
 * `alsoWithheldBy` mean something.
 */
function gatesWithholding(
  entry: ToolCatalogEntry,
  opts: {
    tier: string | null;
    scope: ToolAccessScope | null;
    interview: boolean;
    offLan: boolean;
    voice: boolean;
    advertisedThisTurn: ReadonlySet<string>;
  },
): InspectGate[] {
  const hits: InspectGate[] = [];
  const { name } = entry;

  if (!toolAllowedForTier(name, opts.tier ?? undefined, opts.voice)) {
    hits.push("write_tier");
  }
  // `scope === null` is "§3 applies no narrowing", not "everything allowed".
  // `toolAllowedInScope` cannot even be called with a null scope, which is the
  // type system saying the same thing.
  if (opts.scope && !toolAllowedInScope(name, opts.scope)) hits.push("role_grant");
  if (opts.interview && WRITE_TOOLS.has(name)) hits.push("interview_strip");
  if (opts.offLan && isWithheldFromOffLan(name)) hits.push("off_lan_withhold");
  if (EXCLUDED_FROM_CHAT_TOOLS.has(name)) hits.push("chat_policy");
  if (!opts.advertisedThisTurn.has(name)) hits.push("turn_relevance");

  return hits;
}

/**
 * The pool a turn selects from: the registry minus the two name-axis gates,
 * the interview strip, the off-LAN withholding and the chat-scope policy.
 *
 * Mirrors the composition order in `routes/llm.ts` rather than re-deriving it
 * — this is the input `effectiveAdvertisedToolNames` expects, and handing it a
 * pool assembled any other way would make the relevance answer wrong in a way
 * no test of this file alone could catch.
 */
function poolFor(opts: {
  tier: string | null;
  scope: ToolAccessScope | null;
  interview: boolean;
  offLan: boolean;
  voice: boolean;
}): string[] {
  return TOOL_CATALOG.filter((e) => {
    if (!toolAllowedForTier(e.name, opts.tier ?? undefined, opts.voice)) return false;
    if (opts.scope && !toolAllowedInScope(e.name, opts.scope)) return false;
    if (opts.interview && WRITE_TOOLS.has(e.name)) return false;
    if (opts.offLan && isWithheldFromOffLan(e.name)) return false;
    if (EXCLUDED_FROM_CHAT_TOOLS.has(e.name)) return false;
    return true;
  }).map((e) => e.name);
}

/**
 * One row per registered tool, for one person, on one modelled turn.
 *
 * Read-only in every sense: it takes no action, and it resolves the TARGET's
 * reach, never the caller's. A page that quietly showed the admin their own
 * tools while claiming to show somebody else's would be the most convincing
 * possible way to get this wrong.
 */
export async function inspectToolsForPerson(
  prisma: PrismaClient,
  input: ToolInspectInput,
): Promise<ToolInspectResult> {
  const attributed: AttributedToolAccess = await resolveAttributedToolAccess(
    prisma,
    input.targetUserId,
  );

  const interview = input.interview ?? false;
  const offLan = input.offLan ?? false;
  const voice = input.voice ?? false;

  // An unresolvable identity denies everything. Modelling that with
  // DENY_ALL_TOOL_SCOPE rather than an early return keeps ONE row-building
  // path: the rows still say which gate refused (role_grant, for every tool),
  // and the caller reads `unresolved` for the reason the scope is what it is.
  const scope: ToolAccessScope | null = attributed.unresolved
    ? DENY_ALL_TOOL_SCOPE
    : attributed.scope;
  const tier = attributed.tier;

  const advertisedThisTurn = attributed.unresolved
    ? new Set<string>()
    : effectiveAdvertisedToolNames({
        mode: input.selectionMode ?? "domains",
        messages: [{ role: "user", content: input.message ?? "" }],
        pool: poolFor({ tier, scope, interview, offLan, voice }),
        // The dynamic half of the universe, passed for the same reason the
        // wire path passes it: a registered remote tool can open a domain, and
        // an inspector that omitted them would report `turn_relevance` on a
        // tool the real turn advertises. Empty on a box with no remote server.
        runtimeTools: runtimeToolRegistry.list(),
      });

  const byGate = Object.fromEntries(INSPECT_GATES.map((g) => [g, 0])) as Record<
    InspectGate,
    number
  >;

  const rows: ToolInspectRow[] = TOOL_CATALOG.map((entry) => {
    const hits = gatesWithholding(entry, {
      tier,
      scope,
      interview,
      offLan,
      voice,
      advertisedThisTurn,
    });
    const gate = hits[0] ?? null;
    if (gate) byGate[gate] += 1;

    // §3 locks: a name-axis pass says nothing about whether a LOCK call would
    // be permitted, because that rule needs resolved args and is decided at
    // dispatch. Say so on the row rather than let "advertised" imply more than
    // it means.
    const lockCaveat =
      !gate && VOICE_WRITE_TOOLS.has(entry.name) && scope && !scope.locks
        ? "Advertised, but a lock or unlock through it is refused at the moment it is called."
        : undefined;

    return {
      name: entry.name,
      domain: entry.domain,
      homeDescription: entry.homeDescription,
      requiresWrite: entry.requiresWrite,
      requiresConfirmation: entry.requiresConfirmation,
      advertised: gate === null,
      gate,
      reason: gate ? REASONS[gate](entry, tier) : null,
      alsoWithheldBy: hits.slice(1),
      ...(lockCaveat ? { lockCaveat } : {}),
    };
  });

  const advertised = rows.filter((r) => r.advertised).length;

  return {
    targetUserId: input.targetUserId,
    tier,
    unresolved: attributed.unresolved,
    noRoleNarrowing: !attributed.unresolved && attributed.scope === null,
    counts: {
      registered: rows.length,
      advertised,
      withheld: rows.length - advertised,
      byGate,
    },
    rows,
  };
}

/**
 * The core tools, exported so the page can label them.
 *
 * They are applied BY NAME inside `selectAdvertisedTools`, ahead of any domain
 * matching, which is why a turn that matches nothing still advertises five
 * tools rather than none — a fact the relevance column looks wrong without.
 */
export const INSPECT_CORE_TOOL_NAMES: readonly string[] = [...CORE_TOOL_NAMES];
