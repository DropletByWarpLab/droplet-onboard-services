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
import setPhoneHomeBlocking from "./handlers/network/set-phone-home-blocking.js";
import addPortForward from "./handlers/network/add-port-forward.js";
import getRouterSystemInfo from "./handlers/network/get-router-system-info.js";
import restartRouter from "./handlers/network/restart-router.js";
// WARP-470: F2 network throughput summary (network_check card)
import networkSummary from "./handlers/network/summary.js";
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
// WARP-1426: summarize a file via the orchestrator's single-turn completion
import summarizeFile from "./handlers/files/summarize-file.js";

// smart-home
import listSmartHomeDevices from "./handlers/smart-home/list-smart-home-devices.js";
import getSmartHomeDevice from "./handlers/smart-home/get-smart-home-device.js";
import controlDevice from "./handlers/smart-home/control-device.js";
import discoverMatterDevices from "./handlers/smart-home/discover-matter-devices.js";
import commissionDevice from "./handlers/smart-home/commission-device.js";
import getCommandHistory from "./handlers/smart-home/get-command-history.js";
// WARP-474: G2 smart-home scenes
import runScene from "./handlers/smart-home/run-scene.js";

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
// WARP-1425: countdown timer over the Reminder model (server-side now+duration)
import setTimer from "./handlers/reminders/set-timer.js";

// notifications
import sendNotification from "./handlers/notifications/send-notification.js";
import listNotifications from "./handlers/notifications/list-notifications.js";

// system
import getSystemHealth from "./handlers/system/get-system-health.js";
import listDrives from "./handlers/system/list-drives.js";
// BUG-3: read-only storage-pool (mdadm) inventory. Destructive pool ops are
// deliberately NOT registered here (ADR-019 D5 — AI-blocked entirely).
import listStoragePools from "./handlers/system/list-storage-pools.js";
// WARP-461: durable memory facts (Phase B4)
import memoryRecall from "./handlers/memory/recall.js";
import memoryExtractFact from "./handlers/memory/extract.js";
// WARP-1425: forget a remembered fact (soft-disable; Tier-2 confirm flow)
import memoryForget from "./handlers/memory/forget.js";

// WARP-466: D2 email tools
import emailSearch from "./handlers/email/search.js";
import emailRead from "./handlers/email/read.js";
import emailSummarizeThread from "./handlers/email/summarize-thread.js";
import emailDraftReply from "./handlers/email/draft-reply.js";
import emailSend from "./handlers/email/send.js";

// Native PM module (ADR-026) — tools dispatch through the orchestrator
// WARP-509 — write tools
import pmCreateWorkItem from "./handlers/pm/create-work-item.js";
import pmUpdateWorkItem from "./handlers/pm/update-work-item.js";
import pmAddWorkItemComment from "./handlers/pm/add-work-item-comment.js";
import pmTransitionWorkItem from "./handlers/pm/transition-work-item.js";
// WARP-508 — read tools
import pmListWorkspaces from "./handlers/pm/list-workspaces.js";
import pmListProjects from "./handlers/pm/list-projects.js";
import pmListWorkItems from "./handlers/pm/list-work-items.js";
import pmGetWorkItem from "./handlers/pm/get-work-item.js";
import pmSearchWorkItems from "./handlers/pm/search-work-items.js";

// ERP-connector framework (WARP-1094) — Eaglesoft as provider #1. DB-
// independent slice: handlers return ERP_NOT_CONNECTED; the live read/write
// paths ship in WARP-1095+. Read tools are Read-tier; the appointment
// scheduler is Write-tier (requiresWrite + requiresConfirmation, brief §11.6).
import erpGetScheduleToday from "./handlers/erp/get-schedule-today.js";
import erpFindPatient from "./handlers/erp/find-patient.js";
import erpGetArSummary from "./handlers/erp/get-ar-summary.js";
import erpScheduleAppointment from "./handlers/erp/schedule-appointment.js";

// business (WARP-1120) — read-only structured business-profile access
import businessProfileGet from "./handlers/business/profile-get.js";

// data (WARP-899/WARP-900) — encode/decode, hashing, format conversion.
// All Tier-1 read/pure-computation: no I/O, no app secrets, no network egress.
import encodeText from "./handlers/data/encode-text.js";
import decodeText from "./handlers/data/decode-text.js";
import hashText from "./handlers/data/hash-text.js";
import convertDataFormat from "./handlers/data/convert-format.js";
import formatJson from "./handlers/data/format-json.js";
// data (WARP-901) — misc dev utilities, all Tier-1 read/pure-computation
import timestampConvert from "./handlers/data/timestamp-convert.js";
import uuidGenerate from "./handlers/data/uuid-generate.js";
import regexTest from "./handlers/data/regex-test.js";
// data (WARP-1424) — everyday utilities (calculator, unit/date/time math),
// all Tier-1 read/pure-computation. Gap analysis: WARP-1423.
import calculate from "./handlers/data/calculate.js";
import unitConvert from "./handlers/data/unit-convert.js";
import getCurrentDatetime from "./handlers/data/get-current-datetime.js";
import dateMath from "./handlers/data/date-math.js";
// data (WARP-1426): translation via the orchestrator's single-turn completion
import translateText from "./handlers/data/translate-text.js";

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
  // WARP-613: phone-home egress control
  setPhoneHomeBlocking,
  addPortForward,
  getRouterSystemInfo,
  restartRouter,
  // WARP-470: F2 network KPI rollup → network_check card
  networkSummary,
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
  // WARP-1426: file summarization (read_file semantics + /api/llm/complete)
  summarizeFile,
  // smart-home
  listSmartHomeDevices,
  getSmartHomeDevice,
  controlDevice,
  discoverMatterDevices,
  commissionDevice,
  getCommandHistory,
  // WARP-474: G2 smart-home scenes (run by name or id)
  runScene,
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
  // WARP-1425: countdown timer (cancel/list ride complete_reminder/list_reminders)
  setTimer,
  // notifications
  sendNotification,
  listNotifications,
  // system
  getSystemHealth,
  listDrives,
  listStoragePools,
  // WARP-466: D2 email
  emailSearch,
  emailRead,
  emailSummarizeThread,
  emailDraftReply,
  emailSend,
  // WARP-461: durable memory facts
  memoryRecall,
  memoryExtractFact,
  // WARP-1425: forget a remembered fact (Tier-2: write + confirmation)
  memoryForget,
  // WARP-509: native PM (write tools — requiresWrite + requiresConfirmation)
  pmCreateWorkItem,
  pmUpdateWorkItem,
  pmAddWorkItemComment,
  pmTransitionWorkItem,
  // WARP-508: native PM (read tools — list/get/search)
  pmListWorkspaces,
  pmListProjects,
  pmListWorkItems,
  pmGetWorkItem,
  pmSearchWorkItems,
  // WARP-1094: ERP-connector (Eaglesoft) — 3 Read-tier + 1 Write-tier
  erpGetScheduleToday,
  erpFindPatient,
  erpGetArSummary,
  erpScheduleAppointment,
  // WARP-1120: business-knowledge layer (read-only Tier 1)
  businessProfileGet,
  // WARP-899/WARP-900: data-utility domain (encode/decode, hashing, format
  // conversion) — all Tier-1 read/pure-computation.
  encodeText,
  decodeText,
  hashText,
  convertDataFormat,
  formatJson,
  // WARP-901: misc dev utilities (all Tier-1 read/pure-computation)
  timestampConvert,
  uuidGenerate,
  regexTest,
  // WARP-1424: everyday utility tools (all Tier-1 read/pure-computation)
  calculate,
  unitConvert,
  getCurrentDatetime,
  dateMath,
  // WARP-1426: translation (Tier-1; single-turn completion via orchestrator)
  translateText,
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(allTools.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS.get(name);
}
