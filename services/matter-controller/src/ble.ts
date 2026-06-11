/**
 * BLE transport registration for the matter-controller sidecar.
 *
 * WARP-850 requirement #3:
 *  - Registered into `Environment.default` at PROCESS START, before the
 *    CommissioningController is constructed and before the HTTP server
 *    binds — NOT inside init. The bleCommissioning capability answer is
 *    computed exactly once per process lifetime and never flips
 *    mid-boot (see the WARP-850 ticket comment).
 *  - HCI adapter id comes from `DROPLET_MATTER_BLE_HCI_ID` (default 0).
 *  - Graceful degrade to IP-only commissioning when there is no
 *    adapter, the @matter/nodejs-ble module is unavailable, or its
 *    native HCI stack (@stoprocent/noble's hci-socket bindings) fails
 *    to load. Windows dev installs and CI runners hit those paths;
 *    capabilities must reflect reality, not aspiration.
 *
 * How registration works (verified against @matter/nodejs-ble 0.16.10):
 * importing the package runs its `install.js` side effect, which adds a
 * ServiceBundle hook watching the `ble.enable` environment variable.
 * Setting `ble.enable=true` constructs a `NodeJsBle` (reading the HCI
 * id from `ble.hci.id`) and calls `env.set(Ble, instance)`; setting it
 * back to false deletes the registration. matter.js's controller then
 * answers `env.has(Ble)` — the same check behind its "BLE is not
 * enabled on this platform" log line and our capabilities surface.
 *
 * The noble native module is loaded LAZILY by matter.js (first access
 * to the scanner), so a successful `ble.enable=true` alone would let a
 * box without working HCI bindings claim bleCommissioning=true and then
 * explode on the first commissioning attempt. We force the load here by
 * touching `.scanner` once, and roll the registration back if it
 * throws.
 */

import * as fs from "node:fs";
import pino from "pino";
import { Ble } from "@matter/main/protocol";

const logger = pino({ name: "matter-controller-ble" });

/**
 * The narrow slice of matter.js `Environment` this module uses,
 * injectable for tests. Production passes `Environment.default`.
 */
export interface BleEnvLike {
  vars: { set(name: string, value: unknown): void };
  has(type: unknown): boolean;
  get(type: unknown): unknown;
}

export interface BleRegistrationResult {
  /** True only when a working BLE transport is registered. */
  bleCommissioning: boolean;
  /** Operator-facing reason, logged at boot and exposed via /capabilities. */
  reason: string;
}

export interface RegisterBleOptions {
  hciId: number;
  environment: BleEnvLike;
  /** Test seam — defaults to the /sys/class/bluetooth/hci<N> probe. */
  adapterPresent?: (hciId: number) => boolean;
  /** Test seam — defaults to dynamic-importing @matter/nodejs-ble. */
  importModule?: () => Promise<unknown>;
}

/**
 * Default adapter probe: the kernel exposes every registered HCI
 * adapter under /sys/class/bluetooth/hci<N> (host netns — the sidecar
 * runs with `network_mode: host`). On non-Linux dev hosts the path
 * doesn't exist and we honestly report IP-only.
 */
export function defaultAdapterPresent(hciId: number): boolean {
  return fs.existsSync(`/sys/class/bluetooth/hci${hciId}`);
}

export async function registerBleAtProcessStart(
  options: RegisterBleOptions,
): Promise<BleRegistrationResult> {
  const {
    hciId,
    environment,
    adapterPresent = defaultAdapterPresent,
    importModule = () => import("@matter/nodejs-ble"),
  } = options;

  if (!adapterPresent(hciId)) {
    const reason = `no Bluetooth adapter at hci${hciId} — BLE commissioning disabled, IP-only`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  try {
    await importModule();
  } catch (err) {
    const reason = `@matter/nodejs-ble import failed (${(err as Error).message}) — BLE commissioning disabled, IP-only`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  // The install hook reads ble.hci.id when constructing NodeJsBle, so
  // the id must be in place BEFORE ble.enable flips true.
  environment.vars.set("ble.hci.id", hciId);
  environment.vars.set("ble.enable", true);

  if (!environment.has(Ble)) {
    const reason =
      "ble.enable was set but no Ble implementation registered — BLE commissioning disabled, IP-only";
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  // Force the lazy native load now. NodeJsBle defers requiring
  // @stoprocent/noble (and its hci-socket bindings) until the scanner
  // is first touched — which would otherwise be mid-commissioning.
  try {
    void (environment.get(Ble) as Ble).scanner;
  } catch (err) {
    environment.vars.set("ble.enable", false);
    const reason = `BLE native HCI stack failed to load (${(err as Error).message}) — registration rolled back, IP-only`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  const reason = `BLE commissioning enabled on hci${hciId}`;
  logger.info(reason);
  return { bleCommissioning: true, reason };
}
