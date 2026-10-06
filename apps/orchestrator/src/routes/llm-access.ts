/**
 * WARP-3452 — `/api/llm-access/*`: coding tools on the LAN using the box's
 * model runtime through ai-gateway's `/llm/` router (ADR-067).
 *
 * Public (the normal session):
 *   GET    /llm-access                     page state + the caller's own tokens
 *   PUT    /llm-access/settings            the box-wide switch (owner/admin, audited)
 *   POST   /llm-access/tokens              mint a token (shown once; 409 while off)
 *   GET    /llm-access/tokens/all          every token, with its holder (owner/admin)
 *   POST   /llm-access/tokens/:id/renew    +364 days (own token, or owner/admin)
 *   DELETE /llm-access/tokens/:id          revoke, keeping the row (own, or owner/admin)
 * Owner, admin and members (wire role `family`) only; guests and every
 * service principal get 403 `role_not_allowed`.
 *
 * Internal, for ai-gateway alone — pinned to `_service:ai-gateway` (the
 * AI_GATEWAY_SAMPLER_TOKEN principal) by id AND the `service` role, as
 * join-code pins `_service:display`; every person and every other service
 * principal gets 403 and the WARP-237 denial row:
 *   POST   /llm-access/_introspect   { token } → who, and which model; every request, no cache
 *   POST   /llm-access/_usage        token counts after a request (never content)
 *
 * The switch OFF does not revoke anything: introspection answers 403
 * `disabled` until it is back on.
 */
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import {
  bearerIsServicePrincipal,
  recordAccessDenied,
  requireRole,
  requireRoleOrService,
} from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { resolveActiveModel } from "../services/active-model.service.js";
import {
  TOKEN_ROLES,
  addTokenUsage,
  checkToken,
  createToken,
  isLlmAccessEnabled,
  listTokens,
  recordTokenUse,
  renewToken,
  revokeToken,
  setLlmAccessEnabled,
  type TokenManager,
} from "../services/model-access-token.service.js";

/** ai-gateway's principal (middleware/auth.ts SERVICE_PRINCIPALS). */
const AI_GATEWAY_SERVICE_ID = "_service:ai-gateway";

const INTERNAL_PATHS: ReadonlySet<string> = new Set(["/api/llm-access/_introspect", "/api/llm-access/_usage"]);

/**
 * Wrap the app-wide per-IP limiter so ai-gateway's two internal calls skip it.
 * Every ai-gateway call shares one source IP, and each `/llm/` request costs
 * two (introspect, then usage), so a dozen busy tokens would exhaust the
 * bucket and 429 every ai-gateway call — the off-LAN gate reads included.
 * ai-gateway already limits each token itself (LLM_ACCESS_RPM, one in flight).
 *
 * Exactly these two POST paths, exactly the AI_GATEWAY_SAMPLER_TOKEN bearer
 * (constant-time, authMiddleware's matcher). Anything else — another path,
 * another principal, a different case or a trailing slash — is counted.
 */
export function exemptLlmAccessInternalCalls(limiter: RequestHandler): RequestHandler {
  return (req, res, next) =>
    req.method === "POST" && INTERNAL_PATHS.has(req.path) && bearerIsServicePrincipal(req, AI_GATEWAY_SERVICE_ID)
      ? next()
      : limiter(req, res, next);
}

const settingsSchema = z.object({ enabled: z.boolean() });
const createSchema = z.object({ label: z.string().trim().min(1).max(64) });
const usageSchema = z.object({
  tokenId: z.string().min(1).max(64),
  promptTokens: z.number().int().min(0).max(10_000_000),
  completionTokens: z.number().int().min(0).max(10_000_000),
  error: z.boolean(),
});

function requireTokenRole(req: Request, res: Response, next: NextFunction): void {
  if (TOKEN_ROLES.has(req.user?.role ?? "")) {
    next();
    return;
  }
  recordAccessDenied(req, "role-not-permitted");
  res.status(403).json({ error: "role_not_allowed" });
}

const isAdmin = (req: Request) => req.user?.role === "owner" || req.user?.role === "admin";
const manager = (req: Request): TokenManager => ({ userId: req.user!.id, isAdmin: isAdmin(req) });

/**
 * The model ai-gateway serves: the box's active chat model as a RUNTIME id
 * (WARP-2882), resolved strictly — when the installed set can't be confirmed
 * this answers null rather than pass a possibly-stale name to the runtime.
 * The window is the one the runtime is configured with and the orchestrator
 * budgets against (OLLAMA_CONTEXT_LENGTH, also DMR's ctx size in compose);
 * the gateway listing reports none for local models by design.
 */
async function servedModel(prisma: PrismaClient): Promise<{ activeModel: string | null; contextWindow: number | null }> {
  const activeModel = await resolveActiveModel(prisma, { strict: true });
  return { activeModel, contextWindow: activeModel ? config.OLLAMA_CONTEXT_LENGTH : null };
}

export function createLlmAccessRouter(prisma: PrismaClient): Router {
  const router = Router();
  const aiGatewayOnly = requireRoleOrService(AI_GATEWAY_SERVICE_ID);

  async function pageState(req: Request) {
    const [enabled, served, tokens] = await Promise.all([
      isLlmAccessEnabled(prisma),
      servedModel(prisma),
      listTokens(prisma, req.user!.id),
    ]);
    const canCreate = enabled && TOKEN_ROLES.has(req.user!.role);
    return { enabled, canCreate, isAdmin: isAdmin(req), ...served, tokens };
  }

  router.post("/llm-access/_introspect", aiGatewayOnly, async (req, res, next) => {
    try {
      if (!(await isLlmAccessEnabled(prisma))) {
        res.status(403).json({ error: "disabled" });
        return;
      }
      const check = await checkToken(prisma, req.body?.token);
      if (!check.ok) {
        res.status(check.status).json({ error: check.error });
        return;
      }
      const { activeModel, contextWindow } = await servedModel(prisma);
      if (!activeModel) {
        res.status(403).json({ error: "no_active_model" });
        return;
      }
      await recordTokenUse(prisma, check.tokenId);
      res.json({ tokenId: check.tokenId, userId: check.userId, role: check.role, activeModel, contextWindow });
    } catch (err) {
      next(err);
    }
  });

  router.post("/llm-access/_usage", aiGatewayOnly, async (req, res, next) => {
    try {
      const parsed = usageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_usage" });
        return;
      }
      if (!(await addTokenUsage(prisma, parsed.data))) {
        res.status(404).json({ error: "unknown_token" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/llm-access", requireTokenRole, async (req, res, next) => {
    try {
      res.json(await pageState(req));
    } catch (err) {
      next(err);
    }
  });

  router.put("/llm-access/settings", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_settings" });
        return;
      }
      const { enabled } = parsed.data;
      if (await setLlmAccessEnabled(prisma, enabled)) {
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "cpu",
          what: enabled ? "Coding tools allowed to use the local model" : "Coding tools blocked from the local model",
          sub: req.user?.username ?? null,
          refs: { setting: "ai.llm_access.enabled", enabled },
          actor: actorFromRequest(req),
        });
      }
      res.json(await pageState(req));
    } catch (err) {
      next(err);
    }
  });

  router.post("/llm-access/tokens", requireTokenRole, async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_label" });
        return;
      }
      if (!(await isLlmAccessEnabled(prisma))) {
        res.status(409).json({ error: "disabled" });
        return;
      }
      const minted = await createToken(prisma, req.user!.id, parsed.data.label);
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "key-round",
        what: "Coding-tool token created",
        sub: minted.row.label,
        // Never the token itself — the row id is the non-secret handle.
        refs: { tokenId: minted.row.id, userId: req.user!.id, expiresAt: minted.row.expiresAt },
        actor: actorFromRequest(req),
      });
      res.status(201).json(minted);
    } catch (err) {
      next(err);
    }
  });

  router.get("/llm-access/tokens/all", requireRole("owner", "admin"), async (_req, res, next) => {
    try {
      res.json({ tokens: await listTokens(prisma, null) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/llm-access/tokens/:id/renew", requireTokenRole, async (req, res, next) => {
    try {
      const renewed = await renewToken(prisma, req.params.id, manager(req));
      if (renewed === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (renewed === "revoked") {
        res.status(409).json({ error: "revoked" });
        return;
      }
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "key-round",
        what: "Coding-tool token renewed",
        sub: renewed.label,
        refs: { tokenId: renewed.row.id, userId: renewed.userId, expiresAt: renewed.row.expiresAt },
        actor: actorFromRequest(req),
      });
      res.json(renewed.row);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/llm-access/tokens/:id", requireTokenRole, async (req, res, next) => {
    try {
      const revoked = await revokeToken(prisma, req.params.id, manager(req));
      if (revoked === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (revoked !== "already") {
        await recordActivity({
          kind: "auth",
          severity: "ok",
          sourceIcon: "key-round",
          what: "Coding-tool token revoked",
          sub: revoked.label,
          refs: { tokenId: req.params.id, userId: revoked.userId, revokedBy: req.user!.id },
          actor: actorFromRequest(req),
        });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
