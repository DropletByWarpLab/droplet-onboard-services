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
 * How registration works — EXPLICITLY, not via the package's install
 * hook. @matter/nodejs-ble ships an `install.js` side effect that adds
 * a ServiceBundle hook watching `ble.enable`, but the hook registers
 * into whichever @matter/general module instance the LOADER bound. Our
 * dist is CJS; a dynamic `import()` from it loads the package's ESM
 * build, whose `#general` binds the ESM copy of @matter/general — a
 * DIFFERENT ServiceBundle/Environment singleton than our CJS one. On
 * the box that meant the hook fired in a parallel universe and
 * `env.has(Ble)` stayed false (first deployed sidecar image, WARP-850
 * on-box regression #3). So we do not depend on the hook at all:
 * load the module, construct `NodeJsBle({ environment })` ourselves,
 * and `env.set(Ble, instance)` keyed to OUR `Ble` symbol — the same
 * module universe the CommissioningController checks.
 *
 * The noble native module is loaded LAZILY by matter.js (first access
 * to the scanner), so a successful registration alone would let a box
 * without working HCI bindings claim bleCommissioning=true and then
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
  set(type: unknown, instance: unknown): void;
  delete(type: unknown, instance?: unknown): void;
  has(type: unknown): boolean;
  get(type: unknown): unknown;
}

/** The slice of @matter/nodejs-ble this module consumes. */
export interface NodeJsBleModuleLike {
  NodeJsBle: new (options: { environment: unknown }) => unknown;
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
  /**
   * Test seam — defaults to the raw-HCI `isDevUp()` probe
   * (defaultAdapterPowered). Returns `undefined` when the probe itself
   * is unavailable (non-Linux dev host, bindings missing) — that is
   * treated as "unknown, proceed", never as unpowered.
   */
  adapterPowered?: (hciId: number) => boolean | undefined;
  /**
   * Test seam — defaults to `require("@matter/nodejs-ble")`. require,
   * NOT dynamic import(): our dist is CJS, and import() would load the
   * package's ESM build, binding the ESM copy of @matter/general — the
   * split-singleton failure this module exists to avoid.
   */
  loadModule?: () => NodeJsBleModuleLike | Promise<NodeJsBleModuleLike>;
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

/**
 * WARP-1939: is the adapter actually POWERED (hci device UP), not just
 * present? Presence alone lied on the live box: with bluetoothd
 * disabled, hci0 exists in /sys but comes up unpowered after boot, and
 * noble then scans a dead adapter forever — every commission honestly
 * reports "No commissionable device was discovered" while the log
 * claims "BLE commissioning enabled". This probe closes that gap.
 *
 * Implementation rides the same @stoprocent/bluetooth-hci-socket
 * binding noble itself uses (a guaranteed transitive dependency), so
 * the answer can never disagree with what noble will see. Any probe
 * failure returns `undefined` — unknown must never demote a working
 * setup to IP-only (Windows dev installs, CI).
 */
export function defaultAdapterPowered(hciId: number): boolean | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const hciSocketModule = require("@stoprocent/bluetooth-hci-socket") as {
      new (): {
        bindRaw(devId: number): void;
        isDevUp(): boolean;
        stop?(): void;
      };
    };
    const socket = new hciSocketModule();
    try {
      socket.bindRaw(hciId);
      return socket.isDevUp();
    } finally {
      socket.stop?.();
    }
  } catch {
    return undefined;
  }
}

export async function registerBleAtProcessStart(
  options: RegisterBleOptions,
): Promise<BleRegistrationResult> {
  const {
    hciId,
    environment,
    adapterPresent = defaultAdapterPresent,
    adapterPowered = defaultAdapterPowered,
    loadModule = () =>
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("@matter/nodejs-ble") as NodeJsBleModuleLike,
  } = options;

  if (!adapterPresent(hciId)) {
    const reason = `no Bluetooth adapter at hci${hciId} — BLE commissioning disabled, IP-only`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  let mod: NodeJsBleModuleLike;
  try {
    mod = await loadModule();
  } catch (err) {
    const reason = `@matter/nodejs-ble load failed (${(err as Error).message}) — BLE commissioning disabled, IP-only`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  // NodeJsBle reads the HCI id from the environment's vars, so it must
  // be in place BEFORE construction.
  environment.vars.set("ble.hci.id", hciId);

  let instance: unknown;
  try {
    instance = new mod.NodeJsBle({ environment });
  } catch (err) {
    const reason = `NodeJsBle construction failed (${(err as Error).message}) — BLE commissioning disabled, IP-only`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  // Explicit registration keyed to OUR Ble symbol — never the install
  // hook (see the header: the hook can land in a parallel ESM module
  // universe and silently no-op).
  environment.set(Ble, instance);

  if (!environment.has(Ble)) {
    const reason =
      "environment rejected the Ble registration — BLE commissioning disabled, IP-only";
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  // Force the lazy native load now. NodeJsBle defers requiring
  // @stoprocent/noble (and its hci-socket bindings) until the scanner
  // is first touched — which would otherwise be mid-commissioning.
  try {
    void (environment.get(Ble) as Ble).scanner;
  } catch (err) {
    environment.delete(Ble, instance);
    const reason = `BLE native HCI stack failed to load (${(err as Error).message}) — registration rolled back, IP-only`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  // WARP-1939: presence is not power. hci0 exists in /sys the moment
  // the driver binds, but with bluetoothd disabled (its LE connection
  // management corrupts noble's raw-HCI connects — Unknown Connection
  // Identifier on every attempt, proven live 2026-08-12) nothing powers
  // the adapter unless droplet-bt-power.service ran. An unpowered
  // adapter makes noble scan silently blind, so claiming
  // bleCommissioning=true here would be a lie the operator can only
  // detect by a bulb that is never found. Roll back and say why.
  // `undefined` = probe unavailable (non-Linux dev, CI) — proceed.
  if (adapterPowered(hciId) === false) {
    environment.delete(Ble, instance);
    const reason =
      `Bluetooth adapter hci${hciId} is present but not powered — BLE commissioning disabled, IP-only. ` +
      `Run 'btmgmt power on' or install droplet-bt-power.service (scripts/setup.sh Bluetooth prep, WARP-1939)`;
    logger.warn(reason);
    return { bleCommissioning: false, reason };
  }

  const reason = `BLE commissioning enabled on hci${hciId}`;
  logger.info(reason);
  return { bleCommissioning: true, reason };
}
