/**
 * Router pairing routes (ADR-071 slice B, WARP-3739).
 *
 *   GET  /network/router/pairing        pairing card state (owner/admin/family)
 *   POST /network/router/pair           claim + persist       (owner/admin)
 *   POST /network/router/pair/persist   retry the persist leg (owner/admin)
 *
 * Slice C moved the implementation into `network-device-pairing.routes.ts`, which
 * serves the router, the switch and the APs identically; this module keeps the
 * slice B entry point (and its tests) as the router's registration.
 */
export { registerRouterPairingRoutes } from "./network-device-pairing.routes.js";
export type { DevicePairingRouteDeps as RouterPairingRouteDeps } from "./network-device-pairing.routes.js";
