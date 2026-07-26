/**
 * WARP-1529 / ADR-032 §3 axis d (RBAC v2 T5) — per-role tool-domain narrowing.
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
 * registry. The turn still answers; it just answers without tools.
 */
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG } from "@droplet/tools-core";
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
 * Resolve the caller's tool scope, or `null` when no narrowing applies.
 *
 * Cheap path first: one indexed read of `accessRoleId`. Every user on a box
 * today has none, so the common turn pays a single small query and NEVER
 * touches the §3 resolver — which is also what makes the "role-less behaves
 * exactly as today" claim structural rather than incidental.
 */
export async function resolveToolAccessScope(
  prisma: PrismaClient,
  user: { id?: string; role?: string } | undefined,
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

  let row: {
    accessRoleId: string | null;
    accessRole: { toolGrants: Array<{ domain: string; level: string }> } | null;
  } | null;
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
