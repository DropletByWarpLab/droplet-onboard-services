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
 * one tool domain: it resolves the ACTING user and asks the same question the
 * dispatch check asks — is `domain` in their scope, and for a write, may they
 * write it?
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
 *   2. the feature — may they open the module serving THIS prefix, at `view`?
 *      The same check `requireFeatureAccess` makes of a human on the same
 *      URL. `business` passes with CRM OR Projects (question 1), but the data
 *      under `/api/crm` is still CRM data: a Projects-only person gets a 404
 *      here for it, exactly as they do in the browser.
 *
 *   - owner / no custom role  → null scope passes question 1 (same as chat);
 *     question 2 still applies, and resolves to the full catalog for owners.
 *   - unknown / deactivated user, or a read error → DENY (fail closed).
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
  features: EffectiveAccessResolver = resolveEffectiveAccess,
): RequestHandler {
  function deny(req: Request, res: Response, reason: string): void {
    recordAccessDenied(req, "mcp-acting-user-tool-domain-denied");
    logger.warn({ domain, reason }, "mcp_acting_user_denied");
    res.status(404).json({ error: "module_disabled", module: moduleId });
  }

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
      const allowed = READ_METHODS.has(req.method)
        ? scope.domains.has(domain)
        : scope.writeDomains.has(domain);
      if (!allowed) {
        deny(req, res, READ_METHODS.has(req.method) ? "domain_not_in_scope" : "domain_not_writable");
        return;
      }
    }
    // Question 2 — the module serving this prefix, as `requireFeatureAccess`
    // asks it of a human (null = no local row, nothing to narrow).
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
