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

import { createRequireRecentMfa } from "../middleware/require-recent-mfa.js";
import {
  INDEX_IN_PROGRESS,
  reindexFile,
} from "../services/file-reindex.service.js";

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
