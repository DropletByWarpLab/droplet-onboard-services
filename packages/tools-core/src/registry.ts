import type { Tool } from "./types.js";
import listNetworkDevices from "./handlers/network/list-network-devices.js";
import getNetworkStatus from "./handlers/network/get-network-status.js";
import blockNetworkDevice from "./handlers/network/block-network-device.js";
import listSmartHomeDevices from "./handlers/smart-home/list-smart-home-devices.js";
import listFiles from "./handlers/files/list-files.js";

const allTools: Tool[] = [
  listNetworkDevices,
  getNetworkStatus,
  blockNetworkDevice,
  listSmartHomeDevices,
  listFiles,
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(allTools.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS.get(name);
}
