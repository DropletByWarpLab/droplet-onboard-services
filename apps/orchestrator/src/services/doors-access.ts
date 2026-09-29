/**
 * ADR-055 (P4a) — who may read and who may change doors, in one place.
 *
 * Two consumers must agree, and a second copy is how they stop: the routes'
 * role guards (routes/doors.ts), and the floor the MCP acting-user gate applies
 * to the PERSON the assistant acts for (module-mounts.ts
 * MCP_ACTING_USER_ROLE_FLOORS). The route admits `_service:mcp` before any role
 * check, so without the second one a staff member could ask the assistant for
 * what the browser would refuse them.
 *
 * Reads floor at admin: with no per-door-group grants yet (brief §11.4 — they
 * depend on AC-017) the module's own grant is the only narrowing, and access
 * logs identify people entering places at times. Default-deny; widening to
 * `family` is this list, the access catalog's `view` floor, and nothing else.
 * Writes are the owner alone (§11.4: "Not admin").
 */
export const DOORS_READ_ROLES = ["owner", "admin"] as const;
export const DOORS_WRITE_ROLES = ["owner"] as const;
