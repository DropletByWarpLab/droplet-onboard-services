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
 *
 *   - owner / no custom role  → null scope, pass (same as chat).
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
import { recordAccessDenied } from "./auth.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("mcp-acting-user-gate");

export const MCP_PRINCIPAL_ID = "_service:mcp";

/** Nextcloud username (the asserted header) → the acting person's tool reach. */
export type ActingUserAccessResolver = (nextcloudUsername: string) => Promise<AttributedToolAccess>;

export function actingUserAccessResolver(prisma: PrismaClient): ActingUserAccessResolver {
  return async (nextcloudUsername) => {
    let row: { id: string } | null;
    try {
      row = await prisma.user.findUnique({
        where: { nextcloudUsername },
        select: { id: true },
      });
    } catch (err) {
      logger.error({ err }, "mcp_acting_user_lookup_failed");
      return { scope: DENY_ALL_TOOL_SCOPE, tier: null, unresolved: "read_failed" };
    }
    if (!row) return { scope: DENY_ALL_TOOL_SCOPE, tier: null, unresolved: "user_missing" };
    return resolveAttributedToolAccess(prisma, row.id);
  };
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireMcpActingUserToolDomain(
  domain: string,
  moduleId: ModuleId,
  resolve: ActingUserAccessResolver,
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
    let access: AttributedToolAccess;
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
    if (scope === null) {
      next();
      return;
    }
    const allowed = READ_METHODS.has(req.method)
      ? scope.domains.has(domain)
      : scope.writeDomains.has(domain);
    if (!allowed) {
      deny(req, res, READ_METHODS.has(req.method) ? "domain_not_in_scope" : "domain_not_writable");
      return;
    }
    next();
  };
}
