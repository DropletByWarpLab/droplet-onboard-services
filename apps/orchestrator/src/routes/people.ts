/**
 * WARP-455 — A1 local user directory + scope bindings + guest time-box.
 *
 * Surface owned by this file:
 *   GET    /api/people                — owner+admin list of local User rows
 *   GET    /api/people/permissions    — role × ability matrix (read-only)
 *   PATCH  /api/people/:id/role       — owner+admin, emits ActivityRow
 *   PATCH  /api/people/:id/scope      — owner+admin, emits ActivityRow
 *   DELETE /api/people/:id            — owner+admin, emits ActivityRow
 *
 * Dependencies (do NOT re-implement):
 *   - `requireRole(...roles)`           — WARP-171, src/middleware/auth.ts
 *   - `recordActivity({ kind, ... })`   — WARP-456, src/services/activity.singleton.ts
 *   - `Role` enum                       — WARP-171, src/services/jwt.service.ts (mirrors Prisma)
 *   - `Scope` enum + `requireScope`     — added by THIS ticket, src/middleware/scope.ts
 *
 * Per the no-guessing rule (CLAUDE.md): the User row carries `role: Role`
 * and the GuestExpiry row carries `status: GuestExpiryStatus` — both
 * explicit Prisma enums, never derived from a nullable column.
 *
 * The local `User` model is ADDITIVE on top of the Nextcloud-OCS auth
 * fallback in middleware/auth.ts — it does not replace OCS-validated
 * sessions. A row in this table represents a person the household has
 * deliberately registered through the dashboard's People surface; the
 * Nextcloud fallback continues to populate `req.user` for legacy
 * sessions that haven't yet been mirrored locally.
 */
export const PEOPLE_SURFACE_DOC_ANCHOR = "WARP-455";
