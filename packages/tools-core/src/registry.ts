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
// WARP-446 — coverage extender AP onboarding
import listApDevices from "./handlers/network/list-ap-devices.js";
import approveAp from "./handlers/network/approve-ap.js";
import decommissionAp from "./handlers/network/decommission-ap.js";

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
import getSmartHomeDevice from "./handlers/smart-home/get-smart-home-device.js";
import controlDevice from "./handlers/smart-home/control-device.js";
import discoverMatterDevices from "./handlers/smart-home/discover-matter-devices.js";
import commissionDevice from "./handlers/smart-home/commission-device.js";
import getCommandHistory from "./handlers/smart-home/get-command-history.js";

// cameras
import listCameras from "./handlers/cameras/list-cameras.js";
import listDiscoveredCameras from "./handlers/cameras/list-discovered-cameras.js";
import listCameraEvents from "./handlers/cameras/list-camera-events.js";
import scanForCameras from "./handlers/cameras/scan-for-cameras.js";
import acceptDiscoveredCamera from "./handlers/cameras/accept-discovered-camera.js";
import getCameraSnapshot from "./handlers/cameras/get-camera-snapshot.js";
import listClips from "./handlers/cameras/list-clips.js";
import exportClip from "./handlers/cameras/export-clip.js";
import getCameraLiveUrl from "./handlers/cameras/get-camera-live-url.js";
import shareClip from "./handlers/cameras/share-clip.js";

// switch
import getSwitchPorts from "./handlers/switch/get-switch-ports.js";
import getSwitchVlans from "./handlers/switch/get-switch-vlans.js";
import setPortVlan from "./handlers/switch/set-port-vlan.js";
import getSwitchPoe from "./handlers/switch/get-switch-poe.js";
import setPortPoe from "./handlers/switch/set-port-poe.js";
import detectWanPort from "./handlers/switch/detect-wan-port.js";
import setupCameraPorts from "./handlers/switch/setup-camera-ports.js";

// calendar
import createEvent from "./handlers/calendar/create-event.js";
import listEvents from "./handlers/calendar/list-events.js";
import updateEvent from "./handlers/calendar/update-event.js";
import deleteEvent from "./handlers/calendar/delete-event.js";

// reminders
import createReminder from "./handlers/reminders/create-reminder.js";
import listReminders from "./handlers/reminders/list-reminders.js";
import completeReminder from "./handlers/reminders/complete-reminder.js";

// notifications
import sendNotification from "./handlers/notifications/send-notification.js";
import listNotifications from "./handlers/notifications/list-notifications.js";

// system
import getSystemHealth from "./handlers/system/get-system-health.js";
import listDrives from "./handlers/system/list-drives.js";

// WARP-466: D2 email tools
import emailSearch from "./handlers/email/search.js";
import emailRead from "./handlers/email/read.js";
import emailSummarizeThread from "./handlers/email/summarize-thread.js";
import emailDraftReply from "./handlers/email/draft-reply.js";
import emailSend from "./handlers/email/send.js";

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
  // WARP-446: coverage extender AP onboarding
  listApDevices,
  approveAp,
  decommissionAp,
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
  getSmartHomeDevice,
  controlDevice,
  discoverMatterDevices,
  commissionDevice,
  getCommandHistory,
  // cameras
  listCameras,
  listDiscoveredCameras,
  listCameraEvents,
  scanForCameras,
  acceptDiscoveredCamera,
  getCameraSnapshot,
  listClips,
  exportClip,
  getCameraLiveUrl,
  shareClip,
  // switch
  getSwitchPorts,
  getSwitchVlans,
  setPortVlan,
  getSwitchPoe,
  setPortPoe,
  detectWanPort,
  setupCameraPorts,
  // calendar
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  // reminders
  createReminder,
  listReminders,
  completeReminder,
  // notifications
  sendNotification,
  listNotifications,
  // system
  getSystemHealth,
  listDrives,
  // WARP-466: D2 email
  emailSearch,
  emailRead,
  emailSummarizeThread,
  emailDraftReply,
  emailSend,
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(allTools.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS.get(name);
}
