/**
 * WARP-3193 ARCH-9 — the one in-handler "is this caller owner or admin?"
 * predicate, replacing six identical per-route `isAdmin()` copies.
 *
 * Prefer `requireRole("owner", "admin")` for a plain gate. This exists for the
 * routes that cannot use it without changing their contract: a predicate that
 * branches (vpn.ts shows the endpoint host / widens a listing for admins) or
 * a gate whose 403 body the dashboard already keys on.
 */
import type { Request } from "express";

export function isOwnerOrAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}
