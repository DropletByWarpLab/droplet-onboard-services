/**
 * Matter controller service — native Matter device discovery, commissioning, and control.
 *
 * Embeds matter.js directly in the orchestrator process. Handles:
 *  - mDNS-SD discovery of uncommissioned devices
 *  - PASE commissioning via pairing codes
 *  - Cluster-based device control (OnOff, LevelControl, Thermostat, etc.)
 *  - Real-time state subscriptions via attribute change events
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
import { Ble, type CommissionableDevice } from "@matter/main/protocol";
import { config } from "../config.js";
import type {
  MatterCommissionedDevice,
  MatterDiscoveredDevice,
  MatterEndpointInfo,
  MatterGrouped,
  SmartHomeCategory,
} from "../types/smart-home.js";
import { recordActivity } from "./activity.singleton.js";

const logger = pino({ name: "matter" });

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

// --- Module state ---

let controller: CommissioningController | null = null;
let _initialized = false;
const stateEvents = new EventEmitter();

// --- Initialization ---

export async function initMatterService(): Promise<void> {
  // Ensure storage directory exists
  fs.mkdirSync(config.MATTER_STORAGE_PATH, { recursive: true });

  controller = new CommissioningController({
    environment: {
      environment: Environment.default,
      id: "droplet-controller",
    },
    autoConnect: true,
    adminFabricLabel: config.DROPLET_MATTER_CONTROLLER_NAME,
  });

  await controller.start();
  _initialized = true;

  const nodes = controller.getCommissionedNodes();
  logger.info(
    "Matter controller started — %d commissioned node(s)",
    nodes.length,
  );

  // Set up state change listeners for all existing nodes
  for (const nodeId of nodes) {
    setupNodeListeners(nodeId).catch((err) => {
      logger.debug("Failed to setup listeners for node %s: %s", nodeId, err);
    });
  }
}

export function isMatterInitialized(): boolean {
  return _initialized;
}

// --- Capabilities ---

export interface MatterCapabilities {
  /**
   * Whether BLE commissioning is available on this box. False means the
   * box can only commission devices that are already reachable on the IP
   * network — devices that require Bluetooth for first-time setup cannot
   * be paired until WARP-850 lands.
   */
  bleCommissioning: boolean;
}

/**
 * WARP-851: controller capability surface for the dashboard.
 *
 * Derivation mirrors matter.js exactly: @matter/node's
 * NetworkServer.initialize() sets `state.ble = env.has(Ble)`, and
 * CommissioningController.start() logs "BLE is not enabled on this
 * platform" when that resolves false. A `Ble` implementation is
 * registered in `Environment.default` only when a BLE transport (e.g.
 * @matter/nodejs-ble) has been installed and wired in — we don't ship
 * one, and the orchestrator container has no Bluetooth adapter, so this
 * is false on every current deployment shape.
 *
 * Environment-derived, not controller-state-derived: answers correctly
 * even before/without `initMatterService()`.
 */
export function getMatterCapabilities(): MatterCapabilities {
  return { bleCommissioning: Environment.default.has(Ble) };
}

export async function shutdownMatterService(): Promise<void> {
  if (controller) {
    await controller.close();
    controller = null;
  }
  _initialized = false;
  logger.info("Matter controller stopped");
}

// --- Discovery ---

export async function discoverDevices(
  timeoutMs = 15_000,
): Promise<MatterDiscoveredDevice[]> {
  if (!controller) throw new Error("Matter controller not initialized");

  logger.info("Starting Matter device discovery (timeout: %dms)", timeoutMs);

  const timeoutSec = (timeoutMs / 1000) as Duration;
  const devices = await controller.discoverCommissionableDevices(
    {} as any, // Empty identifier = discover all
    undefined,
    undefined,
    timeoutSec,
  );

  return devices.map(commissionableToDiscovered);
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
    addresses: device.addresses.map((a) => ({
      ip: "ip" in a ? a.ip : "",
      port: "port" in a ? a.port : 0,
      type: a.type,
    })),
  };
}

// --- Commissioning ---

export async function commissionDevice(
  pairingCode: string,
): Promise<{ nodeId: string }> {
  if (!controller) throw new Error("Matter controller not initialized");

  const trimmed = pairingCode.trim();
  let options: NodeCommissioningOptions;

  if (trimmed.startsWith("MT:")) {
    // QR code payload — decode returns an array, take the first entry
    const qrList = QrPairingCodeCodec.decode(trimmed);
    const qr = qrList[0];
    if (!qr) throw new Error("Invalid QR pairing code");
    options = {
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
    options = {
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
  const nodeId = await controller.commissionNode(options);
  logger.info("Device commissioned successfully: nodeId=%s", nodeId);

  // Set up listeners for the new node
  await setupNodeListeners(nodeId);

  // WARP-456: audit row for the commission write. Commissioning is the
  // highest-impact Matter operation — the appliance now owns the
  // device's network credentials and can drive it.
  await recordActivity({
    kind: "smart_home",
    severity: "ok",
    sourceIcon: "plug",
    what: "Commissioned Matter device",
    sub: `nodeId ${String(nodeId)}`,
    refs: { nodeId: String(nodeId) },
  });

  return { nodeId: String(nodeId) };
}

// --- Decommissioning ---

export async function decommissionDevice(nodeIdStr: string): Promise<void> {
  if (!controller) throw new Error("Matter controller not initialized");

  const nodeId = NodeId(BigInt(nodeIdStr));
  const node = await controller.getNode(nodeId);
  try {
    await node.decommission();
  } catch (err) {
    logger.warn("Graceful decommission failed, removing node: %s", err);
    await controller.removeNode(nodeId, false);
  }
  logger.info("Device decommissioned: %s", nodeIdStr);

  // WARP-456: audit row for the destructive write.
  await recordActivity({
    kind: "smart_home",
    severity: "warn",
    sourceIcon: "unplug",
    what: "Decommissioned Matter device",
    sub: `nodeId ${nodeIdStr}`,
    refs: { nodeId: nodeIdStr },
  });
}

// --- Device listing ---

export async function getCommissionedDevices(): Promise<MatterGrouped> {
  if (!controller) throw new Error("Matter controller not initialized");

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

  const nodeIds = controller.getCommissionedNodes();

  for (const nodeId of nodeIds) {
    try {
      const device = await buildDeviceInfo(nodeId);
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
}

export async function getDevice(
  nodeIdStr: string,
): Promise<MatterCommissionedDevice | null> {
  if (!controller) throw new Error("Matter controller not initialized");

  const nodeId = NodeId(BigInt(nodeIdStr));
  if (!controller.isNodeCommissioned(nodeId)) return null;

  return buildDeviceInfo(nodeId);
}

async function buildDeviceInfo(
  nodeId: NodeId,
): Promise<MatterCommissionedDevice | null> {
  if (!controller) return null;

  const node = await controller.getNode(nodeId);
  const basicInfo = node.basicInformation;

  // Build endpoint info
  const endpoints: MatterEndpointInfo[] = [];
  let primaryCategory: SmartHomeCategory = "switch"; // default
  const attributes: Record<string, unknown> = {};

  for (const [epId, endpoint] of node.parts) {
    // Access device types and server clusters from the Descriptor cluster
    const descriptor = endpoint.state?.descriptor;
    const deviceTypes = (descriptor?.deviceTypeList ?? []).map((dt: any) => ({
      deviceType: Number(dt.deviceType),
      revision: Number(dt.revision ?? 1),
    }));
    const clusters = (descriptor?.serverList ?? []).map((c: any) => Number(c));

    endpoints.push({
      endpointId: epId,
      deviceTypes,
      clusters,
    });

    // Determine category from the first non-root endpoint's device type
    if (epId > 0) {
      for (const dt of deviceTypes) {
        const cat = DEVICE_TYPE_CATEGORY[dt.deviceType];
        if (cat) {
          primaryCategory = cat;
          break;
        }
      }

      // Fallback: infer from clusters if no device type match
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

      // Read state attributes from the endpoint
      try {
        readEndpointAttributes(endpoint, attributes);
      } catch {
        // Attributes may not be available if not connected
      }
    }
  }

  // Determine state string
  const state = deriveStateString(primaryCategory, attributes, node);

  // Map NodeStates enum to string
  const connectionStateMap: Record<number, MatterCommissionedDevice["connectionState"]> = {
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

function readEndpointAttributes(
  endpoint: any,
  attributes: Record<string, unknown>,
): void {
  // Try to read common cluster attributes from cached state
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
  category: SmartHomeCategory,
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

// --- Commands ---

export async function sendMatterCommand(
  nodeIdStr: string,
  command: string,
  data?: Record<string, unknown>,
): Promise<{ status: string; result?: unknown }> {
  // WARP-456: wrap the dispatcher so every Matter write — success or
  // failure — lands as one signed ActivityRow. `_sendMatterCommandInner`
  // does the real work; the wrapper only reacts to the outcome.
  let result: { status: string; result?: unknown } | undefined;
  let threw: unknown = null;
  try {
    result = await _sendMatterCommandInner(nodeIdStr, command, data);
    return result;
  } catch (err) {
    threw = err;
    throw err;
  } finally {
    await recordActivity({
      kind: "smart_home",
      severity: threw ? "err" : "ok",
      sourceIcon: "home",
      what: threw
        ? `Matter ${command} failed`
        : `Matter ${command}`,
      sub: `nodeId ${nodeIdStr}`,
      refs: {
        nodeId: nodeIdStr,
        command,
      },
    });
  }
}

async function _sendMatterCommandInner(
  nodeIdStr: string,
  command: string,
  data?: Record<string, unknown>,
): Promise<{ status: string; result?: unknown }> {
  if (!controller) throw new Error("Matter controller not initialized");

  const nodeId = NodeId(BigInt(nodeIdStr));
  const node = await controller.getNode(nodeId);

  if (node.connectionState !== NodeStates.Connected) {
    throw new Error(`Device ${nodeIdStr} is not connected`);
  }

  // Find the first functional endpoint (skip root endpoint 0)
  const endpointId = data?.endpoint_id
    ? Number(data.endpoint_id)
    : findFunctionalEndpoint(node);

  const endpoint = node.parts.get(endpointId);
  if (!endpoint) throw new Error(`Endpoint ${endpointId} not found on device`);

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
      // Write absolute setpoint (Matter uses units of 0.01 degC)
      const setpoint = Math.round(temp * 100);
      const thermoState = (endpoint.state as any)?.thermostat;
      if (!thermoState) throw new Error("Thermostat cluster not found on endpoint");
      if (mode === 1) {
        // Cooling
        await writeClusterAttribute(endpoint, "thermostat", "occupiedCoolingSetpoint", setpoint);
      } else {
        // Heating (default)
        await writeClusterAttribute(endpoint, "thermostat", "occupiedHeatingSetpoint", setpoint);
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
  // Use the endpoint's InteractionClient to write attributes
  const cluster = endpoint.getClusterClientById?.(clusterName) ??
    endpoint.getClusterClient?.(clusterName);
  if (cluster && typeof cluster.setAttribute === "function") {
    await cluster.setAttribute(attributeName, value);
    return;
  }
  // Fallback: attempt via commands if a set command exists
  const setCommand = `set${attributeName.charAt(0).toUpperCase()}${attributeName.slice(1)}`;
  await invokeClusterCommand(endpoint, clusterName, setCommand, { [attributeName]: value });
}

// --- State subscriptions ---

async function setupNodeListeners(nodeId: NodeId): Promise<void> {
  if (!controller) return;

  const node = await controller.getNode(nodeId);

  node.events.attributeChanged.on((data: any) => {
    stateEvents.emit("state_changed", {
      nodeId: String(nodeId),
      path: data.path,
      value: data.value,
    });
  });

  node.events.stateChanged.on((newState: NodeStates) => {
    stateEvents.emit("connection_changed", {
      nodeId: String(nodeId),
      connectionState: newState,
    });
  });
}

export function subscribeStateChanges(
  callback: (event: any) => void,
): () => void {
  stateEvents.on("state_changed", callback);
  return () => stateEvents.off("state_changed", callback);
}

export function subscribeConnectionChanges(
  callback: (event: any) => void,
): () => void {
  stateEvents.on("connection_changed", callback);
  return () => stateEvents.off("connection_changed", callback);
}
