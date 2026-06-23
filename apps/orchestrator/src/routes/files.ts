import { Router, Request, Response, NextFunction } from "express";
import * as path from "node:path";
import { Readable } from "node:stream";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import {
  ncListFiles,
  ncUploadFile,
  ncDownloadFile,
  ncDeleteFile,
  ncCreateDirectory,
  ncListShares,
  ncMoveFile,
  ncCopyFile,
  ncGetFileId,
  ncListTrash,
  ncRestoreTrashItem,
  ncDeleteTrashItem,
  ncEmptyTrash,
  ncListVersions,
  ncRestoreVersion,
  ncSetFavorite,
  ncListFavorites,
  ncSearchFiles,
  ncListRecents,
  ncFetchThumbnail,
  ncCreateShareV2,
  ncUpdateShare,
  ncDeleteShare,
  ncListSharedWithMe,
  ncDirExists,
  NextcloudOcsError,
} from "../services/nextcloud.client.js";
import type { BulkOperationResult } from "../types/index.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { publish } from "../services/mqtt.service.js";
import { config } from "../config.js";
import type { FileEntryInfo } from "../types/index.js";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import { isUpstreamUnavailable } from "../lib/upstream-unavailable.js";

const logger = pino({ name: "files-route" });

const CACHE_PREFIX = "files:list:";
const CACHE_TTL = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

/**
 * Resolve the Nextcloud credential for this request. For JWT sessions the
 * token is looked up from the Redis-backed NC session store; for legacy
 * sessions the cookie IS the NC token. Throws a sentinel error that the
 * route handlers convert to 401 when no credential is available (e.g. the
 * session pre-dates the NC-session store or the user hasn't logged in
 * since the fix shipped).
 */
class MissingNcTokenError extends Error {
  constructor() {
    super("Nextcloud session is missing — please log in again");
    this.name = "MissingNcTokenError";
  }
}

/**
 * WARP-861 — the MCP file tools call these routes with the service
 * bearer (SERVICE_TOKEN_MCP → `_service:mcp`) plus the per-user
 * Nextcloud credential the agent loop threads via `_meta.ncToken`:
 *   X-Nextcloud-Token: the user's NC app-password / session token
 *   X-Nextcloud-User:  the username the call acts as
 * Only the trusted mcp service principal may assert another user this
 * way (same trust posture as the stdio `_meta` channel); for every
 * other caller the headers are ignored and the session cookie rules.
 */
function isMcpService(req: Request): boolean {
  return req.user?.id === "_service:mcp" && req.user.role === "service";
}

async function getToken(req: Request): Promise<string> {
  if (isMcpService(req)) {
    const headerToken = (req.header("x-nextcloud-token") ?? "").trim();
    if (!headerToken) throw new MissingNcTokenError();
    return headerToken;
  }
  const token = await resolveNcToken(req);
  if (!token) throw new MissingNcTokenError();
  return token;
}

/** Get the username from the authenticated request. */
function getUser(req: Request): string {
  if (isMcpService(req)) {
    const headerUser = (req.header("x-nextcloud-user") ?? "").trim();
    // No fallback for the service principal: acting as "admin" by
    // default would be a privilege escalation, not a convenience.
    if (!headerUser) throw new MissingNcTokenError();
    return headerUser;
  }
  return req.user?.username || "admin";
}

// ────────────────────────────────────────────────────────────
//  WARP-883 (ADR-027 WS-5) — Files spaces (My Files / Shared Household)
// ────────────────────────────────────────────────────────────
//
// Every user already has a PRIVATE space — their own Nextcloud home (the
// per-user `ncCreateUser` account + WebDAV root). What WS-5 adds is a SHARED
// "Household" space, backed by the Nextcloud `groupfolders` app. The
// groupfolders app mounts the group folder INTO each assigned member's home as
// a top-level directory (e.g. `/Household`). So the "shared" space is NOT a
// separate account or WebDAV root — it is just a well-known path prefix browsed
// with the user's OWN existing token. That keeps the per-user routing already
// in place and means a single config var (`DROPLET_SHARED_FOLDER_NAME`) defines
// the whole feature.

/** The top-level folder name the shared "Household" space lives under. */
const SHARED_FOLDER_NAME = config.DROPLET_SHARED_FOLDER_NAME;
/** Absolute home-relative path to the shared space root (e.g. "/Household"). */
const SHARED_FOLDER_PATH = `/${SHARED_FOLDER_NAME}`;

type Space = "personal" | "shared";

/** Coerce an arbitrary `?space=` value to a known space (default personal). */
function resolveSpace(raw: unknown): Space {
  return raw === "shared" ? "shared" : "personal";
}

/**
 * Map a (space, requested path) pair to the real WebDAV home-relative path.
 *
 * - personal: the path is used verbatim (the user's home root).
 * - shared:   the path is resolved UNDER the shared-folder prefix, so
 *             `?space=shared&path=/Trips` → `/Household/Trips` and the bare
 *             shared root → `/Household`. The prefix is always applied here so
 *             a caller can never escape the shared mount via this route.
 */
function rootForSpace(space: Space, requestedPath: string): string {
  const rel = requestedPath.replace(/^\/+/, "");
  if (space === "shared") {
    return rel ? `${SHARED_FOLDER_PATH}/${rel}` : SHARED_FOLDER_PATH;
  }
  return requestedPath || "/";
}

/** Safely publish an MQTT message — failures are non-fatal. */
function safePublish(topic: string, payload: Record<string, unknown>): void {
  try {
    publish(topic, payload);
  } catch (err) {
    logger.warn({ err, topic }, "MQTT publish failed (non-fatal)");
  }
}

// ────────────────────────────────────────────────────────────
//  WARP-880 / WS-2 — keyword + hybrid content search
// ────────────────────────────────────────────────────────────

/** Content-search modes for `GET /api/files/search/content` (WARP-880). */
const FILE_SEARCH_MODES = ["semantic", "keyword", "hybrid"] as const;
type FileSearchMode = (typeof FILE_SEARCH_MODES)[number];

/**
 * The lexical/hybrid engine returns one row per matched *chunk*. A single
 * file is chunked into many rows, so over-fetch by this factor before
 * collapsing to one hit per file — `limit * CHUNKS_PER_FILE_FACTOR` keeps
 * enough headroom that the per-file top-K survives dedupe.
 */
const CHUNKS_PER_FILE_FACTOR = 5;

/**
 * Collapse the engine's per-chunk `SearchHit[]` to one result per file,
 * keeping the best chunk for each path. The service returns rows in score
 * DESC order, so the first chunk seen for a given `path` is the best one.
 * Maps the service `snippet` field → `text` so the output shape matches
 * the existing `SemanticSearchResult` `{ path, score, text }` the
 * frontend already renders.
 */
function dedupeHitsPerFile(
  hits: Array<{ path: string; score: number; snippet: string }>,
  limit: number,
): Array<{ path: string; score: number; text: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; score: number; text: string }> = [];
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    out.push({ path: hit.path, score: hit.score, text: hit.snippet });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Map errors from the Nextcloud client + generic fallthroughs to HTTP responses.
 * OCS errors preserve their upstream status (400 for validation, 403 forbidden,
 * 404 not found, 997 not allowed) so the frontend can render the real message.
 *
 * `degradeTo` (read endpoints only): when supplied AND the error means Nextcloud
 * is simply unreachable (down / 5xx / not resolvable), respond 200 with this
 * empty shape instead of a 500 so the dashboard's file surfaces don't dead-end
 * during a Nextcloud outage (mirrors models-summary.service.ts). Real errors —
 * auth/validation/403/404/OCS status — are handled by the checks ABOVE and keep
 * their existing behavior; only the unavailable-dependency path degrades, and we
 * deliberately do NOT cache the empty fallback so it self-heals on recovery.
 *
 * ORDERING CONTRACT: the `NextcloudOcsError` check runs before the `degradeTo`
 * branch, so a 4xx OCS status always surfaces verbatim. But a *5xx* OCS status
 * means the same thing as a connectivity failure — Nextcloud is down — so on a
 * read endpoint (degradeTo supplied) it must fall through to the empty fallback
 * rather than return a 5xx. Today the degraded list fns throw plain `Error`, so
 * `isUpstreamUnavailable` already catches them via message shape; this 5xx-OCS
 * carve-out locks the contract so a future refactor that throws
 * `NextcloudOcsError(503)` from a list fn still degrades instead of silently
 * 503-ing. The files-route test asserts exactly this.
 */
function handleFileError(
  err: unknown,
  res: Response,
  next: NextFunction,
  degradeTo?: unknown
): void {
  if (err instanceof MissingNcTokenError) {
    res.status(401).json({ error: err.message });
    return;
  }
  // A 5xx OCS status means Nextcloud is down, same as a connectivity failure —
  // so on a read endpoint (degradeTo supplied) it joins the degrade path below
  // instead of surfacing the 5xx (see ORDERING CONTRACT above).
  const ocsOutage =
    err instanceof NextcloudOcsError &&
    err.ocsStatus >= 500 &&
    err.ocsStatus < 600;
  if (err instanceof NextcloudOcsError && !(degradeTo !== undefined && ocsOutage)) {
    const status =
      err.ocsStatus >= 400 && err.ocsStatus < 600 ? err.ocsStatus : 400;
    res.status(status).json({ error: err.message });
    return;
  }
  const anyErr = err as any;
  if (anyErr?.message?.includes("404")) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  if (degradeTo !== undefined && (isUpstreamUnavailable(err) || ocsOutage)) {
    logger.warn({ err }, "Nextcloud unreachable; serving empty file listing");
    res.json(degradeTo);
    return;
  }
  next(err);
}

export function createFilesRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── WARP-473 — file citations (related chats for §2.3 file drawer)
  // GET /api/files/:path(*)/citations?limit=20 — returns recent
  // ChatMessage→ChatSession rows that referenced this filePath.
  //
  // The `:path(*)` wildcard captures arbitrary slashes in the file
  // path (Nextcloud paths look like `/Documents/foo.pdf`). The route
  // is mounted at top-level so this matches `/api/files/Documents/foo.pdf/citations`.
  // Read access is owner+admin+family — guests don't see chat history.
  interface CitationRow {
    id: string;
    filePath: string;
    userId: string;
    threadId: string;
    messageId: string;
    citedAt: Date;
  }
  router.get(
    "/files/:filePath(*)/citations",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const filePath = req.params.filePath
          ? `/${req.params.filePath}`.replace(/\/+/g, "/")
          : "";
        if (filePath === "" || filePath === "/") {
          res.status(400).json({ error: "filePath path-param is required" });
          return;
        }
        const rawLimit = Number.parseInt(String(req.query.limit ?? "20"), 10);
        const limit = Math.max(
          1,
          Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 20),
        );

        // IDOR boundary: FileCitation has no built-in per-row owner check
        // — cross-user leak unless we filter on userId. Owner/admin see
        // every household citation (consistent with /api/activity); other
        // roles are scoped to their own sessions.
        const role = (req as { user?: { role?: string; id?: string } }).user?.role;
        const requesterId =
          (req as { user?: { role?: string; id?: string } }).user?.id ?? "__none__";
        const isPrivileged = role === "owner" || role === "admin";
        const where = isPrivileged
          ? { filePath }
          : { filePath, userId: requesterId };

        const rows = (await prisma.fileCitation.findMany({
          where,
          orderBy: { citedAt: "desc" },
          take: limit,
        })) as unknown as CitationRow[];

        if (rows.length === 0) {
          res.json({ filePath, citations: [] });
          return;
        }

        // Resolve session metadata (title + updatedAt) so the dashboard
        // can render the related-chats list without N round-trips. We
        // de-dup by threadId because one message can fire-and-forget
        // many file paths per turn — the dashboard wants one row per
        // *chat*, not per citation.
        const threadIds = Array.from(new Set(rows.map((r) => r.threadId)));
        const sessions = (await prisma.chatSession.findMany({
          where: { id: { in: threadIds } },
          select: { id: true, title: true, updatedAt: true, userId: true },
        })) as Array<{
          id: string;
          title: string | null;
          updatedAt: Date;
          userId: string;
        }>;
        const sessionById = new Map(sessions.map((s) => [s.id, s]));

        // One row per thread, latest citation wins.
        const seen = new Set<string>();
        const citations: Array<{
          threadId: string;
          messageId: string;
          title: string | null;
          citedAt: Date;
          updatedAt: Date | null;
        }> = [];
        for (const r of rows) {
          if (seen.has(r.threadId)) continue;
          seen.add(r.threadId);
          const session = sessionById.get(r.threadId);
          citations.push({
            threadId: r.threadId,
            messageId: r.messageId,
            title: session?.title ?? null,
            citedAt: r.citedAt,
            updatedAt: session?.updatedAt ?? null,
          });
        }

        res.json({ filePath, citations });
      } catch (err) {
        next(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  //  WARP-881 / WS-3 (ADR-027) — native file comments + tags
  // ────────────────────────────────────────────────────────────
  //
  // Nextcloud stays dumb storage (ADR-013); Droplet owns this metadata in
  // Prisma, keyed on `ncFileId` (oc:fileid) so it SURVIVES a rename/move —
  // unlike the path-keyed FileCitation rows above, which go stale on rename.
  //
  // IDOR: the owner column is written AND filtered using `req.user.id` (the
  // local User UUID) — NOT `getUser(req)`, which returns the Nextcloud
  // username. Filtering by the UUID while storing the username would make a
  // `family` user see ZERO of their own comments. Mirrors FileCitation's
  // read filter (`req.user.id`) exactly. No caching — file metadata must be
  // immediately consistent.

  /** The local User UUID for the requester (NOT the NC username). */
  const requesterId = (req: Request): string =>
    (req as { user?: { id?: string } }).user?.id ?? "__none__";

  /** owner/admin see every household row; family is scoped to its own. */
  const isPrivilegedReq = (req: Request): boolean => {
    const role = (req as { user?: { role?: string } }).user?.role;
    return role === "owner" || role === "admin";
  };

  /**
   * Resolve a request's `:filePath(*)` param to its Nextcloud numeric file
   * id via `ncGetFileId(token, ncUser, path)`. Responds 404 and returns
   * `null` when the path doesn't resolve (mirrors the versions route).
   * `filePath` arrives WITHOUT a leading slash from the wildcard param.
   */
  async function resolveFileIdOr404(
    req: Request,
    res: Response,
    filePath: string,
  ): Promise<number | null> {
    const normalizedPath = filePath
      ? `/${filePath}`.replace(/\/+/g, "/")
      : "";
    if (normalizedPath === "" || normalizedPath === "/") {
      res.status(400).json({ error: "filePath path-param is required" });
      return null;
    }
    const token = await getToken(req);
    const ncUser = getUser(req);
    const fileId = await ncGetFileId(token, ncUser, normalizedPath);
    if (fileId === null) {
      res.status(404).json({ error: "File not found" });
      return null;
    }
    return fileId;
  }

  // ── Comment delete (DELETE /api/files/comments/:id) ──
  // REGISTERED BEFORE the `/files/:filePath(*)/...` routes so the wildcard
  // doesn't shadow this literal path (`comments` would otherwise be captured
  // as a filePath segment). Author-or-privileged: a family member may delete
  // only their own comment; owner/admin may delete any.
  router.delete(
    "/files/comments/:id",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const id = req.params.id;
        const row = await prisma.fileComment.findUnique({ where: { id } });
        if (!row) {
          res.status(404).json({ error: "Comment not found" });
          return;
        }
        // Author check uses the UUID owner column, never the username.
        const isAuthor = row.authorUserId === requesterId(req);
        if (!isAuthor && !isPrivilegedReq(req)) {
          res.status(403).json({ error: "Not your comment" });
          return;
        }
        // Re-assert the scope in the delete predicate (defense in depth):
        // a privileged caller deletes by id; a family author by (id, owner).
        const where = isPrivilegedReq(req)
          ? { id }
          : { id, authorUserId: requesterId(req) };
        await prisma.fileComment.deleteMany({ where });
        // Topic carries the {user} segment so the WS bridge forwards it
        // (it subscribes to `droplet/files/{user}/#`); useFileRealtime then
        // does its blanket `/api/files`-prefix SWR invalidation.
        safePublish(`droplet/files/${getUser(req)}/comment-deleted`, {
          id,
          ncFileId: row.ncFileId,
        });
        res.status(204).end();
      } catch (err) {
        handleFileError(err, res, next);
      }
    },
  );

  // ── Comments: list (GET /api/files/:filePath(*)/comments) ──
  // User-scoped: a family member sees only its own comments; owner/admin see
  // every household comment on the file.
  router.get(
    "/files/:filePath(*)/comments",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const fileId = await resolveFileIdOr404(req, res, req.params.filePath);
        if (fileId === null) return;
        const where = isPrivilegedReq(req)
          ? { ncFileId: fileId }
          : { ncFileId: fileId, authorUserId: requesterId(req) };
        const comments = await prisma.fileComment.findMany({
          where,
          orderBy: { createdAt: "desc" },
        });
        res.json({ ncFileId: fileId, comments });
      } catch (err) {
        handleFileError(err, res, next);
      }
    },
  );

  // ── Comments: create (POST /api/files/:filePath(*)/comments) ──
  router.post(
    "/files/:filePath(*)/comments",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const schema = z.object({ body: z.string().min(1).max(4000) });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Comment body is required (1–4000 chars)" });
          return;
        }
        const fileId = await resolveFileIdOr404(req, res, req.params.filePath);
        if (fileId === null) return;
        const comment = await prisma.fileComment.create({
          data: {
            ncFileId: fileId,
            authorUserId: requesterId(req),
            body: parsed.data.body,
          },
        });
        // {user} segment so the WS bridge (droplet/files/{user}/#) forwards
        // it → useFileRealtime invalidates the file SWR caches.
        safePublish(`droplet/files/${getUser(req)}/comment-added`, {
          id: comment.id,
          ncFileId: fileId,
          authorUserId: comment.authorUserId,
        });
        res.status(201).json({ comment });
      } catch (err) {
        handleFileError(err, res, next);
      }
    },
  );

  // ── Tags: list (GET /api/files/:filePath(*)/tags) ──
  // FILE-scoped (NOT user-scoped): every reader sees every tag on the file —
  // a household-shared taxonomy. `addedByUserId` is provenance only.
  router.get(
    "/files/:filePath(*)/tags",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const fileId = await resolveFileIdOr404(req, res, req.params.filePath);
        if (fileId === null) return;
        const tags = await prisma.fileTag.findMany({
          where: { ncFileId: fileId },
          orderBy: { createdAt: "asc" },
        });
        res.json({ ncFileId: fileId, tags });
      } catch (err) {
        handleFileError(err, res, next);
      }
    },
  );

  // ── Tags: create (POST /api/files/:filePath(*)/tags) ──
  // Upsert on the @@unique(ncFileId, label): a re-add is an idempotent no-op
  // that preserves the original `addedByUserId` / `createdAt`.
  router.post(
    "/files/:filePath(*)/tags",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const schema = z.object({ label: z.string().min(1).max(64) });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Tag label is required (1–64 chars)" });
          return;
        }
        const fileId = await resolveFileIdOr404(req, res, req.params.filePath);
        if (fileId === null) return;
        const tag = await prisma.fileTag.upsert({
          where: { ncFileId_label: { ncFileId: fileId, label: parsed.data.label } },
          create: {
            ncFileId: fileId,
            label: parsed.data.label,
            addedByUserId: requesterId(req),
          },
          // No-op on conflict — the unique row already exists and its
          // provenance (addedByUserId/createdAt) must NOT be overwritten.
          update: {},
        });
        safePublish(`droplet/files/${getUser(req)}/tag-added`, {
          ncFileId: fileId,
          label: tag.label,
        });
        res.status(201).json({ tag });
      } catch (err) {
        handleFileError(err, res, next);
      }
    },
  );

  // ── Tags: delete (DELETE /api/files/:filePath(*)/tags/:label) ──
  router.delete(
    "/files/:filePath(*)/tags/:label",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        const fileId = await resolveFileIdOr404(req, res, req.params.filePath);
        if (fileId === null) return;
        const label = req.params.label;
        await prisma.fileTag.deleteMany({ where: { ncFileId: fileId, label } });
        safePublish(`droplet/files/${getUser(req)}/tag-removed`, {
          ncFileId: fileId,
          label,
        });
        res.status(204).end();
      } catch (err) {
        handleFileError(err, res, next);
      }
    },
  );

  // ── Multer error handler ──
  function handleUpload(req: Request, res: Response, next: NextFunction) {
    upload.array("files", 20)(req, res, (err) => {
      if (err instanceof MulterError) {
        const messages: Record<string, string> = {
          LIMIT_FILE_SIZE: `File too large (max ${config.MAX_UPLOAD_SIZE_MB}MB)`,
          LIMIT_FILE_COUNT: "Too many files (max 20)",
          LIMIT_UNEXPECTED_FILE: 'Unexpected field name (use "files")',
        };
        res
          .status(400)
          .json({ error: messages[err.code] ?? `Upload error: ${err.message}` });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  }

  // ── List directory contents ──
  //
  // WARP-883: accepts an optional `?space=personal|shared` (default personal).
  // `shared` resolves the listing under the Household group-folder prefix; the
  // user's OWN token still drives the request (groupfolders mounts the folder
  // into their home). On the My-Files (personal) home ROOT we hide the shared
  // folder entry so the Household folder isn't shown twice — once as a space in
  // the switcher and once inline.
  router.get("/files", async (req, res, next) => {
    try {
      const requestedPath = (req.query.path as string) || "/";
      const space = resolveSpace(req.query.space);
      const filePath = rootForSpace(space, requestedPath);
      const user = getUser(req);
      const isPersonalRoot = space === "personal" && filePath === "/";

      // Cache key is keyed on the RESOLVED path (e.g. "/Household/Trips"), not
      // the (space, requestedPath) pair — the shared prefix already makes the
      // path distinct from any personal path, and keeping the same key shape
      // means the existing write routes' `cacheDel(CACHE_PREFIX + user + ":" +
      // path)` invalidations still land for shared-space mutations.
      const cacheKey = CACHE_PREFIX + user + ":" + filePath;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const raw = await ncListFiles(await getToken(req), user, filePath);
      // Hide the shared-folder mount from the personal home root only — a
      // subfolder elsewhere (or inside the shared space) that happens to share
      // the name must NOT be filtered.
      const entries = isPersonalRoot
        ? raw.filter((e) => e.name !== SHARED_FOLDER_NAME)
        : raw;
      await cacheSet(cacheKey, entries, CACHE_TTL);
      res.json(entries);
    } catch (err) {
      handleFileError(err, res, next, []);
    }
  });

  // ── Spaces (GET /api/files/spaces) ──
  //
  // WARP-883: tells the dashboard which spaces exist so it can show/hide the
  // My-Files / Shared switcher. "personal" always exists (every user has a
  // home); "shared" exists iff the Household group folder mounted into THIS
  // user's home (the groupfolders provisioning ran + this user is in the
  // household group). Read-only + degrades to shared-unavailable on a
  // Nextcloud outage (never 500) — same posture as the other read endpoints.
  router.get("/files/spaces", async (req, res, next) => {
    try {
      const user = getUser(req);
      let sharedAvailable = false;
      try {
        sharedAvailable = await ncDirExists(
          await getToken(req),
          user,
          SHARED_FOLDER_PATH
        );
      } catch (err) {
        if (err instanceof MissingNcTokenError) throw err;
        logger.warn({ err }, "files/spaces: shared-folder probe failed; reporting unavailable");
        sharedAvailable = false;
      }
      res.json({
        sharedAvailable,
        spaces: [
          { id: "personal", name: "My Files", available: true, root: "/" },
          {
            id: "shared",
            name: SHARED_FOLDER_NAME,
            available: sharedAvailable,
            root: SHARED_FOLDER_PATH,
          },
        ],
      });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Download a file ──
  router.get("/files/download", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }

      const filename = path.basename(filePath);
      const ext = path.extname(filename).toLowerCase();

      const stream = await ncDownloadFile(await getToken(req), getUser(req), filePath);
      if (!stream) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader(
        "Content-Type",
        ext === ".pdf" ? "application/pdf" : "application/octet-stream"
      );

      const nodeStream = Readable.fromWeb(stream as any);
      nodeStream.pipe(res);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Upload file(s) ──
  // WARP-171: per-route guard. owner + admin + family — household
  // file writes. service principals never upload (the file-indexer
  // talks to Nextcloud's WebDAV directly, not through this API).
  router.post("/files/upload", requireRole("owner", "admin", "family"), handleUpload, async (req, res, next) => {
    try {
      const targetPath = (req.query.path as string) || "/";

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        res.status(400).json({ error: "No files provided" });
        return;
      }

      const token = await getToken(req);
      const user = getUser(req);
      const results: { name: string; path: string; size: number }[] = [];

      for (const file of files) {
        await ncUploadFile(token, user, targetPath, file.originalname, file.buffer);
        results.push({
          name: file.originalname,
          path:
            targetPath === "/"
              ? `/${file.originalname}`
              : `${targetPath}/${file.originalname}`,
          size: file.size,
        });
      }

      await cacheDel(CACHE_PREFIX + user + ":" + targetPath);
      safePublish(`droplet/files/${user}/uploaded`, {
        path: targetPath,
        files: results.map((r) => r.name),
        count: results.length,
      });

      res.json({ uploaded: results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Delete a file or directory ──
  router.delete("/files", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }

      const user = getUser(req);
      await ncDeleteFile(await getToken(req), user, filePath);

      const parentPath = path.posix.dirname(filePath) || "/";
      await cacheDel(CACHE_PREFIX + user + ":" + parentPath);

      safePublish(`droplet/files/${user}/deleted`, { path: filePath });
      res.json({ deleted: filePath });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Create a directory ──
  router.post("/files/mkdir", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({ path: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "path is required", details: parsed.error.flatten() });
        return;
      }

      const user = getUser(req);
      await ncCreateDirectory(await getToken(req), user, parsed.data.path);

      const parentPath = path.posix.dirname(parsed.data.path) || "/";
      await cacheDel(CACHE_PREFIX + user + ":" + parentPath);

      res.json({ created: parsed.data.path });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Create a share link ──
  //
  // Accepts the full ShareCreateOptions surface (shareType / permissions /
  // expireDate / password / note / shareWith). Callers that pass only `path`
  // get a public read-only link from the defaults.
  router.post("/files/share", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        shareType: z.number().int().min(0).max(6).optional().default(3), // public link
        permissions: z.number().int().min(1).max(31).optional().default(1),
        expireDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "expireDate must be YYYY-MM-DD")
          .optional(),
        password: z.string().min(1).optional(),
        note: z.string().max(500).optional(),
        shareWith: z.string().min(1).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid share request",
          details: parsed.error.flatten(),
        });
        return;
      }

      const share = await ncCreateShareV2(await getToken(req), parsed.data.path, {
        shareType: parsed.data.shareType,
        permissions: parsed.data.permissions,
        expireDate: parsed.data.expireDate,
        password: parsed.data.password,
        note: parsed.data.note,
        shareWith: parsed.data.shareWith,
      });

      res.json(share);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── List shares for a path ──
  router.get("/files/shares", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const shares = await ncListShares(await getToken(req), filePath);
      res.json({ shares });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ────────────────────────────────────────────────────────────
  //  Phase 1 — Rename / Move / Copy (single + bulk) + Trash + Versions
  // ────────────────────────────────────────────────────────────

  /** Invalidate listing caches for the given parent paths (source + destination). */
  async function invalidateParents(user: string, ...paths: string[]): Promise<void> {
    const parents = new Set<string>();
    for (const p of paths) {
      parents.add(path.posix.dirname(p) || "/");
    }
    for (const parent of parents) {
      await cacheDel(CACHE_PREFIX + user + ":" + parent);
    }
  }

  /**
   * Run an async operation over a list of inputs with bounded concurrency.
   *
   * Why not Promise.all? Nextcloud's WebDAV has a known race when concurrent
   * DELETE/MOVE requests hit the trashbin: one of the requests can 500 while
   * the file ends up half-moved (trash entry created but source not unlinked).
   * Keeping concurrency small (default 1) serializes against that race while
   * still letting the route handle large batches responsively.
   */
  async function runBulk<T, R>(
    items: T[],
    op: (item: T) => Promise<R>,
    concurrency: number = 1
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await op(items[idx]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  // ── Rename (POST /api/files/rename) ──
  router.post("/files/rename", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        newName: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^/\\]+$/, "newName cannot contain path separators"),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid rename request",
          details: parsed.error.flatten(),
        });
        return;
      }
      const { path: filePath, newName } = parsed.data;
      const parentDir = path.posix.dirname(filePath) || "/";
      const newPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;

      const user = getUser(req);
      await ncMoveFile(await getToken(req), user, filePath, newPath, false);

      await invalidateParents(user, filePath);
      safePublish(`droplet/files/${user}/renamed`, { from: filePath, to: newPath });
      res.json({ renamed: { from: filePath, to: newPath } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Move (POST /api/files/move) ──
  router.post("/files/move", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid move request", details: parsed.error.flatten() });
        return;
      }
      const { from, to, overwrite } = parsed.data;

      const user = getUser(req);
      await ncMoveFile(await getToken(req), user, from, to, overwrite);

      await invalidateParents(user, from, to);
      safePublish(`droplet/files/${user}/moved`, { from, to });
      res.json({ moved: { from, to } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Copy (POST /api/files/copy) ──
  router.post("/files/copy", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid copy request", details: parsed.error.flatten() });
        return;
      }
      const { from, to, overwrite } = parsed.data;

      const user = getUser(req);
      await ncCopyFile(await getToken(req), user, from, to, overwrite);

      await invalidateParents(user, to);
      safePublish(`droplet/files/${user}/copied`, { from, to });
      res.json({ copied: { from, to } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Bulk delete (POST /api/files/bulk-delete) ──
  router.post("/files/bulk-delete", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({ paths: z.array(z.string().min(1)).min(1).max(200) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bulk-delete request" });
        return;
      }
      const { paths } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);

      const results: BulkOperationResult[] = await runBulk(paths, async (p) => {
        try {
          await ncDeleteFile(token, user, p);
          return { path: p, ok: true };
        } catch (err: any) {
          return { path: p, ok: false, error: err?.message ?? "unknown error" };
        }
      });

      await invalidateParents(user, ...paths);
      const okCount = results.filter((r) => r.ok).length;
      safePublish(`droplet/files/${user}/bulk-deleted`, {
        count: okCount,
        total: paths.length,
      });

      const allOk = okCount === paths.length;
      res.status(allOk ? 200 : 207).json({ results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Bulk move (POST /api/files/bulk-move) ──
  router.post("/files/bulk-move", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        paths: z.array(z.string().min(1)).min(1).max(200),
        toDir: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bulk-move request" });
        return;
      }
      const { paths, toDir, overwrite } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);
      const normalizedDir = toDir.replace(/\/+$/, "") || "/";

      const results: BulkOperationResult[] = await runBulk(paths, async (p) => {
        try {
          const base = path.posix.basename(p);
          const dest = normalizedDir === "/" ? `/${base}` : `${normalizedDir}/${base}`;
          await ncMoveFile(token, user, p, dest, overwrite);
          return { path: p, ok: true };
        } catch (err: any) {
          return { path: p, ok: false, error: err?.message ?? "unknown error" };
        }
      });

      await invalidateParents(user, ...paths, normalizedDir + "/_");
      const okCount = results.filter((r) => r.ok).length;
      safePublish(`droplet/files/${user}/bulk-moved`, {
        toDir: normalizedDir,
        count: okCount,
        total: paths.length,
      });

      const allOk = okCount === paths.length;
      res.status(allOk ? 200 : 207).json({ results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Bulk copy (POST /api/files/bulk-copy) ──
  router.post("/files/bulk-copy", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        paths: z.array(z.string().min(1)).min(1).max(200),
        toDir: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bulk-copy request" });
        return;
      }
      const { paths, toDir, overwrite } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);
      const normalizedDir = toDir.replace(/\/+$/, "") || "/";

      const results: BulkOperationResult[] = await runBulk(paths, async (p) => {
        try {
          const base = path.posix.basename(p);
          const dest = normalizedDir === "/" ? `/${base}` : `${normalizedDir}/${base}`;
          await ncCopyFile(token, user, p, dest, overwrite);
          return { path: p, ok: true };
        } catch (err: any) {
          return { path: p, ok: false, error: err?.message ?? "unknown error" };
        }
      });

      await invalidateParents(user, normalizedDir + "/_");
      const okCount = results.filter((r) => r.ok).length;
      safePublish(`droplet/files/${user}/bulk-copied`, {
        toDir: normalizedDir,
        count: okCount,
        total: paths.length,
      });

      const allOk = okCount === paths.length;
      res.status(allOk ? 200 : 207).json({ results });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: list (GET /api/files/trash) ──
  router.get("/files/trash", async (req, res, next) => {
    try {
      const items = await ncListTrash(await getToken(req), getUser(req));
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next, { items: [] });
    }
  });

  // ── Trash: restore (POST /api/files/trash/restore) ──
  router.post("/files/trash/restore", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({ name: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      const user = getUser(req);
      await ncRestoreTrashItem(await getToken(req), user, parsed.data.name);
      safePublish(`droplet/files/${user}/trash-restored`, { name: parsed.data.name });
      res.json({ restored: parsed.data.name });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: delete single item permanently (DELETE /api/files/trash/item) ──
  router.delete("/files/trash/item", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const name = req.query.name as string;
      if (!name) {
        res.status(400).json({ error: "name query parameter is required" });
        return;
      }
      const user = getUser(req);
      await ncDeleteTrashItem(await getToken(req), user, name);
      safePublish(`droplet/files/${user}/trash-purged`, { name });
      res.json({ deleted: name });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Trash: empty (DELETE /api/files/trash) ──
  router.delete("/files/trash", requireRole("owner", "admin", "family"), async (_req, res, next) => {
    try {
      const user = getUser(_req);
      await ncEmptyTrash(await getToken(_req), user);
      safePublish(`droplet/files/${user}/trash-emptied`, {});
      res.json({ emptied: true });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Versions: list (GET /api/files/versions?path=...) ──
  router.get("/files/versions", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const user = getUser(req);
      const token = await getToken(req);
      const fileId = await ncGetFileId(token, user, filePath);
      if (fileId === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const versions = await ncListVersions(token, user, fileId);
      res.json({ fileId, versions });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Versions: restore (POST /api/files/versions/restore) ──
  router.post("/files/versions/restore", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        versionId: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid restore request" });
        return;
      }
      const { path: filePath, versionId } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);

      const fileId = await ncGetFileId(token, user, filePath);
      if (fileId === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      await ncRestoreVersion(token, user, fileId, versionId);

      await invalidateParents(user, filePath);
      safePublish(`droplet/files/${user}/version-restored`, { path: filePath, versionId });
      res.json({ restored: { path: filePath, versionId } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ────────────────────────────────────────────────────────────
  //  Phase 2 — Favorites / Recents / Search / Thumbnails / Shares V2
  // ────────────────────────────────────────────────────────────

  // Redis cache prefixes — let callers invalidate one feature independently.
  const FAVORITES_CACHE_PREFIX = "files:favorites:";
  const RECENTS_CACHE_PREFIX = "files:recents:";
  const SEARCH_CACHE_PREFIX = "files:search:";
  const FAVORITES_TTL = 15;
  const RECENTS_TTL = 15;
  const SEARCH_TTL = 5;

  // ── Favorite toggle (POST /api/files/favorite) ──
  router.post("/files/favorite", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        path: z.string().min(1),
        favorite: z.boolean(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid favorite request" });
        return;
      }
      const { path: filePath, favorite } = parsed.data;
      const user = getUser(req);
      await ncSetFavorite(await getToken(req), user, filePath, favorite);
      await cacheDel(FAVORITES_CACHE_PREFIX + user);
      safePublish(`droplet/files/${user}/favorited`, { path: filePath, favorite });
      res.json({ path: filePath, favorite });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Favorites list (GET /api/files/favorites) ──
  router.get("/files/favorites", async (req, res, next) => {
    try {
      const user = getUser(req);
      const cacheKey = FAVORITES_CACHE_PREFIX + user;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json({ items: cached });
        return;
      }
      const items = await ncListFavorites(await getToken(req), user);
      await cacheSet(cacheKey, items, FAVORITES_TTL);
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next, { items: [] });
    }
  });

  // ── Recents (GET /api/files/recents) ──
  router.get("/files/recents", async (req, res, next) => {
    try {
      const limit = Math.max(
        1,
        Math.min(200, parseInt((req.query.limit as string) || "50", 10) || 50)
      );
      const user = getUser(req);
      const cacheKey = `${RECENTS_CACHE_PREFIX}${user}:${limit}`;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json({ items: cached });
        return;
      }
      const items = await ncListRecents(await getToken(req), user, limit);
      await cacheSet(cacheKey, items, RECENTS_TTL);
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next, { items: [] });
    }
  });

  // ── Search (GET /api/files/search?q=...&mime=...) ──
  router.get("/files/search", async (req, res, next) => {
    try {
      const q = (req.query.q as string | undefined)?.trim() ?? "";
      if (!q) {
        res.status(400).json({ error: "q query parameter is required" });
        return;
      }
      if (q.length < 2) {
        res.json({ items: [] });
        return;
      }
      const mime = (req.query.mime as string | undefined)?.trim() || undefined;
      const limit = Math.max(
        1,
        Math.min(200, parseInt((req.query.limit as string) || "50", 10) || 50)
      );
      const user = getUser(req);
      const cacheKey = `${SEARCH_CACHE_PREFIX}${user}:${q}:${mime ?? ""}:${limit}`;
      const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
      if (cached) {
        res.json({ items: cached });
        return;
      }
      const items = await ncSearchFiles(await getToken(req), user, {
        query: q,
        mime,
        limit,
      });
      await cacheSet(cacheKey, items, SEARCH_TTL);
      res.json({ items });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Thumbnail proxy (GET /api/files/thumbnail?path=...&x=...&y=...) ──
  router.get("/files/thumbnail", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const x = Math.max(
        16,
        Math.min(1024, parseInt((req.query.x as string) || "256", 10) || 256)
      );
      const y = Math.max(
        16,
        Math.min(1024, parseInt((req.query.y as string) || "256", 10) || 256)
      );
      const user = getUser(req);
      const token = await getToken(req);

      const fileId = await ncGetFileId(token, user, filePath);
      if (fileId === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const preview = await ncFetchThumbnail(token, fileId, x, y);
      if (!preview) {
        res.status(404).json({ error: "Preview unavailable" });
        return;
      }
      res.setHeader("Content-Type", preview.contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(Buffer.from(preview.body));
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Update existing share (PUT /api/files/share/:id) ──
  router.put("/files/share/:id", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const shareId = parseInt(req.params.id, 10);
      if (Number.isNaN(shareId)) {
        res.status(400).json({ error: "Invalid share id" });
        return;
      }
      const schema = z
        .object({
          permissions: z.number().int().min(1).max(31).optional(),
          password: z.string().optional(),
          expireDate: z.string().optional(),
          note: z.string().optional(),
        })
        .refine(
          (d) =>
            d.permissions !== undefined ||
            d.password !== undefined ||
            d.expireDate !== undefined ||
            d.note !== undefined,
          { message: "At least one field is required" }
        );
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid share update",
          details: parsed.error.flatten(),
        });
        return;
      }
      const token = await getToken(req);

      // OCS accepts one field per PUT — apply them sequentially.
      if (parsed.data.permissions !== undefined) {
        await ncUpdateShare(token, shareId, "permissions", String(parsed.data.permissions));
      }
      if (parsed.data.password !== undefined) {
        await ncUpdateShare(token, shareId, "password", parsed.data.password);
      }
      if (parsed.data.expireDate !== undefined) {
        await ncUpdateShare(token, shareId, "expireDate", parsed.data.expireDate);
      }
      if (parsed.data.note !== undefined) {
        await ncUpdateShare(token, shareId, "note", parsed.data.note);
      }
      res.json({ updated: shareId });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Revoke a share (DELETE /api/files/share/:id) ──
  router.delete("/files/share/:id", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const shareId = parseInt(req.params.id, 10);
      if (Number.isNaN(shareId)) {
        res.status(400).json({ error: "Invalid share id" });
        return;
      }
      await ncDeleteShare(await getToken(req), shareId);
      res.json({ deleted: shareId });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Shared-with-me inbox (GET /api/files/shared-with-me) ──
  router.get("/files/shared-with-me", async (req, res, next) => {
    try {
      const shares = await ncListSharedWithMe(await getToken(req));
      res.json({ shares });
    } catch (err) {
      handleFileError(err, res, next, { shares: [] });
    }
  });

  // ── Share recipients (GET /api/files/share-recipients) ── (WARP-879 / WS-1)
  //
  // The internal-sharing UI (ShareDialog "Person" mode) needs a roster of
  // household members to pick a recipient from. We deliberately do NOT reuse
  // GET /auth/users / OCS `/cloud/users` here: that surface 403s for the
  // `family` role, which would leave the picker empty for exactly the people
  // who share most. Instead we read the LOCAL Prisma `User` table — ADR-013
  // makes the built-in directory the identity source of truth, with Nextcloud
  // demoted to downstream-provisioned WebDAV accounts.
  //
  // Each recipient's `shareWith` is its `nextcloudUsername` (the OCS user id
  // ncCreateShareV2 expects for shareType=0), which ADR-013 keeps decoupled
  // from the local `username`. We resolve the caller's OWN nextcloudUsername
  // from their User row keyed on `req.user.id` (the local UUID — NOT
  // getUser(req), which returns the local username) so we can exclude them
  // from their own picker. The Nextcloud system/database admin
  // (NEXTCLOUD_ADMIN_USER || "admin") is hidden the same way GET /auth/users
  // hides it. Rows without a nextcloudUsername (service principals, fresh
  // invitees pre-first-login) can't receive an OCS share and are excluded.
  // All three exclusions compare case-insensitively.
  router.get(
    "/files/share-recipients",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const callerId = req.user?.id ?? "";
        const caller = callerId
          ? await prisma.user.findUnique({
              where: { id: callerId },
              select: { nextcloudUsername: true },
            })
          : null;
        const selfNc = caller?.nextcloudUsername?.toLowerCase() ?? null;
        const systemUser = (process.env.NEXTCLOUD_ADMIN_USER || "admin").toLowerCase();

        const rows = (await prisma.user.findMany({
          select: {
            displayName: true,
            email: true,
            nextcloudUsername: true,
          },
          orderBy: { displayName: "asc" },
        })) as Array<{
          displayName: string;
          email: string | null;
          nextcloudUsername: string | null;
        }>;

        const recipients = rows
          .filter((u) => {
            if (!u.nextcloudUsername) return false;
            const nc = u.nextcloudUsername.toLowerCase();
            if (nc === systemUser) return false;
            if (selfNc !== null && nc === selfNc) return false;
            return true;
          })
          .map((u) => ({
            shareWith: u.nextcloudUsername as string,
            displayName: u.displayName,
            email: u.email ?? null,
          }));

        res.json({ recipients });
      } catch (err) {
        next(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────
  //  Phase 4 — Semantic content search (pgvector)
  // ────────────────────────────────────────────────────────────

  // ── GET /api/files/search/content?q=...&limit=20 ──
  //
  // Embeds the query string via the ai-gateway gRPC, then does a
  // cosine-similarity search against the FileContentChunk table using
  // pgvector. Each result carries the matched file path + a text snippet
  // so the frontend can render results without a second fetch.
  router.get("/files/search/content", async (req, res, next) => {
    try {
      const q = (req.query.q as string | undefined)?.trim() ?? "";
      if (!q || q.length < 2) {
        res.status(400).json({ error: "q must be at least 2 characters" });
        return;
      }
      const limit = Math.max(
        1,
        Math.min(100, parseInt((req.query.limit as string) || "20", 10) || 20)
      );
      const user = getUser(req);

      // WARP-880 / WS-2 — three content-search modes:
      //   semantic (default) → existing inline pgvector SQL (unchanged)
      //   keyword            → lexical (websearch_to_tsquery + ts_rank_cd),
      //                        works with the AI gateway down
      //   hybrid             → embed + RRF fusion of lexical + vector
      const mode = (req.query.mode as string | undefined)?.trim() || "semantic";
      if (!FILE_SEARCH_MODES.includes(mode as FileSearchMode)) {
        res.status(400).json({
          error: `mode must be one of: ${FILE_SEARCH_MODES.join(", ")}`,
        });
        return;
      }

      // Check Redis cache first (60s TTL on identical queries). The mode is
      // part of the key so keyword/semantic/hybrid results never collide.
      const cacheKey = `filesearch:${mode}:${user}:${q}:${limit}`;
      const cached = await cacheGet<Array<{ path: string; score: number; text: string }>>(cacheKey);
      if (cached) {
        res.json({ results: cached });
        return;
      }

      // Keyword (lexical) search NEVER touches the gRPC embed — this is the
      // headline win: full-text search keeps working when the ai-gateway /
      // LLM stack is down. Placed before the embed block on purpose.
      if (mode === "keyword") {
        const { searchByLexical } = await import(
          "../services/file-search.service.js"
        );
        const hits = await searchByLexical(prisma, {
          userId: user,
          query: q,
          limit: limit * CHUNKS_PER_FILE_FACTOR,
          source: "nextcloud",
        });
        const results = dedupeHitsPerFile(hits, limit);
        await cacheSet(cacheKey, results, 60);
        res.json({ results });
        return;
      }

      // Lazy-import the gRPC embedding function. It's optional — if gRPC
      // isn't available (e.g. ai-gateway down), we return a helpful error
      // rather than a generic 500.
      let embedVec: number[];
      try {
        const { grpcEmbedText, isGrpcAvailable } = await import(
          "../services/ai-gateway.grpc-client.js"
        );
        if (!isGrpcAvailable()) {
          res.status(503).json({ error: "AI gateway not available for semantic search" });
          return;
        }
        const vectors = await grpcEmbedText([q]);
        if (!vectors || vectors.length === 0 || !Array.isArray(vectors[0])) {
          res.status(502).json({ error: "Embedding service returned no vectors" });
          return;
        }
        embedVec = vectors[0];
        // Validate every element is a finite number — a buggy/compromised gRPC
        // response with NaN/Infinity/strings would cause a Postgres cast error.
        if (!embedVec.every((v) => typeof v === "number" && Number.isFinite(v))) {
          res.status(502).json({ error: "Embedding service returned invalid vector" });
          return;
        }
      } catch (err) {
        logger.warn({ err }, "Semantic search: embedding failed");
        res.status(503).json({ error: "Embedding service unavailable" });
        return;
      }

      // Hybrid (WARP-880 / WS-2): RRF fusion of the lexical + vector arms.
      // No rerank pipe — keep it low-latency for the interactive Files page.
      if (mode === "hybrid") {
        const { searchHybrid } = await import(
          "../services/file-search.service.js"
        );
        const hits = await searchHybrid(prisma, {
          userId: user,
          vector: embedVec,
          query: q,
          limit: limit * CHUNKS_PER_FILE_FACTOR,
          source: "nextcloud",
        });
        const results = dedupeHitsPerFile(hits, limit);
        await cacheSet(cacheKey, results, 60);
        res.json({ results });
        return;
      }

      // pgvector cosine similarity — Prisma can't express <=> so we use raw SQL.
      // Two-step query: inner DISTINCT ON deduplicates per file (keeping the
      // best chunk), outer query sorts by score and applies the limit.
      const vecLiteral = `[${embedVec.join(",")}]`;
      const rows: Array<{ path: string; score: number; text: string }> =
        await prisma.$queryRawUnsafe(
          `
          SELECT path, score, text FROM (
            SELECT DISTINCT ON ("ncFileId")
              "path",
              1 - ("embedding" <=> $1::vector) AS score,
              "text"
            FROM "FileContentChunk"
            WHERE "userId" = $2
            ORDER BY "ncFileId", "embedding" <=> $1::vector
          ) ranked
          ORDER BY score DESC
          LIMIT $3
          `,
          vecLiteral,
          user,
          limit
        );

      await cacheSet(cacheKey, rows, 60);
      res.json({ results: rows });
    } catch (err: any) {
      // Catch Prisma/pgvector-specific errors (e.g. vector extension missing,
      // invalid vector cast) and return 503 instead of leaking raw SQL in a 500.
      if (
        err?.code === "P2010" ||
        err?.message?.includes("vector") ||
        err?.message?.includes("does not exist")
      ) {
        logger.warn({ err }, "Semantic search: database error (pgvector?)");
        res.status(503).json({
          error: "Semantic search is not available. The pgvector extension may not be installed.",
        });
        return;
      }
      handleFileError(err, res, next);
    }
  });

  // ── GET /api/files/search/status ── (WARP-310)
  //
  // Lightweight health probe for the AI-toggle in the Files page search
  // bar. The dashboard polls this when the toggle is enabled so the
  // user knows whether semantic search is actually wired up end-to-end:
  //
  //   - gRPC reachable?                  → `gatewayHealthy`
  //   - pgvector extension installed?    → `pgvectorReady`
  //   - any chunks for this user?        → `indexedCount`
  //
  // The composite `state` collapses the three into a single traffic
  // light the UI can render directly:
  //   "ready"      — gateway up + pgvector up + user has chunks
  //   "indexing"   — gateway up + pgvector up + zero chunks (yet)
  //   "unavailable"— gateway or pgvector down
  //
  // Per-user scope is intentional: it tells the *current* user whether
  // their files are searchable. Owner/admin don't get visibility into
  // other users' counts here.
  router.get("/files/search/status", async (req, res, next) => {
    try {
      const user = getUser(req);

      // Probe gRPC. The grpc-client module exposes `isGrpcAvailable()`
      // which reflects the latest init attempt; a hot reload from "down"
      // to "up" lands on the next probe without restart.
      let gatewayHealthy = false;
      try {
        const { isGrpcAvailable } = await import(
          "../services/ai-gateway.grpc-client.js"
        );
        gatewayHealthy = isGrpcAvailable();
      } catch {
        gatewayHealthy = false;
      }

      // Probe pgvector + indexed count in a single round trip. If the
      // extension isn't installed, the query throws and we treat it as
      // pgvectorReady=false.
      let pgvectorReady = false;
      let indexedCount = 0;
      let lastIndexedAt: string | null = null;
      try {
        const rows: Array<{ count: bigint; last: Date | null }> =
          await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::bigint AS count, MAX("indexedAt") AS last ' +
              'FROM "FileContentChunk" WHERE "userId" = $1',
            user,
          );
        pgvectorReady = true;
        if (rows[0]) {
          indexedCount = Number(rows[0].count);
          lastIndexedAt = rows[0].last ? rows[0].last.toISOString() : null;
        }
      } catch (err) {
        logger.warn({ err }, "search/status: pgvector probe failed");
        pgvectorReady = false;
      }

      const state: "ready" | "indexing" | "unavailable" =
        !gatewayHealthy || !pgvectorReady
          ? "unavailable"
          : indexedCount > 0
            ? "ready"
            : "indexing";

      res.json({
        state,
        gatewayHealthy,
        pgvectorReady,
        indexedCount,
        lastIndexedAt,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
