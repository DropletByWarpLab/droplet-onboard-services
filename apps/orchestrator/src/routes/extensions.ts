/**
 * WARP-2900 (ADR-056 slice H2) — `/api/extensions/*`: the owner's promote,
 * install, disable, enable and uninstall of workshop extensions.
 *
 *   GET    /api/extensions                       owner/admin: installed + signed
 *   GET    /api/extensions/proposals             owner/admin: what could be promoted
 *   POST   /api/extensions/:workspaceId/promote  OWNER ONLY, two-phase (202 → 201)
 *   POST   /api/extensions/:slug/disable         owner
 *   POST   /api/extensions/:slug/enable          owner
 *   DELETE /api/extensions/:slug                 owner
 *   GET    /api/extensions/self                  the extension itself (H3)
 *   POST   /api/extensions/self/call             the extension itself (H3)
 *
 * Promote is `requireRole("owner")` and never `requireRoleOrMcpService`: the
 * box signing code is the owner's decision, and no service principal — the
 * assistant included — can make it. The two phases and what each checks are
 * in services/extension-promote.service.ts; the readback the owner confirms
 * is derived from what the manifest PROVIDES, never from its descriptions.
 *
 * THE CALL-BACK (H3). An installed extension holds a `dxt_` bearer that
 * resolves to the `_service:ext:<slug>` principal, which the global
 * extension-principal guard confines to the two `/self` routes. Those
 * resolve the INSTALLING OWNER at call time — the User row, still active,
 * still an owner — and answer 403 when nobody resolves (never an empty
 * 200). `/self/call` runs a static READ tool (TOOL_CATALOG, requiresWrite
 * and requiresConfirmation both false) as that owner, after the owner's
 * own reach check; a write is refused in v1. The /self routes are
 * registered before every `/extensions/:param` route.
 *
 * This file exports only the router factory (the route-file rule); every
 * helper lives in services/.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG } from "@droplet/tools-core";
import { recordAccessDenied, requireRole, type AuthUser } from "../middleware/auth.js";
import { isExtensionPrincipal } from "../middleware/extension-principal-guard.js";
import type { McpClientPort } from "../services/mcp-client.port.js";
import { resolveAttributedToolAccess, toolAllowedForPrincipal } from "../services/tool-access.service.js";
import { EXTENSION_BEARER_STATUSES } from "../services/extension-token.js";
import { createRequireRecentMfa } from "../middleware/require-recent-mfa.js";
import { actorFromRequest } from "../services/activity.service.js";
import { createDeviceIdentityClient } from "../services/device-identity.client.js";
import {
  deriveReadback,
  EXTENSION_SLUG_PATTERN,
  parseExtensionManifest,
  WORKSPACE_ID_PATTERN,
  deriveExtensionSlug,
} from "../services/extension-manifest.js";
import type { ExtensionSigningIdentity } from "../services/extension-promotion.service.js";
import {
  confirmPromotion,
  createPromoteConfirmationStore,
  preparePromotion,
  PromoteError,
  type PromoteDeps,
} from "../services/extension-promote.service.js";
import {
  createExtensionLifecycle,
  ExtensionLifecycleError,
  type ExtensionAttachPort,
  type ExtensionKeySource,
  type ExtensionLifecycle,
} from "../services/extension-lifecycle.service.js";
import {
  createExtensionSandboxClient,
  ExtensionSandboxError,
  type ExtensionSandboxClient,
} from "../services/extension-sandbox.client.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("extensions-route");

/**
 * TODO(WARP-2923): DECISION PENDING (Romain) — does promote also require a
 * recent MFA challenge (createRequireRecentMfa, 60 s window), as
 * POST /api/admin/device-identity/reseal does? The recommendation on the
 * ticket is yes: signing is the crown-jewel operation. Until the decision is
 * recorded this stays false and the hook below is a pass-through; flipping it
 * is this one line (and a route test for the 401 mfa_required path).
 */
const PROMOTE_REQUIRES_RECENT_MFA = false;

const phase2Schema = z
  .object({
    confirmationToken: z.string().min(1).max(200),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    operatorDomain: z.string().min(1).max(64).nullish(),
  })
  .strict();
const phase1Schema = z.object({}).strict();
const selfCallSchema = z
  .object({
    tool: z.string().min(1).max(64),
    arguments: z.record(z.unknown()).optional(),
  })
  .strict();

interface ExtensionsRouterDeps {
  sandbox?: ExtensionSandboxClient;
  identity?: ExtensionSigningIdentity & ExtensionKeySource;
  lifecycle?: ExtensionLifecycle;
  /** H3: the multiplexer attach/detach the default lifecycle goes live through. */
  attach?: ExtensionAttachPort;
  /** H3: handed to each started extension as DROPLET_ORCHESTRATOR_URL. */
  orchestratorUrl?: string;
  /** H3: the dispatch `/self/call` runs through (the process-wide multiplexer). */
  mcp?: Pick<McpClientPort, "isStarted" | "callTool">;
}

export function createExtensionsRouter(prisma: PrismaClient, deps: ExtensionsRouterDeps = {}): Router {
  const router = Router();
  const sandbox = deps.sandbox ?? createExtensionSandboxClient();
  const identity = deps.identity ?? createDeviceIdentityClient();
  const lifecycle =
    deps.lifecycle ??
    createExtensionLifecycle({
      prisma,
      sandbox,
      identity,
      ...(deps.attach ? { attach: deps.attach } : {}),
      ...(deps.orchestratorUrl ? { orchestratorUrl: deps.orchestratorUrl } : {}),
    });
  const promoteDeps: PromoteDeps = {
    prisma,
    sandbox,
    identity,
    lifecycle,
    confirmations: createPromoteConfirmationStore(),
  };
  const promoteMfaGate = PROMOTE_REQUIRES_RECENT_MFA
    ? createRequireRecentMfa()
    : (_req: Request, _res: Response, next: NextFunction) => next();

  const ownerOrAdmin = requireRole("owner", "admin");
  const ownerOnly = requireRole("owner");
  const slugParam = z.string().regex(EXTENSION_SLUG_PATTERN);
  const workspaceParam = z.string().regex(WORKSPACE_ID_PATTERN);

  function fail(err: unknown, res: Response, next: NextFunction): void {
    if (err instanceof PromoteError) {
      res.status(err.httpStatus).json({ error: err.code, message: err.message, ...err.body });
      return;
    }
    if (err instanceof ExtensionLifecycleError) {
      res.status(err.httpStatus).json({ error: err.code, message: err.message, ...err.body });
      return;
    }
    if (err instanceof ExtensionSandboxError) {
      const status = err.code === "SANDBOX_ERROR" && err.status < 500 ? err.status : 503;
      res.status(status).json({
        error: err.code === "SUPERVISION_OFF" ? "extensions_disabled" : "sandbox_error",
        message: err.message,
      });
      return;
    }
    next(err);
  }

  function owner(req: Request) {
    const user = (req as Request & { user: AuthUser }).user;
    return { id: user.id, actor: actorFromRequest(req) };
  }

  // ─── the extension's own routes (H3) ─────────────────────────────────
  //
  // Registered first: nothing below may ever match `/extensions/self`.

  /** The calling extension and the owner it acts for, or a 403 already sent. */
  async function resolveSelf(req: Request, res: Response) {
    const user = req.user;
    if (!isExtensionPrincipal(user) || !user?.extensionId) {
      recordAccessDenied(req, "not-an-extension");
      res.status(403).json({ error: "Forbidden: only an extension calls its own routes" });
      return null;
    }
    const ext = await prisma.extension.findUnique({
      where: { id: user.extensionId },
      include: { currentVersion: true },
    });
    if (!ext || !EXTENSION_BEARER_STATUSES.includes(ext.status)) {
      recordAccessDenied(req, "extension-not-running");
      res.status(403).json({ error: "extension_not_running" });
      return null;
    }
    const owner = await prisma.user.findUnique({
      where: { id: ext.installedByUserId },
      select: { id: true, username: true, displayName: true, role: true, directoryStatus: true },
    });
    // The owner who installed it, as they are NOW: a demoted, deactivated or
    // deleted owner is nobody the extension may act for.
    if (!owner || owner.directoryStatus === "DEACTIVATED" || owner.role !== "owner") {
      recordAccessDenied(req, "extension-owner-unresolved");
      res.status(403).json({
        error: "owner_unresolved",
        message: "the owner who installed this extension is no longer an active owner of this box",
      });
      return null;
    }
    return { ext, owner };
  }

  router.get("/extensions/self", async (req, res, next) => {
    try {
      const self = await resolveSelf(req, res);
      if (!self) return;
      res.json({
        extension: {
          id: self.ext.id,
          version: self.ext.currentVersion?.version ?? null,
          status: self.ext.status,
        },
        actingFor: { id: self.owner.id, username: self.owner.username, displayName: self.owner.displayName },
      });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/extensions/self/call", async (req, res, next) => {
    try {
      const self = await resolveSelf(req, res);
      if (!self) return;
      const body = selfCallSchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: "invalid_request", details: body.error.flatten() });
        return;
      }
      // A STATIC tool only: runtime and other extensions' tools are not in
      // the catalog, so an extension cannot call another one through here.
      const tool = TOOL_CATALOG.find((t) => t.name === body.data.tool);
      if (!tool) {
        res.status(404).json({ error: "unknown_tool" });
        return;
      }
      if (tool.requiresWrite || tool.requiresConfirmation) {
        recordAccessDenied(req, "extension-write-tool");
        res.status(403).json({ error: "write_tool_refused", message: "an extension may call read-only tools only" });
        return;
      }
      const access = await resolveAttributedToolAccess(prisma, self.owner.id);
      if (access.unresolved !== null || !toolAllowedForPrincipal(tool.name, access.tier ?? undefined, access.scope)) {
        recordAccessDenied(req, "extension-tool-not-permitted");
        res.status(403).json({ error: "tool_not_permitted" });
        return;
      }
      const mcp = deps.mcp;
      if (!mcp || !mcp.isStarted) {
        res.status(503).json({ error: "tools_unavailable" });
        return;
      }
      const out = await mcp.callTool(tool.name, body.data.arguments ?? {}, {
        userId: self.owner.username,
        userRole: self.owner.role,
        extensionId: self.ext.id,
      });
      res.json({ isError: out.isError, content: out.content });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.get("/extensions", ownerOrAdmin, async (_req, res, next) => {
    try {
      const rows = await prisma.extension.findMany({
        orderBy: { createdAt: "desc" },
        include: { currentVersion: true },
      });
      res.json({
        extensions: rows.map((r) => {
          const v = r.currentVersion;
          const parsed = v ? parseExtensionManifest(v.manifestBytes) : null;
          return {
            id: r.id,
            workspaceId: r.workspaceId,
            name: r.name,
            status: r.status,
            failureReason: r.failureReason,
            operatorDomain: r.operatorDomain,
            installedByUserId: r.installedByUserId,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            version: v
              ? {
                  version: v.version,
                  tag: v.tag,
                  commit: v.commit,
                  signer: v.signer,
                  keyFingerprint: v.keyFingerprint,
                  promotedAt: v.createdAt.toISOString(),
                }
              : null,
            readback: parsed?.ok ? deriveReadback(parsed.manifest) : null,
          };
        }),
      });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.get("/extensions/proposals", ownerOrAdmin, async (_req, res, next) => {
    try {
      const rows = await prisma.workshopWorkspace.findMany({
        where: { proposedTag: { not: null } },
        orderBy: { proposedAt: "desc" },
        select: { id: true, name: true, userId: true, proposedTag: true, proposedAt: true },
      });
      const proposals = [];
      for (const ws of rows) {
        const tag = ws.proposedTag as string;
        const version = tag.startsWith("proposal/") ? tag.slice("proposal/".length) : tag;
        const slug = deriveExtensionSlug(ws.id);
        const base = {
          workspaceId: ws.id,
          name: ws.name,
          userId: ws.userId,
          tag,
          version,
          slug,
          proposedAt: ws.proposedAt ? ws.proposedAt.toISOString() : null,
        };
        const promoted = await prisma.extensionVersion.findUnique({
          where: { extensionId_version: { extensionId: slug, version } },
          select: { id: true },
        });
        if (promoted) {
          proposals.push({ ...base, promotable: false, reason: "already promoted", readback: null });
          continue;
        }
        try {
          const found = await sandbox.proposalManifest(ws.id, version);
          if (found.manifest === null) {
            // A connector draft or a tag with no manifest: not an extension.
            proposals.push({ ...base, promotable: false, reason: "not an extension (no manifest)", readback: null });
            continue;
          }
          const parsed = parseExtensionManifest(found.manifest);
          proposals.push(
            parsed.ok
              ? { ...base, promotable: true, reason: null, readback: deriveReadback(parsed.manifest) }
              : { ...base, promotable: false, reason: `manifest invalid: ${parsed.detail}`, readback: null },
          );
        } catch (err) {
          if (err instanceof ExtensionSandboxError) {
            proposals.push({ ...base, promotable: false, reason: err.message, readback: null });
            continue;
          }
          throw err;
        }
      }
      res.json({ proposals });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/extensions/:workspaceId/promote", ownerOnly, promoteMfaGate, async (req, res, next) => {
    const workspaceId = workspaceParam.safeParse(req.params.workspaceId);
    if (!workspaceId.success) {
      res.status(400).json({ error: "invalid_workspace" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (body.confirmationToken === undefined) {
        if (!phase1Schema.safeParse(body).success) {
          res.status(400).json({ error: "invalid_request", message: "phase 1 takes an empty body" });
          return;
        }
        const phase1 = await preparePromotion(promoteDeps, owner(req), workspaceId.data);
        res.status(202).json(phase1);
        return;
      }
      const parsed = phase2Schema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const result = await confirmPromotion(promoteDeps, owner(req), workspaceId.data, parsed.data);
      res.status(201).json(result);
    } catch (err) {
      if (!(err instanceof PromoteError)) logger.warn({ err }, "extension_promote_failed");
      fail(err, res, next);
    }
  });

  const transition =
    (op: "disable" | "enable") =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const slug = slugParam.safeParse(req.params.slug);
      if (!slug.success) {
        res.status(400).json({ error: "invalid_extension" });
        return;
      }
      try {
        const row = await lifecycle[op](slug.data, actorFromRequest(req));
        res.json({ id: row.id, status: row.status });
      } catch (err) {
        fail(err, res, next);
      }
    };

  router.post("/extensions/:slug/disable", ownerOnly, transition("disable"));
  router.post("/extensions/:slug/enable", ownerOnly, transition("enable"));

  router.delete("/extensions/:slug", ownerOnly, async (req, res, next) => {
    const slug = slugParam.safeParse(req.params.slug);
    if (!slug.success) {
      res.status(400).json({ error: "invalid_extension" });
      return;
    }
    try {
      const row = await lifecycle.uninstall(slug.data, actorFromRequest(req));
      res.json({ id: row.id, status: row.status });
    } catch (err) {
      fail(err, res, next);
    }
  });

  return router;
}
