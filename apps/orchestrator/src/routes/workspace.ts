/**
 * WARP-2896 (ADR-056 §6.2, slice G) — `/api/workspace/*` and `/api/git/*`:
 * the workshop's workspaces, and the git transport to them.
 *
 * TWO CALLERS, ONE IDENTITY RULE.
 *
 *   - A WORKSHOP RUN. The `workspace_*` tools (packages/tools-core
 *     handlers/workspace) reach here as the `_service:mcp` principal with
 *     `X-Nextcloud-User` naming the person the run acts for and
 *     `X-Droplet-Agent-Run` naming the run. The run is loaded and must (a)
 *     belong to that person, (b) be live (`running` — a parked run's
 *     approved call resumes as running before it is dispatched), and (c)
 *     carry THIS workspace's id: "run owns workspace". A prompt cannot steer
 *     a run into another workspace, because the binding is a column the
 *     route reads, not an argument the model supplies.
 *   - A PERSON on the dashboard (owner/admin), reading a workspace's log,
 *     diff and last run output, creating or deleting one, or driving git.
 *
 * Every write the sandbox performs is attributed to the resolved human
 * (`author`), never to the service principal.
 *
 * THE `run` ALLOW-LIST is applied HERE, before the sandbox is dialled
 * (`refuseRunArgv`), and again by the sandbox. A refused argv never leaves
 * this process.
 *
 * `/api/git/<repo>.git/*` is `git http-backend` behind the gateway: nginx
 * rewrites `/git/` to it, the auth middleware accepts the git CLI's Basic
 * form on this prefix (its second slot carries the session JWT), and the
 * push decision is made here — owner/admin push, every human role fetches,
 * the mcp principal gets nothing — and forwarded to the sandbox as a header.
 */
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import {
  recordAccessDenied,
  requireRole,
  requireRoleOrMcpService,
  type AuthUser,
} from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  createWorkspaceSandboxClient,
  refuseRunArgv,
  RUN_MAX_TIMEOUT_MS,
  WORKSPACE_ID,
  WorkspaceSandboxError,
  type WorkspaceAuthor,
  type WorkspaceOp,
  type WorkspaceSandboxClient,
} from "../services/workspace.service.js";
import { ACTIVE_AGENT_RUN_STATUSES } from "../services/agent-run-worker.service.js";

const MCP_PRINCIPAL_ID = "_service:mcp";
const WORKSHOP_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
// Fetch for every authenticated HUMAN role; push for owner/admin only. This is
// the ticket's AC verbatim — "read for any authenticated role; push for
// owner/admin" (WARP-2896, first bullet) — and deliberate: an extension's
// source is not the box's data (its files, mail, calendar), it is code a run
// wrote from a template, and the workshop's WRITE path (`/api/workspace/*`,
// owner/admin) is what protects the box. A guest cloning an in-progress
// extension sees what the owner could hand them anyway; tightening this is a
// product call to make on the ticket, not silently here.
const GIT_FETCH_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "family", "guest"]);
const GIT_PUSH_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
export const AGENT_RUN_HEADER = "x-droplet-agent-run";
const TEMPLATES_REPO = "templates";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  id: z.string().regex(WORKSPACE_ID).optional(),
  template: z.string().trim().min(1).max(64).optional(),
  onBehalfOf: z.string().trim().min(1).max(200).optional(),
});
const idParam = z.string().regex(WORKSPACE_ID);
const onBehalf = z.object({ onBehalfOf: z.string().trim().min(1).max(200).optional() });

const opSchemas: Record<WorkspaceOp, z.ZodTypeAny> = {
  read: onBehalf.extend({ path: z.string().min(1).max(256) }),
  search: onBehalf.extend({ pattern: z.string().min(1).max(256), glob: z.string().min(1).max(256).optional() }),
  diff: onBehalf.extend({ base: z.string().min(1).max(64).optional() }),
  log: onBehalf.extend({ limit: z.coerce.number().int().min(1).max(100).optional() }),
  write: onBehalf.extend({ path: z.string().min(1).max(256), content: z.string().max(1024 * 1024) }),
  commit: onBehalf.extend({ message: z.string().trim().min(1).max(2000) }),
  run: onBehalf.extend({
    argv: z.array(z.string().min(1).max(128)).min(1).max(16),
    timeoutMs: z.coerce.number().int().min(1000).max(RUN_MAX_TIMEOUT_MS).optional(),
  }),
  propose: onBehalf.extend({
    name: z.string().trim().min(1).max(80),
    version: z.string().trim().min(5).max(64),
    summary: z.string().trim().min(1).max(2000),
  }),
};
/** The ops a person may drive from the dashboard without a run. */
const HUMAN_OPS: ReadonlySet<WorkspaceOp> = new Set(["read", "search", "diff", "log"]);

interface Actor {
  id: string;
  username: string;
  role: string;
  displayName: string | null;
  email: string | null;
}

/** The person this request acts for (agent-runs.ts resolveActor, plus author fields). */
async function resolveActor(prisma: PrismaClient, req: Request, onBehalfOf: string | undefined): Promise<Actor | null> {
  const user = (req as Request & { user?: AuthUser }).user;
  if (!user) return null;
  let username = user.username;
  if (user.id === MCP_PRINCIPAL_ID && user.role === "service") {
    const header = req.header("x-nextcloud-user");
    const named = onBehalfOf ?? (header && header.trim().length > 0 ? header.trim() : undefined);
    if (!named) return null;
    username = named;
  }
  const row = await prisma.user.findFirst({
    where: { username },
    select: { id: true, username: true, role: true, displayName: true, email: true },
  });
  return row ? { ...row, role: String(row.role) } : null;
}

function authorOf(actor: Actor): WorkspaceAuthor {
  return {
    name: actor.displayName?.trim() || actor.username,
    email: actor.email?.trim() || `${actor.username}@droplet.local`,
  };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "ws"}-${randomBytes(3).toString("hex")}`;
}

function relaySandboxError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof WorkspaceSandboxError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

export function createWorkspaceRouter(
  prisma: PrismaClient,
  sandbox: WorkspaceSandboxClient = createWorkspaceSandboxClient(),
): Router {
  const router = Router();
  const gate = requireRoleOrMcpService("owner", "admin");

  async function actorOr403(req: Request, res: Response, onBehalfOf: string | undefined): Promise<Actor | null> {
    const actor = await resolveActor(prisma, req, onBehalfOf);
    if (!actor) {
      recordAccessDenied(req, "workspace-no-principal");
      res.status(403).json({ error: "Forbidden: no principal to act for" });
      return null;
    }
    if (!WORKSHOP_ROLES.has(actor.role)) {
      recordAccessDenied(req, "workspace-role");
      res.status(403).json({ error: "Forbidden: role not permitted to use the workshop" });
      return null;
    }
    return actor;
  }

  /**
   * "Run owns workspace". With the run header: the run must be the actor's,
   * live, and bound to `workspaceId`. Without it: only a person may proceed,
   * and only on the ops the dashboard drives (`HUMAN_OPS`) — the mcp
   * principal without a run is refused, so a chat turn cannot use the
   * workshop's write path by leaving the header off.
   */
  async function bindRun(
    req: Request,
    res: Response,
    actor: Actor,
    workspaceId: string,
    op: WorkspaceOp | null,
  ): Promise<{ runId: string | null } | null> {
    const raw = req.header(AGENT_RUN_HEADER)?.trim();
    const isMcp = (req as Request & { user?: AuthUser }).user?.id === MCP_PRINCIPAL_ID;
    if (!raw) {
      if (isMcp || (op && !HUMAN_OPS.has(op))) {
        recordAccessDenied(req, "workspace-no-run");
        res.status(403).json({ error: "Forbidden: this operation is performed by a workshop run" });
        return null;
      }
      return { runId: null };
    }
    const run = await prisma.agentRun.findUnique({
      where: { id: raw },
      select: { id: true, userId: true, status: true, workspaceId: true },
    });
    if (!run || run.userId !== actor.id || run.workspaceId !== workspaceId) {
      recordAccessDenied(req, "workspace-run-mismatch");
      res.status(403).json({ error: "Forbidden: that run does not own this workspace" });
      return null;
    }
    if (run.status !== "running") {
      recordAccessDenied(req, "workspace-run-not-live");
      res.status(409).json({ error: `Conflict: run is ${run.status}, not running` });
      return null;
    }
    return { runId: run.id };
  }

  // ── templates + collection ──────────────────────────────────────────────

  router.get("/workspace/templates", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await actorOr403(req, res, undefined);
      if (!actor) return;
      res.json({ templates: await sandbox.templates() });
    } catch (err) {
      relaySandboxError(err, res, next);
    }
  });

  router.get("/workspace", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await actorOr403(req, res, undefined);
      if (!actor) return;
      const rows = await prisma.workshopWorkspace.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, createdAt: true } },
        },
      });
      res.json({
        workspaces: rows.map((w) => ({
          id: w.id,
          name: w.name,
          template: w.template,
          status: w.status,
          proposedTag: w.proposedTag,
          proposedAt: w.proposedAt?.toISOString() ?? null,
          createdAt: w.createdAt.toISOString(),
          updatedAt: w.updatedAt.toISOString(),
          userId: w.userId,
          lastRun: w.runs[0]
            ? { id: w.runs[0].id, status: w.runs[0].status, createdAt: w.runs[0].createdAt.toISOString() }
            : null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/workspace", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid workspace", details: parsed.error.flatten() });
        return;
      }
      const actor = await actorOr403(req, res, parsed.data.onBehalfOf);
      if (!actor) return;
      const id = parsed.data.id ?? slugify(parsed.data.name);
      if (id === TEMPLATES_REPO) {
        res.status(400).json({ error: "that id is reserved" });
        return;
      }
      const existing = await prisma.workshopWorkspace.findUnique({ where: { id }, select: { id: true } });
      if (existing) {
        res.status(409).json({ error: `workspace ${id} already exists` });
        return;
      }
      // The sandbox first: a row with no repository behind it is the one
      // state the box must never run in, and the sandbox refuses a
      // duplicate on its own (409) if the DB and the volume ever disagree.
      const status = await sandbox.create(id, parsed.data.template ?? null, authorOf(actor));
      try {
        const row = await prisma.workshopWorkspace.create({
          data: { id, userId: actor.id, name: parsed.data.name, template: parsed.data.template ?? null },
        });
        await recordActivity({
          kind: "tool_run",
          severity: "info",
          sourceIcon: "hammer",
          what: "Workspace created",
          sub: parsed.data.name,
          actor: actorFromRequest(req),
          refs: { workspaceId: id, userId: actor.username, template: parsed.data.template ?? null },
        });
        res.status(201).json({
          id: row.id,
          name: row.name,
          template: row.template,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          git: status,
        });
      } catch (err) {
        await sandbox.remove(id).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      relaySandboxError(err, res, next);
    }
  });

  // ── one workspace ───────────────────────────────────────────────────────

  router.get("/workspace/:id", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "Invalid workspace id" });
        return;
      }
      const actor = await actorOr403(req, res, undefined);
      if (!actor) return;
      const row = await prisma.workshopWorkspace.findUnique({
        where: { id: id.data },
        include: {
          runs: {
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { id: true, status: true, goal: true, createdAt: true, endedAt: true, stopReason: true },
          },
        },
      });
      if (!row) {
        res.status(404).json({ error: "No such workspace" });
        return;
      }
      const git = await sandbox.status(id.data).catch((err: unknown) => {
        if (err instanceof WorkspaceSandboxError) return { error: err.message, code: err.code };
        throw err;
      });
      res.json({
        id: row.id,
        name: row.name,
        template: row.template,
        status: row.status,
        proposedTag: row.proposedTag,
        proposedAt: row.proposedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        userId: row.userId,
        git,
        runs: row.runs.map((r) => ({
          id: r.id,
          status: r.status,
          goal: r.goal,
          stopReason: r.stopReason,
          createdAt: r.createdAt.toISOString(),
          endedAt: r.endedAt?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/workspace/:id", requireRole("owner"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "Invalid workspace id" });
        return;
      }
      const row = await prisma.workshopWorkspace.findUnique({ where: { id: id.data }, select: { id: true, name: true } });
      if (!row) {
        res.status(404).json({ error: "No such workspace" });
        return;
      }
      const active = await prisma.agentRun.count({
        where: { workspaceId: id.data, status: { in: [...ACTIVE_AGENT_RUN_STATUSES] } },
      });
      if (active > 0) {
        res.status(409).json({ error: "A run is still working in this workspace; cancel it first" });
        return;
      }
      await sandbox.remove(id.data);
      await prisma.workshopWorkspace.delete({ where: { id: id.data } });
      await recordActivity({
        kind: "tool_run",
        severity: "warn",
        sourceIcon: "trash",
        what: "Workspace deleted",
        sub: row.name,
        actor: actorFromRequest(req),
        refs: { workspaceId: id.data },
      });
      res.json({ id: id.data, deleted: true });
    } catch (err) {
      relaySandboxError(err, res, next);
    }
  });

  // ── the dashboard's reads ───────────────────────────────────────────────

  router.get("/workspace/:id/log", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "Invalid workspace id" });
        return;
      }
      const actor = await actorOr403(req, res, undefined);
      if (!actor) return;
      if (!(await bindRun(req, res, actor, id.data, "log"))) return;
      const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
      res.json(await sandbox.op(id.data, "log", { limit }));
    } catch (err) {
      relaySandboxError(err, res, next);
    }
  });

  router.get("/workspace/:id/diff", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "Invalid workspace id" });
        return;
      }
      const actor = await actorOr403(req, res, undefined);
      if (!actor) return;
      if (!(await bindRun(req, res, actor, id.data, "diff"))) return;
      const base = typeof req.query.base === "string" && req.query.base.length > 0 ? req.query.base : undefined;
      res.json(await sandbox.op(id.data, "diff", base ? { base } : {}));
    } catch (err) {
      relaySandboxError(err, res, next);
    }
  });

  router.get("/workspace/:id/output", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: "Invalid workspace id" });
        return;
      }
      const actor = await actorOr403(req, res, undefined);
      if (!actor) return;
      if (!(await bindRun(req, res, actor, id.data, "log"))) return;
      res.json(await sandbox.output(id.data));
    } catch (err) {
      relaySandboxError(err, res, next);
    }
  });

  // ── the run's operations ────────────────────────────────────────────────
  //
  // One handler per op, each registered on its own literal path: the tool
  // manifest (tools-core tool-routes.ts) names them one by one, and the
  // admission suite reads the path literal off `router.post(`.

  function opHandler(op: WorkspaceOp) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = idParam.safeParse(req.params.id);
        if (!id.success) {
          res.status(400).json({ error: "Invalid workspace id" });
          return;
        }
        // Who, and may they — BEFORE the body is validated: a caller that
        // does not own the workspace learns nothing about the op's shape.
        const raw = (req.body ?? {}) as Record<string, unknown>;
        const actor = await actorOr403(req, res, typeof raw.onBehalfOf === "string" ? raw.onBehalfOf : undefined);
        if (!actor) return;
        const row = await prisma.workshopWorkspace.findUnique({
          where: { id: id.data },
          select: { id: true, status: true },
        });
        if (!row) {
          res.status(404).json({ error: "No such workspace" });
          return;
        }
        const bound = await bindRun(req, res, actor, id.data, op);
        if (!bound) return;
        const parsed = opSchemas[op].safeParse(raw);
        if (!parsed.success) {
          res.status(400).json({ error: `Invalid ${op}`, details: parsed.error.flatten() });
          return;
        }
        const { onBehalfOf: _onBehalfOf, ...body } = parsed.data as { onBehalfOf?: string } & Record<string, unknown>;
        if (!HUMAN_OPS.has(op) && row.status !== "active") {
          res.status(409).json({ error: `workspace is ${row.status}; nothing more can be written to it` });
          return;
        }
        if (op === "run") {
          // Refused HERE, before the sandbox is dialled. The sandbox refuses
          // it again; this is the one the model's argument meets first.
          const reason = refuseRunArgv(body.argv);
          if (reason) {
            res.status(400).json({ error: reason, code: "COMMAND_NOT_ALLOWED" });
            return;
          }
        }
        const withAuthor =
          op === "commit" || op === "propose" ? { ...body, author: authorOf(actor) } : body;
        const timeoutMs =
          op === "run" && typeof body.timeoutMs === "number" ? (body.timeoutMs as number) : undefined;
        const result = await sandbox.op(id.data, op, withAuthor, timeoutMs);

        if (op === "propose") {
          const tag = (result as { tag?: string })?.tag ?? null;
          await prisma.workshopWorkspace.update({
            where: { id: id.data },
            data: { status: "proposed", proposedTag: tag, proposedAt: new Date() },
          });
          await recordActivity({
            kind: "tool_run",
            severity: "info",
            sourceIcon: "hammer",
            what: "Extension proposed",
            sub: `${body.name as string} ${body.version as string}`,
            actor: actorFromRequest(req),
            refs: { workspaceId: id.data, userId: actor.username, agentRunId: bound.runId, tag },
          });
        } else if (op === "run" || op === "commit") {
          await recordActivity({
            kind: "tool_run",
            severity: "info",
            sourceIcon: "hammer",
            what: op === "run" ? "Workspace command ran" : "Workspace commit",
            sub: op === "run" ? (body.argv as string[]).join(" ") : (body.message as string).slice(0, 120),
            actor: actorFromRequest(req),
            refs: { workspaceId: id.data, userId: actor.username, agentRunId: bound.runId },
          });
        }
        res.json(result);
      } catch (err) {
        relaySandboxError(err, res, next);
      }
    };
  }

  router.post("/workspace/:id/read", gate, opHandler("read"));
  router.post("/workspace/:id/search", gate, opHandler("search"));
  router.post("/workspace/:id/diff", gate, opHandler("diff"));
  router.post("/workspace/:id/log", gate, opHandler("log"));
  router.post("/workspace/:id/write", gate, opHandler("write"));
  router.post("/workspace/:id/commit", gate, opHandler("commit"));
  router.post("/workspace/:id/run", gate, opHandler("run"));
  router.post("/workspace/:id/propose", gate, opHandler("propose"));

  // ── git smart HTTP ──────────────────────────────────────────────────────
  //
  // `/api/git/<repo>.git/<rest>`. Humans only (the mcp principal is 403 —
  // a tool has no business cloning). The repo must be a workspace the box
  // knows, or `templates`. Push is a role decision made here and forwarded
  // as X-Droplet-Git-Push; the sandbox's http-backend honours nothing else.

  // `inflate: false`: git gzips large pushes and says so in Content-Encoding;
  // the bytes and the header must reach http-backend together, untouched.
  const gitBody = express.raw({ type: () => true, limit: "64mb", inflate: false });

  router.all("/git/*", gitBody, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: AuthUser }).user;
      if (!user || user.id === MCP_PRINCIPAL_ID || user.role === "service") {
        recordAccessDenied(req, "git-no-human");
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (!GIT_FETCH_ROLES.has(user.role)) {
        recordAccessDenied(req, "git-role");
        res.status(403).json({ error: "Forbidden: role not permitted to use the workshop's git" });
        return;
      }
      const rest = req.path.replace(/^\/git/, "");
      const m = /^\/([a-z0-9][a-z0-9-]{0,63})\.git(\/.*)?$/.exec(rest);
      if (!m) {
        res.status(404).json({ error: "not a repository" });
        return;
      }
      const repo = m[1];
      if (repo !== TEMPLATES_REPO) {
        const row = await prisma.workshopWorkspace.findUnique({ where: { id: repo }, select: { id: true } });
        if (!row) {
          res.status(404).json({ error: "not a repository" });
          return;
        }
      }
      const service = typeof req.query.service === "string" ? req.query.service : "";
      const wantsPush = service === "git-receive-pack" || rest.endsWith("/git-receive-pack");
      const allowPush = GIT_PUSH_ROLES.has(user.role);
      if (wantsPush && !allowPush) {
        recordAccessDenied(req, "git-push-role");
        res.status(403).json({ error: "Forbidden: your role may fetch this repository, not push to it" });
        return;
      }
      const out = await sandbox.git({
        method: req.method,
        path: rest,
        query: req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1) : "",
        contentType: req.header("content-type") ?? null,
        contentEncoding: req.header("content-encoding") ?? null,
        body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        user: user.username,
        allowPush,
      });
      if (wantsPush && req.method === "POST" && out.status === 200) {
        await recordActivity({
          kind: "tool_run",
          severity: "info",
          sourceIcon: "hammer",
          what: "Workspace push",
          sub: `${repo}.git`,
          actor: actorFromRequest(req),
          refs: { workspaceId: repo, userId: user.username },
        });
      }
      res.status(out.status);
      for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
      // Packfile bytes for the git CLI, under git's own content types (or
      // text/plain for http-backend's refusals) — never HTML, and nosniff so
      // a browser cannot be talked into treating them as such.
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (!out.headers["content-type"]) res.setHeader("Content-Type", "application/octet-stream");
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      res.send(out.body);
    } catch (err) {
      relaySandboxError(err, res, next);
    }
  });

  return router;
}
