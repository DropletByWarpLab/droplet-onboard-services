/**
 * Process-wide RouterPairingService (ADR-071 slice B). One instance, because the
 * in-flight guard and the "foreign fingerprint already audited" set are
 * per-process state shared by the routes and the startup/periodic reconcile.
 */
import type { PrismaClient } from "@prisma/client";
import { createDeviceIdentityClient } from "./device-identity.client.js";
import * as openwrt from "./openwrt.client.js";
import { createRouterPairingService, type RouterPairingService } from "./router-pairing.service.js";

let instance: RouterPairingService | null = null;

export function getRouterPairingService(prisma: PrismaClient): RouterPairingService {
  if (!instance) {
    instance = createRouterPairingService({
      prisma,
      identity: createDeviceIdentityClient(),
      // Lazy: a test that mocks openwrt.client without this export must still build the router.
      routingFetch: (path, init) => openwrt.routingFetch(path, init),
      probeRouter: () => openwrt.fetchSystemInfo(),
    });
  }
  return instance;
}

/** Test seam. */
export function _resetRouterPairingServiceForTests(): void {
  instance = null;
}
