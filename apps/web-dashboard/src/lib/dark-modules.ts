/**
 * The modules that SHIP DARK, and are ABSENT rather than off.
 *
 * While unavailable the orchestrator does not list such a module at all
 * (`listedWhenUnavailable: false`), so it is missing from `GET /api/modules`
 * instead of present with `effective: false`. Three consequences, all ruled by
 * "ship dark = absent":
 *
 *   · The client's gate reads "not in the payload" as "a module I can't
 *     classify: show it", so that reading is inverted for these ids.
 *   · Its gate fails CLOSED while the probe is unresolved (every other module
 *     fails open, so a blip can never blank a shipping page): nothing about a
 *     dark module — nav entry, page — appears until the module list positively
 *     lists it.
 *   · Off is a plain 404, not the route guard's card. That card says "An owner
 *     or admin can turn it on", which is not true of a module the flag alone
 *     switches on, and it would hint that the product exists. The page calls
 *     `notFound()` itself, because a `notFound()` thrown from the guard (which
 *     sits in the layout, above the segment's boundary) does not reach
 *     `app/not-found.tsx`; `ModuleRouteGuard` therefore steps aside for these
 *     ids.
 *
 * An explicit list, never derived: "unlisted" is a decision made per module in
 * the registry, true only of the modules named here. Keep it in step with the
 * registry's `listedWhenUnavailable: false` rows. Its own file so the guard can
 * read it without importing the hook module.
 *
 * No module ships dark in this build, so the list is empty and every gate that
 * reads it behaves exactly as if it were not there.
 */
export const ABSENT_UNLESS_LISTED: ReadonlySet<string> = new Set<string>();
