/** HA-3 routers: stream/app auth before dashboard parsers; management after auth. */
import { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import { createHostedService, HostedError, HOSTED_SESSION_SECONDS, hostedCookieName, type HostedDeps } from "../services/hosted.service.js";

export function createHostedRelayRouter(prisma: PrismaClient, deps: HostedDeps = {}): Router {
  const router = Router();
  const service = createHostedService(prisma, deps);
  router.use(async (req, res, next) => {
    try {
      if (!(await service.gatewayPeer(req))) { res.status(404).end(); return; }
      service.gate(); next();
    } catch (error) { next(error); }
  });
  router.use("/:slug", async (req, res, next) => {
    const slug = req.params.slug;
    try {
      await service.checkAppOrigin(req);
      let path: string;
      try { path = decodeURIComponent(req.path); }
      catch { throw new HostedError(400, "app_path_invalid"); }
      res.setHeader("Referrer-Policy", "no-referrer");
      if (path === "/_droplet/session" && req.method === "GET") {
        const token = await service.redeem(slug, req.query.code);
        res.setHeader("Cache-Control", "no-store");
        res.cookie(hostedCookieName(slug), token, { httpOnly: true, secure: true, sameSite: "lax", path: `/${slug}/`, maxAge: HOSTED_SESSION_SECONDS * 1000 });
        res.redirect(303, `/${slug}/`); return;
      }
      if (path.startsWith("/_droplet") && (path === "/_droplet" || path.startsWith("/_droplet/"))) {
        const { user } = await service.session(req, slug);
        res.setHeader("Cache-Control", "no-store");
        if (path === "/_droplet/whoami" && req.method === "GET") {
          res.json({ app: slug, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } }); return;
        }
        if (path === "/_droplet/logout" && req.method === "POST") {
          res.clearCookie(hostedCookieName(slug), { httpOnly: true, secure: true, sameSite: "lax", path: `/${slug}/` });
          res.status(204).end(); return;
        }
        res.status(404).end(); return;
      }
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method)) { res.status(405).end(); return; }
      await service.relay(req, res, slug);
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HostedError) { res.status(error.status).json({ error: error.code }); return; }
    // No raw URLs/headers here: an exchange code is a credential.
    res.status(503).json({ error: "hosted_unavailable" });
  });
  return router;
}

export function createHostedManagementRouter(prisma: PrismaClient, deps: HostedDeps = {}): Router {
  const router = Router(); const service = createHostedService(prisma, deps);
  router.get("/", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => { try { res.json(await service.list(req)); } catch (error) { next(error); } });
  router.post("/:slug/session", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!z.object({}).strict().safeParse(req.body ?? {}).success) { res.status(400).json({ error: "invalid_request" }); return; }
      res.setHeader("Cache-Control", "no-store"); res.json(await service.mint(req, req.params.slug));
    } catch (error) { next(error); }
  });
  router.get("/:slug/logs", requireRoleOrMcpService("owner", "admin"), async (req, res, next) => {
    try {
      const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
      const since = req.query.since === undefined ? undefined : Number(req.query.since);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000 || (since !== undefined && (!Number.isSafeInteger(since) || since < 0))) {
        res.status(400).json({ error: "invalid_log_cursor" }); return;
      }
      res.json(await service.logs(req, req.params.slug, limit, since));
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof HostedError ? error.status : 503).json({ error: error instanceof HostedError ? error.code : "hosted_unavailable" });
  });
  return router;
}
