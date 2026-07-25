/**
 * WARP-287 — admin re-index route.
 *
 *   POST /api/admin/files/:id/reindex
 *
 * Forces re-extraction of a single file. Used to upgrade legacy chunks
 * (no `metadata.anchor`) to anchored ones without a global backfill, or
 * to recover after an extractor fix.
 *
 * Errors:
 *   401 auth_required       — no req.user
 *   403 admin_required      — non-admin user
 *   401 mfa_required/stale  — admin without recent MFA
 *   409 index_in_progress   — another reindex is already running
 *   500 reindex_failed      — extractor / DB failure (rolled back)
 *
 * The `requireAdmin` middleware runs before `createRequireRecentMfa()`
 * so a non-admin caller is rejected with 403 before we leak the MFA
 * stamp expectation — admin is the cheaper-to-check authoritative gate.
 *
 * Prisma is held by `file-reindex.service` via `setPrismaForReindex`,
 * called from `createApp(prisma)`. The router itself is a module-level
 * constant so route-table introspection (and the spec-shaped import
 * `import { adminFilesRouter } from "./admin-files"`) works.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { PrismaClient } from "@prisma/client";

import { createRequireRecentMfa } from "../middleware/require-recent-mfa.js";
import { requireRole } from "../middleware/auth.js";
import {
  INDEX_IN_PROGRESS,
  reindexFile,
} from "../services/file-reindex.service.js";
import { ncGetUserQuotaAdmin } from "../services/nextcloud.client.js";
import { gfListFolders } from "../services/nextcloud-groups.client.js";
import { adminBasicToken } from "../services/department-provisioner.service.js";
import {
  resolveEffectiveUsage,
  type EffectiveUsageSource,
} from "../services/effective-usage.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("admin-files-usage-route");

// Match the same admin-role spelling used by admin-device-identity.
// "owner" is the canonical top-level role in this codebase; "admin" is
// the spec-mandated role. Accept both so legacy owner accounts retain
// the surface without a role rename.
const ADMIN_ROLES = new Set(["admin", "owner"]);

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { user?: { role?: string } }).user;
  if (!user) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  if (!user.role || !ADMIN_ROLES.has(user.role)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  next();
}

export const adminFilesRouter = Router();
const requireMfa = createRequireRecentMfa();

adminFilesRouter.post(
  "/files/:id/reindex",
  requireAdmin,
  requireMfa,
  async (req: Request, res: Response) => {
    const user = (req as unknown as { user: { id: string } }).user;
    const fileId = req.params.id;
    try {
      const result = await reindexFile({ fileId, actor: user.id });
      res.json({ fileId, chunksWritten: result.chunksWritten });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === INDEX_IN_PROGRESS) {
        res.status(409).json({
          error: "index_in_progress",
          message: "indexing in progress, try again in a moment",
        });
        return;
      }
      console.error("admin_reindex.failed", { fileId, error: e.message });
      res.status(500).json({
        error: "reindex_failed",
        message: e.message,
      });
    }
  },
);

/**
 * WARP-1271 (T19a) — admin usage roster.
 *
 *   GET /api/admin/files/usage
 *
 * Per-user rows via `ncGetUserQuotaAdmin` (bounded concurrency ~4 —
 * requesting every household member's quota serially would be slow on a
 * large roster; unbounded Promise.all risks hammering NC) with per-user
 * failures rendered as an honest "—" rather than dropping the row or
 * 500ing the whole page. Per-department rows come from `gfListFolders`,
 * which already returns `{size, quota}` per groupfolder (REST) — no
 * separate PROPFIND needed, that reads a single WebDAV path's `oc:size`,
 * whereas groupfolders REST already aggregates the whole folder.
 *
 * Factory-based (unlike the module-level `adminFilesRouter` above)
 * because it needs Prisma — mounted separately at "/api/admin" from
 * app.ts, alongside `adminFilesRouter`.
 */
const ADMIN_USAGE_CONCURRENCY = 4;

interface AdminUsageUserRow {
  userId: string;
  displayName: string;
  /**
   * WARP-1531 (RBAC v2 T7): the EFFECTIVE storage quota. When a person
   * policy or an AccessRole default manages it (`quotaSource` ≠ "default")
   * this is that resolved desired value, BigInt string-encoded — rendered
   * even when the live NC read fails. Unmanaged users keep the pre-1531
   * live-NC semantics: null = unlimited; "—" = read failed.
   */
  quota: string | null;
  /** Provenance of `quota` — additive (WARP-1531). */
  quotaSource: EffectiveUsageSource;
  used: string; // "—" on read failure
  free: string | null; // null = unlimited/unknown; "—" = read failed
  /** WARP-1270 (T18) — the per-user upload cap; WARP-1531: now the
   *  EFFECTIVE value (person override ?? AccessRole default); null =
   *  system default, nothing set on either level. */
  largestUploadMb: number | null;
  /** Provenance of `largestUploadMb` — additive (WARP-1531). */
  largestUploadMbSource: EffectiveUsageSource;
  /**
   * WARP-1270 (T18) — always null today: Droplet has no per-user
   * last-activity timestamp (auth is stateless JWT, no login-audit table
   * yet). Kept as an explicit field (renders "—" client-side, the design
   * brief's sanctioned honest-unknown treatment) rather than inventing a
   * proxy from `User.updatedAt` (which changes on ANY row edit, not
   * activity) or omitting the column and silently diverging from the
   * design packet's roster spec (people usage table: "…largest-upload
   * override, last-active"). Wire to a real source when one exists.
   */
  lastActive: string | null;
}

interface AdminUsageDepartmentRow {
  id: string;
  name: string;
  kind: string;
  sizeBytes: string; // "—" when the groupfolder id isn't discovered yet
  quotaBytes: string | null; // null = unlimited
}

async function fetchUserUsageRow(
  adminToken: string,
  user: {
    id: string;
    displayName: string;
    username: string;
    nextcloudUsername: string | null;
    // C2 (PR #1223 review): storageQuotaBytes is deliberately NON-optional —
    // if a future refactor drops it from the route's findMany select, this
    // param stops compiling instead of silently resolving every
    // person-managed quota to role/default provenance.
    usagePolicy: { storageQuotaBytes: bigint | null; maxUploadSizeMb: number | null } | null;
    accessRole: { storageQuotaBytes: bigint | null; maxUploadSizeMb: number | null } | null;
  },
): Promise<AdminUsageUserRow> {
  const displayName = user.displayName || user.username;
  // WARP-1531: person field ?? AccessRole default ?? box default, per field.
  const effective = resolveEffectiveUsage(user.usagePolicy, user.accessRole);
  const largestUploadMb = effective.maxUploadSizeMb.value;
  const largestUploadMbSource = effective.maxUploadSizeMb.source;
  const quotaSource = effective.storageQuotaBytes.source;
  // Non-null exactly when a person policy or role default manages the quota
  // — then it IS the roster's quota value (desired state, the same value
  // the reconciler converges NC onto). Unmanaged (source "default") keeps
  // the live-NC read as before.
  const managedQuota =
    effective.storageQuotaBytes.value !== null ? effective.storageQuotaBytes.value.toString() : null;
  if (!user.nextcloudUsername) {
    return {
      userId: user.id,
      displayName,
      quota: managedQuota,
      quotaSource,
      used: "—",
      free: null,
      largestUploadMb,
      largestUploadMbSource,
      lastActive: null,
    };
  }
  const quota = await ncGetUserQuotaAdmin(adminToken, user.nextcloudUsername).catch(() => null);
  if (!quota) {
    return {
      userId: user.id,
      displayName,
      quota: managedQuota ?? "—",
      quotaSource,
      used: "—",
      free: "—",
      largestUploadMb,
      largestUploadMbSource,
      lastActive: null,
    };
  }
  return {
    userId: user.id,
    displayName,
    quota: managedQuota ?? (quota.quota !== null ? String(Math.trunc(quota.quota)) : null),
    quotaSource,
    used: String(Math.trunc(quota.used)),
    free: quota.free !== null ? String(Math.trunc(quota.free)) : null,
    largestUploadMb,
    largestUploadMbSource,
    lastActive: null,
  };
}

export function createAdminFilesUsageRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/files/usage",
    requireRole("owner", "admin"),
    async (_req: Request, res: Response) => {
      try {
        const adminToken = adminBasicToken();

        const users = await prisma.user.findMany({
          select: {
            id: true,
            displayName: true,
            username: true,
            nextcloudUsername: true,
            usagePolicy: { select: { storageQuotaBytes: true, maxUploadSizeMb: true } },
            // WARP-1531: role-level usage defaults feed the effective values.
            accessRole: { select: { storageQuotaBytes: true, maxUploadSizeMb: true } },
          },
        });

        const userRows: AdminUsageUserRow[] = [];
        for (let i = 0; i < users.length; i += ADMIN_USAGE_CONCURRENCY) {
          const batch = users.slice(i, i + ADMIN_USAGE_CONCURRENCY);
          const settled = await Promise.all(
            batch.map((u) => fetchUserUsageRow(adminToken, u)),
          );
          userRows.push(...settled);
        }

        const [folders, departments] = await Promise.all([
          gfListFolders(adminToken),
          prisma.department.findMany({
            where: { state: "active" },
            select: { id: true, name: true, kind: true, ncGroupfolderId: true, quotaBytes: true },
          }),
        ]);
        const foldersById = new Map(folders.map((f) => [f.id, f]));

        const departmentRows: AdminUsageDepartmentRow[] = departments.map((d) => {
          const gf = d.ncGroupfolderId !== null ? foldersById.get(d.ncGroupfolderId) : undefined;
          return {
            id: d.id,
            name: d.name,
            kind: d.kind,
            sizeBytes: gf ? String(gf.size) : "—",
            quotaBytes:
              d.quotaBytes !== null
                ? d.quotaBytes.toString()
                : gf && gf.quota !== -3
                  ? String(gf.quota)
                  : null,
          };
        });

        res.json({ users: userRows, departments: departmentRows });
      } catch (err) {
        logger.error({ err }, "GET /api/admin/files/usage failed");
        res.status(500).json({ error: "usage_fetch_failed" });
      }
    },
  );

  return router;
}
