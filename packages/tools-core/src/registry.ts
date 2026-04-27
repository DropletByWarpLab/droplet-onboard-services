import type { Tool } from "./types.js";

// network
import listNetworkDevices from "./handlers/network/list-network-devices.js";
import getNetworkStatus from "./handlers/network/get-network-status.js";
import listDhcpLeases from "./handlers/network/list-dhcp-leases.js";
import getWifiSettings from "./handlers/network/get-wifi-settings.js";
import scanWifiNetworks from "./handlers/network/scan-wifi-networks.js";
import setWifiSsid from "./handlers/network/set-wifi-ssid.js";
import setWifiChannel from "./handlers/network/set-wifi-channel.js";
import getFirewallRules from "./handlers/network/get-firewall-rules.js";
import blockNetworkDevice from "./handlers/network/block-network-device.js";
import unblockNetworkDevice from "./handlers/network/unblock-network-device.js";
import addPortForward from "./handlers/network/add-port-forward.js";
import getRouterSystemInfo from "./handlers/network/get-router-system-info.js";

// files
import listFiles from "./handlers/files/list-files.js";
import readFile from "./handlers/files/read-file.js";
import searchFiles from "./handlers/files/search-files.js";
import searchContent from "./handlers/files/search-content.js";
import listRecentFiles from "./handlers/files/list-recent-files.js";
import writeFile from "./handlers/files/write-file.js";
import deleteFile from "./handlers/files/delete-file.js";
import createDirectory from "./handlers/files/create-directory.js";
import renameFile from "./handlers/files/rename-file.js";
import moveFile from "./handlers/files/move-file.js";
import copyFile from "./handlers/files/copy-file.js";

// smart-home
import listSmartHomeDevices from "./handlers/smart-home/list-smart-home-devices.js";

const allTools: Tool[] = [
  // network
  listNetworkDevices,
  getNetworkStatus,
  listDhcpLeases,
  getWifiSettings,
  scanWifiNetworks,
  setWifiSsid,
  setWifiChannel,
  getFirewallRules,
  blockNetworkDevice,
  unblockNetworkDevice,
  addPortForward,
  getRouterSystemInfo,
  // files
  listFiles,
  readFile,
  searchFiles,
  searchContent,
  listRecentFiles,
  writeFile,
  deleteFile,
  createDirectory,
  renameFile,
  moveFile,
  copyFile,
  // smart-home
  listSmartHomeDevices,
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(allTools.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS.get(name);
}
