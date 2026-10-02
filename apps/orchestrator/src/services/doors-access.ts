/**
 * ADR-055 — who may read and who may change doors, in one place.
 *
 * The routes' role guards (routes/doors.ts) read these lists. The SAME floor is
 * stated a second time, as a fact about tiers, in the access catalog: `doors`
 * offers `view` at `minTier: "admin"` with `refuseBelowFloor`, and that one
 * fact is what `requireModuleTierFloor` applies to a browser and what the MCP
 * acting-user gate applies to the PERSON the assistant acts for
 * (module-mounts.ts MCP_ACTING_USER_GATED_DOMAINS). The route admits
 * `_service:mcp` before any role check, so that second statement is the only
 * thing that keeps a staff member from asking the assistant for what the
 * browser would refuse them. `doors-access.test.ts` pins that the two agree, so
 * widening one without the other is a red build, not a quiet escalation.
 *
 * Reads floor at admin: with no per-door-group grants yet (brief §11.4 — they
 * depend on AC-017) the module's own grant is the only narrowing, and access
 * logs identify people entering places at times. Default-deny; widening to
 * `family` is this list, the access catalog's `view` floor, and nothing else.
 * Writes are the owner alone (§11.4: "Not admin").
 */
export const DOORS_READ_ROLES = ["owner", "admin"] as const;
export const DOORS_WRITE_ROLES = ["owner"] as const;
