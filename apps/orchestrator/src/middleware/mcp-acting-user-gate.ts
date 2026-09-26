/**
 * WARP-2988 — the MCP service path, narrowed by the person the assistant acts for.
 *
 * Tools reach the orchestrator as the `_service:mcp` principal, and
 * `requireFeatureAccess` passes service principals straight through
 * (feature-gate.ts). Every in-process dispatcher (chat agent loop, ToolSpec
 * runner, agent-run worker) applies the ADR-032 §3 tool scope BEFORE calling
 * MCP, but a caller that reaches the MCP server any other way (its HTTP
 * transport takes any orchestrator access token and runs only the write-tier
 * RBAC) arrives here unchecked. This gate closes that at the data boundary for
 * each domain in `MCP_ACTING_USER_GATED_DOMAINS` (module-mounts.ts): it
 * resolves the ACTING user and asks the same question the dispatch check asks
 * — is `domain` in their scope, and for a write, may they write it?
 *
 * Identity: mcp-server stamps `X-Nextcloud-User` on every orchestrator call
 * (services/mcp-server/src/context.ts `withActingUser`). It is trusted ONLY
 * from `_service:mcp`, the same assertion camera-access.service.ts and
 * middleware/space.ts already rely on; for anyone else this gate is a no-op.
 * Despite its name the header carries `User.username` on the stdio transport
 * (routes/llm.ts, agent-run-worker) and `User.id` on the HTTP transport
 * (`claims.sub`), so it is resolved by username, then by id — the same
 * column routes/brain.ts, agent-runs.ts and tools.ts read. NOT by
 * `nextcloudUsername`: SSO- and SCIM-created users have it null.
 *
 * Two questions, both about the acting person:
 *   1. the tool scope — is `domain` in their §3 reach (a write needs `use`)?
 *      The method stands in for "a write": a GET is a read tool's hop. Where
 *      the domain has NO read tool (`team_chat`: both tools send, and both
 *      read the roster by GET first), every hop is some write tool's, so
 *      every method needs `use` (WARP-3162). Otherwise a `view` grant, which
 *      reaches none of that domain's tools, would still clear its GETs.
 *   2. the feature — ONLY where the browser asks it: when the module serving
 *      this prefix is in FEATURE_GATED_MODULES (module-mounts.ts), the acting
 *      person must hold it, the same check `requireFeatureAccess` makes of a
 *      human on that URL. Today that is `crm` (/api/crm); `projects` is not
 *      feature-gated, so /api/pm asks question 1 only. The rule is browser
 *      parity: the assistant never reaches more than the person could in the
 *      browser, and never LESS either — a CRM-only person's `business_find`
 *      on a customer reads that customer's projects, as their browser can.
 *      The mount passes `features = null` for an ungated module.
 *
 *   - owner / no custom role  → null scope passes question 1 (same as chat);
 *     question 2 still applies where it applies, and resolves to the full
 *     catalog for owners.
 *   - unknown / deactivated user, or a read error → DENY (fail closed).
 *     This includes a VOICE turn: the voice service's principal
 *     (`_service:voice`) is what routes/llm.ts forwards as the acting user,
 *     and no User row carries it, so voice `business_*` calls get the same
 *     404 `module_disabled` ("switched off"). Deliberate — no person is
 *     attributable, like cameras — until voice carries the speaker's identity.
 *   - NO header → pass. Only orchestrator-internal stdio calls with no user
 *     context omit it (the ToolSpec schedule ticker), and those already
 *     cleared `resolveAttributedToolAccess` in the runner's pre-flight. The
 *     HTTP transport always has `claims.sub`, so it always names someone.
 *
 * Denials are 404 `module_disabled`, byte-consistent with the module and
 * feature gates, so `business_*`'s `businessError` still reads them as "that
 * part of Droplet is switched off".
 */
import type { PrismaClient } from "@prisma/client";
import type { Request, RequestHandler, Response, NextFunction } from "express";
import type { ModuleId } from "@prisma/client";
import {
  DENY_ALL_TOOL_SCOPE,
  resolveAttributedToolAccess,
  type AttributedToolAccess,
} from "../services/tool-access.service.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";
import type { EffectiveAccessResolver } from "./feature-gate.js";
import { recordAccessDenied } from "./auth.js";
import { createLogger } from "../lib/logger.js";
import { readableDomains, toolLayers } from "../services/tool-layers.service.js";

const logger = createLogger("mcp-acting-user-gate");

export const MCP_PRINCIPAL_ID = "_service:mcp";

/** The acting person's tool reach, plus their `User.id` (null when unresolved). */
export type ActingUserAccess = AttributedToolAccess & { userId: string | null };

/** The asserted header (username on stdio, `User.id` over HTTP) → the acting person. */
export type ActingUserAccessResolver = (asserted: string) => Promise<ActingUserAccess>;

export function actingUserAccessResolver(prisma: PrismaClient): ActingUserAccessResolver {
  return async (asserted) => {
    let row: { id: string } | null;
    try {
      row =
        (await prisma.user.findUnique({ where: { username: asserted }, select: { id: true } })) ??
        (await prisma.user.findUnique({ where: { id: asserted }, select: { id: true } }));
    } catch (err) {
      logger.error({ err }, "mcp_acting_user_lookup_failed");
      return { scope: DENY_ALL_TOOL_SCOPE, tier: null, unresolved: "read_failed", userId: null };
    }
    if (!row) return { scope: DENY_ALL_TOOL_SCOPE, tier: null, unresolved: "user_missing", userId: null };
    return { ...(await resolveAttributedToolAccess(prisma, row.id)), userId: row.id };
  };
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireMcpActingUserToolDomain(
  domain: string,
  moduleId: ModuleId,
  resolve: ActingUserAccessResolver,
  /** Question 2's resolver; `null` when the module is not feature-gated for humans. */
  features: EffectiveAccessResolver | null = resolveEffectiveAccess,
): RequestHandler {
  function deny(req: Request, res: Response, reason: string): void {
    recordAccessDenied(req, "mcp-acting-user-tool-domain-denied");
    logger.warn({ domain, reason }, "mcp_acting_user_denied");
    res.status(404).json({ error: "module_disabled", module: moduleId });
  }
  // WARP-3162 — compiled catalog only: a runtime (remote MCP) tool never hops
  // an orchestrator route, so it cannot make a request this gate sees.
  const everyToolWrites = !readableDomains(toolLayers()).has(domain);

  return async function mcpActingUserGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (req.user?.id !== MCP_PRINCIPAL_ID) {
      next();
      return;
    }
    const asserted = (req.header("x-nextcloud-user") ?? "").trim();
    // WARP-3162 — routes/team-chat.ts acts for `X-Droplet-User`, not the
    // header this gate resolves. The mcp-server sets both from the same
    // `ctx.userId` (`withActingUser`, and the team-chat handlers'
    // `actingHeaders`), so on a real call they are equal. When they are not,
    // this gate would clear one person while the route acts for another:
    // refuse. That includes an `X-Droplet-User` with no `X-Nextcloud-User`,
    // which would otherwise pass below as a call that names nobody.
    const forwarded = (req.header("x-droplet-user") ?? "").trim();
    if (forwarded && forwarded !== asserted) {
      deny(req, res, "acting_user_headers_disagree");
      return;
    }
    if (!asserted) {
      next();
      return;
    }
    let access: ActingUserAccess;
    try {
      access = await resolve(asserted);
    } catch (err) {
      logger.error({ err }, "mcp_acting_user_resolve_failed");
      deny(req, res, "resolve_failed");
      return;
    }
    if (access.unresolved) {
      deny(req, res, access.unresolved);
      return;
    }
    const scope = access.scope;
    if (scope !== null) {
      const write = everyToolWrites || !READ_METHODS.has(req.method);
      const allowed = write ? scope.writeDomains.has(domain) : scope.domains.has(domain);
      if (!allowed) {
        deny(req, res, write ? "domain_not_writable" : "domain_not_in_scope");
        return;
      }
    }
    // Question 2 — the module serving this prefix, as `requireFeatureAccess`
    // asks it of a human (null = no local row, nothing to narrow).
    if (features === null) {
      next();
      return;
    }
    try {
      const effective = access.userId ? await features(access.userId) : null;
      if (effective && !effective.features.some((f) => f.moduleId === moduleId)) {
        deny(req, res, "feature_not_held");
        return;
      }
    } catch (err) {
      logger.error({ err }, "mcp_acting_user_feature_read_failed");
      deny(req, res, "feature_read_failed");
      return;
    }
    next();
  };
}
