/**
 * WARP-2972 — which tool domains a module toggle and a person's own grants
 * withhold. The ONE derivation of the module→tool-domain verdict for every
 * consumer of the tool list:
 *
 *   - the chat pool (`llm-agent.service.ts`) and its budget estimate;
 *   - `GET /api/llm/tools` and the catalog's `reach.module`;
 *   - the mcp-server, over `GET /api/modules/tool-verdict`, for `tools/list`
 *     and `tools/call` on both transports;
 *   - the admin tool inspector's `module` gate.
 *
 * The predicate that USES a verdict lives in `@droplet/tools-core`
 * (`isToolWithheldByModule`): this file only builds it.
 *
 * ── the two axes ───────────────────────────────────────────────────
 *
 *   BOX     the module must be EFFECTIVE (available ∧ enabled — the same set
 *           the route gate `requireModuleEnabled` reads, through the same cache,
 *           so a toggle takes effect on the tool list the moment it does on
 *           the route).
 *   PERSON  where the acting person is known, they must HOLD the module: the
 *           §3 resolver's `features`, which already carry the role's grants,
 *           the per-person exceptions, the tier floors and the workspace
 *           intersection. An owner is §3's one bypass and gets the box axis
 *           alone.
 *
 * Both apply to people the §3 tool SCOPE does not narrow — the owner and
 * everybody with no AccessRole. That is the gap: `resolveToolAccessScope`
 * returns a null scope for them, and a null scope narrows nothing, so a
 * disabled module's tools reached the model. A role-less person's per-person
 * deny EXCEPTION is honoured by every route gate and was dropped from the
 * tool list.
 *
 * ── the domain join ────────────────────────────────────────────────
 *
 * `OWNERS_BY_DOMAIN` (access-catalog.ts), the same join `domainsForFeatures`
 * makes: a claimed domain survives when ANY of its owners is held (WARP-2988:
 * `business` is CRM or Projects); a domain no module claims is never withheld.
 *
 * ── fail closed ────────────────────────────────────────────────────
 *
 * Anything that stops a verdict being established — the module set unreadable,
 * a named person unknown, ambiguous or deactivated, their grants unreadable —
 * yields `FAIL_CLOSED_MODULE_VERDICT`: every module-owned domain withheld,
 * every unclaimed domain still available. It is never an error, so the tool
 * list is short, not broken. A service principal (`_service:*`, e.g. voice) is
 * no person and gets the box axis.
 */
import type { ModuleId, PrismaClient } from "@prisma/client";
import { FAIL_CLOSED_MODULE_VERDICT, type ModuleVerdict } from "@droplet/tools-core";
import { OWNERS_BY_DOMAIN } from "./access-catalog.js";
import { resolveAssertedUser } from "./asserted-user.service.js";
import { resolveEffectiveAccess } from "./effective-access.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("tool-module-verdict");

/** Default lifetime of a resolved person. Short: a grant change is visible within it. */
export const MODULE_VERDICT_TTL_MS = 5_000;
const MAX_CACHED_PEOPLE = 512;

/** PURE — the claimed tool domains none of whose owning modules is in `held`. */
export function withheldDomainsFor(held: ReadonlySet<ModuleId>): Set<string> {
  const out = new Set<string>();
  for (const [domain, owners] of OWNERS_BY_DOMAIN) {
    if (!owners.some((m) => held.has(m))) out.add(domain);
  }
  return out;
}

export interface ModuleVerdictDeps {
  /** Only `user.findMany` (the asserted-person lookup). */
  prisma: Pick<PrismaClient, "user">;
  /** The box's EFFECTIVE module ids. Read on every call: its cache is the module gate's. */
  boxModuleIds: () => Promise<ReadonlySet<ModuleId>>;
  /**
   * The modules one person holds, or `null` when they cannot be resolved.
   * Default: the §3 resolver's `features`.
   */
  personModuleIds?: (userId: string) => Promise<ReadonlySet<ModuleId> | null>;
  /**
   * Whether a NAMED person narrows anything. False when the box has no
   * identity system (AUTH_ENABLED=false: every request is the synthetic `dev`
   * owner, who has no User row to resolve). Then only the box axis applies —
   * without this an unresolvable `dev` would fail closed and a developer's
   * owner chat would lose every module-owned tool. Default: true.
   */
  personAxis?: () => boolean;
  ttlMs?: number;
  now?: () => number;
}

/**
 * `asserted` is who the call is for: a username (stdio `_meta.userId`), a
 * `User.id` (an HTTP JWT `sub`), a `_service:*` principal, or nobody.
 */
export type ModuleVerdictResolver = (asserted: string | null | undefined) => Promise<ModuleVerdict>;

async function defaultPersonModuleIds(userId: string): Promise<ReadonlySet<ModuleId> | null> {
  const access = await resolveEffectiveAccess(userId);
  return access ? new Set(access.features.map((f) => f.moduleId)) : null;
}

/** What is cached about one asserted value: who they are and what they hold. */
type PersonEntry =
  | { at: number; kind: "owner" }
  | { at: number; kind: "person"; held: ReadonlySet<ModuleId> };

export function createModuleVerdictResolver(deps: ModuleVerdictDeps): ModuleVerdictResolver {
  const ttlMs = deps.ttlMs ?? MODULE_VERDICT_TTL_MS;
  const now = deps.now ?? Date.now;
  const personModuleIds = deps.personModuleIds ?? defaultPersonModuleIds;
  const people = new Map<string, PersonEntry>();

  /** `null` = could not be established (the caller fails closed). */
  async function person(asserted: string): Promise<PersonEntry | null> {
    const cached = people.get(asserted);
    if (cached && now() - cached.at < ttlMs) return cached;
    const resolved = await resolveAssertedUser(deps.prisma as PrismaClient, asserted);
    if (!resolved.ok) {
      logger.warn({ reason: resolved.reason }, "module_verdict_person_unresolved");
      return null;
    }
    let entry: PersonEntry;
    if (resolved.user.role === "owner") {
      entry = { at: now(), kind: "owner" };
    } else {
      const held = await personModuleIds(resolved.user.id);
      if (held === null) {
        logger.warn("module_verdict_grants_unresolved");
        return null;
      }
      entry = { at: now(), kind: "person", held };
    }
    if (people.size >= MAX_CACHED_PEOPLE) people.clear();
    people.set(asserted, entry);
    return entry;
  }

  return async function resolveModuleVerdict(asserted) {
    try {
      const box = await deps.boxModuleIds();
      const who = asserted?.trim();
      if (!who || who.startsWith("_service:") || deps.personAxis?.() === false) {
        return { withheldDomains: withheldDomainsFor(box) };
      }
      const entry = await person(who);
      if (entry === null) return FAIL_CLOSED_MODULE_VERDICT;
      const held =
        entry.kind === "owner" ? box : new Set([...entry.held].filter((m) => box.has(m)));
      return { withheldDomains: withheldDomainsFor(held) };
    } catch (err) {
      logger.error({ err }, "module_verdict_failed_closed");
      return FAIL_CLOSED_MODULE_VERDICT;
    }
  };
}

// ── the process-wide binding ───────────────────────────────────────

let bound: ModuleVerdictResolver | null = null;

/**
 * Bind the resolver at boot (app.ts), beside `initEffectiveAccess`. Idempotent
 * — first binder wins, as `initEffectiveAccess` does.
 */
export function initToolModuleVerdict(
  prisma: Pick<PrismaClient, "user">,
  boxModuleIds: () => Promise<ReadonlySet<ModuleId>>,
  personAxis?: () => boolean,
): void {
  if (bound) return;
  bound = createModuleVerdictResolver({ prisma, boxModuleIds, personAxis });
}

/** Exposed only for tests — inject a resolver, or `null` to model an unwired process. */
export function _setToolModuleVerdictForTests(resolver: ModuleVerdictResolver | null): void {
  bound = resolver;
}

/**
 * The verdict for `asserted`, from the bound resolver. UNWIRED fails closed:
 * a process that never called `initToolModuleVerdict` withholds every
 * module-owned tool rather than offering them all.
 */
export const resolveToolModuleVerdict: ModuleVerdictResolver = async (asserted) => {
  if (!bound) {
    logger.error("tool_module_verdict_unwired");
    return FAIL_CLOSED_MODULE_VERDICT;
  }
  try {
    return await bound(asserted);
  } catch (err) {
    // The shipped resolver never throws; an injected one might. A tool list
    // must come back shorter, never fail, so this is a verdict too.
    logger.error({ err }, "tool_module_verdict_resolver_threw");
    return FAIL_CLOSED_MODULE_VERDICT;
  }
};
