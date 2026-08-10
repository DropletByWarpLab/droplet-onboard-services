/**
 * Matter controller core — owns the matter.js CommissioningController.
 *
 * WARP-850: extracted from the orchestrator's
 * `apps/orchestrator/src/services/matter.service.ts` so the controller
 * lives in the init network namespace (compose `network_mode: host`),
 * giving it raw HCI access for BLE commissioning and native LAN
 * multicast for mDNS discovery (home LAN + the in-container OpenWrt
 * AP's br-lan host bridge).
 *
 * Behavior parity notes vs. the orchestrator original:
 *  - The matter.js environment id stays `droplet-controller` and the
 *    storage path keeps the `MATTER_STORAGE_PATH` env contract, so the
 *    `matter-data` volume moves over unchanged and commissioned fabrics
 *    survive the migration without re-pairing (requirement #2).
 *  - Errors from matter.js are rethrown UNTRANSLATED. The orchestrator's
 *    `translateCommissionError()` maps raw messages to customer copy;
 *    the HTTP layer (server.ts) ships `errorClass` + `errorMessage`
 *    through so that mapping keeps working (requirement #4).
 *  - `recordActivity` audit rows are NOT emitted here — the orchestrator
 *    client wraps commission/decommission/command outcomes exactly as
 *    before, so the signed ActivityRow chain stays in one process.
 *
 * matter.js is injected via `createController` so unit tests can drive
 * the full surface against a fake controller.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import pino from "pino";
import { Environment, ServerAddress, type Duration } from "@matter/main";
import { NodeId } from "@matter/main/types";
import {
  CommissioningController,
  type NodeCommissioningOptions,
} from "@project-chip/matter.js";
import { NodeStates, type PairedNode } from "@project-chip/matter.js/device";
import { GeneralCommissioning } from "@matter/main/clusters";
import { ManualPairingCodeCodec, QrPairingCodeCodec } from "@matter/main/types";
import { type CommissionableDevice } from "@matter/main/protocol";
import type {
  MatterCommissionedDevice,
  MatterDiscoveredDevice,
  MatterEndpointInfo,
  MatterGrouped,
  SmartHomeCategory,
} from "./types.js";

const logger = pino({ name: "matter-controller-core" });

// --- Matter device type IDs to SmartHomeCategory mapping ---
const DEVICE_TYPE_CATEGORY: Record<number, SmartHomeCategory> = {
  // Lighting
  0x0100: "light",      // On/Off Light
  0x0101: "light",      // Dimmable Light
  0x010c: "light",      // Color Temperature Light
  0x010d: "light",      // Extended Color Light
  // Switches / Plugs
  0x0103: "switch",     // On/Off Plug-in Unit
  0x010a: "switch",     // On/Off Light Switch
  0x010b: "switch",     // Dimmer Switch
  // Sensors
  0x0302: "sensor",     // Temperature Sensor
  0x0305: "sensor",     // Pressure Sensor
  0x0307: "sensor",     // Humidity Sensor
  0x0106: "sensor",     // Light Sensor
  0x0044: "sensor",     // Occupancy Sensor
  0x0015: "binary_sensor", // Contact Sensor
  // Climate
  0x0301: "climate",    // Thermostat
  // WARP-897: 0x002b is the Fan device type — it was mislabeled "climate",
  // which routed it to the thermostat widget and hid the fan controls.
  0x002b: "fan",        // Fan
  // Media
  0x0028: "media_player", // Basic Video Player
  0x0023: "media_player", // Casting Video Player
  0x0022: "media_player", // Speaker
  // Covers
  0x0202: "cover",      // Window Covering
  // Locks
  0x000a: "lock",       // Door Lock
  // Other
  0x000f: "vacuum",     // Robotic Vacuum Cleaner
};

/**
 * KAN-7: Matter Thermostat SystemMode enum (Matter spec §4.3.9.1.5) keyed by
 * the HVAC mode labels the dashboard surfaces. Heat/cool/auto are Tier-1
 * writes; "off" is Tier-2 (gated by the orchestrator's safety rules) because
 * it can leave a home with no heating/cooling.
 */
const HVAC_MODE_TO_SYSTEM_MODE: Record<string, number> = {
  off: 0,
  auto: 1,
  cool: 3,
  heat: 4,
};

// Cluster IDs for capability detection
const CLUSTER_ID = {
  ON_OFF: 0x0006,
  LEVEL_CONTROL: 0x0008,
  COLOR_CONTROL: 0x0300,
  THERMOSTAT: 0x0201,
  DOOR_LOCK: 0x0101,
  WINDOW_COVERING: 0x0102,
  FAN_CONTROL: 0x0202,
  MEDIA_PLAYBACK: 0x0506,
  TEMPERATURE_MEASUREMENT: 0x0402,
  HUMIDITY_MEASUREMENT: 0x0405,
  OCCUPANCY_SENSING: 0x0406,
} as const;

/**
 * The slice of `CommissioningController` the core uses. Narrowed to an
 * interface so tests can inject a fake; production passes the real
 * matter.js instance which satisfies this structurally.
 */
export interface ControllerLike {
  start(): Promise<void>;
  close(): Promise<void>;
  getCommissionedNodes(): readonly NodeId[] | NodeId[] | bigint[];
  isNodeCommissioned(nodeId: NodeId): boolean;
  commissionNode(options: NodeCommissioningOptions): Promise<NodeId | bigint>;
  getNode(nodeId: NodeId): Promise<PairedNode>;
  removeNode(nodeId: NodeId, tryDecommission: boolean): Promise<void>;
  discoverCommissionableDevices(
    identifier: object,
    discoveryCapabilities?: unknown,
    discoveredCallback?: unknown,
    timeout?: Duration,
  ): Promise<CommissionableDevice[]>;
}

export interface MatterControllerCoreOptions {
  storagePath: string;
  adminFabricLabel: string;
  /**
   * WARP-895: Wi-Fi network handed to a BLE-first device during
   * commissioning so it can move off BLE onto the operational LAN. When
   * `wifiSsid` is empty, commissioning is on-network-only (the
   * pre-WARP-895 behaviour). The PSK is resolved at commission time —
   * `wifiPskFile` first, then `wifiPsk` — so a per-box PSK provisioned
   * after the sidecar started is still picked up.
   */
  wifiSsid?: string;
  /**
   * WARP-1363: file-first SSID, mirroring `wifiPskFile`. The static env
   * SSID goes stale the moment the AP is renamed (claim / setup-wizard
   * Wi-Fi save) — the commissionee then scans for a network that no
   * longer exists and answers NetworkNotFound (proven live on .87:
   * env said "Droplet", the AP broadcast "WarpLab"). The file is
   * re-read per commission, so a rename can never strand commissioning.
   */
  wifiSsidFile?: string;
  wifiPsk?: string;
  wifiPskFile?: string;
  /** ISO-3166 alpha-2 regulatory domain; defaults to "XX" (unspecified). */
  regulatoryCountryCode?: string;
  /**
   * Whether the BLE transport was registered at process start (ble.ts).
   * Manual pairing codes carry no discovery-capability bits, and
   * matter.js defaults to mDNS-only when `discoveryCapabilities` is
   * absent — so without this flag the BLE scanner never runs and a
   * freshly-reset BLE-first device can never be discovered.
   */
  bleCommissioning?: boolean;
  /** Test seam — defaults to constructing the real matter.js controller. */
  createController?: () => ControllerLike;
}

/**
 * WARP-1035: the Wi-Fi knobs shared by the commissioning path and the
 * /capabilities route — both call resolveWifiNetwork on the same values
 * so the wizard's `wifiProvisioning` answer can never drift from what a
 * commission actually does.
 */
export type WifiProvisioningOptions = Pick<
  MatterControllerCoreOptions,
  "wifiSsid" | "wifiSsidFile" | "wifiPsk" | "wifiPskFile"
>;

/**
 * WARP-1363: resolve the SSID a commission would hand the device —
 * file-first (`wifiSsidFile`, written by droplet-openwrt-attach next to
 * the AP PSK), env fallback. Exported so /capabilities reports the SAME
 * apSsid the next commission would actually use.
 */
export async function resolveWifiSsid(
  options: WifiProvisioningOptions,
): Promise<string> {
  const ssidFile = (options.wifiSsidFile ?? "").trim();
  if (ssidFile) {
    try {
      const fromFile = (await fs.promises.readFile(ssidFile, "utf8")).trim();
      if (fromFile) return fromFile;
    } catch (err) {
      logger.warn(
        { err, ssidFile },
        "DROPLET_MATTER_WIFI_SSID_FILE is set but unreadable — falling back to DROPLET_MATTER_WIFI_SSID",
      );
    }
  }
  return (options.wifiSsid ?? "").trim();
}

/**
 * WARP-895: resolve the operational Wi-Fi network a BLE-first device is
 * handed during commissioning. SSID source order (WARP-1363): the file
 * (`options.wifiSsidFile` — live AP SSID persisted by
 * droplet-openwrt-attach), then `options.wifiSsid`. PSK source order: the
 * file (`options.wifiPskFile` — the per-box AP PSK provisioned by
 * droplet-openwrt-attach), then `options.wifiPsk`. Returns undefined —
 * commissioning then proceeds on-network-only, exactly as before WARP-895
 * — when no SSID or no PSK is available.
 *
 * Exported (WARP-1035) so server.ts /capabilities can compute
 * `wifiProvisioning` per request; the file re-read means a per-box PSK
 * that lands after the sidecar started flips the answer with no restart.
 */
export async function resolveWifiNetwork(
  options: WifiProvisioningOptions,
): Promise<{ wifiSsid: string; wifiCredentials: string } | undefined> {
  const wifiSsid = await resolveWifiSsid(options);
  if (!wifiSsid) return undefined;
  let psk = "";
  const pskFile = (options.wifiPskFile ?? "").trim();
  if (pskFile) {
    try {
      psk = (await fs.promises.readFile(pskFile, "utf8")).trim();
    } catch (err) {
      logger.warn(
        { err, pskFile },
        "DROPLET_MATTER_WIFI_PSK_FILE is set but unreadable — falling back to DROPLET_MATTER_WIFI_PSK",
      );
    }
  }
  if (!psk) psk = (options.wifiPsk ?? "").trim();
  if (!psk) return undefined;
  return { wifiSsid, wifiCredentials: psk };
}

export interface MatterControllerCore {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  isInitialized(): boolean;
  discover(timeoutMs: number): Promise<MatterDiscoveredDevice[]>;
  commission(pairingCode: string): Promise<{ nodeId: string }>;
  /** @returns false when the nodeId isn't commissioned (route maps to 404). */
  decommission(nodeIdStr: string): Promise<boolean>;
  /**
   * WARP-1469: force an immediate reconnect attempt for a still-paired
   * but offline device. matter.js otherwise parks a dropped node in
   * WaitingForDeviceDiscovery and only re-probes ~every 10 minutes, so a
   * device the user just power-cycled or carried back into range stays
   * "offline" in the UI for minutes. Non-blocking: triggerReconnect()
   * schedules the attempt and the `connection_changed` SSE event reports
   * the outcome.
   * @returns false when the nodeId isn't commissioned (route maps to 404).
   */
  reconnect(nodeIdStr: string): Promise<boolean>;
  listDevices(): Promise<MatterGrouped>;
  getDevice(nodeIdStr: string): Promise<MatterCommissionedDevice | null>;
  sendCommand(
    nodeIdStr: string,
    command: string,
    data?: Record<string, unknown>,
  ): Promise<{ status: string; result?: unknown }>;
  /** Emits `state_changed` and `connection_changed` — fanned out over SSE. */
  events: EventEmitter;
}

/**
 * Fabric-continuity invariant (WARP-850 requirement #2): this id keys
 * the on-disk storage layout under MATTER_STORAGE_PATH. It MUST stay
 * `droplet-controller` — the value the orchestrator used pre-extraction
 * — or every paired device orphans on upgrade. Pinned by
 * controller.test.ts; exported so the test fails compilation if the
 * constant disappears and fails assertion if the value drifts.
 */
export const MATTER_ENV_ID = "droplet-controller";

export function createMatterControllerCore(
  options: MatterControllerCoreOptions,
): MatterControllerCore {
  let controller: ControllerLike | null = null;
  let initialized = false;
  const events = new EventEmitter();

  const createController =
    options.createController ??
    (() =>
      new CommissioningController({
        environment: {
          environment: Environment.default,
          id: MATTER_ENV_ID,
        },
        autoConnect: true,
        adminFabricLabel: options.adminFabricLabel,
      }) as unknown as ControllerLike);

  function requireController(): ControllerLike {
    if (!controller) throw new Error("Matter controller not initialized");
    return controller;
  }

  async function setupNodeListeners(nodeId: NodeId): Promise<void> {
    if (!controller) return;
    const node = await controller.getNode(nodeId);

    node.events.attributeChanged.on((data: any) => {
      events.emit("state_changed", {
        nodeId: String(nodeId),
        path: data.path,
        value: data.value,
      });
    });

    node.events.stateChanged.on((newState: NodeStates) => {
      events.emit("connection_changed", {
        nodeId: String(nodeId),
        connectionState: newState,
      });
    });
  }

  async function buildDeviceInfo(
    nodeId: NodeId,
  ): Promise<MatterCommissionedDevice | null> {
    if (!controller) return null;

    const node = await controller.getNode(nodeId);
    const basicInfo = node.basicInformation;

    const endpoints: MatterEndpointInfo[] = [];
    let primaryCategory: SmartHomeCategory = "switch"; // default
    const attributes: Record<string, unknown> = {};

    for (const [epId, endpoint] of node.parts) {
      const descriptor = (endpoint as any).state?.descriptor;
      const deviceTypes = (descriptor?.deviceTypeList ?? []).map((dt: any) => ({
        deviceType: Number(dt.deviceType),
        revision: Number(dt.revision ?? 1),
      }));
      const clusters = (descriptor?.serverList ?? []).map((c: any) => Number(c));

      endpoints.push({ endpointId: epId, deviceTypes, clusters });

      if (epId > 0) {
        for (const dt of deviceTypes) {
          const cat = DEVICE_TYPE_CATEGORY[dt.deviceType];
          if (cat) {
            primaryCategory = cat;
            break;
          }
        }

        if (primaryCategory === "switch" && clusters.length > 0) {
          if (clusters.includes(CLUSTER_ID.LEVEL_CONTROL))
            primaryCategory = "light";
          else if (clusters.includes(CLUSTER_ID.THERMOSTAT))
            primaryCategory = "climate";
          else if (clusters.includes(CLUSTER_ID.DOOR_LOCK))
            primaryCategory = "lock";
          else if (clusters.includes(CLUSTER_ID.WINDOW_COVERING))
            primaryCategory = "cover";
          else if (clusters.includes(CLUSTER_ID.TEMPERATURE_MEASUREMENT))
            primaryCategory = "sensor";
          else if (clusters.includes(CLUSTER_ID.MEDIA_PLAYBACK))
            primaryCategory = "media_player";
        }

        try {
          readEndpointAttributes(endpoint, attributes);
        } catch {
          // Attributes may not be available if not connected
        }
      }
    }

    const state = deriveStateString(attributes, node);

    const connectionStateMap: Record<
      number,
      MatterCommissionedDevice["connectionState"]
    > = {
      [NodeStates.Connected]: "connected",
      [NodeStates.Disconnected]: "disconnected",
      [NodeStates.Reconnecting]: "reconnecting",
      [NodeStates.WaitingForDeviceDiscovery]: "waiting",
    };

    return {
      nodeId: String(nodeId),
      name:
        basicInfo?.nodeLabel ||
        basicInfo?.productName ||
        `Matter Device ${nodeId}`,
      category: primaryCategory,
      state,
      connectionState:
        connectionStateMap[node.connectionState] ?? "disconnected",
      vendorName: basicInfo?.vendorName,
      vendorId: basicInfo?.vendorId ? Number(basicInfo.vendorId) : undefined,
      productName: basicInfo?.productName,
      productId: basicInfo?.productId,
      serialNumber: basicInfo?.serialNumber,
      endpoints,
      attributes,
    };
  }

  async function sendCommandInner(
    nodeIdStr: string,
    command: string,
    data?: Record<string, unknown>,
  ): Promise<{ status: string; result?: unknown }> {
    const ctl = requireController();

    const nodeId = NodeId(BigInt(nodeIdStr));
    const node = await ctl.getNode(nodeId);

    if (node.connectionState !== NodeStates.Connected) {
      throw new Error(`Device ${nodeIdStr} is not connected`);
    }

    const endpointId = data?.endpoint_id
      ? Number(data.endpoint_id)
      : findFunctionalEndpoint(node);

    const endpoint = node.parts.get(endpointId);
    if (!endpoint)
      throw new Error(`Endpoint ${endpointId} not found on device`);

    switch (command) {
      case "turn_on":
        await invokeClusterCommand(endpoint, "onOff", "on");
        return { status: "ok" };

      case "turn_off":
        await invokeClusterCommand(endpoint, "onOff", "off");
        return { status: "ok" };

      case "toggle":
        await invokeClusterCommand(endpoint, "onOff", "toggle");
        return { status: "ok" };

      case "set_brightness": {
        const level = Math.round(
          (Number(data?.brightness ?? 100) / 100) * 254,
        );
        await invokeClusterCommand(endpoint, "levelControl", "moveToLevel", {
          level,
          transitionTime: data?.transition_time ?? 10,
          optionsMask: 0,
          optionsOverride: 0,
        });
        return { status: "ok" };
      }

      // WARP-1371: color-capable lights (ColorControl 0x0300). Hue arrives in
      // UX degrees (0-360) and saturation in percent; Matter wants 0-254 for
      // both (spec 3.2.7). A light without hue/sat support rejects the invoke
      // and the raw matter.js error surfaces (honesty contract) rather than a
      // fabricated ok.
      case "set_color": {
        const hueDeg = Number(data?.hue ?? 0);
        const satPct = Number(data?.saturation ?? 100);
        const hue = Math.round(((((hueDeg % 360) + 360) % 360) / 360) * 254);
        const saturation = Math.round(
          (Math.min(Math.max(satPct, 0), 100) / 100) * 254,
        );
        await invokeClusterCommand(endpoint, "colorControl", "moveToHueAndSaturation", {
          hue,
          saturation,
          transitionTime: data?.transition_time ?? 10,
          optionsMask: 0,
          optionsOverride: 0,
        });
        return { status: "ok" };
      }

      // WARP-1371: tunable-white lights. Accepts UX kelvin (preferred) or raw
      // mireds; clamped to the 153-500 mired band virtually every retail bulb
      // supports (6500K-2000K).
      case "set_color_temperature": {
        let mireds = Number(data?.mireds ?? 0);
        if (!mireds) {
          const kelvin = Number(data?.kelvin ?? 2700);
          mireds = Math.round(1_000_000 / Math.min(Math.max(kelvin, 2000), 6500));
        }
        mireds = Math.min(Math.max(Math.round(mireds), 153), 500);
        await invokeClusterCommand(endpoint, "colorControl", "moveToColorTemperature", {
          colorTemperatureMireds: mireds,
          transitionTime: data?.transition_time ?? 10,
          optionsMask: 0,
          optionsOverride: 0,
        });
        return { status: "ok" };
      }

      // WARP-1371: window coverings (WindowCovering 0x0102). The June audit
      // proved the old path (onOff toggle) always 500s on a real cover —
      // these are the cluster commands a blind actually implements. The
      // motion commands are VOID requests (WARP-1366 payload rule applies).
      case "open_cover":
        await invokeClusterCommand(endpoint, "windowCovering", "upOrOpen");
        return { status: "ok" };

      case "close_cover":
        await invokeClusterCommand(endpoint, "windowCovering", "downOrClose");
        return { status: "ok" };

      case "stop_cover":
        await invokeClusterCommand(endpoint, "windowCovering", "stopMotion");
        return { status: "ok" };

      // UX position is percent OPEN (100 = fully open); Matter lift is
      // hundredths-of-percent CLOSED (10000 = fully closed) — invert.
      case "set_cover_position": {
        const positionPct = Math.min(Math.max(Number(data?.position ?? 100), 0), 100);
        await invokeClusterCommand(endpoint, "windowCovering", "goToLiftPercentage", {
          liftPercent100thsValue: Math.round((100 - positionPct) * 100),
        });
        return { status: "ok" };
      }

      // WARP-1371: fans (FanControl 0x0202). Speed is an attribute write, not
      // a command — percentSetting (0-100) with fanMode auto-derived by the
      // device; explicit modes map to the FanModeEnum.
      case "set_fan_speed": {
        const percent = Math.min(Math.max(Math.round(Number(data?.percent ?? 100)), 0), 100);
        await writeClusterAttribute(endpoint, "fanControl", "percentSetting", percent);
        return { status: "ok" };
      }

      case "set_fan_mode": {
        // Matter FanModeEnum (Fan Control cluster 0x0202, spec §4.4.6): 0 Off, 1 Low, 2 Medium, 3 High,
        // 4 On, 5 Auto.
        const FAN_MODES: Record<string, number> = {
          off: 0,
          low: 1,
          medium: 2,
          high: 3,
          on: 4,
          auto: 5,
        };
        const mode = FAN_MODES[String(data?.mode ?? "")];
        if (mode === undefined)
          throw new Error(`Unsupported fan mode: ${String(data?.mode ?? "")}`);
        await writeClusterAttribute(endpoint, "fanControl", "fanMode", mode);
        return { status: "ok" };
      }

      // WARP-1371: media players (MediaPlayback 0x0506) — the three verbs
      // every speaker/display supports. All VOID requests.
      case "play_media":
        await invokeClusterCommand(endpoint, "mediaPlayback", "play");
        return { status: "ok" };

      case "pause_media":
        await invokeClusterCommand(endpoint, "mediaPlayback", "pause");
        return { status: "ok" };

      case "stop_media":
        await invokeClusterCommand(endpoint, "mediaPlayback", "stop");
        return { status: "ok" };

      case "set_temperature": {
        const temp = Number(data?.temperature ?? 21);
        const mode = Number(data?.mode ?? 0); // 0=heat, 1=cool
        const setpoint = Math.round(temp * 100);
        const thermoState = (endpoint as any).state?.thermostat;
        if (!thermoState)
          throw new Error("Thermostat cluster not found on endpoint");
        if (mode === 1) {
          await writeClusterAttribute(
            endpoint,
            "thermostat",
            "occupiedCoolingSetpoint",
            setpoint,
          );
        } else {
          await writeClusterAttribute(
            endpoint,
            "thermostat",
            "occupiedHeatingSetpoint",
            setpoint,
          );
        }
        return { status: "ok" };
      }

      case "set_hvac_mode": {
        // Matter Thermostat SystemMode enum (Matter spec §4.3.9.1.5):
        // 0 = Off, 1 = Auto, 3 = Cool, 4 = Heat. We expose the four modes
        // the dashboard surfaces; emergency-heat/dry/etc. are intentionally
        // out of scope here.
        const mode = String(data?.mode ?? "");
        const systemMode = HVAC_MODE_TO_SYSTEM_MODE[mode];
        if (systemMode === undefined)
          throw new Error(`Unsupported HVAC mode: ${mode}`);
        const thermoState = (endpoint as any).state?.thermostat;
        if (!thermoState)
          throw new Error("Thermostat cluster not found on endpoint");
        // Surface the sidecar/device error HONESTLY: not every thermostat
        // accepts every systemMode write, so a rejected write must propagate
        // the raw matter.js error rather than reporting a fabricated ok.
        await writeClusterAttribute(
          endpoint,
          "thermostat",
          "systemMode",
          systemMode,
        );
        return { status: "ok" };
      }

      case "lock":
        await invokeClusterCommand(endpoint, "doorLock", "lockDoor", {});
        return { status: "ok" };

      case "unlock":
        await invokeClusterCommand(endpoint, "doorLock", "unlockDoor", {});
        return { status: "ok" };

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  return {
    events,

    async init(): Promise<void> {
      fs.mkdirSync(options.storagePath, { recursive: true });

      controller = createController();
      await controller.start();
      initialized = true;

      const nodes = controller.getCommissionedNodes();
      logger.info(
        "Matter controller started — %d commissioned node(s)",
        nodes.length,
      );

      for (const nodeId of nodes) {
        setupNodeListeners(nodeId as NodeId).catch((err) => {
          logger.debug(
            "Failed to setup listeners for node %s: %s",
            nodeId,
            err,
          );
        });
      }
    },

    isInitialized(): boolean {
      return initialized;
    },

    async shutdown(): Promise<void> {
      if (controller) {
        await controller.close();
        controller = null;
      }
      initialized = false;
      logger.info("Matter controller stopped");
    },

    async discover(timeoutMs: number): Promise<MatterDiscoveredDevice[]> {
      const ctl = requireController();
      logger.info(
        "Starting Matter device discovery (timeout: %dms)",
        timeoutMs,
      );
      // matter.js Duration is stored in milliseconds (see @matter/general
      // time/Duration.ts), so pass timeoutMs straight through — dividing by
      // 1000 here previously turned a 5000ms scan into a 5ms one that found
      // nothing.
      const timeout = timeoutMs as Duration;
      // WARP-1362 sibling: an omitted discoveryCapabilities defaults
      // matter.js's collectScanners() to mDNS-only, so the BLE scanner
      // never runs even with the transport registered (see commission()).
      const discoveryCapabilities = {
        onIpNetwork: true,
        ...(options.bleCommissioning ? { ble: true } : {}),
      };
      const devices = await ctl.discoverCommissionableDevices(
        {} as any, // Empty identifier = discover all
        discoveryCapabilities,
        undefined,
        timeout,
      );
      return devices.map(commissionableToDiscovered);
    },

    async commission(pairingCode: string): Promise<{ nodeId: string }> {
      const ctl = requireController();

      const trimmed = pairingCode.trim();

      // WARP-895: hand a BLE-first device the operational Wi-Fi network so
      // it can move off BLE onto the LAN (matter.js sends
      // AddOrUpdateWiFiNetwork only when the device's NetworkCommissioning
      // cluster needs it; a device already on IP ignores it). Resolved
      // per-commission so a per-box PSK provisioned after sidecar start is
      // picked up. Absent ⇒ on-network-only (pre-WARP-895 behaviour).
      const wifiNetwork = await resolveWifiNetwork(options);
      const commissioning = {
        regulatoryLocation:
          GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: options.regulatoryCountryCode ?? "XX",
        ...(wifiNetwork ? { wifiNetwork } : {}),
      };
      if (wifiNetwork) {
        logger.info(
          "Commissioning will provision Wi-Fi SSID '%s' for a BLE-first device",
          wifiNetwork.wifiSsid,
        );
      }

      // Scan every transport we actually have: pairing codes carry no
      // discovery-capability bits (and we deliberately ignore the QR's —
      // scanning a superset is harmless, matter.js uses whichever scanner
      // finds the device first). Omitting this made discovery mDNS-only,
      // which is exactly the retail BLE-first case WARP-895 exists for.
      const discoveryCapabilities = {
        onIpNetwork: true,
        ...(options.bleCommissioning ? { ble: true } : {}),
      };

      let commissioningOptions: NodeCommissioningOptions;

      if (trimmed.startsWith("MT:")) {
        // QR code payload — decode returns an array, take the first entry
        const qrList = QrPairingCodeCodec.decode(trimmed);
        const qr = qrList[0];
        if (!qr) throw new Error("Invalid QR pairing code");
        commissioningOptions = {
          commissioning,
          discovery: {
            identifierData: { longDiscriminator: qr.discriminator },
            discoveryCapabilities,
          },
          passcode: qr.passcode,
        };
      } else {
        // Manual pairing code (11 or 21 digit number)
        const manual = ManualPairingCodeCodec.decode(trimmed);
        commissioningOptions = {
          commissioning,
          discovery: {
            identifierData: { shortDiscriminator: manual.shortDiscriminator },
            discoveryCapabilities,
          },
          passcode: manual.passcode,
        };
      }

      logger.info("Commissioning device with pairing code...");
      const nodeId = await ctl.commissionNode(commissioningOptions);
      logger.info("Device commissioned successfully: nodeId=%s", nodeId);

      await setupNodeListeners(nodeId as NodeId);

      return { nodeId: String(nodeId) };
    },

    async decommission(nodeIdStr: string): Promise<boolean> {
      const ctl = requireController();
      const nodeId = NodeId(BigInt(nodeIdStr));
      // Mirror getDevice's guard: an uncommissioned nodeId must surface
      // as the route's 404, not an untyped matter.js getNode throw that
      // the HTTP layer can only report as a 500.
      if (!ctl.isNodeCommissioned(nodeId)) return false;
      const node = await ctl.getNode(nodeId);
      try {
        await node.decommission();
      } catch (err) {
        logger.warn("Graceful decommission failed, removing node: %s", err);
        await ctl.removeNode(nodeId, false);
      }
      logger.info("Device decommissioned: %s", nodeIdStr);
      return true;
    },

    async reconnect(nodeIdStr: string): Promise<boolean> {
      const ctl = requireController();
      const nodeId = NodeId(BigInt(nodeIdStr));
      // Mirror decommission/getDevice's guard: an uncommissioned nodeId
      // surfaces as the route's 404, not an untyped matter.js getNode
      // throw the HTTP layer could only report as a 500.
      if (!ctl.isNodeCommissioned(nodeId)) return false;
      const node = await ctl.getNode(nodeId);
      // Non-blocking (matter.js PairedNode.triggerReconnect): schedules an
      // immediate reconnect and returns. matter.js self-guards against a
      // reconnect already in flight, so a double-tap is a safe no-op. The
      // `connection_changed` SSE event carries the eventual result.
      node.triggerReconnect();
      logger.info("Reconnect triggered for node: %s", nodeIdStr);
      return true;
    },

    async listDevices(): Promise<MatterGrouped> {
      const ctl = requireController();

      const grouped: MatterGrouped = {
        lights: [],
        switches: [],
        sensors: [],
        climate: [],
        media: [],
        covers: [],
        locks: [],
        other: [],
      };

      const nodeIds = ctl.getCommissionedNodes();

      for (const nodeId of nodeIds) {
        try {
          const device = await buildDeviceInfo(nodeId as NodeId);
          if (!device) continue;

          switch (device.category) {
            case "light":
              grouped.lights.push(device);
              break;
            case "switch":
              grouped.switches.push(device);
              break;
            case "sensor":
            case "binary_sensor":
              grouped.sensors.push(device);
              break;
            case "climate":
            case "fan":
              grouped.climate.push(device);
              break;
            case "media_player":
              grouped.media.push(device);
              break;
            case "cover":
              grouped.covers.push(device);
              break;
            case "lock":
              grouped.locks.push(device);
              break;
            default:
              grouped.other.push(device);
              break;
          }
        } catch (err) {
          logger.debug("Failed to build info for node %s: %s", nodeId, err);
        }
      }

      return grouped;
    },

    async getDevice(
      nodeIdStr: string,
    ): Promise<MatterCommissionedDevice | null> {
      const ctl = requireController();
      const nodeId = NodeId(BigInt(nodeIdStr));
      if (!ctl.isNodeCommissioned(nodeId)) return null;
      return buildDeviceInfo(nodeId);
    },

    async sendCommand(
      nodeIdStr: string,
      command: string,
      data?: Record<string, unknown>,
    ): Promise<{ status: string; result?: unknown }> {
      return sendCommandInner(nodeIdStr, command, data);
    },
  };
}

// --- Pure helpers (ported verbatim from the orchestrator original) ---

/**
 * Project one matter.js `ServerAddress` onto the sidecar's wire shape.
 *
 * matter.js 0.17 restructured this union. In 0.16 every member carried a
 * literal `type` discriminant (`"udp" | "tcp" | "ble"`), so the old code
 * could read `a.type` straight through. 0.17 added a BARE `ServerAddressIp`
 * member — `{ ip, port }` with NO `type` at all — and replaced the
 * discriminant with the guards `ServerAddress.isIp()` / `.isBle()` and the
 * total accessor `ServerAddress.protocolOf()`.
 *
 * Reading `a.type` under 0.17 therefore yields `undefined` for the new
 * variant, which would have blanked the BLE-vs-IP transport signal on the
 * commissioning path while every test stayed green — the same silent-degrade
 * class as WARP-850. `protocolOf()` is total and never returns undefined:
 *   BLE  → "ble"      (peripheralAddress present)
 *   UDP  → "udp"      (explicit transport)
 *   TCP  → "tcp"      (explicit transport)
 *   bare → "ip"       (transport-agnostic DNS-SD record — the new variant)
 * so "ble" still means BLE and everything else still means IP, which is the
 * only distinction any consumer draws from this field.
 *
 * `ServerAddress` is imported from `@matter/main` — the same entrypoint as
 * `Environment` above, NOT from `@matter/general` directly. Binding a second
 * copy of `@matter/general` is precisely how WARP-850 split the
 * `Environment.default` singleton and silently disabled BLE on a shipped box.
 *
 * BLE addresses have no `ip`/`port`; those keep their empty sentinels so the
 * orchestrator-facing shape is unchanged, and the peripheral identity is
 * carried in the additive optional `peripheralAddress` rather than being
 * dropped (it is the only address information a BLE record actually has).
 *
 * Both arms use POSITIVE guards, with a sentinel fallback for anything the
 * union grows next. The 0.16 code was defensive the same way (`"ip" in a ? …`)
 * and that defensiveness is why this upgrade only had to change a mapping
 * rather than chase undefined `ip`/`port` through the HTTP layer — keep it.
 */
function serverAddressToWire(
  a: ServerAddress,
): MatterDiscoveredDevice["addresses"][number] {
  const type = ServerAddress.protocolOf(a);
  if (ServerAddress.isIp(a)) {
    return { ip: a.ip, port: a.port, type };
  }
  if (ServerAddress.isBle(a)) {
    return { ip: "", port: 0, type, peripheralAddress: a.peripheralAddress };
  }
  // Unreachable for the 0.17 union. If matter.js adds a member, the wire
  // contract still holds (`ip: string`, `port: number`) instead of leaking
  // `undefined` into the orchestrator and everything downstream of it.
  return { ip: "", port: 0, type };
}

function commissionableToDiscovered(
  device: CommissionableDevice,
): MatterDiscoveredDevice {
  const vp = device.VP?.split("+");
  return {
    deviceIdentifier: device.deviceIdentifier,
    discriminator: device.D,
    vendorId: vp?.[0] ? parseInt(vp[0], 10) : undefined,
    productId: vp?.[1] ? parseInt(vp[1], 10) : undefined,
    deviceName: device.DN,
    deviceType: device.DT,
    commissioningMode: device.CM,
    addresses: device.addresses.map(serverAddressToWire),
  };
}

function readEndpointAttributes(
  endpoint: any,
  attributes: Record<string, unknown>,
): void {
  try {
    const onOff = endpoint.state?.onOff;
    if (onOff !== undefined) {
      attributes.onOff =
        typeof onOff === "object" ? onOff.onOff : Boolean(onOff);
    }
  } catch { /* cluster not present */ }

  try {
    const level = endpoint.state?.levelControl;
    if (level !== undefined) {
      attributes.currentLevel = level.currentLevel;
    }
  } catch { /* cluster not present */ }

  try {
    const thermo = endpoint.state?.thermostat;
    if (thermo !== undefined) {
      attributes.localTemperature = thermo.localTemperature;
      attributes.occupiedHeatingSetpoint = thermo.occupiedHeatingSetpoint;
      attributes.occupiedCoolingSetpoint = thermo.occupiedCoolingSetpoint;
      attributes.systemMode = thermo.systemMode;
    }
  } catch { /* cluster not present */ }

  // WARP-897: the state the control widgets render — color, cover position,
  // fan speed/mode, lock bolt state. Same per-cluster try pattern: absent
  // clusters simply contribute nothing.
  try {
    const color = endpoint.state?.colorControl;
    if (color !== undefined) {
      attributes.currentHue = color.currentHue;
      attributes.currentSaturation = color.currentSaturation;
      attributes.colorTemperatureMireds = color.colorTemperatureMireds;
    }
  } catch { /* cluster not present */ }

  try {
    const cover = endpoint.state?.windowCovering;
    if (cover !== undefined) {
      attributes.liftPercent100ths = cover.currentPositionLiftPercent100ths;
    }
  } catch { /* cluster not present */ }

  try {
    const fan = endpoint.state?.fanControl;
    if (fan !== undefined) {
      attributes.fanPercent = fan.percentCurrent ?? fan.percentSetting;
      attributes.fanMode = fan.fanMode;
    }
  } catch { /* cluster not present */ }

  try {
    const lock = endpoint.state?.doorLock;
    if (lock !== undefined) {
      attributes.lockState = lock.lockState;
    }
  } catch { /* cluster not present */ }

  try {
    const temp = endpoint.state?.temperatureMeasurement;
    if (temp !== undefined) {
      attributes.measuredValue = temp.measuredValue;
    }
  } catch { /* cluster not present */ }
}

function deriveStateString(
  attributes: Record<string, unknown>,
  node: PairedNode,
): string {
  if (node.connectionState !== NodeStates.Connected) return "unavailable";

  // WARP-897: a lock is its bolt, never its (absent) onOff — DoorLock
  // lockState: 1 Locked, 2 Unlocked; anything else is honestly reported.
  if (attributes.lockState !== undefined && attributes.lockState !== null) {
    const ls = Number(attributes.lockState);
    if (ls === 1) return "locked";
    if (ls === 2) return "unlocked";
    return "not fully locked";
  }
  // WARP-897: covers — Matter lift is hundredths CLOSED (10000 = closed).
  if (
    attributes.liftPercent100ths !== undefined &&
    attributes.liftPercent100ths !== null
  ) {
    return Number(attributes.liftPercent100ths) >= 9900 ? "closed" : "open";
  }
  if (attributes.onOff !== undefined) {
    return attributes.onOff ? "on" : "off";
  }
  // WARP-897: fans without an onOff cluster — speed is the state.
  if (attributes.fanPercent !== undefined && attributes.fanPercent !== null) {
    return Number(attributes.fanPercent) > 0 ? "on" : "off";
  }
  if (attributes.measuredValue !== undefined) {
    return String(Number(attributes.measuredValue) / 100);
  }
  if (attributes.localTemperature !== undefined) {
    return String(Number(attributes.localTemperature) / 100);
  }
  return "unknown";
}

function findFunctionalEndpoint(node: PairedNode): number {
  for (const [epId] of node.parts) {
    if (epId > 0) return epId;
  }
  throw new Error("No functional endpoint found on device");
}

async function invokeClusterCommand(
  endpoint: any,
  clusterName: string,
  commandName: string,
  args?: Record<string, unknown>,
): Promise<void> {
  const commands = endpoint.commands?.[clusterName];
  if (!commands) {
    throw new Error(`Cluster '${clusterName}' not found on endpoint`);
  }
  const fn = commands[commandName];
  if (typeof fn !== "function") {
    throw new Error(
      `Command '${commandName}' not found on cluster '${clusterName}'`,
    );
  }
  // WARP-1366: pass args through UNTOUCHED. onOff.on/off/toggle take a void
  // request — matter.js validates the payload against the cluster schema and
  // rejects a substituted {} with ValidationDatatypeMismatchError, which made
  // every commissioned on/off device uncontrollable (proven live on .87 with
  // the first end-to-end commissioned GE Cync light).
  await fn(args);
}

async function writeClusterAttribute(
  endpoint: any,
  clusterName: string,
  attributeName: string,
  value: unknown,
): Promise<void> {
  const cluster =
    endpoint.getClusterClientById?.(clusterName) ??
    endpoint.getClusterClient?.(clusterName);
  if (cluster && typeof cluster.setAttribute === "function") {
    await cluster.setAttribute(attributeName, value);
    return;
  }
  const setCommand = `set${attributeName.charAt(0).toUpperCase()}${attributeName.slice(1)}`;
  await invokeClusterCommand(endpoint, clusterName, setCommand, {
    [attributeName]: value,
  });
}
