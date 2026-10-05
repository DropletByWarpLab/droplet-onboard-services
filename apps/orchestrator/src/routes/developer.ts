/**
 * WARP-3533 — `/api/developer/*`: Settings -> Developer. Personal API tokens for
 * `/api/pm` and `/api/support`, the workspace switch for them, and the ICS feed
 * links for "my work" and each project (ADR-069 §9).
 *
 *   GET    /developer                       page state + the caller's own tokens
 *   PUT    /developer/settings              the box-wide switch (owner/admin, audited)
 *   POST   /developer/tokens                mint a token (shown once; 409 while off)
 *   GET    /developer/tokens/all            every token, with its holder (owner/admin)
 *   DELETE /developer/tokens/:id            revoke, keeping the row (own, or owner/admin)
 *   GET    /developer/feeds                 "my work" + each project, and whether it has a link
 *   POST   /developer/feeds/rotate          mint a feed link (ends that feed's previous one)
 *   POST   /developer/feeds/revoke          turn a feed link off
 *
 * Owner, admin and members (wire role `family`) may hold a token; guests and
 * every service principal get 403 `role_not_allowed`. The feed routes refuse
 * through the Projects gates instead (404 `module_disabled`), because a feed is
 * a view of Projects, not a credential for the API.
 *
 * WHY THIS ROUTER IS NOT UNDER /api/pm: an API token is confined to `/api/pm`
 * and `/api/support` (middleware/pm-api-token-guard.ts). A token that could call
 * these routes could mint its own successor, a feed link that outlives its
 * revocation, or flip the switch. Living here, a token is a 403 on every one of
 * them — pinned in developer.routes.test.ts against the real auth stack.
 *
 * The switch OFF does not revoke anything: every token answers 401 until it is
 * back on. Creating a token while it is off is a 409.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { recordAccessDenied, requireRole } from "../middleware/auth.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { getEffectiveModuleIds } from "../services/modules.service.js";
import {
  PM_API_TOKENS_ENABLED_KEY,
  PM_API_TOKEN_HOLDER_ROLES,
  PM_API_TOKEN_MAX_LIFETIME_MS,
  PM_API_TOKEN_SCOPES,
  createPmApiToken,
  isPmApiTokensEnabled,
  listPmApiTokens,
  revokePmApiToken,
  setPmApiTokensEnabled,
  type PmApiTokenManager,
  type PmApiTokenScope,
} from "../services/pm/pm-api-token.service.js";
import {
  feedPath,
  listActivePmFeedLinks,
  revokeFeedTokens,
  rotateFeedToken,
  type FeedTarget,
} from "../services/calendar-feed-token.service.js";
import { pmFeedAccessRefusal } from "../services/pm/pm-feed-access.js";
import { findFeedProject, listFeedProjects } from "../services/pm/pm-ics.service.js";

/** What each scope means, in the words the page shows. */
const SCOPE_COPY: Record<PmApiTokenScope, { label: string; description: string }> = {
  "pm:read": {
    label: "Read projects",
    description: "List and read projects, work items, comments and activity.",
  },
  "pm:write": {
    label: "Read and change projects",
    description: "Everything above, plus create, edit, move, comment on and delete work, as you.",
  },
  "support:read": {
    label: "Read support tickets",
    description: "List and read tickets and their conversations.",
  },
  "support:write": {
    label: "Read and change support tickets",
    description: "Everything above, plus reply to, edit and close tickets, as you.",
  },
};

/** The module each scope reaches: a scope for a switched-off module is not offered. */
const SCOPE_MODULE: Record<PmApiTokenScope, string> = {
  "pm:read": "projects",
  "pm:write": "projects",
  "support:read": "support",
  "support:write": "support",
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(PM_API_TOKEN_SCOPES)).min(1).max(PM_API_TOKEN_SCOPES.length),
  expiresAt: z.string().datetime().nullable().optional(),
});
const settingsSchema = z.object({ enabled: z.boolean() });
const feedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("my_work") }),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1).max(64) }),
]);

function requireHolderRole(req: Request, res: Response, next: NextFunction): void {
  if (PM_API_TOKEN_HOLDER_ROLES.has(req.user?.role ?? "")) {
    next();
    return;
  }
  recordAccessDenied(req, "role-not-permitted");
  res.status(403).json({ error: "role_not_allowed" });
}

/** Any signed-in PERSON (the feed routes' own gate is the Projects floor, which answers a guest 404). */
function requirePerson(req: Request, res: Response, next: NextFunction): void {
  const role = req.user?.role;
  if (role === "owner" || role === "admin" || role === "family" || role === "guest") {
    next();
    return;
  }
  recordAccessDenied(req, "role-not-permitted");
  res.status(403).json({ error: "role_not_allowed" });
}

const isAdmin = (req: Request): boolean => req.user?.role === "owner" || req.user?.role === "admin";
const manager = (req: Request): PmApiTokenManager => ({ userId: req.user!.id, isAdmin: isAdmin(req) });

export function createDeveloperRouter(prisma: PrismaClient): Router {
  const router = Router();

  async function pageState(req: Request) {
    const [enabled, effective, tokens] = await Promise.all([
      isPmApiTokensEnabled(prisma),
      getEffectiveModuleIds(prisma, config).catch(() => new Set<string>() as ReadonlySet<string>),
      listPmApiTokens(prisma, req.user!.id),
    ]);
    const scopes = PM_API_TOKEN_SCOPES.filter((s) => (effective as ReadonlySet<string>).has(SCOPE_MODULE[s])).map((id) => ({
      id,
      ...SCOPE_COPY[id],
    }));
    return {
      enabled,
      canCreate: enabled && PM_API_TOKEN_HOLDER_ROLES.has(req.user!.role),
      isAdmin: isAdmin(req),
      scopes,
      tokens,
      openapiPath: "/api/pm/openapi.json",
    };
  }

  router.get("/developer", requireHolderRole, async (req, res, next) => {
    try {
      res.json(await pageState(req));
    } catch (err) {
      next(err);
    }
  });

  router.put("/developer/settings", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_settings" });
        return;
      }
      const { enabled } = parsed.data;
      if (await setPmApiTokensEnabled(prisma, enabled)) {
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "key-round",
          what: enabled ? "API tokens allowed" : "API tokens blocked",
          sub: req.user?.username ?? null,
          refs: { setting: PM_API_TOKENS_ENABLED_KEY, enabled },
          actor: actorFromRequest(req),
        });
      }
      res.json(await pageState(req));
    } catch (err) {
      next(err);
    }
  });

  router.post("/developer/tokens", sensitiveRateLimit, requireHolderRole, async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const now = new Date();
      let expiresAt: Date | null = null;
      if (parsed.data.expiresAt) {
        expiresAt = new Date(parsed.data.expiresAt);
        if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() > now.getTime() + PM_API_TOKEN_MAX_LIFETIME_MS) {
          res.status(400).json({ error: "invalid_expiry" });
          return;
        }
      }
      if (!(await isPmApiTokensEnabled(prisma))) {
        res.status(409).json({ error: "disabled" });
        return;
      }
      const user = req.user!;
      const minted = await createPmApiToken(
        prisma,
        { id: user.id, role: user.role },
        { name: parsed.data.name, scopes: parsed.data.scopes, expiresAt },
        now,
      );
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "key-round",
        what: "API token created",
        sub: minted.row.name,
        // Never the token itself — the row id is the non-secret handle.
        refs: { tokenId: minted.row.id, userId: user.id, scopes: minted.row.scopes, expiresAt: minted.row.expiresAt },
        actor: actorFromRequest(req),
      });
      res.status(201).json(minted);
    } catch (err) {
      next(err);
    }
  });

  router.get("/developer/tokens/all", requireRole("owner", "admin"), async (_req, res, next) => {
    try {
      res.json({ tokens: await listPmApiTokens(prisma, null) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/developer/tokens/:id", requireHolderRole, async (req, res, next) => {
    try {
      const revoked = await revokePmApiToken(prisma, req.params.id, manager(req));
      if (revoked === "not_found") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (revoked !== "already") {
        await recordActivity({
          kind: "auth",
          severity: "ok",
          sourceIcon: "key-round",
          what: "API token revoked",
          sub: revoked.name,
          refs: { tokenId: req.params.id, userId: revoked.userId, revokedBy: req.user!.id },
          actor: actorFromRequest(req),
        });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── ICS feed links ────────────────────────────────────────────────────────

  /** The Projects gates, re-asked here (see services/pm/pm-feed-access.ts). True = refused and answered. */
  async function refusedByProjects(req: Request, res: Response): Promise<boolean> {
    const refusal = await pmFeedAccessRefusal(prisma, req.user!.role);
    if (!refusal) return false;
    recordAccessDenied(req, "feed-projects-gate");
    res.status(refusal.status).json(refusal.body);
    return true;
  }

  /** The feed a request body names, or null after answering 400 / 404. */
  async function feedTarget(req: Request, res: Response): Promise<{ target: FeedTarget; name: string } | null> {
    const parsed = feedSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return null;
    }
    if (parsed.data.kind === "my_work") return { target: { scope: "pm_my_work" }, name: "My work" };
    const project = await findFeedProject(prisma, parsed.data.projectId);
    if (!project) {
      res.status(404).json({ error: "project_not_found" });
      return null;
    }
    return { target: { scope: "pm_project", projectId: project.id }, name: project.name };
  }

  router.get("/developer/feeds", requirePerson, async (req, res, next) => {
    try {
      if (await refusedByProjects(req, res)) return;
      const [links, projects] = await Promise.all([listActivePmFeedLinks(prisma, req.user!.id), listFeedProjects(prisma)]);
      const mine = links.find((l) => l.target.scope === "pm_my_work");
      const byProject = new Map(
        links.flatMap((l) => (l.target.scope === "pm_project" ? [[l.target.projectId, l] as const] : [])),
      );
      const state = (l?: { createdAt: Date; expiresAt: Date }) => ({
        state: l ? ("active" as const) : ("none" as const),
        createdAt: l?.createdAt.toISOString() ?? null,
        expiresAt: l?.expiresAt.toISOString() ?? null,
      });
      res.json({
        feeds: [
          { kind: "my_work", projectId: null, name: "My work", identifier: null, ...state(mine) },
          ...projects.map((p) => ({
            kind: "project",
            projectId: p.id,
            name: p.name,
            identifier: p.identifier,
            ...state(byProject.get(p.id)),
          })),
        ],
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/developer/feeds/rotate", sensitiveRateLimit, requirePerson, async (req, res, next) => {
    try {
      if (await refusedByProjects(req, res)) return;
      const feed = await feedTarget(req, res);
      if (!feed) return;
      const user = req.user!;
      const minted = await rotateFeedToken(prisma, user.id, feed.target);
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "calendar",
        what: minted.rotated > 0 ? "Work feed link replaced" : "Work feed link created",
        sub: feed.name,
        // Never the token itself — the row id is the non-secret selector.
        refs: {
          tokenId: minted.id,
          scope: feed.target.scope,
          projectId: feed.target.scope === "pm_project" ? feed.target.projectId : null,
          endedPrevious: minted.rotated,
          expiresAt: minted.expiresAt.toISOString(),
        },
        actor: actorFromRequest(req),
      });
      res.json({
        url: `${feedPath(user.username, feed.target)}?token=${minted.token}`,
        expiresAt: minted.expiresAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/developer/feeds/revoke", requirePerson, async (req, res, next) => {
    try {
      if (await refusedByProjects(req, res)) return;
      const feed = await feedTarget(req, res);
      if (!feed) return;
      const revoked = await revokeFeedTokens(prisma, req.user!.id, feed.target);
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "calendar",
        what: "Work feed link turned off",
        sub: feed.name,
        refs: {
          scope: feed.target.scope,
          projectId: feed.target.scope === "pm_project" ? feed.target.projectId : null,
          revoked,
        },
        actor: actorFromRequest(req),
      });
      res.json({ revoked });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
