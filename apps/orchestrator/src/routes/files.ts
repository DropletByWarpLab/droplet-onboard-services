import { Router, Request, Response, NextFunction } from "express";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { PrismaClient, type DepartmentRight } from "@prisma/client";
import pino from "pino";
import {
  ncListFiles,
  ncUploadFile,
  ncDownloadFile,
  ncFetchFileResponse,
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
  ncListOutboundShares,
  ncListMyShares,
  ncGetShare,
  ncDirExists,
  NextcloudOcsError,
  type ShareDetail,
} from "../services/nextcloud.client.js";
import { MAX_FILES_PER_UPLOAD } from "@droplet/shared-types";
import {
  sendShareNotificationEmail,
  type SendOptions as EmailSendOptions,
} from "../services/email-channel.service.js";
import type { BulkOperationResult } from "../types/index.js";
import {
  cacheGet,
  cacheSet,
  cacheDel,
  invalidatePrefix,
} from "../services/cache.service.js";
import { readUserEmail } from "../services/user-directory.service.js";
import {
  ncMintEditorSession,
  docServerHealthy,
  DocServerUnavailableError,
} from "../services/docserver.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { publish } from "../services/mqtt.service.js";
import { config } from "../config.js";
import type { FileEntryInfo } from "../types/index.js";
import { requireRole, requireRoleOrMcpService, recordAccessDenied } from "../middleware/auth.js";
import { isUpstreamUnavailable } from "../lib/upstream-unavailable.js";
import { isPathUnderUser } from "../services/brain-memory.service.js";
import {
  classifyFileContentId,
  contentTypeForFilename,
  inlinePreviewContentType,
  parseRangeHeader,
} from "../lib/file-content.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  checkSpaceAccess,
  requireSpaceAccess,
  resolveRawSpaceToDepartmentId,
  type SpaceAccessCaller,
} from "../middleware/space.js";
import {
  resolveFileDepartment,
  upsertFileRegistryEntry,
} from "../services/file-registry.service.js";
import { adminBasicToken } from "../services/department-provisioner.service.js";
import { departmentManagerOrAdmin } from "../services/department-membership.service.js";
import { getEffectiveUsage } from "../services/effective-usage.service.js";

const logger = pino({ name: "files-route" });

const CACHE_PREFIX = "files:list:";
const CACHE_TTL = 10;

const MEMORY_STORAGE = multer.memoryStorage();

/**
 * WARP-1271 (T19a) — per-user upload cap. WARP-1531 (RBAC v2 T7): the cap
 * is now the EFFECTIVE value — the person's `UserUsagePolicy.maxUploadSizeMb`
 * ?? their `AccessRole` default ?? config, resolved field-by-field by
 * effective-usage.service.ts. Whatever the source, it tightens
 * `config.MAX_UPLOAD_SIZE_MB` for the authenticated caller and can only
 * shrink the ceiling, never raise it (min(), never a bypass). With zero
 * AccessRole rows (null accessRoleId — production today) this resolves
 * exactly as pre-1531: person override or config default. Two indexed
 * point reads per request (no cross-request cache — the brief's "cache
 * per-request only" is naturally true here since this runs once per
 * upload call, not per file).
 */
async function resolveUploadLimitMb(
  prisma: PrismaClient,
  userId: string | undefined,
): Promise<number> {
  if (!userId) return config.MAX_UPLOAD_SIZE_MB;
  try {
    const effective = await getEffectiveUsage(prisma, userId);
    const capMb = effective.maxUploadSizeMb.value;
    if (capMb != null && capMb > 0) {
      return Math.min(config.MAX_UPLOAD_SIZE_MB, capMb);
    }
  } catch (err) {
    logger.warn({ err, userId }, "upload: usage-policy lookup failed; using config default");
  }
  return config.MAX_UPLOAD_SIZE_MB;
}

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
 * WARP-582 — a request that reaches a files handler without an authenticated
 * username must be refused with 401 (fail-closed), never run as anyone else
 * and never surface as a 500 invariant crash. Historically getUser() was
 * `req.user?.username || "admin"` — the ORCH-007 fail-open where a missing
 * user silently ran every file op as the Nextcloud admin; #944 made it throw,
 * and this sentinel pins the thrown shape to a 401 in handleFileError.
 */
class MissingAuthUserError extends Error {
  constructor() {
    super("Authenticated user required — please log in again");
    this.name = "MissingAuthUserError";
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
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
  // WARP-582: typed sentinel → handleFileError maps it to 401 (re-auth), so
  // the fail-closed refusal never degrades or surfaces as a 500.
  if (!username) throw new MissingAuthUserError();
  return username;
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

type Space = "personal" | "shared" | string; // "personal", "shared", or "dept:<uuid>"

/** Coerce an arbitrary `?space=` value to a known space (default personal). */
function resolveSpace(raw: unknown): Space {
  if (typeof raw !== "string") return "personal";
  if (raw === "shared" || raw === "personal") return raw;
  if (raw.startsWith("dept:")) return raw; // Keep dept:<uuid> as-is for resolution.
  return "personal";
}

/**
 * WARP-1610 — one directory listing, named the way the cache must name it:
 * the SPACE the caller declared plus the home-relative path that space
 * resolved to.
 *
 * The resolved path alone is not an identity. `space=personal` resolves
 * `?path=/Alpha` verbatim, and a department named `Alpha` mounts at `/Alpha`
 * inside that same home — so a personal folder and a department library
 * collapse onto ONE cache key and can serve each other's contents for the
 * whole `CACHE_TTL`. The caller may legitimately see both (this is
 * content-mixing, not disclosure — the disclosure half was WARP-1556), but
 * being shown the wrong folder's contents under the right folder's breadcrumb
 * is still wrong.
 *
 * Every listing read and every listing `cacheDel` names a `SpacedPath`, and
 * write routes carry it PER PATH: a cross-space move hands `from` and `to` to
 * `invalidateParents` in different spaces, so one space per request could only
 * ever be right for one of the two sides.
 *
 * Accepted consequence: a groupfolder is reachable BOTH as `dept:<uuid>` and
 * (ungated) as the personal path it mounts at, and those are now two entries.
 * A write in one no longer drops the other, so the alias view can lag by up to
 * `CACHE_TTL` (10s) — the same freshness bound every uncached listing already
 * has. That is strictly better than the alternative it replaces, which was the
 * two views overwriting each other's CONTENTS.
 */
interface SpacedPath {
  space: Space;
  path: string;
}

/**
 * WARP-1610 — the space half of a listing cache key.
 *
 * `personal` / `shared` are the literal space tokens. A department is
 * identified by its UUID: the only name it has that a rename can't move (a
 * rename relocates the mount point, which changes the resolved path but must
 * not change which space a listing belongs to). `dept:<uuid>` becomes
 * `dept_<uuid>` so the tag contributes no `:` of its own and the joined key
 * stays unambiguously delimited.
 *
 * Returns `null` for anything that is not one of those shapes — FAIL CLOSED,
 * the same posture as `aclCacheTag` and deliberately NOT
 * `activeDeptMountNames`' fail-open one: a key we cannot name correctly is a
 * key we must neither read from nor write to, because the fallback would be
 * exactly the space-less key this ticket is removing. Serving a fresh upstream
 * listing is always safe; serving a cached one we can't attribute to a space
 * is not.
 *
 * No Prisma read of its own: the space token reaching here has already been
 * canonicalized by `resolveSpace` and, for `dept:`, proved to name an ACTIVE
 * department by `rootForSpace` (which throws otherwise, before any key is
 * built). Department membership/visibility still comes from Postgres via
 * `aclCacheTag`, never from Nextcloud state (ADR-029:47/:181).
 */
function spaceCacheTag(space: Space): string | null {
  if (space === "personal" || space === "shared") return space;
  if (space.startsWith("dept:")) {
    const departmentId = space.slice("dept:".length);
    if (!departmentId || departmentId.includes(":") || departmentId.includes("/")) {
      return null;
    }
    return `dept_${departmentId}`;
  }
  return null;
}

/**
 * WARP-1262 (T10): raw `?space=` / body `space` extraction, query taking
 * precedence over body when a caller supplies both (mirrors the space
 * middleware's own `defaultSpaceResolver` precedence). Write routes with a
 * path in the querystring (delete, trash) read `?space=`; routes with a
 * JSON body (mkdir, rename, favorite, ...) read `body.space`. Shared by
 * every write route below so the (space, requestedPath) → resolved-path
 * flow and the `requireSpaceAccess` guard always agree on which raw value
 * they're resolving.
 */
function spaceQueryOrBody(req: Request): unknown {
  if (req.query.space !== undefined) return req.query.space;
  return (req.body as Record<string, unknown> | undefined)?.space;
}

/**
 * `requireSpaceAccess`'s `resolveSpace` option for `spaceQueryOrBody`,
 * translating the legacy WS-5 "shared" literal to the gate's "household"
 * token and letting anything else the gate itself doesn't recognize fail
 * closed via its own `parseSpaceValue` (see the `/files` list route above
 * for why this alias exists).
 */
function resolveSpaceGuardToken(req: Request): unknown {
  const raw = spaceQueryOrBody(req);
  if (typeof raw !== "string") return undefined;
  if (raw === "shared") return "household";
  if (raw.startsWith("dept:")) return raw;
  return undefined;
}

/**
 * WARP-1262 (security): thrown by `rootForSpace` when a caller-supplied path
 * contains a `..` traversal segment. Mapped to HTTP 400 by `handleFileError`
 * so every space-threaded write route rejects traversal with a clean client
 * error instead of handing the escaped path to the WebDAV client.
 */
class UnsafePathError extends Error {
  constructor(message = "path must not contain '..' segments") {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * WARP-1261: generalized path routing for personal/shared/department spaces.
 *
 * Map a (space, requested path) pair to the real WebDAV home-relative path.
 * The registry prefix is ALWAYS applied for shared/department spaces so a caller
 * can never escape via `../` (fail-closed, matches WARP-938 safety checks).
 *
 * - personal: the path is used verbatim (the user's home root) — "/" or "/path".
 * - shared:   path is resolved UNDER the shared-folder prefix (e.g. "/Household/Trips").
 * - dept:<uuid>: path is resolved UNDER the department mount point (e.g. "/Engineering/Docs").
 *
 * For dept:<uuid>, the Department row must exist and be active (enforced by the
 * caller with requireSpaceAccess middleware or checkSpaceAccess prior to invoking).
 * If resolution fails, throws a safe error (never silently falls back to personal).
 */
async function rootForSpace(prisma: PrismaClient, space: Space, requestedPath: string): Promise<string> {
  // WARP-1262 (security): reject path traversal at the single (space, path) →
  // operational-path chokepoint. The downstream WebDAV builder only strips
  // leading slashes, so a `..` segment would be resolved by fetch/undici's URL
  // normalizer and land the operation in a SIBLING space the caller was never
  // gated for — `requireSpaceAccess`/`checkSpaceAccess` only authorizes the
  // declared `space` token, never `path`. mkdir already guards its own input
  // (isSafeUserPath, below); enforcing it HERE makes the "a caller can never
  // escape via `../`" contract documented above true for EVERY write route
  // (upload/delete/rename/move/copy/bulk-*/favorite/version-restore) — current
  // and future — not just the one route that remembered to call isSafeUserPath.
  if (!isSafeUserPath(requestedPath)) {
    throw new UnsafePathError();
  }
  const rel = requestedPath.replace(/^\/+/, "");

  if (space === "personal") {
    return requestedPath || "/";
  }

  if (space === "shared") {
    return rel ? `${SHARED_FOLDER_PATH}/${rel}` : SHARED_FOLDER_PATH;
  }

  if (space.startsWith("dept:")) {
    const deptId = space.slice("dept:".length);
    const dept = await prisma.department.findUnique({
      where: { id: deptId },
      select: { id: true, name: true, parentId: true, kind: true, state: true },
    });

    if (!dept) {
      throw new Error(`Unknown space: ${space}`);
    }
    if (dept.state !== "active") {
      throw new Error(`Space is not active: ${space}`);
    }

    // Resolve mount point: DEPARTMENT → name; TEAM → "Parent — Team".
    let mountName = dept.name;
    if (dept.kind === "TEAM" && dept.parentId) {
      const parent = await prisma.department.findUnique({
        where: { id: dept.parentId },
        select: { name: true },
      });
      if (parent) {
        mountName = `${parent.name} — ${dept.name}`;
      }
    }

    return rel ? `/${mountName}/${rel}` : `/${mountName}`;
  }

  throw new Error(`Malformed space: ${space}`);
}

/**
 * WARP-1267 — active department/team mount names visible to this caller,
 * used ONLY to extend the personal-root hide-filter below: Nextcloud mounts
 * every groupfolder (Household, and now each dept/team) as a top-level entry
 * inside the caller's own home, the same reason Household has always been
 * hidden there (WARP-883) — without this, a dept/team library would show up
 * TWICE in My Files once departments exist. Mirrors the visibility rule in
 * GET /api/files/spaces (member OR owner/admin see-all).
 */
async function activeDeptMountNames(
  prisma: PrismaClient,
  userId: string,
  isOwnerOrAdmin: boolean
): Promise<string[]> {
  // Best-effort: a Department lookup failure must never break the primary
  // "list my files" request — fail open (nothing extra hidden) rather than
  // 500, same posture as the sharedAvailable probe above.
  try {
    const depts = await prisma.department.findMany({
      where: { kind: { in: ["DEPARTMENT", "TEAM"] }, state: "active" },
      select: {
        name: true,
        kind: true,
        parentId: true,
        memberships: { where: { userId }, select: { id: true } },
      },
    });

    const names: string[] = [];
    for (const dept of depts) {
      if (!isOwnerOrAdmin && dept.memberships.length === 0) continue;
      if (dept.kind === "TEAM" && dept.parentId) {
        const parent = await prisma.department.findUnique({
          where: { id: dept.parentId },
          select: { name: true },
        });
        names.push(parent ? `${parent.name} — ${dept.name}` : dept.name);
      } else {
        names.push(dept.name);
      }
    }
    return names;
  } catch (err) {
    logger.warn({ err, userId }, "activeDeptMountNames: department lookup failed; not hiding any dept mounts");
    return [];
  }
}

/**
 * WARP-938 (security): true iff `requested` is a home-relative path with no
 * `..` traversal segment.
 *
 * The downstream WebDAV builder only strips leading slashes, so a `..` segment
 * is resolved by the server and can land the operation outside the intended
 * target (e.g. `/Documents/../secret` → a sibling at root). A legitimate
 * create-directory path never needs `..`, so we reject any input that contains
 * a `..` path segment outright. We check BOTH the raw and the POSIX-normalized
 * forms (normalize collapses `..`, so the raw check is what actually catches
 * the traversal; normalize guards odd separators like `//` or trailing `/`).
 * Plain dots inside a name ("report.v2") and normal nested paths are unaffected.
 */
function isSafeUserPath(requested: string): boolean {
  const rawSegments = requested.split("/");
  if (rawSegments.includes("..")) return false;
  const normalized = path.posix.normalize("/" + requested.replace(/^\/+/, ""));
  return !normalized.split("/").includes("..");
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
 * WARP-940 — keyword score floor for files matched by NAME only.
 *
 * `searchByLexical` returns `ts_rank_cd` scores (small positive floats,
 * typically < 1). A pure name match has no lexical relevance score, so we
 * give it a fixed sentinel that sorts BELOW any genuine content hit but
 * ABOVE zero — the file is clearly relevant (its name contains the term),
 * just less precisely ranked than a body match. The frontend renders the
 * score as a percentage, so a small non-zero value reads as "matched".
 */
const KEYWORD_NAME_MATCH_SCORE = 0.01;

/**
 * WARP-940 — fold Nextcloud name-search results (`FileEntryInfo[]`) into the
 * keyword content-search result shape. Directories are dropped (the Files
 * search popover navigates to files); each surviving file gets the
 * name-match sentinel score and its display name as the snippet text so the
 * popover has something to render.
 */
function nameHitsToResults(
  files: FileEntryInfo[],
): Array<{ path: string; score: number; text: string }> {
  return files
    .filter((f) => !f.isDirectory)
    .map((f) => ({
      path: f.path,
      score: KEYWORD_NAME_MATCH_SCORE,
      text: f.name,
    }));
}

/**
 * WARP-940 — union content hits (already deduped, score DESC) with name-only
 * hits. A file matched by BOTH arms keeps its content hit (higher score +
 * real snippet); name-only files are appended in order. Clamped to `limit`.
 */
function unionContentAndNameHits(
  contentResults: Array<{ path: string; score: number; text: string }>,
  nameResults: Array<{ path: string; score: number; text: string }>,
  limit: number,
): Array<{ path: string; score: number; text: string }> {
  const seen = new Set(contentResults.map((r) => r.path));
  const out = [...contentResults];
  for (const nr of nameResults) {
    if (out.length >= limit) break;
    if (seen.has(nr.path)) continue;
    seen.add(nr.path);
    out.push(nr);
  }
  return out.slice(0, limit);
}

/**
 * WARP-1140 — index owner of shared "Household" (groupfolder) chunks.
 *
 * The file-indexer physically watches `__groupfolders/{id}/…` (groupfolder
 * content never lives under any user's home dir) and writes those chunks
 * under this sentinel userId with a `/<SHARED_FOLDER_NAME>/…` display path —
 * the same path each member sees in their own WebDAV home. Must match the
 * file-indexer's `HOUSEHOLD_USER_ID` (services/file-indexer/config.py).
 */
const HOUSEHOLD_INDEX_USER = "__household__";

/**
 * WARP-1264 — department chunk-corpus sentinel. The file-indexer emits
 * chunks for a non-household groupfolder-backed department under this
 * sentinel userId (services/file-indexer/watcher.py
 * `_lookup_department_for_groupfolder`).
 */
function deptSentinel(departmentId: string): string {
  return `__dept_${departmentId}__`;
}

/** Corpus resolution result: the FileContentChunk `userId` list this caller
 * may search, plus the max `aclVersion` across their visible departments
 * (folded into the search cache key so a rights/membership change can never
 * serve a stale cached result — see `deptSearchCorpora`). */
interface DeptSearchCorpora {
  corpora: string[];
  aclVersion: number;
}

/**
 * WARP-1264 — resolve which caller (local User id + role) this request
 * acts as. For the trusted MCP service principal, swaps in the asserted NC
 * user's LOCAL identity (same pattern as `middleware/space.ts`'s
 * `_service:mcp` handling) — the service principal's own `role: "service"`
 * must never be used for a department-membership decision. Returns null
 * when no caller identity can be resolved (fail-closed → personal corpus
 * only).
 */
async function resolveSearchCaller(
  req: Request,
  prisma: PrismaClient,
): Promise<{ id: string; role: string } | null> {
  if (isMcpService(req)) {
    const assertedNcUser = (req.header("x-nextcloud-user") ?? "").trim();
    if (!assertedNcUser) return null;
    const localUser = await prisma.user.findUnique({
      where: { nextcloudUsername: assertedNcUser },
      select: { id: true, role: true },
    });
    return localUser ? { id: localUser.id, role: localUser.role } : null;
  }
  const id = req.user?.id;
  const role = req.user?.role;
  if (!id || !role) return null;
  return { id, role };
}

/** One ACTIVE department the caller is visible into, with the `aclVersion`
 * that any cache key derived from it must carry. */
interface VisibleDept {
  id: string;
  kind: string;
  aclVersion: number;
}

/**
 * The caller's department visibility, as read from Prisma.
 *
 * `resolved: false` is the FAIL-CLOSED sentinel (WARP-1556): the walk could
 * not be completed — no resolvable caller identity, or a DB hiccup — so
 * nothing is known about this caller's cross-space visibility. Two different
 * degradations are correct for the two kinds of consumer:
 *
 *   • a consumer that only WIDENS a corpus (`deptSearchCorpora`) degrades to
 *     personal-only and carries on;
 *   • a consumer that GATES CONTENT VISIBILITY (the user-keyed Files caches)
 *     must bypass its cache entirely — reading a "personal-only" key after a
 *     failed walk could serve, and writing one could poison it with, content
 *     from a department the caller may no longer be in.
 */
interface CallerDeptVisibility {
  depts: VisibleDept[];
  /** max(`aclVersion`) across `depts`; 0 when there are none. */
  aclVersion: number;
  resolved: boolean;
}

/**
 * WARP-1264 (extracted for WARP-1556) — the ACTIVE departments this caller is
 * visible into: owner/admin see ALL active departments (audited "see-all",
 * same posture as `checkSpaceAccess`); everyone else sees only their own
 * active `DepartmentMembership` rows.
 *
 * No WebDAV probes and no Nextcloud state — membership is read straight from
 * Postgres (ADR-029:47/:181 → ADR-013), in a single query, mirroring the
 * `?space=` middleware's ONE-`findUnique`-per-space philosophy.
 *
 * Never throws: every failure path returns the `resolved: false` sentinel and
 * lets the caller pick its own (documented) degradation.
 */
async function visibleDeptsForCaller(
  req: Request,
  prisma: PrismaClient,
): Promise<CallerDeptVisibility> {
  try {
    const caller = await resolveSearchCaller(req, prisma);
    if (!caller) return { depts: [], aclVersion: 0, resolved: false };

    const isOwnerOrAdmin = caller.role === "owner" || caller.role === "admin";
    let depts: VisibleDept[];
    if (isOwnerOrAdmin) {
      depts = await prisma.department.findMany({
        where: { state: "active" },
        select: { id: true, kind: true, aclVersion: true },
      });
    } else {
      const memberships = await prisma.departmentMembership.findMany({
        where: { userId: caller.id, department: { state: "active" } },
        select: { department: { select: { id: true, kind: true, aclVersion: true } } },
      });
      depts = memberships.map((m) => m.department);
    }

    let aclVersion = 0;
    for (const dept of depts) {
      if (dept.aclVersion > aclVersion) aclVersion = dept.aclVersion;
    }
    return { depts, aclVersion, resolved: true };
  } catch (err) {
    logger.debug(
      { err },
      "visibleDeptsForCaller: department lookup failed; caller visibility unresolved",
    );
    return { depts: [], aclVersion: 0, resolved: false };
  }
}

/**
 * WARP-1556 — the membership/ACL dimension every user-keyed Files cache that
 * can carry CROSS-SPACE content must fold into its key.
 *
 * Shape: `acl<maxAclVersion>-<digest>`, where the digest covers the sorted
 * `<departmentId>:<aclVersion>` pairs of every department the caller is
 * currently visible into. Both halves are load-bearing:
 *
 *   • the max version busts the key on a RIGHTS change against an unchanged
 *     department set (this is what `deptSearchCorpora` folds into the
 *     content-search key, WARP-1264);
 *   • the digest busts it on a MEMBERSHIP change. `max()` alone does not: a
 *     caller in Alpha(acl=3) + Beta(acl=9) revoked from Alpha still maxes at
 *     9, and would keep reading Alpha's file names out of the pre-revocation
 *     entry until TTL. The content-search key is safe from that only because
 *     it ALSO carries the full corpus list; this digest is the same defence,
 *     kept to a bounded key length.
 *
 * The digest is hashed rather than inlined so a key stays short (and no
 * department id leaks into Redis key space / slow-log output).
 *
 * Returns `null` when the caller's visibility could not be resolved. That is
 * NOT "no departments" — it is "unknown", and the caller MUST fail closed by
 * skipping the cache in both directions. Deliberately the opposite posture
 * from `activeDeptMountNames` above, which fails OPEN (`[]`, nothing hidden):
 * that is right for a cosmetic hide-filter over a live upstream response and
 * wrong for a cache that gates what content a caller is handed back.
 */
async function aclCacheTag(
  req: Request,
  prisma: PrismaClient,
): Promise<string | null> {
  const { depts, aclVersion, resolved } = await visibleDeptsForCaller(req, prisma);
  if (!resolved) return null;
  const fingerprint = depts
    .map((d) => `${d.id}:${d.aclVersion}`)
    .sort()
    .join(",");
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
  return `acl${aclVersion}-${digest}`;
}

/**
 * WARP-1264 — resolve which FileContentChunk owners this request may
 * search: always the user's own corpus, plus one `__dept_<uuid>__` sentinel
 * per ACTIVE department the caller is visible into (see
 * `visibleDeptsForCaller` for the visibility rule).
 *
 * The HOUSEHOLD department is dual-sentinelled during rollout: when it is
 * among the caller's visible departments, BOTH the legacy `__household__`
 * sentinel AND its `__dept_<uuid>__` form are included, so content indexed
 * under either form (old watcher builds vs. WARP-1264 builds) stays
 * searchable without a reindex.
 *
 * Best-effort by design: any failure (no session, DB hiccup) means
 * "personal only" — content search must never fail outright just because
 * the corpus lookup can't run. Safe here (unlike for a cache key) because
 * the corpus list is a *filter* on a live query: narrowing it can only ever
 * hide content, never disclose it.
 */
async function deptSearchCorpora(
  req: Request,
  prisma: PrismaClient,
  user: string,
): Promise<DeptSearchCorpora> {
  const { depts, aclVersion } = await visibleDeptsForCaller(req, prisma);
  const corpora = [user];
  for (const dept of depts) {
    if (dept.kind === "HOUSEHOLD") {
      corpora.push(HOUSEHOLD_INDEX_USER);
    }
    corpora.push(deptSentinel(dept.id));
  }
  return { corpora, aclVersion };
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
  // WARP-1262 (security): a `..` traversal in a caller-supplied path is a bad
  // request, never a 5xx — map it to 400 (before the NC-outage branches, since
  // it originates client-side, not from an upstream).
  if (err instanceof UnsafePathError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof MissingNcTokenError) {
    res.status(401).json({ error: err.message });
    return;
  }
  // WARP-582 — missing authenticated user is a 401 (fail-closed re-auth
  // prompt), never an admin fallback and never a 500. Ordered BEFORE the
  // degrade branches so a read endpoint can't swallow it into an empty
  // listing.
  if (err instanceof MissingAuthUserError) {
    res.status(401).json({ error: err.message });
    return;
  }
  // WARP-882: the document-server engine is an upstream dependency. When it is
  // disabled or unreachable the correct status is 503, with the typed error's
  // wire shape so the dashboard renders a calm "editing unavailable" state.
  if (err instanceof DocServerUnavailableError) {
    res.status(err.status).json(err.toJSON());
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

export function createFilesRouter(
  prisma: PrismaClient,
  // WARP-941: injectable transport seam for the person-share notification
  // email — same seam createProtectedAuthRouter threads for invites, so
  // tests never dial a real relay. Production callers pass nothing.
  emailSendOptions: EmailSendOptions = {},
): Router {
  const router = Router();

  /**
   * WARP-1556 — build a user-keyed Files cache key that carries the caller's
   * membership/ACL dimension: `<prefix><user>:<aclTag>[:<suffix>…]`.
   *
   * Returns `null` when the caller's department visibility could not be
   * resolved. `null` means FAIL CLOSED — the route must skip the cache in
   * BOTH directions (no read, no write, no del): reading the personal-only
   * key after a failed lookup could hand back another space's content, and
   * writing it could poison that key for a caller who really has no
   * departments. Serving a fresh upstream response is always safe; serving a
   * cached one when we cannot prove what the caller may see is not.
   *
   * Costs one indexed Prisma read per request on the routes that use it —
   * the same read `GET /api/files/search/content` has paid since WARP-1264.
   */
  async function aclScopedKey(
    req: Request,
    prefix: string,
    user: string,
    ...suffix: string[]
  ): Promise<string | null> {
    const tag = await aclCacheTag(req, prisma);
    if (!tag) return null;
    return [`${prefix}${user}`, tag, ...suffix].join(":");
  }

  /**
   * WARP-1556 — the ONE builder for the directory-listing cache key, shared by
   * the `GET /api/files` read and every write route's invalidation, so a key
   * written by the read is always the key a later `cacheDel` names. Never
   * inline `CACHE_PREFIX + user + ":" + path` again: that shape has neither
   * dimension below, and a read/del pair built from two different shapes
   * silently stops invalidating.
   *
   * Shape: `files:list:<user>:<aclTag>:<spaceTag>:<resolvedPath>` — TWO
   * orthogonal dimensions, both load-bearing and neither a substitute for the
   * other:
   *
   *   • `<aclTag>` (WARP-1556) is WHAT THE CALLER MAY SEE — max(aclVersion)
   *     plus a digest of the sorted `deptId:aclVersion` pairs. It stops a
   *     just-revoked member from reading a gated library's listing out of
   *     Redis for the rest of the TTL. That is a disclosure boundary.
   *   • `<spaceTag>` (WARP-1610) is WHICH LISTING THIS IS. The caller may see
   *     both a personal `/Alpha` and department Alpha's `/Alpha`; the ACL tag
   *     is identical for the two (same caller, same memberships) and so
   *     cannot separate them. Only the space can.
   *
   * `null` from EITHER (unresolved visibility, or an unnameable space) → skip
   * the cache in both directions; see `aclScopedKey` and `spaceCacheTag`.
   */
  async function listCacheKey(
    req: Request,
    user: string,
    target: SpacedPath,
  ): Promise<string | null> {
    const spaceTag = spaceCacheTag(target.space);
    if (!spaceTag) return null;
    return aclScopedKey(req, CACHE_PREFIX, user, spaceTag, target.path);
  }

  /**
   * Invalidate the listing cache for one already-resolved (space, path).
   *
   * WARP-1556: goes through `listCacheKey` so the del names exactly the key
   * the read wrote.
   *
   * WARP-1682 — a null key must NOT mean "skip". The original reasoning was
   * that there is "nothing readable either, since the read path bypasses the
   * cache in that state", but that treats a PER-REQUEST condition as durable
   * state. `aclCacheTag` returns null whenever `visibleDeptsForCaller` fails
   * to resolve, which it does on any transient Prisma hiccup (it swallows the
   * throw and reports `resolved: false`). The entry we are trying to drop was
   * written by an EARLIER request whose ACL walk DID resolve — so a live key
   * exists, and skipping the del pins the pre-write listing for the rest of
   * CACHE_TTL. On a delete that means the file the user just removed is served
   * back to them until the entry expires.
   *
   * Fallback: sweep every listing entry for this user. It is broader than the
   * one key we wanted — a cache miss on the user's other directories — but
   * over-invalidating a cache is always safe, and this only runs on the rare
   * unresolved-visibility path. The trailing ":" keeps the prefix from
   * matching a different user whose name merely starts the same way.
   */
  async function invalidateListing(
    req: Request,
    user: string,
    target: SpacedPath,
  ): Promise<void> {
    const key = await listCacheKey(req, user, target);
    if (key) {
      await cacheDel(key);
      return;
    }
    await invalidatePrefix(`${CACHE_PREFIX}${user}:`);
  }

  /**
   * WARP-941 — best-effort notification email for person shares (shareType 0).
   *
   * Resolves the recipient's email from the LOCAL Prisma `User` directory by
   * `nextcloudUsername`, case-insensitively — the same matching contract as
   * GET /files/share-recipients, which is where the `shareWith` value the
   * dashboard posts came from in the first place (ADR-013; the at-rest dcv1
   * email blob is decrypted via readUserEmail). Delivery goes over the
   * operator's SMTP channel via sendShareNotificationEmail, which no-ops
   * unless the channel is configured AND enabled — identical gating to user
   * invites.
   *
   * NEVER throws, and is invoked fire-and-forget: the share already exists in
   * Nextcloud, so a directory gap, an unconfigured channel, or a relay outage
   * must not fail or delay the share response.
   */
  async function notifyPersonShareByEmail(
    req: Request,
    shareWith: string,
    filePath: string,
  ): Promise<void> {
    try {
      // Full-directory scan is intentional at household scale (tens of rows):
      // it resolves BOTH the recipient (exact-case then case-insensitive, in
      // JS — no Postgres `mode:'insensitive'` query) and the caller's display
      // name in a single round-trip. Narrow only if the directory grows large.
      const rows = (await prisma.user.findMany({
        select: { id: true, displayName: true, email: true, nextcloudUsername: true },
      })) as Array<{
        id: string;
        displayName: string;
        email: string | null;
        nextcloudUsername: string | null;
      }>;

      const target = shareWith.toLowerCase();
      // Prefer an exact-case match so two directory rows that differ only by
      // case can't misdeliver this notification (it discloses the sharer +
      // filename) to the wrong person; fall back to the case-insensitive
      // contract for the normal single-variant case.
      const recipient =
        rows.find((u) => u.nextcloudUsername === shareWith) ??
        rows.find((u) => u.nextcloudUsername?.toLowerCase() === target);
      // WARP-233: decrypt the at-rest dcv1 blob. Null/empty → nothing to send to.
      const to = recipient ? readUserEmail(recipient.email) : null;
      if (!to) {
        logger.info(
          { shareWith, hasRecipientRow: Boolean(recipient) },
          "share notification skipped — no directory email for recipient",
        );
        return;
      }

      const caller = rows.find((u) => u.id === req.user?.id);
      const sharerDisplayName = caller?.displayName || req.user?.username || "Someone";

      await sendShareNotificationEmail(
        prisma,
        {
          to,
          sharerDisplayName,
          fileName: path.posix.basename(filePath) || filePath,
        },
        emailSendOptions,
      );
    } catch (err) {
      // Directory lookup failed (or an unexpected throw): log and move on —
      // the share itself already succeeded.
      logger.warn({ err, shareWith }, "share notification email failed");
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // WARP-882 / WS-4 — in-browser editing + co-authoring (OnlyOffice)
  // ════════════════════════════════════════════════════════════════════
  // The configured engine (Collabora CODE by default — LibreOffice technology,
  // no licensing fee; OnlyOffice DS CE via DOCS_ENGINE=onlyoffice, which
  // requires an OEM license before GA — see ADR-034 + the docserver.client.ts
  // header) is reached via its Nextcloud connector app over a WOPI-style
  // handshake. The orchestrator stays engine-agnostic: it only mints sessions
  // + reports status.

  // The engine identifier surfaced on /files/docs/status. Config drives the
  // actual engine; this string is informational for the dashboard.
  const DOCS_ENGINE = config.DOCS_ENGINE;

  // 10s-cached doc-server readiness so the dashboard can gate the "Edit" entry
  // without hammering the engine's health endpoint on every files-page load.
  const DOCS_STATUS_CACHE_KEY = "files:docs:status";
  const DOCS_STATUS_TTL = 10;

  // ── Document-server status (GET /api/files/docs/status) ──
  //
  // Registered BEFORE the `:filePath(*)/editor-session` wildcard so the literal
  // `docs/status` path is never captured as a file path. Returns
  // { state: "ready"|"unavailable", engine }. Never 500s — an unhealthy engine
  // is a "unavailable" state, not an error, so the files page renders calmly.
  router.get(
    "/files/docs/status",
    requireRole("owner", "admin", "family"),
    async (_req: Request, res: Response, _next: NextFunction) => {
      // Cache reads/writes are best-effort: Redis unavailability must not 500
      // this route (the "Never 500s" contract in the comment above).
      let cached: { state: string; engine: string } | null = null;
      try { cached = await cacheGet<{ state: string; engine: string }>(DOCS_STATUS_CACHE_KEY); } catch { /* Redis unavailable */ }
      if (cached) {
        res.json(cached);
        return;
      }
      const healthy = await docServerHealthy();
      const payload = {
        state: healthy ? "ready" : "unavailable",
        engine: DOCS_ENGINE,
      };
      try { await cacheSet(DOCS_STATUS_CACHE_KEY, payload, DOCS_STATUS_TTL); } catch { /* Redis unavailable */ }
      res.json(payload);
    },
  );

  // ── Editor session (GET /api/files/:path/editor-session) ──
  //
  // Decides edit-vs-view SERVER-SIDE and never trusts a client-sent mode:
  //   - `edit` if the caller OWNS the file (not present in shared-with-me), OR
  //     it is shared to them WITH the Nextcloud update permission bit (2).
  //   - `view` otherwise.
  // A client `?mode=` query is deliberately ignored. Error mapping (via
  // handleFileError): missing NC token → 401, DocServerUnavailableError → 503,
  // not-found file → 404.
  router.get(
    "/files/:filePath(*)/editor-session",
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
        const token = await getToken(req);
        const user = getUser(req);

        // WARP-1260 (T8): department metadata gate — resolve BEFORE minting
        // the doc-server session so a non-member never reaches the WOPI
        // handshake for a dept file. TWO phases with DIFFERENT failure
        // postures:
        //   1. NC/file-id RESOLUTION is best-effort — a resolution failure
        //      (NC unreachable, path no longer resolves) falls through to the
        //      existing mint-time behavior rather than 500ing.
        //   2. The authorization DECISION (checkSpaceAccess) is NOT best-effort
        //      and runs OUTSIDE the resolution try/catch: a denial returns 403
        //      and any internal error (a transient department/membership Prisma
        //      failure) propagates to the route's outer catch (fail-closed). If
        //      it stayed inside the swallow, a thrown membership lookup would be
        //      silently discarded and the session minted anyway — the exact
        //      cross-department fail-open ADR-029 §3.2 closes. Mirrors the
        //      comments/tags routes' `gateFileSpaceAccess` posture.
        let gateDepartmentId: string | null = null;
        try {
          const gateFileId = await ncGetFileId(token, user, filePath);
          if (gateFileId !== null) {
            gateDepartmentId = await resolveFileDepartment(prisma, gateFileId);
          }
        } catch (gateErr) {
          logger.debug(
            { err: gateErr, filePath },
            "editor-session: department gate resolution failed (best-effort, falling through)",
          );
        }
        if (gateDepartmentId) {
          const gateCaller: SpaceAccessCaller = {
            id: requesterId(req),
            role: (req as { user?: { role?: string } }).user?.role ?? "",
          };
          const access = await checkSpaceAccess(
            prisma,
            req,
            gateCaller,
            gateDepartmentId,
            "reader",
          );
          if (!access.allowed) {
            res.status(access.status).json({ error: access.error });
            return;
          }
        }

        // Edit-vs-view: default to the owner's edit capability, then DOWNGRADE
        // to the share's permission if this is a shared-with-me item. We never
        // UPGRADE based on client input. `ncListSharedWithMe` returns the
        // caller's inbound shares with their granted permission bitmask
        // (bit 2 = update); a file the caller owns is absent from that list, so
        // owners keep edit.
        const NC_PERMISSION_UPDATE = 2;
        let mode: "edit" | "view" = "edit";
        const shares = await ncListSharedWithMe(token);
        const inboundShare = shares.find((s) => s.path === filePath);
        if (inboundShare) {
          mode =
            (inboundShare.permissions & NC_PERMISSION_UPDATE) === NC_PERMISSION_UPDATE
              ? "edit"
              : "view";
        }

        const session = await ncMintEditorSession(token, user, filePath, mode);

        // Record/refresh the OPEN co-authoring session, keyed on ncFileId so a
        // second editor joining the same document upserts the one row rather
        // than duplicating it. `status` is an EXPLICIT column. This is an
        // audit/coordination write — a failure must not block the editor from
        // opening (same non-fatal posture as safePublish), so it is awaited but
        // its rejection is swallowed with a warning.
        try {
          await prisma.fileEditSession.upsert({
            where: { ncFileId: session.ncFileId },
            create: {
              ncFileId: session.ncFileId,
              ncUser: user,
              filePath,
              mode: session.mode,
              status: "open",
              documentKey: session.documentKey,
            },
            update: {
              ncUser: user,
              filePath,
              mode: session.mode,
              status: "open",
              lastActiveAt: new Date(),
              closedAt: null,
              documentKey: session.documentKey,
            },
          });
        } catch (persistErr) {
          logger.warn({ err: persistErr, ncFileId: session.ncFileId }, "FileEditSession upsert failed (non-fatal)");
        }

        res.json(session);
      } catch (err) {
        // The doc-server client throws a plain Error("File not found: …") when
        // the path resolves to no Nextcloud fileId — surface it as 404 here
        // (mirrors the versions route's explicit null-fileId → 404), keeping
        // the shared handleFileError 404 matcher narrow. DocServerUnavailable
        // (→503) and MissingNcToken (→401) flow through handleFileError.
        if (
          err instanceof Error &&
          !(err instanceof DocServerUnavailableError) &&
          /file not found/i.test(err.message)
        ) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        handleFileError(err, res, next);
      }
    },
  );

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

        // WARP-1260 (T8): department metadata gate. FileCitation is keyed
        // by `filePath`, not `ncFileId`, so resolve the NC file id first.
        // TWO phases with DIFFERENT failure postures:
        //   1. NC/file-id RESOLUTION is best-effort — any resolution failure
        //      (missing NC session, Nextcloud unreachable, path no longer
        //      exists) falls through to the existing personal-space semantics
        //      below rather than 500ing or 401ing a route that historically
        //      never depended on NC.
        //   2. The authorization DECISION (checkSpaceAccess) is NOT best-effort
        //      and runs OUTSIDE the resolution try/catch: a denial returns 403
        //      and any internal error (a transient department/membership Prisma
        //      failure) propagates to the route's outer catch (fail-closed)
        //      instead of being swallowed and falling through UNGATED — the
        //      exact cross-department fail-open ADR-029 §3.2 closes. Mirrors the
        //      comments/tags routes' `gateFileSpaceAccess` posture.
        let gateDepartmentId: string | null = null;
        try {
          const gateToken = await getToken(req);
          const gateNcUser = getUser(req);
          const gateFileId = await ncGetFileId(gateToken, gateNcUser, filePath);
          if (gateFileId !== null) {
            gateDepartmentId = await resolveFileDepartment(prisma, gateFileId);
          }
        } catch (gateErr) {
          logger.debug(
            { err: gateErr, filePath },
            "citations: department gate resolution failed (best-effort, falling through)",
          );
        }
        if (gateDepartmentId) {
          const gateCaller: SpaceAccessCaller = {
            id: (req as { user?: { id?: string } }).user?.id ?? "__none__",
            role: (req as { user?: { role?: string } }).user?.role ?? "",
          };
          const access = await checkSpaceAccess(
            prisma,
            req,
            gateCaller,
            gateDepartmentId,
            "reader",
          );
          if (!access.allowed) {
            res.status(access.status).json({ error: access.error });
            return;
          }
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

  // ── WARP-1260 (T8) — metadata-route department gate ──
  //
  // comments/tags/citations/editor-session resolve a file's `ncFileId`
  // (via `resolveFileIdOr404` above, or their own `ncGetFileId` call) and
  // then call this: `resolveFileDepartment` → if the file IS registered
  // to a department, run the SAME `requireSpaceAccess('reader')` truth
  // table `middleware/space.ts` uses, inline, against that department.
  // Files absent from the registry (`departmentId === null`) fall back to
  // the existing personal-space semantics (per-user IDOR filters already
  // on every route below) — no gate applied. Ships in the same release as
  // dept spaces per the brief: fail-open here is a cross-department
  // metadata leak. On denial this writes the 403 response itself (via
  // `checkSpaceAccess`'s result) and returns `false`; the caller must
  // `return` immediately without writing anything further.
  async function gateFileSpaceAccess(
    req: Request,
    res: Response,
    ncFileId: number,
    minRight: DepartmentRight,
  ): Promise<boolean> {
    const departmentId = await resolveFileDepartment(prisma, ncFileId);
    if (!departmentId) return true;
    const caller: SpaceAccessCaller = {
      id: requesterId(req),
      role: (req as { user?: { role?: string } }).user?.role ?? "",
    };
    const access = await checkSpaceAccess(prisma, req, caller, departmentId, minRight);
    if (!access.allowed) {
      res.status(access.status).json({ error: access.error });
      return false;
    }
    return true;
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
        if (!(await gateFileSpaceAccess(req, res, row.ncFileId, "reader"))) return;
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
        if (!(await gateFileSpaceAccess(req, res, fileId, "reader"))) return;
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
        if (!(await gateFileSpaceAccess(req, res, fileId, "reader"))) return;
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
        if (!(await gateFileSpaceAccess(req, res, fileId, "reader"))) return;
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
        if (!(await gateFileSpaceAccess(req, res, fileId, "reader"))) return;
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
        if (!(await gateFileSpaceAccess(req, res, fileId, "reader"))) return;
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
  // WARP-1271 (T19a): the per-request file-size limit is resolved from the
  // caller's UserUsagePolicy BEFORE constructing the multer instance —
  // multer's `limits` are fixed at construction, so a per-user cap means a
  // per-request multer(), not a shared module-level one. LIMIT_FILE_SIZE
  // gets an honest 413 (was 400) naming the ACTUAL limit that applied,
  // which may be tighter than config.MAX_UPLOAD_SIZE_MB.
  //
  // WARP-1666: `limits.files` is set as well as the `.array()` maxCount, and
  // the two MUST stay equal. multer's own maxCount bookkeeping reports an
  // over-count as LIMIT_UNEXPECTED_FILE — the same code a genuinely misnamed
  // field raises (multer/index.js: `filesLeft[fieldname]` hits 0) — so without
  // a busboy-level `files` limit a 36-file upload was rejected with "unexpected
  // field name", pointing every reader at the wrong problem. With `limits.files`
  // set, busboy raises LIMIT_FILE_COUNT first and each code again means one
  // thing only.
  async function handleUpload(req: Request, res: Response, next: NextFunction) {
    const userId = (req as { user?: { id?: string } }).user?.id;
    const limitMb = await resolveUploadLimitMb(prisma, userId);
    const scopedUpload = multer({
      storage: MEMORY_STORAGE,
      limits: {
        fileSize: limitMb * 1024 * 1024,
        files: MAX_FILES_PER_UPLOAD,
      },
    });
    scopedUpload.array("files", MAX_FILES_PER_UPLOAD)(req, res, (err) => {
      if (err instanceof MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: `File too large (max ${limitMb}MB for your account)`,
          });
          return;
        }
        const messages: Record<string, string> = {
          LIMIT_FILE_COUNT: `Too many files (max ${MAX_FILES_PER_UPLOAD} per upload)`,
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
  // WARP-883 (T5) + WARP-1261 (T9): accepts an optional `?space=` (default personal).
  // personal: the path is used verbatim (the user's home root).
  // shared: the path resolves UNDER the Household prefix (legacy WS-5 compatibility).
  // dept:<uuid>: path resolves UNDER the department mount point.
  // On the My-Files (personal) home ROOT we hide the shared folder entry so the
  // Household folder isn't shown twice — once as a space in the switcher and once inline.
  // Composed with requireSpaceAccess middleware (reader minRight). The gate's own
  // parseSpaceValue() only recognizes "personal" / "household" / "dept:<uuid>" and
  // fails closed on anything else — but this route's `?space=` contract predates it
  // (WARP-883/WS-5) and uses "shared" as the household alias, with any other
  // unrecognized value silently falling back to personal (rootForSpace/resolveSpace
  // above mirror the same lenient contract). Translate at the gate boundary so the
  // access check and the path-resolution below stay in agreement, while a malformed
  // `dept:<uuid>` still fails closed per the gate's own truth table.
  router.get(
    "/files",
    requireSpaceAccess(prisma, "reader", {
      resolveSpace: (req) => {
        const raw = req.query.space;
        if (typeof raw !== "string") return undefined; // personal
        if (raw === "shared") return "household"; // legacy WS-5 alias
        if (raw.startsWith("dept:")) return raw; // pass through for uuid validation
        return undefined; // "personal" or any unrecognized value -> personal
      },
    }),
    async (req, res, next) => {
      try {
        const requestedPath = (req.query.path as string) || "/";
        const space = resolveSpace(req.query.space);
        const filePath = await rootForSpace(prisma, space, requestedPath);
        const user = getUser(req);
        const isPersonalRoot = space === "personal" && filePath === "/";

      // The cache identity is the (space, resolvedPath) PAIR, built by the one
      // `listCacheKey` builder every write route also invalidates through, so
      // a mutation always lands on the entry this read wrote.
      //
      // Neither half alone is enough, and the reason is the same seam seen
      // from two sides. This route IS gated per-request by
      // requireSpaceAccess, but the gate only authorizes the DECLARED
      // `?space=`, and `space=personal` resolves the path verbatim — so
      // `?path=/Alpha` (no space) produces the very same resolved path the
      // gated `?space=dept:<alpha>` read produced, with no membership check
      // at all. Therefore:
      //
      //   • WARP-1556's ACL tag: without it a just-revoked member keeps
      //     pulling that library's listing out of Redis through the ungated
      //     personal path for the whole CACHE_TTL window (disclosure).
      //   • WARP-1610's space tag: a caller who may legitimately see BOTH a
      //     personal folder named `Alpha` and department Alpha still gets one
      //     served in place of the other, because their ACL tag is identical
      //     for the two reads (content-mixing).
      const cacheKey = await listCacheKey(req, user, { space, path: filePath });
      if (cacheKey) {
        const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
        if (cached) {
          res.json(cached);
          return;
        }
      }

      const raw = await ncListFiles(await getToken(req), user, filePath);
      // Hide the shared-folder AND any active dept/team groupfolder mount
      // from the personal home root only (WARP-1267) — a subfolder elsewhere
      // (or inside the shared/dept space itself) that happens to share the
      // name must NOT be filtered.
      let entries = raw;
      if (isPersonalRoot) {
        const userId = req.user?.id;
        const isOwnerOrAdmin = req.user?.role === "owner" || req.user?.role === "admin";
        const hideNames = new Set([SHARED_FOLDER_NAME]);
        if (userId) {
          for (const name of await activeDeptMountNames(prisma, userId, isOwnerOrAdmin)) {
            hideNames.add(name);
          }
        }
        entries = raw.filter((e) => !hideNames.has(e.name));
      }
      if (cacheKey) await cacheSet(cacheKey, entries, CACHE_TTL);
      res.json(entries);
    } catch (err) {
      handleFileError(err, res, next, []);
    }
  });

  // ── Spaces (GET /api/files/spaces) ──
  //
  // WARP-883 (T5) + WARP-1261 (T9): tells the dashboard which spaces exist.
  // Returns: personal always; household (shared) with legacy id for wire-compat
  // + spaceRef for v2; active DEPARTMENT/TEAM rows where caller is member or
  // owner/admin.
  //
  // sharedAvailable probes the Household groupfolder; demoted (membership
  // decides visibility in v2, not the probe). Read-only + degrades gracefully
  // on Nextcloud outage (never 500).
  router.get("/files/spaces", async (req, res, next) => {
    try {
      const user = getUser(req);
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

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

      // Build the response: personal, household (shared), then active departments.
      const spaces: Array<Record<string, unknown>> = [
        { id: "personal", name: "My Files", root: "/" },
      ];

      // Household absorption: the seeded HOUSEHOLD kind department is returned
      // with id='shared' for wire-compat, plus spaceRef for v2 routing.
      const household = await prisma.department.findFirst({
        where: { kind: "HOUSEHOLD" },
        select: { id: true, name: true },
      });
      if (household) {
        spaces.push({
          id: "shared",
          name: household.name,
          spaceRef: `dept:${household.id}`,
          root: `/${SHARED_FOLDER_NAME}`,
          kind: "household",
          state: "active",
          // No 'right' or 'available' — household is special (always available if it exists).
        });
      }

      // DB-driven departments: personal always; then Department rows where
      // state=active AND caller is owner/admin OR has membership.
      const isOwnerOrAdmin = req.user?.role === "owner" || req.user?.role === "admin";

      // WARP-1267: memberships are ALWAYS selected (not gated on role) so the
      // response can tell an admin-see-all visit ("I can see this because
      // I'm an admin") apart from an actual membership ("I'm a member here")
      // — the `isMember` flag the Files UI needs to drive the admin
      // foreign-library banner (brief §2).
      const deptQuery = prisma.department.findMany({
        where: {
          kind: { in: ["DEPARTMENT", "TEAM"] },
          state: "active",
        },
        select: {
          id: true,
          name: true,
          parentId: true,
          kind: true,
          memberships: {
            where: { userId },
            select: { right: true },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      const depts = await deptQuery;

      for (const dept of depts) {
        const membershipArray = dept.memberships;
        const isMember = membershipArray.length > 0;

        // Not owner/admin and not a member → not visible, skip entirely.
        if (!isOwnerOrAdmin && !isMember) continue;

        // Resolve the mount point: DEPARTMENT → name; TEAM → "Parent — Team".
        // parentName is also threaded through for kind=TEAM so the dashboard
        // can render the "<Department> / <Team>" breadcrumb crumb without a
        // second lookup — the UI owns this hierarchy illusion since NC mounts
        // team libraries flat (2026-07-11 amendment, ADR-029 §D-3).
        let mountName = dept.name;
        let parentName: string | undefined;
        if (dept.kind === "TEAM" && dept.parentId) {
          const parent = await prisma.department.findUnique({
            where: { id: dept.parentId },
            select: { name: true },
          });
          if (parent) {
            mountName = `${parent.name} — ${dept.name}`;
            parentName = parent.name;
          }
        }

        const membershipRight = membershipArray[0]?.right;
        // A member's own right always wins; an owner/admin visiting a
        // library they're not a member of gets the implicit see-all right
        // (they already short-circuit-pass `requireSpaceAccess` at manager
        // level — §3.1) so the switcher can still show a rights chip.
        const right = isMember ? membershipRight : isOwnerOrAdmin ? "manager" : undefined;

        spaces.push({
          id: `dept:${dept.id}`,
          name: dept.name,
          root: `/${mountName}`,
          kind: dept.kind === "TEAM" ? "team" : "department",
          state: "active",
          right,
          isMember,
          ...(parentName ? { parentName } : {}),
        });
      }

      res.json({
        sharedAvailable,
        spaces,
      });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Download a file, or serve it inline for the preview modal ──
  //
  // `?disposition=inline` (PreviewPane's `getPreviewUrl`) flips this route from
  // "save to disk" to "render in place". It exists because the preview modal
  // feeds this URL to an `<object>`/`<video>`/`<audio>` tag, and a browser
  // honours `Content-Disposition: attachment` inside `<object>` by DOWNLOADING —
  // which is why clicking Preview on a PDF used to raise a Save-As dialog over
  // an empty modal instead of showing the document.
  //
  // Inline is granted ONLY for `inlinePreviewContentType()`'s safelist, never
  // for an arbitrary upload: `text/html` and `image/svg+xml` execute script, so
  // rendering a user-supplied one inline on the dashboard origin would be stored
  // XSS against the session cookie. An off-safelist file still downloads,
  // exactly as before — the affordance degrades, the invariant does not.
  router.get("/files/download", async (req, res, next) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }

      const filename = path.basename(filePath);
      const ext = path.extname(filename).toLowerCase();

      // Resolve the disposition BEFORE fetching bytes so the safelist decision
      // is one branch, evaluated once, and visible in every header below.
      const inlineType =
        req.query.disposition === "inline" ? inlinePreviewContentType(filename) : null;
      const serveInline = inlineType !== null;

      const stream = await ncDownloadFile(await getToken(req), getUser(req), filePath);
      if (!stream) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      // WARP-237: file-level data-access record (chunk-level RAG reads are
      // deferred — see the WARP-237 gap analysis). Fire-and-forget so the
      // byte stream is not delayed by the append lock.
      //
      // Only a real download is recorded. Opening the preview modal is a read,
      // not an export, and logging it as "File downloaded" would make the
      // Activity feed's download trail useless for the question it exists to
      // answer — which files actually left the box.
      if (!serveInline) {
        void recordActivity({
          kind: "file",
          severity: "info",
          sourceIcon: "download",
          what: "File downloaded",
          sub: filePath,
          refs: { path: filePath },
          actor: actorFromRequest(req),
        });
      }

      if (serveInline) {
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Content-Type", inlineType);
        // Belt-and-braces for the safelist: `nosniff` stops a browser
        // re-interpreting safelisted bytes as markup, and the `sandbox` CSP
        // strips scripting/same-origin from the rendered document even if a
        // future edit widens the safelist by mistake.
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "sandbox");
      } else {
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader(
          "Content-Type",
          ext === ".pdf" ? "application/pdf" : "application/octet-stream"
        );
      }

      const nodeStream = Readable.fromWeb(stream as any);
      nodeStream.pipe(res);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Upload file(s) ──
  // WARP-171: per-route guard. owner + admin + family — household
  // file writes.
  //
  // WARP-1460: also admit the `_service:mcp` principal. The shipped
  // `write_file` and new `create_document` LLM tools POST a JSON body
  // `{dir, filename, contentBase64}` to this route (via the nextcloud
  // HttpClient), NOT a multipart form. Plain `requireRole` 403'd the
  // service principal AND the handler was multipart-only, so both tools
  // were dead on the HTTP path. The guard now mirrors the sibling MCP
  // write routes (DELETE /files, POST /files/move|copy), and the handler
  // branches on transport (see below). Human role set is unchanged; NC
  // identity for the service principal still comes from X-Nextcloud-* via
  // getToken/getUser (WARP-861 idiom — missing either → 401, no admin
  // fallback), while a human's headers stay ignored (session rules).
  //
  // WARP-1262 (T10): `?space=` is read via the query string ONLY (never
  // multipart body fields) — `requireSpaceAccess` is composed BEFORE
  // `handleUpload` (multer), so `req.body` isn't populated yet when the
  // gate runs. `path` (the target dir) is space-relative; the server
  // resolves the operational path, killing the client-side pre-translation.
  router.post(
    "/files/upload",
    requireRoleOrMcpService("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    handleUpload,
    async (req, res, next) => {
    try {
      const space = resolveSpace(req.query.space);

      // WARP-1460: two transports feed this route. multer only populates
      // `req.files` for a multipart/form-data request — it calls next()
      // untouched for a JSON body — so `req.files` presence discriminates the
      // human dashboard upload (multipart; target dir in `?path=`) from the
      // write_file / create_document tools (JSON `{dir, filename,
      // contentBase64}`; target dir in the body `dir` field). Both shapes
      // normalize to a single {name, buffer, size} list so the post-write
      // bookkeeping loop below is SHARED and can never diverge between paths.
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      let rawTargetPath: string;
      let uploads: { name: string; buffer: Buffer; size: number }[];

      if (files.length > 0) {
        // Existing multipart path — byte-identical behavior: dir from `?path=`.
        rawTargetPath = (req.query.path as string) || "/";
        uploads = files.map((f) => ({
          name: f.originalname,
          buffer: f.buffer,
          size: f.size,
        }));
      } else if (
        typeof (req.body as { contentBase64?: unknown } | undefined)?.contentBase64 ===
        "string"
      ) {
        // NEW JSON single-file path (write_file / create_document). The tools
        // read the directory from the `dir` body field, NOT `?path=`.
        // `contentBase64` is a string here (narrowed by the `else if` above).
        const body = req.body as {
          dir?: unknown;
          filename?: unknown;
          contentBase64: string;
        };
        rawTargetPath =
          typeof body.dir === "string" && body.dir.length > 0 ? body.dir : "/";

        // The JSON body carries a bare basename — reject an empty name, any
        // path separator, or a `..`/`.` segment so the write is pinned to a
        // single path segment. (`dir` traversal is caught separately by
        // rootForSpace below; this guards the FILENAME.)
        const filename = typeof body.filename === "string" ? body.filename : "";
        const filenameSegments = filename.split(/[\\/]/);
        if (
          filename.length === 0 ||
          filenameSegments.length > 1 ||
          filenameSegments.includes("..") ||
          filename === "."
        ) {
          res.status(400).json({
            error: "filename must be a non-empty basename with no path separators",
          });
          return;
        }

        // Decode base64 strictly — reject non-base64 input, matching
        // write_file's INVALID_BASE64 posture (re-encode must round-trip).
        const cleaned = body.contentBase64.replace(/\s+/g, "");
        const buffer = Buffer.from(cleaned, "base64");
        if (buffer.toString("base64").replace(/=+$/, "") !== cleaned.replace(/=+$/, "")) {
          res.status(400).json({ error: "invalid base64 content" });
          return;
        }

        // Enforce the 10 MB LLM-write cap on the DECODED bytes (mirrors
        // @droplet/tools-core's MAX_WRITE_BYTES). The multipart path is capped
        // upstream by multer's per-request `limits.fileSize`; the JSON path has
        // no multer, so the ceiling is enforced here.
        const MAX_JSON_WRITE_BYTES = 10 * 1024 * 1024;
        if (buffer.byteLength > MAX_JSON_WRITE_BYTES) {
          res.status(413).json({
            error: `content too large (max ${MAX_JSON_WRITE_BYTES} bytes)`,
          });
          return;
        }

        uploads = [{ name: filename, buffer, size: buffer.byteLength }];
      } else {
        res.status(400).json({ error: "No files provided" });
        return;
      }

      const targetPath = await rootForSpace(prisma, space, rawTargetPath);

      const token = await getToken(req);
      const user = getUser(req);
      const results: { name: string; path: string; size: number }[] = [];

      // WARP-1260 (T8) writer, WARP-1262 (T10) gate: the space was already
      // resolved + authorized by `requireSpaceAccess` above, so the
      // file-registry departmentId is just the guard's own resolved value
      // — no second lookup needed.
      const uploadDepartmentId = req.spaceDepartmentId ?? null;
      const ownerUserId = (req as { user?: { id?: string } }).user?.id ?? null;

      for (const file of uploads) {
        await ncUploadFile(token, user, targetPath, file.name, file.buffer);
        const uploadedPath =
          targetPath === "/"
            ? `/${file.name}`
            : `${targetPath}/${file.name}`;
        results.push({
          name: file.name,
          path: uploadedPath,
          size: file.size,
        });

        // Best-effort, non-blocking: a registry-write failure must never
        // fail the upload the user is actively waiting on.
        if (ownerUserId) {
          try {
            const ncFileId = await ncGetFileId(token, user, uploadedPath);
            if (ncFileId !== null) {
              await upsertFileRegistryEntry(prisma, {
                ncFileId,
                ownerUserId,
                path: uploadedPath,
                departmentId: uploadDepartmentId,
              });
            }
          } catch (registryErr) {
            logger.warn(
              { err: registryErr, path: uploadedPath },
              "upload: file-registry upsert failed (non-fatal)",
            );
          }
        }
      }

      await invalidateListing(req, user, { space, path: targetPath });
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
  // WARP-1262 (T10): `?space=` threading — path is space-relative, resolved
  // server-side; killing the client-side `toHomeRelativePath` pre-translate.
  router.delete(
    "/files",
    requireRoleOrMcpService("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
    try {
      const rawPath = req.query.path as string;
      if (!rawPath) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      const space = resolveSpace(req.query.space);
      const filePath = await rootForSpace(prisma, space, rawPath);

      const user = getUser(req);
      const parentPath = path.posix.dirname(filePath) || "/";

      // WARP-1682: invalidate the parent listing whether or not the WebDAV
      // call succeeded. A FAILED delete is precisely when the cached listing
      // is least trustworthy — `runBulk` below documents Nextcloud's trashbin
      // race, where a request can 500 while the file "ends up half-moved
      // (trash entry created but source not unlinked)". Skipping the del on
      // the throw path left that half-applied state readable out of Redis for
      // the rest of CACHE_TTL, which is how a delete that errored could still
      // show the file until a page reload. `bulk-delete` already invalidates
      // unconditionally; this matches it.
      try {
        await ncDeleteFile(await getToken(req), user, filePath);
      } finally {
        await invalidateListing(req, user, { space, path: parentPath });
      }

      safePublish(`droplet/files/${user}/deleted`, { path: filePath });
      res.json({ deleted: filePath });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Create a directory ──
  // WARP-1262 (T10): `?space=` (query or body) threading.
  router.post(
    "/files/mkdir",
    requireRoleOrMcpService("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
    try {
      const schema = z.object({ path: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "path is required", details: parsed.error.flatten() });
        return;
      }

      // WARP-938 (security): reject path traversal. The WebDAV layer strips only
      // leading slashes, so a `..` segment would resolve to a sibling of the
      // intended target — letting an authenticated user create directories
      // anywhere in their storage. Normalize and require the result to stay
      // anchored at root with no `..` segments. Checked on the RAW
      // space-relative input, before the space prefix is applied.
      if (!isSafeUserPath(parsed.data.path)) {
        res.status(400).json({ error: "path must not contain '..' segments" });
        return;
      }

      const space = resolveSpace(spaceQueryOrBody(req));
      const targetPath = await rootForSpace(prisma, space, parsed.data.path);

      const user = getUser(req);
      await ncCreateDirectory(await getToken(req), user, targetPath);

      const parentPath = path.posix.dirname(targetPath) || "/";
      await invalidateListing(req, user, { space, path: parentPath });

      res.json({ created: targetPath });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Create a share link ──
  //
  // Accepts the full ShareCreateOptions surface (shareType / permissions /
  // expireDate / password / note / shareWith). Callers that pass only `path`
  // get a public read-only link from the defaults.
  //
  // WARP-1269 (T17): `?space=`/body `space` threading for department/household
  // content. Personal shares (no space, or `space: "personal"`) are
  // COMPLETELY UNTOUCHED — same caller-token OCS call, same response, same
  // audit row shape as before this ticket. A dept/household space requires
  // `manager` right (requireSpaceAccess below) and, once past the gate, the
  // OCS share is minted with the NC ADMIN credential (department members
  // other than the manager themselves are not necessarily NC users with
  // sharing rights on the groupfolder-mounted path) — never the caller's own
  // token for that branch. On OCS success a `DepartmentShare` registry row is
  // written for authz/audit on later PUT/DELETE and the "shared by me" list;
  // on OCS failure no row is written and the error surfaces honestly.
  // WARP-1456: requireRoleOrMcpService so the share_file LLM tool (Tier-2,
  // handler-enforced confirmation) can dispatch here as `_service:mcp`. The
  // NC identity still comes from getToken(req) — for the service principal
  // that is the X-Nextcloud-Token header per the WARP-861 idiom (no header →
  // 401, no admin fallback). Human role set unchanged.
  router.post(
    "/files/share",
    requireRoleOrMcpService("owner", "admin", "family"),
    requireSpaceAccess(prisma, "manager", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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

      // WARP-938 (security): same traversal guard the other space-threaded
      // write routes apply BEFORE the space prefix goes on — doubly
      // important here since the dept branch below mints the share with the
      // NC ADMIN credential, so a `..` escape would be a privilege
      // escalation, not just a wrong-folder mistake.
      if (!isSafeUserPath(parsed.data.path)) {
        res.status(400).json({ error: "path must not contain '..' segments" });
        return;
      }

      const space = resolveSpace(spaceQueryOrBody(req));
      const targetPath = await rootForSpace(prisma, space, parsed.data.path);
      const departmentId = req.spaceDepartmentId ?? null;
      const shareToken = departmentId ? adminBasicToken() : await getToken(req);

      const share = await ncCreateShareV2(shareToken, targetPath, {
        shareType: parsed.data.shareType,
        permissions: parsed.data.permissions,
        expireDate: parsed.data.expireDate,
        password: parsed.data.password,
        note: parsed.data.note,
        shareWith: parsed.data.shareWith,
      });

      if (departmentId) {
        await prisma.departmentShare.create({
          data: {
            departmentId,
            ncShareId: share.id,
            createdById: req.user!.id,
            shareType: parsed.data.shareType,
            path: parsed.data.path,
          },
        });
      }

      // WARP-237: share creation is a mandatory-emit privileged action.
      // NEVER put the share password in refs.
      await recordActivity({
        kind: "file",
        severity: "ok",
        sourceIcon: "share-2",
        what: "Share created",
        sub: parsed.data.path,
        refs: {
          path: parsed.data.path,
          shareType: parsed.data.shareType,
          permissions: parsed.data.permissions,
          shareWith: parsed.data.shareWith ?? null,
          expireDate: parsed.data.expireDate ?? null,
          passwordProtected: parsed.data.password !== undefined,
          departmentId: departmentId ?? null,
        },
        actor: actorFromRequest(req),
      });

      // WARP-941 — person shares (shareType 0) notify the recipient by email,
      // best-effort. Fire-and-forget: notifyPersonShareByEmail never throws,
      // and nothing about mail may fail or delay this response — the share
      // already exists in Nextcloud. Link shares (shareType 3) deliberately
      // send nothing: no recipient, no lookup, no dial.
      if (parsed.data.shareType === 0 && parsed.data.shareWith) {
        void notifyPersonShareByEmail(req, parsed.data.shareWith, parsed.data.path);
      }

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

  /**
   * WARP-1262 (T10): resolve + gate ONE side of a cross-space move/copy —
   * shared by both routes below so the resolve-then-check sequence (and
   * its `recordAccessDenied` audit trail) has exactly one implementation.
   * Writes the 403 response and returns `{ ok: false }` on denial; callers
   * MUST stop processing when this returns `ok: false` (the response is
   * already sent).
   */
  async function checkCrossSpaceSide(
    req: Request,
    res: Response,
    caller: SpaceAccessCaller,
    rawSpace: unknown,
    minRight: DepartmentRight,
  ): Promise<{ ok: true; departmentId: string | null } | { ok: false }> {
    // WARP-1262 (fix): translate the legacy WS-5 "shared" literal to the gate's
    // "household" token BEFORE resolving — exactly as resolveSpaceGuardToken
    // does for every single-space write route. `resolveRawSpaceToDepartmentId`
    // → parseSpaceValue only recognizes "household", so a raw "shared" (the
    // canonical id the rest of the app — resolveSpace(), the dashboard's
    // FileSpaceId, move/copy fromSpace/toSpace — actually produces for that
    // space) would otherwise fall through to `malformed` and 403 a legitimate
    // Household move/copy. Anything else passes through unchanged so a truly
    // malformed value still fails closed.
    const guardSpace = rawSpace === "shared" ? "household" : rawSpace;
    const resolved = await resolveRawSpaceToDepartmentId(prisma, guardSpace);
    if (!resolved.ok) {
      recordAccessDenied(req, resolved.reason);
      res.status(403).json({ error: resolved.error });
      return { ok: false };
    }
    const check = await checkSpaceAccess(prisma, req, caller, resolved.departmentId, minRight);
    if (!check.allowed) {
      res.status(check.status).json({ error: check.error });
      return { ok: false };
    }
    return { ok: true, departmentId: check.departmentId };
  }

  /**
   * Invalidate listing caches for the parents of the given targets (source +
   * destination).
   *
   * WARP-1610: each target carries its OWN space, so the space is resolved PER
   * PATH rather than once per request. That is what a cross-space move needs —
   * `POST /files/move` is the one call site that passes `from` and `to` in
   * different spaces, and a single per-request space could only ever name one
   * of the two sides correctly, silently leaving the other side's entry live
   * for the rest of the TTL.
   *
   * Dedupe is on the (space, parent) PAIR, never on the parent string alone: a
   * cross-space move between a personal `/Alpha` and department Alpha's
   * `/Alpha` has one parent string and two distinct cache entries, and a
   * `Set<string>` of parents would collapse them and drop only one.
   */
  async function invalidateParents(
    req: Request,
    user: string,
    ...targets: SpacedPath[]
  ): Promise<void> {
    const parents = new Map<string, SpacedPath>();
    for (const target of targets) {
      const parent = path.posix.dirname(target.path) || "/";
      // NUL separator: no space token or path segment can contain it, so the
      // composite key can't alias two different (space, parent) pairs.
      parents.set(`${target.space}\u0000${parent}`, { space: target.space, path: parent });
    }
    for (const parent of parents.values()) {
      await invalidateListing(req, user, parent);
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
  // WARP-1262 (T10): `?space=`/body `space` threading — rename stays a
  // single-space op (same-dir), gated `contributor` like the other
  // write-within-a-space verbs.
  router.post(
    "/files/rename",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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
      const space = resolveSpace(spaceQueryOrBody(req));
      const filePath = await rootForSpace(prisma, space, parsed.data.path);
      const { newName } = parsed.data;
      const parentDir = path.posix.dirname(filePath) || "/";
      const newPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`;

      const user = getUser(req);
      await ncMoveFile(await getToken(req), user, filePath, newPath, false);

      await invalidateParents(req, user, { space, path: filePath });
      safePublish(`droplet/files/${user}/renamed`, { from: filePath, to: newPath });
      res.json({ renamed: { from: filePath, to: newPath } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Move (POST /api/files/move) ──
  //
  // WARP-1262 (T10): cross-space DUAL-CHECK. `fromSpace`/`toSpace` each
  // default independently to personal (no implicit "same as the other
  // side" fallback — an omitted `?space=`/body-space pair must behave
  // exactly like the pre-T10 personal-only route, brief §3.1). Move
  // deletes the source, so the source side needs `contributor` (not
  // `reader` — see the copy route below for the asymmetry); the target
  // side always needs `contributor`. Each side is resolved + checked
  // independently via `resolveRawSpaceToDepartmentId` + `checkSpaceAccess`
  // (the same primitives `requireSpaceAccess` composes) since a single
  // route can't be gated by ONE space token here.
  router.post("/files/move", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
        fromSpace: z.string().optional(),
        toSpace: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid move request", details: parsed.error.flatten() });
        return;
      }
      const { from: rawFrom, to: rawTo, overwrite, fromSpace: rawFromSpace, toSpace: rawToSpace } = parsed.data;

      const role = req.user?.role;
      const userId = req.user?.id;
      if (typeof role !== "string" || !role || typeof userId !== "string" || !userId) {
        recordAccessDenied(req, "space-no-session");
        res.status(403).json({ error: "Forbidden: no session" });
        return;
      }
      const caller: SpaceAccessCaller = { id: userId, role };

      // Move deletes the source — contributor required on BOTH sides.
      const fromResult = await checkCrossSpaceSide(req, res, caller, rawFromSpace, "contributor");
      if (!fromResult.ok) return;
      const toResult = await checkCrossSpaceSide(req, res, caller, rawToSpace, "contributor");
      if (!toResult.ok) return;

      const fromSpaceValue = resolveSpace(rawFromSpace);
      const toSpaceValue = resolveSpace(rawToSpace);
      const from = await rootForSpace(prisma, fromSpaceValue, rawFrom);
      const to = await rootForSpace(prisma, toSpaceValue, rawTo);

      const user = getUser(req);
      await ncMoveFile(await getToken(req), user, from, to, overwrite);

      // WARP-1610: the cross-space case. `from` and `to` can be in
      // DIFFERENT spaces, and their resolved paths can even be the same
      // string (personal `/Alpha` ↔ department Alpha's `/Alpha`) — each
      // side must name its own key, so each carries its own space.
      await invalidateParents(
        req,
        user,
        { space: fromSpaceValue, path: from },
        { space: toSpaceValue, path: to },
      );
      safePublish(`droplet/files/${user}/moved`, { from, to });
      res.json({ moved: { from, to } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Copy (POST /api/files/copy) ──
  //
  // WARP-1262 (T10): cross-space DUAL-CHECK, same shape as move — but copy
  // does NOT delete the source, so the source side only needs `reader`;
  // the target side still needs `contributor`. This asymmetry is the
  // whole point of the ticket's dual-check requirement: a reader on dept A
  // may copy INTO dept A content they can write to, without needing
  // contributor rights on a source they're only reading from.
  router.post("/files/copy", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().default(false),
        fromSpace: z.string().optional(),
        toSpace: z.string().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid copy request", details: parsed.error.flatten() });
        return;
      }
      const { from: rawFrom, to: rawTo, overwrite, fromSpace: rawFromSpace, toSpace: rawToSpace } = parsed.data;

      const role = req.user?.role;
      const userId = req.user?.id;
      if (typeof role !== "string" || !role || typeof userId !== "string" || !userId) {
        recordAccessDenied(req, "space-no-session");
        res.status(403).json({ error: "Forbidden: no session" });
        return;
      }
      const caller: SpaceAccessCaller = { id: userId, role };

      // Copy doesn't delete the source — only reader required there; the
      // target is written to, so contributor required there.
      const fromResult = await checkCrossSpaceSide(req, res, caller, rawFromSpace, "reader");
      if (!fromResult.ok) return;
      const toResult = await checkCrossSpaceSide(req, res, caller, rawToSpace, "contributor");
      if (!toResult.ok) return;

      const fromSpaceValue = resolveSpace(rawFromSpace);
      const toSpaceValue = resolveSpace(rawToSpace);
      const from = await rootForSpace(prisma, fromSpaceValue, rawFrom);
      const to = await rootForSpace(prisma, toSpaceValue, rawTo);

      const user = getUser(req);
      await ncCopyFile(await getToken(req), user, from, to, overwrite);

      await invalidateParents(req, user, { space: toSpaceValue, path: to });
      safePublish(`droplet/files/${user}/copied`, { from, to });
      res.json({ copied: { from, to } });
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  // ── Bulk delete (POST /api/files/bulk-delete) ──
  // WARP-1262 (T10): bulk ops act on a SINGLE space (the dashboard's
  // multi-select lives inside one space view) — `?space=`/body `space`
  // threading, every path in the batch resolved under the same space.
  router.post(
    "/files/bulk-delete",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
    try {
      const schema = z.object({ paths: z.array(z.string().min(1)).min(1).max(200) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid bulk-delete request" });
        return;
      }
      const space = resolveSpace(spaceQueryOrBody(req));
      const paths = await Promise.all(
        parsed.data.paths.map((p) => rootForSpace(prisma, space, p)),
      );
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

      await invalidateParents(req, user, ...paths.map((p) => ({ space, path: p })));
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
  // WARP-1262 (T10): single-space threading (see bulk-delete above).
  router.post(
    "/files/bulk-move",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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
      const space = resolveSpace(spaceQueryOrBody(req));
      const paths = await Promise.all(
        parsed.data.paths.map((p) => rootForSpace(prisma, space, p)),
      );
      const toDirResolved = await rootForSpace(prisma, space, parsed.data.toDir);
      const { overwrite } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);
      const normalizedDir = toDirResolved.replace(/\/+$/, "") || "/";

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

      await invalidateParents(
        req,
        user,
        ...paths.map((p) => ({ space, path: p })),
        { space, path: normalizedDir + "/_" },
      );
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
  // WARP-1262 (T10): single-space threading (see bulk-delete above).
  router.post(
    "/files/bulk-copy",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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
      const space = resolveSpace(spaceQueryOrBody(req));
      const paths = await Promise.all(
        parsed.data.paths.map((p) => rootForSpace(prisma, space, p)),
      );
      const toDirResolved = await rootForSpace(prisma, space, parsed.data.toDir);
      const { overwrite } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);
      const normalizedDir = toDirResolved.replace(/\/+$/, "") || "/";

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

      await invalidateParents(req, user, { space, path: normalizedDir + "/_" });
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
  //
  // WARP-1262 (T10): `?space=`/body `space` threading. NC's trashbin is a
  // flat per-user WebDAV area keyed by trash-assigned filename (not a
  // space-relative path) — `ncRestoreTrashItem`/`ncDeleteTrashItem`/
  // `ncEmptyTrash` restore to/purge from the ORIGINAL location automatically
  // and take no path argument to resolve, so there's nothing for
  // `rootForSpace` to do here. The gate still runs (contributor required)
  // so a caller can't purge/restore dept trash without dept write rights;
  // an omitted `space` defaults to personal, unchanged from pre-T10.
  router.post(
    "/files/trash/restore",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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
  // WARP-1262 (T10): `?space=` threading (see trash/restore above).
  router.delete(
    "/files/trash/item",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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
  // WARP-1262 (T10): `?space=` threading (see trash/restore above).
  router.delete(
    "/files/trash",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
    try {
      const user = getUser(req);
      await ncEmptyTrash(await getToken(req), user);
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
  // WARP-1262 (T10): `?space=`/body `space` threading, contributor gate.
  // WARP-1456: requireRoleOrMcpService so the restore_file_version LLM tool
  // (Tier-2, handler-enforced confirmation) can dispatch here as
  // `_service:mcp`. The NC identity still comes from getUser(req)/getToken(req)
  // — for the service principal those are the X-Nextcloud-User/-Token headers
  // per the WARP-861 idiom (missing either → 401, no admin fallback). Human
  // role set unchanged.
  router.post(
    "/files/versions/restore",
    requireRoleOrMcpService("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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
      const space = resolveSpace(spaceQueryOrBody(req));
      const filePath = await rootForSpace(prisma, space, parsed.data.path);
      const { versionId } = parsed.data;
      const user = getUser(req);
      const token = await getToken(req);

      const fileId = await ncGetFileId(token, user, filePath);
      if (fileId === null) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      await ncRestoreVersion(token, user, fileId, versionId);

      await invalidateParents(req, user, { space, path: filePath });
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
  //
  // WARP-1556: favorites / recents / name-search are all fed by a Nextcloud
  // query scoped to the caller's HOME, and every active department/team
  // groupfolder is mounted inside that home (the very reason
  // `activeDeptMountNames` exists). So all three can return cross-space file
  // names and paths, and all three used to be keyed per-user with no
  // membership dimension. Each key below now goes through `aclScopedKey`.
  const FAVORITES_CACHE_PREFIX = "files:favorites:";
  const RECENTS_CACHE_PREFIX = "files:recents:";
  const SEARCH_CACHE_PREFIX = "files:search:";
  const FAVORITES_TTL = 15;
  const RECENTS_TTL = 15;
  const SEARCH_TTL = 5;

  // ── Favorite toggle (POST /api/files/favorite) ──
  // WARP-1262 (T10): `?space=`/body `space` threading, contributor gate.
  router.post(
    "/files/favorite",
    requireRole("owner", "admin", "family"),
    requireSpaceAccess(prisma, "contributor", { resolveSpace: resolveSpaceGuardToken }),
    async (req, res, next) => {
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
      const space = resolveSpace(spaceQueryOrBody(req));
      const filePath = await rootForSpace(prisma, space, parsed.data.path);
      const { favorite } = parsed.data;
      const user = getUser(req);
      await ncSetFavorite(await getToken(req), user, filePath, favorite);
      // WARP-1556: the read key is ACL-scoped, so the invalidation must be
      // too. An unresolved tag means we can't name the entry — skip the del
      // (the entry self-expires in FAVORITES_TTL seconds; the worst case is a
      // briefly stale star, never a disclosure).
      const favKey = await aclScopedKey(req, FAVORITES_CACHE_PREFIX, user);
      if (favKey) await cacheDel(favKey);
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
      const cacheKey = await aclScopedKey(req, FAVORITES_CACHE_PREFIX, user);
      if (cacheKey) {
        const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
        if (cached) {
          res.json({ items: cached });
          return;
        }
      }
      const items = await ncListFavorites(await getToken(req), user);
      if (cacheKey) await cacheSet(cacheKey, items, FAVORITES_TTL);
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
      const cacheKey = await aclScopedKey(
        req,
        RECENTS_CACHE_PREFIX,
        user,
        String(limit),
      );
      if (cacheKey) {
        const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
        if (cached) {
          res.json({ items: cached });
          return;
        }
      }
      const items = await ncListRecents(await getToken(req), user, limit);
      if (cacheKey) await cacheSet(cacheKey, items, RECENTS_TTL);
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
      const cacheKey = await aclScopedKey(
        req,
        SEARCH_CACHE_PREFIX,
        user,
        q,
        mime ?? "",
        String(limit),
      );
      if (cacheKey) {
        const cached = await cacheGet<FileEntryInfo[]>(cacheKey);
        if (cached) {
          res.json({ items: cached });
          return;
        }
      }
      const items = await ncSearchFiles(await getToken(req), user, {
        query: q,
        mime,
        limit,
      });
      if (cacheKey) await cacheSet(cacheKey, items, SEARCH_TTL);
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

  /**
   * WARP-1269 (T17): shared PUT/DELETE authz + credential resolution for
   * `/files/share/:id`. A `shareId` with a `DepartmentShare` registry row
   * was minted with the ADMIN credential (the manager-share path above) —
   * mutating it must use that same credential, and the caller must be
   * either the row's creator, an owner/admin, or a manager (own- or
   * parent-department, via `departmentManagerOrAdmin`) of that department.
   * A `shareId` with NO registry row is an ordinary personal share:
   * completely unchanged from pre-T17 behavior — the caller's own token,
   * no extra authz beyond the existing `requireRole` gate.
   *
   * On denial this writes the 403 response itself (audited via
   * `recordAccessDenied`, matching the space-middleware convention) and
   * returns `{ ok: false }`; callers MUST stop processing.
   */
  async function resolveShareMutationAuth(
    req: Request,
    res: Response,
    shareId: number
  ): Promise<
    | { ok: true; token: string; deptRow: { departmentId: string } | null }
    | { ok: false }
  > {
    const deptRow = await prisma.departmentShare.findUnique({
      where: { ncShareId: shareId },
      select: { departmentId: true, createdById: true },
    });
    if (!deptRow) {
      return { ok: true, token: await getToken(req), deptRow: null };
    }

    const caller = req.user;
    if (!caller) {
      recordAccessDenied(req, "share-no-session");
      res.status(403).json({ error: "Forbidden: no session" });
      return { ok: false };
    }

    const isCreator = deptRow.createdById === caller.id;
    const isPrivileged =
      isCreator ||
      caller.role === "owner" ||
      caller.role === "admin" ||
      (await departmentManagerOrAdmin(prisma, deptRow.departmentId, caller));
    if (!isPrivileged) {
      recordAccessDenied(req, "share-not-authorized");
      res.status(403).json({ error: "Forbidden: not authorized to modify this share" });
      return { ok: false };
    }

    return { ok: true, token: adminBasicToken(), deptRow: { departmentId: deptRow.departmentId } };
  }

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

      const auth = await resolveShareMutationAuth(req, res, shareId);
      if (!auth.ok) return;
      const { token } = auth;

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

      const auth = await resolveShareMutationAuth(req, res, shareId);
      if (!auth.ok) return;
      const { token, deptRow } = auth;

      await ncDeleteShare(token, shareId);

      if (deptRow) {
        // WARP-1269 (T17): keep the row for audit/"shared by me" history —
        // revoke, don't delete.
        await prisma.departmentShare.update({
          where: { ncShareId: shareId },
          data: { revokedAt: new Date() },
        });
        await recordActivity({
          kind: "file",
          severity: "info",
          sourceIcon: "share-2",
          what: "Share revoked",
          sub: String(shareId),
          refs: { shareId, departmentId: deptRow.departmentId },
          actor: actorFromRequest(req),
        });
      }

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

  // ── Shares I created (GET /api/files/shares-by-me) ── (WARP-941)
  //
  // Outbound counterpart of /files/shared-with-me, backing the dashboard's
  // "Shared by me" tab (previously a hardcoded placeholder). Nextcloud scopes
  // the un-filtered OCS shares listing to shares the authenticated user owns,
  // so the caller's own NC token is the only scoping needed — same session
  // gating as the sibling route. Same degrade contract too: an unreachable
  // Nextcloud serves an empty list rather than a 500 so the Shared page
  // still renders during an outage.
  router.get("/files/shares-by-me", async (req, res, next) => {
    try {
      const shares = await ncListOutboundShares(await getToken(req));
      res.json({ shares });
    } catch (err) {
      handleFileError(err, res, next, { shares: [] });
    }
  });

  // ── Shared-by-me outbox (GET /api/files/shared-by-me) ──
  //
  // WARP-1269 (T17): personal shares the caller owns (OCS, caller's own
  // token, no path filter) UNION the caller's non-revoked `DepartmentShare`
  // registry rows (admin-minted manager shares), each rehydrated to the same
  // `ShareDetail` wire shape via the admin credential — the registry row
  // itself only carries the id/department/audit fields, not live share
  // state (permissions/expiry/password), so live OCS state is the source of
  // truth for what's rendered. A department share whose live OCS record is
  // gone (deleted directly in Nextcloud, out of band) is silently dropped
  // rather than surfaced as a broken row.
  router.get("/files/shared-by-me", async (req, res, next) => {
    try {
      const callerId = req.user?.id ?? "";
      const [personalShares, deptRows] = await Promise.all([
        ncListMyShares(await getToken(req)),
        callerId
          ? prisma.departmentShare.findMany({
              where: { createdById: callerId, revokedAt: null },
              select: { ncShareId: true },
            })
          : Promise.resolve([]),
      ]);

      const deptShares: ShareDetail[] = [];
      for (const row of deptRows) {
        const detail = await ncGetShare(adminBasicToken(), row.ncShareId);
        if (detail) deptShares.push(detail);
      }

      res.json({ shares: [...personalShares, ...deptShares] });
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
            // WARP-233: decrypt the at-rest dcv1 blob for display.
            email: readUserEmail(u.email),
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

      // WARP-1264: which chunk corpora this user may search — their own,
      // plus one sentinel per ACTIVE department they're visible into
      // (owner/admin see all). Best-effort (personal-only on any lookup
      // failure) so this never introduces a new failure mode into search.
      const { corpora: searchUserIds, aclVersion } = await deptSearchCorpora(
        req,
        prisma,
        user,
      );
      const additionalUserIds = searchUserIds.slice(1);

      // Check Redis cache first (60s TTL on identical queries). The mode is
      // part of the key so keyword/semantic/hybrid results never collide.
      // WARP-1264: the corpus list AND the max aclVersion across the
      // caller's visible departments are part of the key, so neither a
      // membership change nor a rights change on an unchanged corpus set
      // can ever serve a stale cached result.
      const cacheKey = `filesearch:${mode}:v${aclVersion}:${searchUserIds.join(",")}:${q}:${limit}`;
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
        // Two arms:
        //   1. lexical CONTENT match over FileContentChunk.text_tsv
        //   2. Nextcloud NAME match (%substring% on display name)
        // WARP-940: the AC is "files whose name and/or content contain the
        // term", but keyword used to run arm 1 only — so a partial term like
        // "const" never surfaced a file named "Construction…", even though
        // the Name-mode endpoint (same ncSearchFiles) finds it fine.
        const contentHits = await searchByLexical(prisma, {
          userId: user,
          additionalUserIds,
          query: q,
          limit: limit * CHUNKS_PER_FILE_FACTOR,
          source: "nextcloud",
        });
        const contentResults = dedupeHitsPerFile(contentHits, limit);

        // Arm 2 is a best-effort enhancement. Skip it entirely when the
        // content arm already filled the page — the union would discard every
        // name hit anyway, so firing a WebDAV SEARCH there is pure waste.
        //
        // The name arm hits Nextcloud (WebDAV), a SEPARATE dependency from
        // the AI gateway. Keyword's "works gateway-down" promise is about the
        // AI stack, so a Nextcloud OUTAGE on this arm must NOT fail the
        // request — it degrades to content-only. An AUTH failure (missing /
        // expired NC session) is different: it is not an outage, so resolve
        // the token OUTSIDE the best-effort catch and let a
        // MissingNcTokenError propagate (→ 401) instead of masking a re-login
        // prompt as a degraded 200.
        let nameDegraded = false;
        let nameResults: Array<{ path: string; score: number; text: string }> =
          [];
        if (contentResults.length < limit) {
          const token = await getToken(req); // auth failure → 401, not degrade
          try {
            const nameFiles = await ncSearchFiles(token, user, {
              query: q,
              // Over-fetch like the content arm: parseMultiStatus sorts
              // directories first and nameHitsToResults drops them, so a
              // directory-heavy match needs headroom to yield `limit` files.
              limit: limit * CHUNKS_PER_FILE_FACTOR,
            });
            nameResults = nameHitsToResults(nameFiles);
          } catch (nameErr) {
            // Nextcloud unreachable on the name arm: log + degrade to
            // content-only, and flag so we DON'T persist the degraded union.
            nameDegraded = true;
            logger.warn(
              { err: nameErr },
              "keyword search: name arm failed; returning content-only",
            );
          }
        }

        const results = unionContentAndNameHits(
          contentResults,
          nameResults,
          limit,
        );
        // Only cache a COMPLETE result set. A degraded (content-only) union
        // must not be written to the 60s cache, or it would keep serving the
        // stale, partial result for up to 60s after Nextcloud recovers.
        if (!nameDegraded) {
          await cacheSet(cacheKey, results, 60);
        }
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
          additionalUserIds,
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
      //
      // WARP-1140: pin the corpus to source='nextcloud' so semantic searches
      // the SAME corpus as keyword/hybrid. The unfiltered query also matched
      // brain-memory chunks (chat attachments), whose paths aren't navigable
      // from the Files page AND which all share ncFileId=0 — so DISTINCT ON
      // ("ncFileId") collapsed every brain chunk into one bogus result row.
      // The userId list mirrors the other modes (own + Household corpus).
      const vecLiteral = `[${embedVec.join(",")}]`;
      const userIdPlaceholders = searchUserIds
        .map((_, i) => `$${i + 2}`)
        .join(", ");
      const limitParam = searchUserIds.length + 2;
      const rows: Array<{ path: string; score: number; text: string }> =
        await prisma.$queryRawUnsafe(
          `
          SELECT path, score, text FROM (
            SELECT DISTINCT ON ("ncFileId")
              "path",
              1 - ("embedding" <=> $1::vector) AS score,
              "text"
            FROM "FileContentChunk"
            WHERE "userId" IN (${userIdPlaceholders})
              AND "source" = 'nextcloud'
            ORDER BY "ncFileId", "embedding" <=> $1::vector
          ) ranked
          ORDER BY score DESC
          LIMIT $${limitParam}
          `,
          vecLiteral,
          ...searchUserIds,
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
      // WARP-1264: same corpus rule as content search — own chunks plus one
      // sentinel per ACTIVE department the caller is visible into
      // (owner/admin see all, an audited see-all consistent with
      // `checkSpaceAccess`).
      const { corpora: searchUserIds } = await deptSearchCorpora(req, prisma, user);

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
      const userIdPlaceholders = searchUserIds
        .map((_, i) => `$${i + 1}`)
        .join(", ");
      try {
        const rows: Array<{ count: bigint; last: Date | null }> =
          await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::bigint AS count, MAX("indexedAt") AS last ' +
              `FROM "FileContentChunk" WHERE "userId" IN (${userIdPlaceholders})`,
            ...searchUserIds,
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

      // WARP-1140: explicit per-file indexer state (FileIndexStatus, written
      // by the file-indexer — the WARP-218 "no guessing" convention). The
      // dashboard uses `pendingCount` to render an honest "still indexing"
      // empty state instead of "no match". Own try/catch: a deployment where
      // the migration hasn't run yet must not break the probe.
      let pendingCount = 0;
      let failedCount = 0;
      try {
        const statusRows: Array<{ status: string; count: bigint }> =
          await prisma.$queryRawUnsafe(
            'SELECT status::text AS status, COUNT(*)::bigint AS count ' +
              `FROM "FileIndexStatus" WHERE "userId" IN (${userIdPlaceholders}) ` +
              "GROUP BY status",
            ...searchUserIds,
          );
        for (const row of statusRows) {
          if (row.status === "indexing") pendingCount = Number(row.count);
          if (row.status === "failed") failedCount = Number(row.count);
        }
      } catch (err) {
        logger.warn({ err }, "search/status: FileIndexStatus probe failed");
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
        pendingCount,
        failedCount,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/files/:id/content — inline content for the citation viewers ──
  //
  // `apps/web-dashboard/src/components/citations/PdfCitation.tsx` and
  // `MediaCitation.tsx` both load their preview from
  // `/api/files/${encodeURIComponent(hit.fileId)}/content` (PDFs append the
  // `#page=N` fragment). `hit.fileId` is polymorphic — the producers set it to
  // a numeric Nextcloud file id, a "/"-prefixed home-relative path, or a
  // brain-memory item id (`SearchTab.tsx`: `hit.ncFileId ? String(hit.ncFileId)
  // : hit.path`; `ChatMessage.tsx`: `c.brainItemId ? String(c.brainItemId) :
  // c.path`) — so `classifyFileContentId` dispatches on shape.
  //
  // Served INLINE (never as an attachment) with a best-effort Content-Type and
  // HTTP Range support, so `<iframe>`/`<video>` can render and seek.
  //
  // Registered LAST so the static sibling routes above (`/files/search/content`
  // in particular, which `:id` would otherwise shadow) keep winning.
  router.get("/files/:id/content", async (req, res, next) => {
    try {
      const classified = classifyFileContentId(req.params.id);

      // ── Brain-memory item: original bytes on local disk ──
      // Ownership + zip-slip posture mirrors
      // `GET /api/files/brain/:itemId/download` in files-brain.ts: the owner
      // key is `req.user.id` (what BrainMemoryItem.userId stores), a
      // cross-user hit 404s rather than 403s (no existence leak), and a
      // storagePath outside the user's tree is refused, never served.
      if (classified.kind === "brain") {
        const userId = (req as Request & { user?: { id?: string } }).user?.id;
        if (!userId) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const item = await prisma.brainMemoryItem.findUnique({
          where: { id: classified.itemId },
        });
        if (
          !item ||
          item.userId !== userId ||
          !item.storagePath ||
          !isPathUnderUser(userId, item.storagePath)
        ) {
          res.status(404).json({ error: "not_found" });
          return;
        }

        let size: number;
        try {
          size = (await stat(item.storagePath)).size;
        } catch {
          res.status(404).json({ error: "not_found" });
          return;
        }

        res.setHeader(
          "Content-Type",
          item.mimeType ?? contentTypeForFilename(item.filename),
        );
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Accept-Ranges", "bytes");

        const range = parseRangeHeader(req.header("range"), size);
        if (range && "unsatisfiable" in range) {
          res.setHeader("Content-Range", `bytes */${size}`);
          res.status(416).end();
          return;
        }
        if (range) {
          res.status(206);
          res.setHeader(
            "Content-Range",
            `bytes ${range.start}-${range.end}/${size}`,
          );
          res.setHeader("Content-Length", String(range.end - range.start + 1));
          createReadStream(item.storagePath, {
            start: range.start,
            end: range.end,
          }).pipe(res);
        } else {
          res.setHeader("Content-Length", String(size));
          createReadStream(item.storagePath).pipe(res);
        }
        return;
      }

      // ── Nextcloud-backed: a numeric ncFileId (resolve to a path via the
      // content index) or an already-explicit path. Authorization is the
      // caller's own NC token against the caller's own home — a path lifted
      // from someone else's index simply doesn't resolve there.
      let ncPath: string | null;
      if (classified.kind === "ncfile") {
        const chunk = await prisma.fileContentChunk.findFirst({
          where: { ncFileId: classified.ncFileId },
          select: { path: true },
        });
        ncPath = chunk?.path ?? null;
      } else {
        ncPath = classified.path;
      }
      if (!ncPath) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const upstream = await ncFetchFileResponse(
        await getToken(req),
        getUser(req),
        ncPath,
        req.header("range"),
      );
      if (!upstream) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      // 200, or 206/416 when WebDAV ruled on the forwarded Range.
      res.status(upstream.status);
      res.setHeader(
        "Content-Type",
        contentTypeForFilename(path.basename(ncPath)),
      );
      res.setHeader("Content-Disposition", "inline");
      res.setHeader(
        "Accept-Ranges",
        upstream.headers.get("accept-ranges") ?? "bytes",
      );
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) res.setHeader("Content-Range", contentRange);
      const contentLength = upstream.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);

      if (!upstream.body) {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body as never).pipe(res);
    } catch (err) {
      handleFileError(err, res, next);
    }
  });

  return router;
}
