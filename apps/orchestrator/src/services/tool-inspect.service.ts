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
 *
 * ── Runtime tools (WARP-2900, ADR-056 slice H4) ────────────────────────────
 *
 * A promoted extension or a connected vendor server adds tools that exist
 * only at runtime (`runtimeToolRegistry`). The chat path lists them through
 * the multiplexer and narrows them with the SAME name predicates as a
 * compiled tool — so they get a row here, run through the same gates, with
 * two differences that are both the shipped behaviour rather than a choice:
 *
 *   - `role_grant`: a runtime tool has no catalog entry, and
 *     `toolAllowedInScope` fails closed on that, so a person with a custom
 *     role never reaches one. The reason says so instead of naming an area.
 *   - the dispatch verdict is NOT a gate. The multiplexer's `listTools()`
 *     advertises every vetted remote tool and asks the remote call policy
 *     (the WARP-2426 record, for an extension) only inside `callTool`. So
 *     the model IS shown an unreviewed extension tool — its schema costs
 *     window budget and invites a call — and every call is refused
 *     (REMOTE_WRITE_NOT_PERMITTED until an owner reviews it as a read).
 *     The row stays `advertised` and carries the refusal as `callRefusal`,
 *     counted in `refusedAtDispatch`, the way `lockCaveat` says "advertised,
 *     but a lock call is refused". Counting it as withheld would understate
 *     what the model receives. The verdict is the policy's answer, obtained
 *     by calling it (runtime-tool-view.service.ts).
 *
 * A runtime row never carries the wire description: `homeDescription` is a
 * sentence this box writes from the name and the source.
 */
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG } from "@droplet/tools-core";

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
import {
  runtimeToolRegistry,
  type RuntimeToolDescriptor,
} from "./runtime-tool-registry.service.js";
import type { RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import { remoteCallPolicy } from "./mcp-client.singleton.js";
import {
  classifyRuntimeTool,
  extensionOfRuntimeTool,
  runtimeToolSource,
  wireNameOf,
  type RuntimeToolClassificationView,
} from "./runtime-tool-view.service.js";
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
  // WARP-2900 — a runtime tool's dispatch verdict is deliberately absent: it
  // is decided inside callTool, after the tool has been advertised, so it is
  // `ToolInspectRow.callRefusal`, not a gate.
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
  /**
   * WARP-2900 — where the tool comes from: `built-in` for a compiled tool,
   * `extension:<slug>@<version>` for a promoted extension, `remote:<serverId>`
   * for any other runtime server.
   */
  source: string;
  /** The runtime server that advertised it. Null for a compiled tool. */
  serverId: string | null;
  /**
   * WARP-2900 — runtime rows only: what the dispatch policy answers for a
   * call to this tool (the classification that applied). For a runtime row,
   * `requiresWrite` / `requiresConfirmation` say what dispatch treats it as:
   * only an allowed tool is a read; everything else is held as a confirming
   * write, the import default.
   */
  classification?: RuntimeToolClassificationView;
  /**
   * WARP-2900 — runtime rows only, set ⇔ the dispatch policy denies every
   * call to it. One sentence saying so. NOT a withholding gate: an advertised
   * row with a `callRefusal` is a tool the model is shown and cannot use.
   */
  callRefusal?: string;
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
    /**
     * WARP-2900 — how many ADVERTISED rows carry a `callRefusal`: tools the
     * model is shown whose every call dispatch refuses. A subset of
     * `advertised`, never of `withheld`.
     */
    refusedAtDispatch: number;
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

/** Injectable for tests; production uses the process-wide registry and policy. */
export interface ToolInspectDeps {
  /** The runtime half of the universe. Defaults to `runtimeToolRegistry.list()`. */
  runtimeTools?: readonly RuntimeToolDescriptor[];
  /**
   * The policy the multiplexer dispatches remote calls through. Defaults to
   * the process-wide `remoteCallPolicy`, read lazily.
   */
  remoteCallPolicy?: RemoteCallPolicy;
}

/** What the gates need to know about a row's tool, compiled or runtime. */
interface GateSubject {
  name: string;
  domain: string;
  requiresWrite: boolean;
  /** Present ⇔ a runtime tool. */
  runtime?: true;
}

const RUNTIME_REFUSAL: Record<string, string> = {
  REMOTE_WRITE_NOT_PERMITTED:
    `The assistant is shown it, but every call is refused: it starts as a change ` +
    `that asks first, and this box cannot yet ask before a tool it did not build ` +
    `makes a change. An owner can review it as read-only.`,
  REMOTE_TOOL_DENIED: `An owner blocked it. The assistant is shown it, but every call is refused.`,
  REMOTE_TOOL_NOT_CLASSIFIED:
    `Nobody has classified it on this box yet, so the assistant is shown it but every call is refused.`,
};

const REASONS: Record<InspectGate, (e: GateSubject, tier: string | null) => string> = {
  write_tier: (_e, tier) =>
    `It changes something, and ${tier ?? "this person"} is not owner or admin. ` +
    `The assistant can read on their behalf; it cannot act on their behalf.`,
  role_grant: (e) =>
    e.runtime
      ? `Their role is a custom one, and custom roles do not reach tools added at runtime ` +
        `(an extension or a connected server).`
      : `Their role does not reach the "${e.domain}" area` +
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

/** The row's `callRefusal`: undefined ⇔ the policy allows the call. */
function callRefusalOf(classification: RuntimeToolClassificationView): string | undefined {
  if (classification.decision === "allow") return undefined;
  const code = classification.code ?? "";
  return RUNTIME_REFUSAL[code] ?? `The assistant is shown it, but every call is refused (${code}).`;
}

/**
 * Evaluate every gate for one tool. Returns them in dispatch order, so the
 * head of the list is the gate that actually fired.
 *
 * Note the deliberate absence of any short-circuit: the caller wants the whole
 * set, not the first hit, and evaluating them all is what makes
 * `alsoWithheldBy` mean something.
 */
function gatesWithholding(
  entry: GateSubject,
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
function poolFor(
  names: readonly string[],
  opts: {
    tier: string | null;
    scope: ToolAccessScope | null;
    interview: boolean;
    offLan: boolean;
    voice: boolean;
  },
): string[] {
  // WARP-2900 — `names` is the compiled catalog plus the runtime tools: the
  // chat path's pool is `mcpClient.listTools()`, which carries both, narrowed
  // by the same predicates below.
  return names.filter((name) => {
    if (!toolAllowedForTier(name, opts.tier ?? undefined, opts.voice)) return false;
    if (opts.scope && !toolAllowedInScope(name, opts.scope)) return false;
    if (opts.interview && WRITE_TOOLS.has(name)) return false;
    if (opts.offLan && isWithheldFromOffLan(name)) return false;
    if (EXCLUDED_FROM_CHAT_TOOLS.has(name)) return false;
    return true;
  });
}

/** snake_case → "Snake case", for a runtime row's box-written label. */
function humanize(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A runtime row's `homeDescription`, written by this box from the name and
 * the source. Never the wire description: that is the author's claim.
 */
function runtimeLabel(tool: RuntimeToolDescriptor): string {
  const ext = extensionOfRuntimeTool(tool);
  const from = ext ? `the ${ext.id} extension, version ${ext.version}` : `the ${tool.serverId} server`;
  return `${humanize(wireNameOf(tool))}, from ${from}`;
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
  deps: ToolInspectDeps = {},
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
  const runtimeTools = deps.runtimeTools ?? runtimeToolRegistry.list();
  // Lazy on purpose: suites that mock the singleton never reach it unless a
  // runtime tool exists, and a box with none never consults it.
  const policy: RemoteCallPolicy = deps.remoteCallPolicy ?? ((i) => remoteCallPolicy(i));

  const advertisedThisTurn = attributed.unresolved
    ? new Set<string>()
    : effectiveAdvertisedToolNames({
        mode: input.selectionMode ?? "domains",
        messages: [{ role: "user", content: input.message ?? "" }],
        pool: poolFor(
          [...TOOL_CATALOG.map((e) => e.name), ...runtimeTools.map((t) => t.name)],
          { tier, scope, interview, offLan, voice },
        ),
        // The dynamic half of the universe, passed for the same reason the
        // wire path passes it: a registered remote tool can open a domain, and
        // an inspector that omitted them would report `turn_relevance` on a
        // tool the real turn advertises. Empty on a box with no remote server.
        runtimeTools,
      });

  const byGate = Object.fromEntries(INSPECT_GATES.map((g) => [g, 0])) as Record<
    InspectGate,
    number
  >;

  const gateOpts = { tier, scope, interview, offLan, voice, advertisedThisTurn };

  const rows: ToolInspectRow[] = TOOL_CATALOG.map((entry) => {
    const hits = gatesWithholding(entry, gateOpts);
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
      source: "built-in",
      serverId: null,
    };
  });

  // WARP-2900 — the runtime half, through the same gates, with the dispatch
  // verdict recorded beside them rather than as one. The multiplexer never registers a runtime name that matches a
  // compiled one (WARP-2420), so a runtime row cannot shadow a compiled row.
  const compiled = new Set(TOOL_CATALOG.map((e) => e.name));
  for (const tool of runtimeTools) {
    if (compiled.has(tool.name)) continue;
    const classification = classifyRuntimeTool(tool, policy);
    const readAllowed = classification.decision === "allow";
    const subject: GateSubject = {
      name: tool.name,
      domain: tool.domain,
      requiresWrite: !readAllowed,
      runtime: true,
    };
    const callRefusal = callRefusalOf(classification);
    const hits = gatesWithholding(subject, gateOpts);
    const gate = hits[0] ?? null;
    if (gate) byGate[gate] += 1;
    rows.push({
      name: tool.name,
      domain: tool.domain,
      homeDescription: runtimeLabel(tool),
      requiresWrite: !readAllowed,
      requiresConfirmation: !readAllowed,
      advertised: gate === null,
      gate,
      reason: gate ? REASONS[gate](subject, tier) : null,
      alsoWithheldBy: hits.slice(1),
      source: runtimeToolSource(tool),
      serverId: tool.serverId,
      classification,
      ...(callRefusal ? { callRefusal } : {}),
    });
  }

  const advertised = rows.filter((r) => r.advertised).length;
  const refusedAtDispatch = rows.filter((r) => r.advertised && r.callRefusal).length;

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
      refusedAtDispatch,
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
