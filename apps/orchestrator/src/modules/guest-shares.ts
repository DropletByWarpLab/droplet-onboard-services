/**
 * WARP-3369 (Romain, 2026-09-30) — the ONE thing an external guest may do inside
 * a module whose tier floor refuses them: act on a record that was explicitly
 * SHARED with them.
 *
 * An external guest gets nothing from company-wide business data, and
 * `requireModuleTierFloor` answers 404 on the whole of `/api/pm` for them. The
 * exception Romain decided: assigning a work item to a guest shares that one
 * item. The guest may read it, read and write its comments, and move its state
 * — and see nothing else in Projects (no other item, no project list, no board,
 * no activity feed, no relations, no search).
 *
 * This file declares only WHICH REQUESTS a guest may get past the prefix floor,
 * by method and path. It is not the authorization: every route listed here
 * carries a per-record guard (`middleware/guest-share.ts`) that answers 404
 * unless the record is assigned to the caller, and
 * `__tests__/guest-work-item-share.test.ts` pins that every path below is served
 * by a route carrying that guard. A request not listed stays 404 for a guest, so
 * a route added under `/api/pm` tomorrow is closed to them until someone opens
 * it here on purpose.
 *
 * Kept apart from the registry and the mounts so the feature gate can read it
 * without importing a router.
 */
import type { ModuleId } from "@prisma/client";
import { normalizeGatePath } from "./module-registry.js";

export interface GuestShare {
  method: "GET" | "POST";
  /** Matched against the lower-cased, trailing-slash-free full path. */
  path: RegExp;
}

const WORK_ITEM = "/api/pm/work-items/[^/]+";

export const GUEST_SHARES: Partial<Record<ModuleId, readonly GuestShare[]>> = {
  projects: [
    // read the item
    { method: "GET", path: new RegExp(`^${WORK_ITEM}$`) },
    // read and write its comments
    { method: "GET", path: new RegExp(`^${WORK_ITEM}/comments$`) },
    { method: "POST", path: new RegExp(`^${WORK_ITEM}/comments$`) },
    // move its state
    { method: "POST", path: new RegExp(`^${WORK_ITEM}/transition$`) },
    // …and the state names to move it to (only for a project holding an item assigned to them)
    { method: "GET", path: /^\/api\/pm\/projects\/[^/]+\/states$/ },
  ],
};

/** Does `moduleId` let a guest past its tier floor for this request? */
export function isGuestShared(moduleId: ModuleId, method: string, fullPath: string): boolean {
  const shares = GUEST_SHARES[moduleId];
  if (!shares) return false;
  const path = normalizeGatePath(fullPath);
  return shares.some((s) => s.method === method && s.path.test(path));
}
