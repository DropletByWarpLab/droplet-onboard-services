/**
 * The one place that answers "may this principal invoke this tool".
 *
 * TWO independent narrowing axes live here, and a tool must clear BOTH:
 *
 *   A. ADR-004 — the coarse WRITE-TIER gate. Non-privileged tiers
 *      (family/guest/service) lose every `requiresWrite` tool outright,
 *      regardless of any AccessRole. Shipped long before RBAC v2; it is what
 *      chat has always enforced via `narrowAllowedToolsForRole`.
 *   B. WARP-1529 / ADR-032 §3 axis d (RBAC v2 T5) — per-role tool-domain
 *      narrowing, for the people who actually hold an AccessRole.
 *
 * Neither is a superset of the other. (A) catches the role-less user (B)
 * deliberately skips — which is every user on every box in the field today.
 * (B) catches a privileged tier whose role was never granted the domain.
 * WARP-1621 moved (A) here, out of routes/llm.ts, because the ToolSpec run
 * path could not reach it there and so enforced only (B): a `family` user
 * pressed Run on a spec calling `control_device` and it fired, while the same
 * tool was stripped from their chat turn before the model saw it. A second
 * copy of a tool filter is exactly how two surfaces come to disagree, so
 * `narrowAllowedToolsForRole` now DELEGATES to this file rather than owning
 * its own predicate.
 *
 * ── axis B (§3) in detail ──────────────────────────────────────────
 *
 * ONE predicate, TWO enforcement points:
 *
 *   1. CATALOG (UX) — routes/llm.ts `narrowAllowedToolsForRole` and the agent
 *      loop's advertised pool. Decides what the model is even told about.
 *   2. DISPATCH (security) — llm-agent.service.ts, immediately before
 *      `deps.mcp.callTool`. Fail-closed: a stale client tool shelf (an
 *      `allowed_tools` list a browser tab cached before the role changed, or
 *      a replayed tool_call) cannot invoke a tool the catalog would have
 *      dropped. The catalog filter is a courtesy; THIS is the boundary.
 *
 * WARP-1580 added a THIRD consumer of the same predicate — the ToolSpec
 * runner (services/tool-spec-runner.service.ts), reached from run-now
 * (routes/tools.ts) and the WARP-463 schedule ticker. It imports
 * `firstForbiddenToolName` + `toolDispatchDenial` from here rather than
 * re-deriving anything; a second copy of the narrowing is exactly how two
 * surfaces drift apart (the shape of both WARP-1523 and WARP-1564).
 *
 * §3 verbatim for this axis:
 *
 *   toolDomains = writeFilter(tier) ∩ moduleToolDomains(features) ∩ roleToolGrants
 *   locks       = role.mayOperateLocks && smart_home ∈ features
 *
 * The first two intersections and the locks flag are resolved by T3
 * (effective-access.service.ts) — consumed here, never re-derived. In
 * particular the module→tool-domain join has exactly ONE derivation in the
 * tree: access-catalog.ts's MODULE_BY_DOMAIN / domainsForFeatures, which T3's
 * resolver calls. Nothing in this file walks `MODULES[].toolDomains`; a second
 * walk is how the two copies drift apart and a module-off stops gating (the
 * shape of the pre-T3 bug where `matter`/`devices` were never catalog values).
 *
 * What T3's §5 wire shape deliberately does NOT carry is the per-domain grant
 * LEVEL (`view` | `use`), because `toolDomains` is a flat domain list; so the
 * level axis is read here, straight off `AccessRoleToolGrant`, and joined onto
 * T3's resolved domains. Write-capability is decided by tools-core's
 * `requiresWrite` on every tool — never a hand-maintained list (the same
 * discipline as the orchestrator's WRITE_TOOLS).
 *
 * COST. The scope is resolved ONCE per chat turn, in the route, and passed
 * down as a plain value; both enforcement points are then pure in-memory
 * predicates — the dispatch gate never re-reads anything, no matter how many
 * tools a turn calls. A person with no AccessRole (everyone today) costs one
 * indexed `User` lookup and never reaches the §3 resolver at all; a role
 * holder additionally pays that resolver's reads once per turn, against a
 * turn that is already seconds of inference. T3's "DB-read per request, no
 * cache in v1" decision stands.
 *
 * ── WARP-1582: eliding that one lookup, and why it is safe ──────────
 *
 * The lookup above is on the chat hot path. WARP-1582 lets the chat turn
 * skip it using the session's `accessRoleId` claim. A claim is a SNAPSHOT,
 * so this is an authorization input that can go stale — the opposite of
 * everything else this epic did. It is therefore scoped hard, and the
 * argument is written down here rather than assumed.
 *
 * WHAT IS TRUSTED. Exactly one decision: "the claim is PRESENT and says
 * `null`, therefore no custom role exists, therefore no narrowing applies."
 * Nothing else. A claim that NAMES a role buys nothing — the grants still
 * have to be read — so the database remains the only grant source, and the
 * claim is never an input to what a role may do.
 *
 * WHICH DIRECTION CAN GO WRONG. Only one:
 *
 *   claim `null` + row non-null  →  FAIL-OPEN. Someone was narrowed after
 *       their token was minted, and the narrowing is not yet applied.
 *   claim non-null + row null    →  safe by construction. We read anyway,
 *       and the read is authoritative.
 *   claim absent                 →  safe by construction. Absent means
 *       unknown; we read.
 *
 * WHY THE FAIL-OPEN DIRECTION IS CLOSED. Every transition that sets
 * `User.accessRoleId` from null to non-null revokes the person's sessions:
 *
 *   - POST /api/access/roles/:id/assign  → revokeAllSessions per member,
 *     on BOTH branches (tier crossing and same-tier swap).
 *   - PUT  /api/people/:id/role          → same, via runRoleChangePostEffects
 *     or the explicit else-branch revoke.
 *   - invite accept                      → the session is minted AFTER the
 *     assignment, in the same request, so it is born fresh.
 *   - role delete                        → 409s while any member holds the
 *     role; it never assigns one.
 *
 * And revocation reaches an ACCESS token, not just a refresh: revokeAllSessions
 * deletes `sess:rec:{sid}`, and middleware/auth.ts 401s the very next request
 * whose sid has no record. The window is one request, not one token lifetime.
 * The refresh path additionally re-derives the claim from the User row
 * (WARP-116's existing "DB role wins" rule), so a claim self-heals every
 * ≤15 min even if a revoke was missed.
 *
 * RESIDUAL WINDOWS, stated honestly. Three, and all three are PRE-EXISTING
 * and shared with the `role` claim this function already trusts:
 *   (a) sid-less legacy access tokens skip checkSession entirely (≤15 min);
 *   (b) checkSession fails OPEN when Redis is unreachable;
 *   (c) revokeAllSessions swallows a Redis error, so a sweep can be partial.
 * In every one of those conditions a stale `role: "owner"` claim already
 * grants the §3 owner bypass — total reach, no narrowing, no read. A stale
 * `accessRoleId: null` is strictly narrower than a hazard already accepted.
 * This adds no new trust class; it extends an existing one to a weaker axis.
 *
 * WHY NOT SIMPLY EVERYWHERE. Because "closed by a mechanism elsewhere" is a
 * weaker guarantee than "cannot be stale", and it should not be the default
 * anyone inherits. Hence {@link ToolScopeTrust}: DEFAULT `"database"`, the
 * shipped behaviour, and an explicit `"session-claim"` opt-in. Exactly one
 * production surface opts in — the chat turn — and
 * __tests__/tool-scope-claim-trust.guard.test.ts pins that list.
 *
 * The chat turn is the right place and the ToolSpec runner is not, for a
 * reason that is NOT "reads vs writes" — a chat turn can absolutely call a
 * write tool. It is layering and blast radius. On the chat path the elided
 * T5 narrowing is one gate among several that still run per turn (the coarse
 * ADR-004 write filter off the request role in narrowAllowedToolsForRole, the
 * WARP-642 replay guard, tools-core's `requiresWrite`, the layer-1 route
 * guards). The ToolSpec run-now path executes a whole multi-step sequence
 * unattended from a single imperative request with no per-turn latency
 * budget worth trading, and its scheduled twin
 * ({@link resolveAttributedToolAccess}) has no claim to trust at all — so
 * letting run-now trust one would make the same spec enforce differently
 * depending on whether a human pressed Run.
 *
 * WHAT THIS BUYS. One indexed primary-key `User` read per chat turn, for the
 * role-less majority. Small in isolation; the point is that it is the only
 * DB read the narrowing costs someone who is not narrowed at all, so after
 * this the T5 machinery is free for everyone it does not apply to.
 *
 * WHO IS NARROWED. Only people who actually hold an AccessRole:
 *
 *   - `owner`   → null scope. §3 owner bypass, full control.
 *   - `service` → null scope. Service principals keep their dedicated
 *                 requireRoleOrService paths and never resolve through the
 *                 §3 resolver (the `_service:voice` write scope is untouched).
 *   - accessRoleId === null → null scope. EVERY user on a box today. Their
 *                 tool reach stays byte-identical to the pre-T5 world: the
 *                 coarse ADR-004 write filter is still the only narrowing.
 *                 T5 must not start dropping tools from people nobody has
 *                 assigned a custom role to — that would ship a silent
 *                 capability regression to every deployed box.
 *   - everyone else → the narrowed scope below.
 *
 * FAIL-CLOSED. When the resolver cannot answer — missing user row, DB error,
 * an unwired §3 resolver — it returns {@link DENY_ALL_TOOL_SCOPE} rather than
 * `null`. "I couldn't check" must never resolve to "full reach": a transient
 * read error would otherwise hand a deliberately-narrowed role the whole
 * registry. The turn still answers; it just answers without tools, and the
 * ADR-004 layer-1 route guards keep enforcing throughout.
 *
 * WHICH `role` IS AUTHORITATIVE. The owner/service short-circuits read the
 * REQUEST principal's role — the same claim `requireRole` and
 * `isPrivilegedRole` already trust app-wide — so the tool surface doesn't
 * grow a second, divergent authorization identity (and an owner's chat turn
 * doesn't gain a DB read to answer a question the token already answered).
 * `writeDomains` below uses the §3 resolver's `tier`, which comes from the
 * User row. If the two ever disagree (a stale token across a demotion), the
 * composition stays conservative in BOTH directions: the coarse write filter
 * in narrowAllowedToolsForRole runs off the request role, this scope's write
 * axis runs off the row, and a tool needs to clear both.
 */
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG, TOOLS } from "@droplet/tools-core";
import type { Role } from "./jwt.service.js";
import { resolveEffectiveAccess } from "./effective-access.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tool-access");

/** name → catalog entry (domain + the authoritative `requiresWrite` flag). */
const CATALOG_BY_NAME: ReadonlyMap<string, (typeof TOOL_CATALOG)[number]> = new Map(
  TOOL_CATALOG.map((entry) => [entry.name, entry] as const),
);

/**
 * The resolved per-person tool reach. Deliberately tier-free: the tier's
 * write filter is folded into `writeDomains` at resolve time so both
 * enforcement points share one flag-free predicate.
 */
export interface ToolAccessScope {
  /** §3 `toolDomains` — writeFilter(tier) ∩ moduleToolDomains ∩ roleToolGrants. */
  domains: ReadonlySet<string>;
  /**
   * Domains whose `requiresWrite` tools are still reachable: the role granted
   * `use` AND the tier keeps write tools at all. A `use` grant never widens a
   * family/guest tier past the ADR-004 floor — §3 intersects, it never unions.
   */
  writeDomains: ReadonlySet<string>;
  /** §3 `locks` — role.mayOperateLocks ∧ smart_home ∈ features. */
  locks: boolean;
}

/** The fail-closed scope: no domain, no write, no locks. */
export const DENY_ALL_TOOL_SCOPE: ToolAccessScope = Object.freeze({
  domains: new Set<string>(),
  writeDomains: new Set<string>(),
  locks: false,
});

/** Tiers that keep write tools at all (the shipped ADR-004 write filter). */
function tierKeepsWriteTools(tier: Role | string | undefined): boolean {
  return tier === "owner" || tier === "admin";
}

// ── axis A: the ADR-004 coarse write-tier gate ─────────────────────

/**
 * Which tool names require the caller to be owner/admin. Read-only tools
 * (list_*, get_*, search_*) are fine for any authenticated user; write tools
 * (block/unblock/accept/scan, file mutations, device control) must be gated
 * because the LLM is driven by user-controlled prompt text and will happily
 * call them on request — and, since WARP-462, because a ToolSpec is a stored
 * program a non-privileged user can fire with one button.
 *
 * Derived directly from each tool's `requiresWrite` boolean in
 * `@droplet/tools-core` (WARP-104) so gate behaviour can never drift from
 * per-tool intent: adding a write tool to the registry automatically includes
 * it here. Legacy aliases `block_device` / `unblock_device` are not registered
 * in tools-core — callers must use the canonical
 * `block_network_device` / `unblock_network_device` names.
 *
 * Moved here from routes/llm.ts by WARP-1621: it was unreachable from the
 * ToolSpec surfaces while it lived inside a route module.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  Array.from(TOOLS.values())
    .filter((t) => t.requiresWrite)
    .map((t) => t.name),
);

/**
 * WARP-2665 — the one place a tool list is classified as writing.
 *
 * Three surfaces decide something from "does this spec call a write tool":
 * the routes' authoring-time reconcile (which names the offending tools in
 * its 400), the ticker's fire-time gate, and the pattern miner's `writes`
 * column. Each used to re-derive it against `WRITE_TOOLS` inline, and one
 * classification site drifting from another is exactly how the miner's
 * copy came to be a hardcoded `false`. `writeToolsIn` is the predicate;
 * `hasWriteTool` is the boolean the two gates read.
 */
export function writeToolsIn(names: ReadonlyArray<string>): string[] {
  return names.filter((name) => WRITE_TOOLS.has(name));
}

export function hasWriteTool(names: ReadonlyArray<string>): boolean {
  return writeToolsIn(names).length > 0;
}

/**
 * WARP-1398 — the always-on voice assistant runs as the `_service:voice`
 * principal. ADR-004 §3 makes service principals read-only by DEFAULT; this is
 * the one documented, scoped exception (ADR-004 amendment, approved
 * 2026-07-18): voice may drive the smart-home CONTROL tools so "hey Droplet,
 * turn off the kitchen lights" works. Every OTHER service principal
 * (email-indexer, etc.) stays read-only — callers gate on the exact principal
 * id via `isVoicePrincipal`, not the coarse `service` role. Locks are NOT in
 * this set at the tool level, but a `control_device` lock command is Tier-2
 * (confirmation_required) and the voice flow can't complete a confirmation, so
 * locks stay refused via voice until per-speaker enrollment (WARP-1056)
 * provides an identity to gate on.
 *
 * Deliberately just `control_device` — NOT `run_scene`: a routine can contain
 * a lock command, which would bypass the per-command Tier-2 lock refusal, so
 * voice-run scenes wait on scene-level lock analysis (follow-up).
 *
 * Never true on a ToolSpec surface: the runs route's `requireRole` excludes
 * `service`, and a scheduled fire's attributed principal must own a User row,
 * which no `_service:*` id does.
 */
export const VOICE_WRITE_TOOLS: ReadonlySet<string> = new Set(["control_device"]);

/**
 * The ADR-004 privileged tiers. Threat model: the LLM is steered by
 * user-controlled prompt text, and a ToolSpec is a stored program with a Run
 * button; only owner/admin may touch write tools.
 */
export function isPrivilegedRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Axis A alone: may this TIER invoke `name` at all, ignoring AccessRoles?
 *
 * Deliberately name-only and args-free — which is what makes a whole-list
 * PRE-FLIGHT complete for this axis (unlike the §3 lock rule, which needs
 * resolved args and can only be decided at dispatch).
 */
export function toolAllowedForTier(
  name: string,
  tier: string | undefined,
  isVoice = false,
): boolean {
  if (isPrivilegedRole(tier)) return true;
  return !WRITE_TOOLS.has(name) || (isVoice && VOICE_WRITE_TOOLS.has(name));
}

// ── the shared predicate ───────────────────────────────────────────

/**
 * May this scope invoke `name`? Fail-closed on anything unrecognised: a tool
 * with no catalog entry has no domain, so it cannot be shown to be in reach.
 */
export function toolAllowedInScope(name: string, scope: ToolAccessScope): boolean {
  const entry = CATALOG_BY_NAME.get(name);
  if (!entry) return false;
  if (!scope.domains.has(entry.domain)) return false;
  if (entry.requiresWrite && !scope.writeDomains.has(entry.domain)) return false;
  return true;
}

/** Filter a candidate tool-name list to what `scope` may invoke (order kept). */
export function narrowToolNamesToScope(
  names: readonly string[],
  scope: ToolAccessScope,
): string[] {
  return names.filter((n) => toolAllowedInScope(n, scope));
}

/**
 * The object-shaped sibling of `narrowToolNamesToScope`: filter a candidate
 * list of tool-like objects to what `scope` may invoke (order kept).
 *
 * An absent scope (`null`/`undefined`) — the owner bypass, service principals,
 * anyone with no AccessRole — narrows nothing, and the list is returned
 * unchanged. Carrying that case HERE is the point: both call sites need it,
 * and expressing it twice is how the two can disagree. Both nullish forms are
 * accepted because the request field is `ToolAccessScope | null | undefined`.
 *
 * WARP-2556 follow-up. The "is this tool in scope" rule had drifted into three
 * independent expressions — the estimate's pool filter in `routes/llm.ts`, the
 * dispatch filter in `llm-agent.service.ts`, and this module's name-list
 * helper. That is precisely the shape that let the estimate-side copy be lost
 * in the WARP-2497 × WARP-2552 conflict resolution with no compiler signal,
 * which is the defect WARP-2556 exists to fix. A new access axis added to
 * `toolAllowedInScope` now reaches every narrowing site by construction.
 */
export function narrowToolsToScope<T extends { name: string }>(
  tools: readonly T[],
  scope: ToolAccessScope | null | undefined,
): readonly T[] {
  if (!scope) return tools;
  return tools.filter((t) => toolAllowedInScope(t.name, scope));
}

/**
 * WARP-1580 — the whole-list PRE-FLIGHT: the first name in `names` this scope
 * may not invoke, or `null` when every name is in reach.
 *
 * Used by the ToolSpec surfaces, which — unlike a chat turn — know the entire
 * call sequence before the first dispatch. Checking up front is what lets a
 * forbidden spec be refused WHOLE instead of half-executing up to the
 * offending step. `null`/absent scope means no narrowing applies and nothing
 * is forbidden (owner, service, and every role-less user).
 *
 * NAME-ONLY by construction. The args-dependent rule (§3 `locks`) cannot be
 * decided here because a step's args may carry a `${prev}` reference that
 * only resolves once the previous step has returned — so `lockOperationDenied`
 * stays where it can see resolved args, at dispatch. This pre-flight is the
 * courtesy; the runner's per-step {@link toolDispatchDenial} is the boundary.
 */
export function firstForbiddenToolName(
  names: readonly string[],
  scope: ToolAccessScope | null | undefined,
): string | null {
  if (!scope) return null;
  for (const name of names) {
    if (!toolAllowedInScope(name, scope)) return name;
  }
  return null;
}

// ── A ∧ B: the composed answer every surface asks ──────────────────

/** Which axis refused. Operator-facing: "your tier has no write tools at all"
 *  and "your access role was never granted this domain" have different fixes,
 *  and an operator chasing a stopped automation needs to know which. */
export type ToolDenialAxis = "write_tier" | "role_grant";

/**
 * WARP-1621 — the whole question, in one call: may `tier` (axis A), holding
 * `scope` (axis B), invoke `name`?
 *
 * `scope === null` means axis B does not apply — the §3 owner bypass, service
 * principals, and everyone with no AccessRole. It does NOT mean "no
 * narrowing": axis A still runs, which is precisely the layer the ToolSpec
 * surfaces were missing.
 */
export function toolAllowedForPrincipal(
  name: string,
  tier: string | undefined,
  scope: ToolAccessScope | null | undefined,
  isVoice = false,
): boolean {
  if (!toolAllowedForTier(name, tier, isVoice)) return false;
  return !scope || toolAllowedInScope(name, scope);
}

/**
 * Filter a candidate tool-name list to what this principal may invoke (order
 * kept). The catalog-build half of enforcement; `routes/llm.ts`'s
 * `narrowAllowedToolsForRole` is a thin wrapper over exactly this.
 */
export function narrowToolNamesForPrincipal(
  names: readonly string[],
  tier: string | undefined,
  scope: ToolAccessScope | null | undefined,
  isVoice = false,
): string[] {
  return names.filter((n) => toolAllowedForPrincipal(n, tier, scope, isVoice));
}

/**
 * The whole-list PRE-FLIGHT across BOTH axes: the first name this principal
 * may not invoke, with the axis that refused it — or `null` when every name is
 * in reach.
 *
 * Used by the ToolSpec surfaces, which (unlike a chat turn) know the entire
 * call sequence before the first dispatch. Checking up front is what lets a
 * forbidden spec be refused WHOLE instead of half-executing up to the
 * offending step — a half-applied automation is worse than a refused one, and
 * the caller cannot undo it.
 *
 * Axis A is checked first per name, so a role-less caller (no scope at all)
 * still gets a precise reason rather than a bare "forbidden".
 *
 * NAME-ONLY by construction, as both axes' name rules are. The args-dependent
 * rule (§3 `locks`) cannot be decided here because a step's args may carry a
 * `${prev}` reference that only resolves once the previous step has returned —
 * so `lockOperationDenied` stays where it can see resolved args, at dispatch.
 * A spec's tool NAMES are static (`parseCallStep` requires a literal string
 * and `${prev}` substitution never touches them), so for the name axes this
 * pre-flight is complete, not merely a courtesy.
 */
export function firstToolDeniedForPrincipal(
  names: readonly string[],
  tier: string | undefined,
  scope: ToolAccessScope | null | undefined,
  isVoice = false,
): { tool: string; axis: ToolDenialAxis } | null {
  for (const name of names) {
    if (!toolAllowedForTier(name, tier, isVoice)) {
      return { tool: name, axis: "write_tier" };
    }
    if (scope && !toolAllowedInScope(name, scope)) {
      return { tool: name, axis: "role_grant" };
    }
  }
  return null;
}

// ── mayOperateLocks (§3 locks) ─────────────────────────────────────

/**
 * Mirrors the vocabulary of tools-core's
 * `handlers/smart-home/control-device.ts` lock detection. Deliberately a
 * SUPERSET-safe substring test, for the same reasons the handler gives: a
 * model can reach for a synonym ("LOCK", "lock_door", "set_lock") or stuff
 * the verb into `data` ({set_locked:true}). Over-matching costs an honest
 * refusal; under-matching costs an unauthorised door.
 *
 * Kept HERE rather than exported from tools-core on purpose — T5 leaves the
 * tools-core package untouched, and this gate is an authorization decision
 * (may this person operate a lock at all) that belongs on the orchestrator
 * side of the trust boundary. The handler's own forced
 * `confirmationRequired` is unchanged and stays the last line of defence
 * for everyone who DOES hold the flag.
 */
export function isLockLikeInvocation(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const record = args as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.toLowerCase() : "";
  if (command.includes("lock")) return true;
  const data = record.data;
  if (data && typeof data === "object") {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (key.toLowerCase().includes("lock")) return true;
      if (typeof value === "string" && value.toLowerCase().includes("lock")) return true;
    }
  }
  return false;
}

/**
 * §3 `locks`: a lock-like smart-home operation additionally requires the
 * role's `mayOperateLocks`. Args-dependent, so this can only be decided at
 * DISPATCH — `control_device` itself stays advertised (it also turns lights
 * on). Scenes are deliberately out of scope: the tools-core handler already
 * documents scene-level lock analysis as its own follow-up, and blocking
 * `run_scene` wholesale here would be a different (larger) refusal than the
 * ticket's.
 */
export function lockOperationDenied(
  name: string,
  args: unknown,
  scope: ToolAccessScope,
): boolean {
  if (scope.locks) return false;
  if (name !== "control_device") return false;
  return isLockLikeInvocation(args);
}

// ── the dispatch gate ──────────────────────────────────────────────

/** Why a dispatch was refused. `code` is model-facing (fed back as the tool
 *  reply) and operator-facing (SSE tool_result + turn trace). */
export interface ToolDispatchDenial {
  code: "FORBIDDEN_TOOL_FOR_ROLE" | "LOCK_OPERATION_NOT_PERMITTED";
  message: string;
}

/**
 * Enforcement point 2: the fail-closed re-check the agent loop runs
 * immediately before `mcp.callTool`. Returns `null` when the call may
 * proceed.
 *
 * A name with no catalog entry returns `null` on purpose — an unregistered /
 * hallucinated name is not an authorization question, and the loop's
 * WARP-642 guard answers it with the list of valid tools so the model can
 * self-correct. Swallowing that here would turn a recoverable typo into an
 * opaque refusal.
 */
export function toolDispatchDenial(
  name: string,
  args: unknown,
  scope: ToolAccessScope | null | undefined,
): ToolDispatchDenial | null {
  if (!scope) return null;
  if (!CATALOG_BY_NAME.has(name)) return null;
  if (!toolAllowedInScope(name, scope)) {
    return {
      code: "FORBIDDEN_TOOL_FOR_ROLE",
      message:
        `The tool '${name}' is not part of this person's access role. ` +
        `Answer without it, or tell them to ask their administrator.`,
    };
  }
  if (lockOperationDenied(name, args, scope)) {
    return {
      code: "LOCK_OPERATION_NOT_PERMITTED",
      message:
        "This person's access role does not permit operating locks. " +
        "Do not retry; tell them to ask their administrator.",
    };
  }
  return null;
}

// ── resolution ─────────────────────────────────────────────────────

/**
 * WARP-1582 — where a call site is willing to resolve `accessRoleId` from.
 *
 *   `"database"`      — always read the User row. The shipped behaviour and
 *                       the DEFAULT: a consumer that has not reasoned about
 *                       claim staleness must not inherit it by omission.
 *   `"session-claim"` — may skip the read when the session claim is PRESENT
 *                       and `null`. Opt-in, enumerated, and justified in
 *                       the module doc above. Read it before adding one.
 */
export type ToolScopeTrust = "database" | "session-claim";

/**
 * Resolve the caller's tool scope, or `null` when no narrowing applies.
 *
 * Cheap path first: one indexed read of `accessRoleId`. Every user on a box
 * today has none, so the common turn pays a single small query and NEVER
 * touches the §3 resolver — which is also what makes the "role-less behaves
 * exactly as today" claim structural rather than incidental. Under
 * `"session-claim"` that last read is elided too when the session already
 * proves there is no role to narrow by.
 */
export async function resolveToolAccessScope(
  prisma: PrismaClient,
  user: { id?: string; role?: string; accessRoleId?: string | null } | undefined,
  trust: ToolScopeTrust = "database",
): Promise<ToolAccessScope | null> {
  const role = user?.role;
  // No principal at all (AUTH_ENABLED=false dev shortcut resolves to owner),
  // the §3 owner bypass, and service principals: unchanged.
  if (!role || role === "owner" || role === "service") return null;
  if (role !== "admin" && role !== "family" && role !== "guest") return null;

  const userId = user?.id;
  if (!userId) {
    logger.error({ role }, "tool_access_scope_no_principal_id");
    return DENY_ALL_TOOL_SCOPE;
  }

  // WARP-1582 — the read elision. Deliberately AFTER the no-principal
  // fail-closed check above: a claim never rescues an identity we could
  // not establish.
  //
  // `=== null`, never `!user.accessRoleId`. An ABSENT claim is `undefined`
  // and must fall through to the read; the falsy test would swallow it and
  // hand every pre-deploy token an un-narrowed scope. That one character is
  // the difference between this being safe and being a fail-open.
  if (trust === "session-claim" && user?.accessRoleId === null) {
    return null;
  }

  let row: AccessRoleIdRow | null;
  try {
    row = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        accessRoleId: true,
        accessRole: { select: { toolGrants: { select: { domain: true, level: true } } } },
      },
    });
  } catch (err) {
    logger.error({ err, userId }, "tool_access_scope_read_failed");
    return DENY_ALL_TOOL_SCOPE;
  }
  if (!row) {
    logger.error({ userId }, "tool_access_scope_user_missing");
    return DENY_ALL_TOOL_SCOPE;
  }
  return composeScopeForRow(userId, row);
}

interface AccessRoleIdRow {
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: string }> } | null;
}

/**
 * The shared tail of BOTH resolvers: the user row is in hand, decide the
 * scope. Split out by WARP-1580 so the request-principal path and the
 * attributed (no-token) path compose identically — the §3 composition has
 * exactly one implementation.
 */
async function composeScopeForRow(
  userId: string,
  row: AccessRoleIdRow,
): Promise<ToolAccessScope | null> {
  // The pre-T5 world: nobody assigned this person a role, so nothing narrows.
  if (row.accessRoleId === null) return null;

  let access: Awaited<ReturnType<typeof resolveEffectiveAccess>>;
  try {
    access = await resolveEffectiveAccess(userId);
  } catch (err) {
    logger.error({ err, userId }, "tool_access_scope_resolve_failed");
    return DENY_ALL_TOOL_SCOPE;
  }
  if (!access) {
    logger.error({ userId }, "tool_access_scope_resolve_empty");
    return DENY_ALL_TOOL_SCOPE;
  }

  const domains = new Set<string>(access.toolDomains);
  const writeDomains = new Set<string>();
  if (tierKeepsWriteTools(access.tier)) {
    for (const grant of row.accessRole?.toolGrants ?? []) {
      if (grant.level === "use" && domains.has(grant.domain)) writeDomains.add(grant.domain);
    }
  }
  return { domains, writeDomains, locks: access.locks };
}

// ── WARP-1580: the ATTRIBUTED principal (no request, no token) ──────

/** Why an attributed principal could not be resolved. Audit-facing. */
export type AttributionFailure =
  | "no_principal"
  | "user_missing"
  | "user_deactivated"
  | "read_failed";

export interface AttributedToolAccess {
  /**
   * `null` means "resolved, and provably needs no narrowing" — the §3 owner
   * bypass or a person with no AccessRole. NOT "unknown": an unresolvable
   * principal yields {@link DENY_ALL_TOOL_SCOPE} with `unresolved` set.
   */
  scope: ToolAccessScope | null;
  /**
   * WARP-1621 — the ADR-004 tier this identity acts at, read off the User ROW
   * (there is no token to trust on this path). `null` when `unresolved` is
   * set: an identity we could not establish has no tier, and the caller must
   * refuse on `unresolved` rather than infer one. Needed because `scope`
   * alone cannot express axis A — a role-less family creator resolves to
   * `scope: null`, which means "no §3 narrowing", NOT "no narrowing".
   */
  tier: string | null;
  /** Non-null ⇔ `scope` is DENY_ALL because the identity could not be trusted. */
  unresolved: AttributionFailure | null;
}

/**
 * WARP-1580 — resolve the tool reach of a stored user id, with NO request
 * principal in play.
 *
 * WHY THIS EXISTS. A scheduled ToolSpec fire has no session, no JWT and no
 * `req.user`, so `resolveToolAccessScope`'s claim-driven short-circuits have
 * nothing to read. Before this, the ticker dispatched through the singleton
 * MCP client with no scope at all — i.e. at FULL registry reach — which made
 * a schedule a laundering path around the T5 narrowing that chat enforces.
 *
 * HOW IT DIFFERS from the request path, deliberately:
 *
 *   - The tier comes off the User ROW, because there is no token to trust.
 *   - `directoryStatus = DEACTIVATED` denies, ahead of the owner bypass. A
 *     deactivated identity is not permitted to act (the login route and the
 *     SSO callback already fail closed on it), so nothing may act AS it —
 *     including a schedule the person left behind.
 *   - An absent / unknown / unreadable id denies instead of resolving to
 *     "no narrowing". This is the inversion that matters: on the request
 *     path "no principal" means AUTH_ENABLED=false and legitimately resolves
 *     to owner; on this path "no principal" means we do not know who is
 *     asking, and a run we cannot attribute must not run at all.
 *
 * `service` rows are not special-cased: service principals are synthetic
 * (`_service:*`) and own no User row, so they resolve to `user_missing` and
 * deny — which is correct, nothing should be scheduling specs as a service.
 */
export async function resolveAttributedToolAccess(
  prisma: PrismaClient,
  userId: string | null | undefined,
): Promise<AttributedToolAccess> {
  const deny = (unresolved: AttributionFailure): AttributedToolAccess => ({
    scope: DENY_ALL_TOOL_SCOPE,
    tier: null,
    unresolved,
  });

  if (!userId) return deny("no_principal");

  let row:
    | (AccessRoleIdRow & { role: string; directoryStatus: string })
    | null;
  try {
    row = (await prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        directoryStatus: true,
        accessRoleId: true,
        accessRole: { select: { toolGrants: { select: { domain: true, level: true } } } },
      },
    })) as (AccessRoleIdRow & { role: string; directoryStatus: string }) | null;
  } catch (err) {
    logger.error({ err, userId }, "attributed_tool_access_read_failed");
    return deny("read_failed");
  }
  if (!row) {
    logger.error({ userId }, "attributed_tool_access_user_missing");
    return deny("user_missing");
  }
  if (row.directoryStatus === "DEACTIVATED") {
    logger.warn({ userId }, "attributed_tool_access_user_deactivated");
    return deny("user_deactivated");
  }
  // §3 owner bypass, read off the row. Service rows never reach here.
  if (row.role === "owner") return { scope: null, tier: "owner", unresolved: null };

  return {
    scope: await composeScopeForRow(userId, row),
    tier: row.role,
    unresolved: null,
  };
}
