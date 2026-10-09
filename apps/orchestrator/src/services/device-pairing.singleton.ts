/**
 * Process-wide switch and AP pairing services (ADR-071 slice C). One instance
 * each, because the in-flight guard and the "foreign fingerprint already
 * audited" set are per-process state shared by the routes and (for the switch)
 * the startup/periodic reconcile. The router's lives in
 * `router-pairing.singleton.ts`, unchanged from slice B.
 */
import type { PrismaClient } from "@prisma/client";
import { createDeviceIdentityClient } from "./device-identity.client.js";
import * as openwrt from "./openwrt.client.js";
import * as switchClient from "./switch.client.js";
import {
  AP_PROFILE,
  SWITCH_PROFILE,
  createDevicePairingService,
  type DevicePairingService,
} from "./device-pairing.service.js";

let switchInstance: DevicePairingService | null = null;
let apInstance: DevicePairingService | null = null;

export function getSwitchPairingService(prisma: PrismaClient): DevicePairingService {
  if (!switchInstance) {
    switchInstance = createDevicePairingService({
      profile: SWITCH_PROFILE,
      prisma,
      identity: createDeviceIdentityClient(),
      // Lazy: a test that mocks switch.client without this export must still build the router.
      serviceFetch: (path, init) => switchClient.switchServiceFetch(path, init),
    });
  }
  return switchInstance;
}

/** APs pair through routing's AP onboarding path (`/aps/:mac/pairing*`). */
export function getApPairingService(prisma: PrismaClient): DevicePairingService {
  if (!apInstance) {
    apInstance = createDevicePairingService({
      profile: AP_PROFILE,
      prisma,
      identity: createDeviceIdentityClient(),
      serviceFetch: (path, init) => openwrt.routingFetch(path, init),
    });
  }
  return apInstance;
}

/** Test seam. */
export function _resetDevicePairingServicesForTests(): void {
  switchInstance = null;
  apInstance = null;
}
