/**
 * WARP-2405 — web sign-in for remote MCP servers. `start`, `paste`, status,
 * disconnect and client routes are session-authenticated; the callback is
 * public (mounted before session auth, like Google's) and identifies the person
 * by the flow: state cookie plus a single-use server-side entry.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { mcpProviderIds, providerDescriptor } from "@droplet/shared-types";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { authRateLimit, sensitiveRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { mcpOAuthOutcomeUrl } from "../services/account-connect-return.js";
import {
  beginMcpSignIn, completeMcpSignIn, disconnectMcpOAuth, mcpOAuthDependencies, mcpSignInView, parsePastedRedirect,
  storeMcpOAuthClient, McpOAuthError, MCP_OAUTH_CALLBACK_PATH, MCP_OAUTH_FLOW_TTL_MS,
  type McpOAuthDependencies,
} from "../services/mcp-oauth/mcp-oauth.service.js";

export const MCP_OAUTH_STATE_COOKIE = "droplet_mcp_oauth_state";
const COOKIE_PATH = "/api/mcp/oauth";
const SIGN_IN_ROLES = ["owner", "admin", "family"] as const;
const provider = z.string().min(1).max(64);
const startBody = z.object({
  provider,
  scope: z.enum(["MEMBER", "WORKSPACE"]),
  acknowledge: z.boolean().optional(),
  redirectMode: z.enum(["origin", "loopback"]).optional(),
}).strict();
const pasteBody = z.object({ redirectUrl: z.string().min(1).max(4096) }).strict();
const clientBody = z.object({
  provider,
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(2048).optional(),
}).strict();
const idParam = z.string().uuid();

function fail(res: Response, err: unknown): Response {
  if (err instanceof McpOAuthError) return res.status(err.status).json({ error: err.code, message: err.message });
  return res.status(503).json({ error: "sign_in_unavailable", message: "Sign-in is unavailable. Try again shortly." });
}

/**
 * Both halves of the sign-in, wired the way `app.ts` wires them: the public
 * callback (mounted before session auth) and the session-authenticated routes.
 * They MUST share one dependency set: `start` writes the in-flight flow that the
 * callback later claims, so two independently built sets would make every real
 * browser redirect fail.
 */
export function createMcpOAuthRouters(
  prisma: PrismaClient,
  options: Partial<McpOAuthDependencies> = {},
): { callback: Router; session: Router } {
  const deps = mcpOAuthDependencies(options);
  return { callback: createMcpOAuthCallbackRouter(prisma, deps), session: createMcpOAuthRouter(prisma, deps) };
}

export function createMcpOAuthRouter(prisma: PrismaClient, options: Partial<McpOAuthDependencies> = {}): Router {
  const router = Router();
  const deps = mcpOAuthDependencies(options);

  router.get("/mcp/oauth/connections", standardRateLimit, requireRole(...SIGN_IN_ROLES), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    try {
      const redirectUri = await trustedOriginUrl(req, MCP_OAUTH_CALLBACK_PATH);
      const ids = mcpProviderIds().filter((id) => {
        const d = providerDescriptor(id);
        return d?.track === "mcp" && d.signIn;
      });
      return res.json({ providers: await Promise.all(ids.map((id) => mcpSignInView(prisma, id, req.user!.id, redirectUri, req.user!.role))) });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post("/mcp/oauth/start", sensitiveRateLimit, requireRole(...SIGN_IN_ROLES), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    const body = startBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "invalid_request" });
    try {
      const started = await beginMcpSignIn(prisma, {
        ...body.data,
        userId: req.user.id,
        username: req.user.username,
        role: req.user.role,
        originCallback: await trustedOriginUrl(req, MCP_OAUTH_CALLBACK_PATH),
      }, deps);
      res.cookie(MCP_OAUTH_STATE_COOKIE, started.state, {
        httpOnly: true, secure: true, sameSite: "lax", path: COOKIE_PATH, maxAge: MCP_OAUTH_FLOW_TTL_MS,
      });
      return res.json({ authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt, redirectUri: started.redirectUri });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.post("/mcp/oauth/paste", sensitiveRateLimit, requireRole(...SIGN_IN_ROLES), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    const body = pasteBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "invalid_request" });
    try {
      const pasted = parsePastedRedirect(body.data.redirectUrl);
      const result = await completeMcpSignIn(prisma, {
        state: pasted.state, code: pasted.code, error: pasted.error, iss: pasted.iss,
        browserState: null, caller: { id: req.user.id, role: req.user.role },
      }, deps);
      res.clearCookie(MCP_OAUTH_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: COOKIE_PATH });
      if (result.outcome === "connected") return res.json({ outcome: "connected" });
      // `blocked`: remote MCP is off for this server right now (nothing was sent).
      return res.status(result.outcome === "blocked" ? 409 : 400).json({ error: "sign_in_failed", outcome: result.outcome });
    } catch (err) {
      return fail(res, err);
    }
  });

  router.delete("/mcp/oauth/connections/:id", sensitiveRateLimit, requireRole(...SIGN_IN_ROLES), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ error: "not_found" });
    try {
      // A row the caller may not touch reads as absent.
      const notes: { revokeSkipped?: boolean } = {};
      if (!await disconnectMcpOAuth(prisma, id.data, { id: req.user.id, role: req.user.role }, deps, notes)) {
        return res.status(404).json({ error: "not_found" });
      }
      // Signed out locally either way. While remote MCP is switched off the vendor is not
      // contacted, so say so (the vendor-side revoke is left to the offboarding work, WARP-3924).
      if (notes.revokeSkipped) {
        return res.status(200).json({
          disconnected: true,
          revoked: false,
          message: "Signed out here. Couldn't revoke at the service while remote MCP is switched off.",
        });
      }
      return res.status(204).send();
    } catch (err) {
      return fail(res, err);
    }
  });

  router.patch("/mcp/oauth/client", sensitiveRateLimit, requireRole("owner", "admin"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user?.id) return res.status(401).json({ error: "unauthenticated" });
    const body = clientBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "invalid_request" });
    try {
      await storeMcpOAuthClient(prisma, { ...body.data, userId: req.user.id }, deps);
      return res.status(204).send();
    } catch (err) {
      return fail(res, err);
    }
  });

  return router;
}

export function createMcpOAuthCallbackRouter(prisma: PrismaClient, options: Partial<McpOAuthDependencies> = {}): Router {
  const router = Router();
  const deps = mcpOAuthDependencies(options);
  router.get("/mcp/oauth/callback", authRateLimit, async (req: Request, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Only a single string value counts; nothing here is ever logged or echoed.
    const param = (name: string) => typeof req.query[name] === "string" ? req.query[name] as string : null;
    const cookie = req.cookies?.[MCP_OAUTH_STATE_COOKIE];
    res.clearCookie(MCP_OAUTH_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: "lax", path: COOKIE_PATH });
    let result: Awaited<ReturnType<typeof completeMcpSignIn>>;
    try {
      result = await completeMcpSignIn(prisma, {
        state: param("state"), code: param("code"), error: param("error"), iss: param("iss"),
        browserState: typeof cookie === "string" ? cookie : null, caller: null,
      }, deps);
    } catch {
      result = { outcome: "failed", provider: null, scope: null };
    }
    // No callback parameter becomes a destination or reflected text.
    const returnTo = result.scope === "WORKSPACE" ? "/integrations/credentials" : "/settings";
    return res.redirect(303, mcpOAuthOutcomeUrl(returnTo, result.provider, result.outcome));
  });
  return router;
}
