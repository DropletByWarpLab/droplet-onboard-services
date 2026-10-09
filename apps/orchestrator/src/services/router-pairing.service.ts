/**
 * Router pairing (ADR-071 slice B, WARP-3739): the router role of the shared
 * `DevicePairingService`. Kept as its own module so the slice B surface
 * (`createRouterPairingService`, `RouterPairingService`, `getBoxFingerprint`) and
 * its callers and tests are unchanged by the slice C generalisation; the
 * implementation, and its documentation, live in `device-pairing.service.ts`.
 */
import {
  createDevicePairingService,
  getBoxFingerprint,
  ROUTER_PROFILE,
  type DevicePairingService,
  type IdentityPort,
  type PairingServiceFetch,
} from "./device-pairing.service.js";

export { getBoxFingerprint };
export type {
  IdentityPort,
  PairingState,
  PairingView,
  PairResult,
} from "./device-pairing.service.js";

export interface RouterPairingDeps {
  prisma: Parameters<typeof createDevicePairingService>[0]["prisma"];
  identity: IdentityPort;
  routingFetch: PairingServiceFetch;
  /** Authenticated probe that throws a typed RouterError (default: GET /system/info). */
  probeRouter: () => Promise<unknown>;
  /** Defaults to global fetch; tests inject. */
  fetchImpl?: typeof fetch;
  bridgeUrl?: string;
  bridgeToken?: () => string;
}

export function createRouterPairingService(deps: RouterPairingDeps): DevicePairingService {
  const { routingFetch, probeRouter, ...rest } = deps;
  return createDevicePairingService({
    ...rest,
    profile: ROUTER_PROFILE,
    serviceFetch: routingFetch,
    probeDevice: probeRouter,
  });
}

export type RouterPairingService = DevicePairingService;
