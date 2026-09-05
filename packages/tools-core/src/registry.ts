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
// WARP-1443: network depth — bandwidth, VPN peer visibility, threat feed
// (handler role-gated), Wi-Fi password rotation, per-device schedules.
import getBandwidthUsage from "./handlers/network/get-bandwidth-usage.js";
import listVpnPeers from "./handlers/network/list-vpn-peers.js";
import listThreatEvents from "./handlers/network/list-threat-events.js";
import setWifiPassword from "./handlers/network/set-wifi-password.js";
import setDeviceSchedule from "./handlers/network/set-device-schedule.js";

// files
import listFiles from "./handlers/files/list-files.js";
import readFile from "./handlers/files/read-file.js";
import searchFiles from "./handlers/files/search-files.js";
import searchContent from "./handlers/files/search-content.js";
// Whole-document read over the file-indexer's extracted text — the PDF /
// scanned-document path `read_file` cannot serve (it rejects declared
// binaries) and `search_content` only answers query-shaped questions for.
import readDocumentText from "./handlers/files/read-document-text.js";
import listRecentFiles from "./handlers/files/list-recent-files.js";
import writeFile from "./handlers/files/write-file.js";
import deleteFile from "./handlers/files/delete-file.js";
import createDirectory from "./handlers/files/create-directory.js";
import renameFile from "./handlers/files/rename-file.js";
import moveFile from "./handlers/files/move-file.js";
import copyFile from "./handlers/files/copy-file.js";
// WARP-1426: summarize a file via the orchestrator's single-turn completion
import summarizeFile from "./handlers/files/summarize-file.js";
// WARP-1456/1458: document tools — versions (list/restore), public share,
// and empty docx/xlsx creation from committed OOXML seed templates.
import listFileVersions from "./handlers/files/list-file-versions.js";
import restoreFileVersion from "./handlers/files/restore-file-version.js";
import shareFile from "./handlers/files/share-file.js";
import createDocument from "./handlers/files/create-document.js";
// WARP-2212 — document GENERATION, as opposed to createDocument's empty seed.
// These send a spec to POST /api/files/render; the model never handles bytes.
import createPdfReport from "./handlers/files/create-pdf-report.js";
import createWordDocument from "./handlers/files/create-word-document.js";
import createSpreadsheet from "./handlers/files/create-spreadsheet.js";
// WARP-2664 — file cleanup: a read-only report (what could go, what an
// organize would do), then the two approved writes it feeds. Bulk delete is
// its own tool rather than a loop over delete_file so ONE confirmation is
// bound to the exact path list.
import analyzeFileCleanup from "./handlers/files/analyze-file-cleanup.js";
import organizeFiles from "./handlers/files/organize-files.js";
import deleteFiles from "./handlers/files/delete-files.js";

// smart-home
import listSmartHomeDevices from "./handlers/smart-home/list-smart-home-devices.js";
import getSmartHomeDevice from "./handlers/smart-home/get-smart-home-device.js";
import controlDevice from "./handlers/smart-home/control-device.js";
import discoverMatterDevices from "./handlers/smart-home/discover-matter-devices.js";
import commissionDevice from "./handlers/smart-home/commission-device.js";
import getCommandHistory from "./handlers/smart-home/get-command-history.js";
// WARP-474: G2 smart-home scenes
import runScene from "./handlers/smart-home/run-scene.js";
// WARP-1447: unpair a Matter device (Tier-2: write + handler-enforced confirm)
import removeDevice from "./handlers/smart-home/remove-device.js";
// WARP-1447: author a scene from chat (two-step confirm; POST /api/scenes)
import createScene from "./handlers/smart-home/create-scene.js";
// WARP-1447: room assignment ("move the lamp to the den"; auto-creates rooms)
import assignDeviceRoom from "./handlers/smart-home/assign-device-room.js";

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
// WARP-1440: camera depth — semantic event search, health, detect/record
// toggle, zones, clip deletion (all via ctx.http.orchestrator).
import searchCameraEvents from "./handlers/cameras/search-camera-events.js";
import getCameraHealth from "./handlers/cameras/get-camera-health.js";
import getCameraStorage from "./handlers/cameras/get-camera-storage.js";
import setCameraDetection from "./handlers/cameras/set-camera-detection.js";
import setDetectionZones from "./handlers/cameras/set-detection-zones.js";
import deleteClip from "./handlers/cameras/delete-clip.js";
// WARP-1893: rename a camera's household-facing label (displayName only —
// never the Frigate config key, which owns the recordings).
import renameCamera from "./handlers/cameras/rename-camera.js";

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
// WARP-1452: text search over the local calendar (pure prisma)
import searchCalendarEvents from "./handlers/calendar/search-events.js";

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
import getGpuStatus from "./handlers/system/get-gpu-status.js";
import getSystemHealth from "./handlers/system/get-system-health.js";
import listDrives from "./handlers/system/list-drives.js";
// BUG-3: read-only storage-pool (mdadm) inventory. Destructive pool ops are
// deliberately NOT registered here (ADR-019 D5 — AI-blocked entirely).
import listStoragePools from "./handlers/system/list-storage-pools.js";
// WARP-1450: appliance ops — drive SMART health, audit trail (handler
// role-gated), OTA status, and the confirmation-gated apply (fire-and-
// return on the server's 202; never awaits completion).
import getDriveHealth from "./handlers/system/get-drive-health.js";
import getAuditLog from "./handlers/system/get-audit-log.js";
import getUpdateStatus from "./handlers/system/get-update-status.js";
import applyUpdate from "./handlers/system/apply-update.js";
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
// WARP-1452: contacts derived on-read from indexed mail senders (pure prisma)
import searchContacts from "./handlers/email/search-contacts.js";

// Native PM module (ADR-026) — tools dispatch through the orchestrator
// WARP-509 — write tools
// Project creation — completes the write surface: work items could only
// ever be added to a project a human had already made by hand.
// WARP-508's five PM read tools are GONE (ADR-045 slice C) — `business_find`
// serves projects and work items now. The write tools above are untouched.

// WARP-2546 — CRM tools. The differentiator a cloud CRM cannot ship: the model
// that reads the pipeline runs on the box, so "draft a follow-up to every deal
// idle 14+ days" never sends a customer list to a vendor.
//
// ADR-045 slice C removed the five CRM READS; the two write tools stay here
// until slice D. `crm-orch.ts` survives with them and keeps the money and
// provenance rules that `handlers/business/_graph.ts` imports.

// ERP-connector framework (WARP-1094) — Eaglesoft as provider #1. DB-
// independent slice: handlers return ERP_NOT_CONNECTED; the live read/write
// paths ship in WARP-1095+. Read tools are Read-tier; the appointment
// scheduler is Write-tier (requiresWrite + requiresConfirmation, brief §11.6).
import erpGetScheduleToday from "./handlers/erp/get-schedule-today.js";
import erpFindPatient from "./handlers/erp/find-patient.js";
import erpGetArSummary from "./handlers/erp/get-ar-summary.js";
import erpScheduleAppointment from "./handlers/erp/schedule-appointment.js";
import moneyListOpenDocuments from "./handlers/money/list-open-documents.js";

// cloud (WARP-2497) — the connected SaaS accounts (Stripe / HubSpot /
// Mailchimp). Deliberately ONE tool for all three vendors and all ten record
// shapes: the dataset name selects the provider inside the orchestrator, so
// the registry's serialized size grows by one small block instead of ten.
import cloudQueryDataset from "./handlers/cloud/query-dataset.js";

// business (WARP-1120) — read-only structured business-profile access
import businessProfileGet from "./handlers/business/profile-get.js";
// ADR-045 slice D — the WRITE half of the tool collapse. Three verbs over
// the CRM and the tracker together, replacing seven single-purpose tools.
// All three are Tier-2 (requiresWrite + requiresConfirmation, enforced by
// the WARP-2305 interceptor; no handler-side prompt).
import businessCreate from "./handlers/business/create.js";
import businessUpdate from "./handlers/business/update.js";
import businessLink from "./handlers/business/link.js";
// business graph (ADR-045 slice C) — two verbs over one typed graph, replacing
// ten noun-shaped CRM/PM reads. See handlers/business/find.ts for the full
// rationale, including why `entity` is an enum and what the fallback is.
import businessFind from "./handlers/business/find.js";
import businessTimeline from "./handlers/business/timeline.js";

// team chat (WARP-1685) — Messages sends on the acting human's behalf.
// Both Tier-2 (requiresWrite + handler-enforced two-phase confirmation);
// dispatch via /api/team-chat as X-Droplet-User = ctx.userId.
import teamChatSendMessage from "./handlers/team-chat/send-message.js";
import teamChatSendMeetingInvite from "./handlers/team-chat/send-meeting-invite.js";

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
// data (WARP-1436): ambient web data (weather/rates) via the screened
// /api/web routes — ambient_data off-LAN channel, fail-closed.
import getWeather from "./handlers/data/get-weather.js";
import currencyConvert from "./handlers/data/currency-convert.js";
// WARP-2180: durable background runs (epic WARP-2176)
import startAgentRun from "./handlers/agent-runs/start-agent-run.js";
import listAgentRuns from "./handlers/agent-runs/list-agent-runs.js";

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
  // WARP-1443: network depth (reads Tier-1; password/schedule Tier-2)
  getBandwidthUsage,
  listVpnPeers,
  listThreatEvents,
  setWifiPassword,
  setDeviceSchedule,
  // files
  listFiles,
  readFile,
  searchFiles,
  searchContent,
  readDocumentText,
  listRecentFiles,
  writeFile,
  deleteFile,
  createDirectory,
  renameFile,
  moveFile,
  copyFile,
  // WARP-1426: file summarization (read_file semantics + /api/llm/complete)
  summarizeFile,
  // WARP-1456: versions + share (restore/share Tier-2 confirm); WARP-1458:
  // create_document (Write-tier). Depend on the WARP-1460 upload-route fix.
  listFileVersions,
  restoreFileVersion,
  shareFile,
  createDocument,
  createPdfReport,
  createWordDocument,
  createSpreadsheet,
  analyzeFileCleanup,
  organizeFiles,
  deleteFiles,
  // smart-home
  listSmartHomeDevices,
  getSmartHomeDevice,
  controlDevice,
  discoverMatterDevices,
  commissionDevice,
  getCommandHistory,
  // WARP-474: G2 smart-home scenes (run by name or id)
  runScene,
  // WARP-1447: unpair a Matter device (Tier-2: write + handler-enforced confirm)
  removeDevice,
  // WARP-1447: create a scene from chat (two-step confirm)
  createScene,
  // WARP-1447: put a device in a room (write tier, no confirmation —
  // reversible household bookkeeping, same posture as create_reminder)
  assignDeviceRoom,
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
  // WARP-1440: camera depth (search/health Tier-1; toggle/zones/delete Tier-2)
  searchCameraEvents,
  getCameraHealth,
  getCameraStorage,
  setCameraDetection,
  setDetectionZones,
  deleteClip,
  renameCamera,
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
  // WARP-1452: calendar text search (Tier-1, pure prisma)
  searchCalendarEvents,
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
  getGpuStatus,
  getSystemHealth,
  listDrives,
  listStoragePools,
  // WARP-1450: appliance ops (reads Tier-1 incl. role-gated audit; apply Tier-2)
  getDriveHealth,
  getAuditLog,
  getUpdateStatus,
  applyUpdate,
  // WARP-466: D2 email
  emailSearch,
  emailRead,
  emailSummarizeThread,
  emailDraftReply,
  emailSend,
  // WARP-1452: derived contacts search (Tier-1, pure prisma)
  searchContacts,
  // WARP-461: durable memory facts
  memoryRecall,
  memoryExtractFact,
  // WARP-1425: forget a remembered fact (Tier-2: write + confirmation)
  memoryForget,
  // WARP-509: native PM (write tools — requiresWrite + requiresConfirmation)
  // ADR-045 slice C: the PM read tools and the CRM read tools were replaced by
  // `business_find` / `business_timeline` (registered under business, below).
  // WARP-1094: ERP-connector (Eaglesoft) — 3 Read-tier + 1 Write-tier
  erpGetScheduleToday,
  erpFindPatient,
  erpGetArSummary,
  moneyListOpenDocuments,
  erpScheduleAppointment,
  // WARP-2497: cloud connectors (Stripe/HubSpot/Mailchimp) — one Read-tier
  // tool covering all ten datasets; the dataset arg picks the provider.
  cloudQueryDataset,
  // WARP-1120: business-knowledge layer (read-only Tier 1)
  businessProfileGet,
  // ADR-045 slice D: business writes (Tier-2 — write + confirmation)
  businessCreate,
  businessUpdate,
  businessLink,
  // ADR-045 slice C: the business graph (both read-only Tier 1)
  businessFind,
  businessTimeline,
  // WARP-1685: Messages sends (Tier-2: write + two-phase confirmation)
  teamChatSendMessage,
  teamChatSendMeetingInvite,
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
  // WARP-1436: ambient web data (Tier-1; screened egress via /api/web)
  getWeather,
  currencyConvert,
  // WARP-2180: background agent runs — start is Tier-2 (unattended compute),
  // list is Tier-1. The worker keeps start_agent_run OUT of a run's pool.
  startAgentRun,
  listAgentRuns,
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(allTools.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS.get(name);
}
