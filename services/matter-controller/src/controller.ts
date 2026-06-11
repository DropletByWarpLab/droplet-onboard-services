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
import { Environment, type Duration } from "@matter/main";
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
  0x002b: "climate",    // Fan
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
  /** Test seam — defaults to constructing the real matter.js controller. */
  createController?: () => ControllerLike;
}

export interface MatterControllerCore {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  isInitialized(): boolean;
  discover(timeoutMs: number): Promise<MatterDiscoveredDevice[]>;
  commission(pairingCode: string): Promise<{ nodeId: string }>;
  decommission(nodeIdStr: string): Promise<void>;
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
          // Fabric-continuity invariant (WARP-850 requirement #2): this id
          // keys the on-disk storage layout under MATTER_STORAGE_PATH. It
          // MUST stay `droplet-controller` — the value the orchestrator
          // used — or every paired device orphans on upgrade.
          id: "droplet-controller",
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
      const timeoutSec = (timeoutMs / 1000) as Duration;
      const devices = await ctl.discoverCommissionableDevices(
        {} as any, // Empty identifier = discover all
        undefined,
        undefined,
        timeoutSec,
      );
      return devices.map(commissionableToDiscovered);
    },

    async commission(pairingCode: string): Promise<{ nodeId: string }> {
      const ctl = requireController();

      const trimmed = pairingCode.trim();
      let commissioningOptions: NodeCommissioningOptions;

      if (trimmed.startsWith("MT:")) {
        // QR code payload — decode returns an array, take the first entry
        const qrList = QrPairingCodeCodec.decode(trimmed);
        const qr = qrList[0];
        if (!qr) throw new Error("Invalid QR pairing code");
        commissioningOptions = {
          commissioning: {
            regulatoryLocation:
              GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
            regulatoryCountryCode: "XX",
          },
          discovery: {
            identifierData: { longDiscriminator: qr.discriminator },
          },
          passcode: qr.passcode,
        };
      } else {
        // Manual pairing code (11 or 21 digit number)
        const manual = ManualPairingCodeCodec.decode(trimmed);
        commissioningOptions = {
          commissioning: {
            regulatoryLocation:
              GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
            regulatoryCountryCode: "XX",
          },
          discovery: {
            identifierData: { shortDiscriminator: manual.shortDiscriminator },
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

    async decommission(nodeIdStr: string): Promise<void> {
      const ctl = requireController();
      const nodeId = NodeId(BigInt(nodeIdStr));
      const node = await ctl.getNode(nodeId);
      try {
        await node.decommission();
      } catch (err) {
        logger.warn("Graceful decommission failed, removing node: %s", err);
        await ctl.removeNode(nodeId, false);
      }
      logger.info("Device decommissioned: %s", nodeIdStr);
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
    addresses: device.addresses.map((a) => ({
      ip: "ip" in a ? a.ip : "",
      port: "port" in a ? a.port : 0,
      type: a.type,
    })),
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

  if (attributes.onOff !== undefined) {
    return attributes.onOff ? "on" : "off";
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
  await fn(args ?? {});
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
