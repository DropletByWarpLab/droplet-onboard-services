/**
 * VLAN + camera-subnet routes.
 *
 * Placeholder module — no VLAN or `/subnets/cameras/*` routes live in
 * the orchestrator yet. Kept as a dedicated registration point so
 * future VLAN/isolation work has an obvious home and `createNetworkRouter`
 * doesn't need restructuring when the first route lands.
 */

import type { Router } from "express";

// No external deps yet; kept as a parameter so the signature matches the
// other `register*Routes` helpers and so deps can be added without
// breaking the composition site in `network.ts`.
export interface VlanDeps {}

export function registerVlanRoutes(_router: Router, _deps: VlanDeps): void {
  // Intentionally empty — see module docstring.
}
