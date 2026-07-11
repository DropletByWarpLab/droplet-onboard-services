/**
 * WARP-555 — read-only tool catalog.
 *
 * The dashboard `/tools` surface (and any external consumer that wants a
 * "what can this Droplet do" listing) needs three things the JSON-RPC
 * `tools/list` wire shape omits: the tool's **domain** (network, files,
 * cameras, …), and the two safety flags `requiresWrite` /
 * `requiresConfirmation`. The flags live on every {@link Tool}; the domain
 * does not, because at runtime a compiled handler has lost the
 * `handlers/<domain>/` folder it came from.
 *
 * Rather than re-derive the domain from the tool name with a fragile
 * prefix heuristic (`list_files` → files but `list_network_devices` →
 * network, `run_scene` → smart-home, `email_*` → email …), we declare the
 * domain → tool-name grouping here, mirroring the exact grouping in
 * `registry.ts`. Everything else — `description`, `requiresWrite`,
 * `requiresConfirmation` — is read straight off the live `Tool`, so the
 * catalog can never drift from per-tool intent.
 *
 * The completeness invariant ("every registered tool has a catalog
 * entry") is enforced by `__tests__/catalog.test.ts`: add a tool to
 * `registry.ts` without slotting its name into a domain below and the
 * suite goes red. That is the same discipline `WRITE_TOOLS` uses in the
 * orchestrator — derive from the registry, never maintain a silent
 * parallel list.
 */

import { TOOLS } from "./registry.js";

/** A tool's home surface. Ordered to match the dashboard IA so the
 *  filter chips read top-to-bottom the way the sidebar does. */
export type ToolDomain =
  | "network"
  | "files"
  | "smart-home"
  | "cameras"
  | "switch"
  | "calendar"
  | "reminders"
  | "notifications"
  | "email"
  | "memory"
  | "pm"
  | "erp"
  | "business"
  | "system"
  | "data";

export interface ToolCatalogEntry {
  name: string;
  /** Agent-facing description from the registry — written for the LLM, so
   *  it may contain jargon and internal references. NOT for end users. */
  description: string;
  /** Plain-language, home-user-facing one-liner for the dashboard `/tools`
   *  surface (ADR-002). Falls back to a humanized name when unmapped. */
  homeDescription: string;
  domain: ToolDomain;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
}

/**
 * Domain → canonical tool names. Mirrors the grouped imports in
 * `registry.ts`. The only new information here is which surface a tool
 * belongs to; the per-tool flags and copy are NOT duplicated.
 */
const DOMAIN_GROUPS: Record<ToolDomain, string[]> = {
  network: [
    "list_network_devices",
    "get_network_status",
    "list_dhcp_leases",
    "get_wifi_settings",
    "scan_wifi_networks",
    "set_wifi_ssid",
    "set_wifi_channel",
    "get_firewall_rules",
    "block_network_device",
    "unblock_network_device",
    "set_phone_home_blocking",
    "add_port_forward",
    "get_router_system_info",
    "restart_router",
    "network_summary",
    "list_ap_devices",
    "approve_ap",
    "decommission_ap",
  ],
  files: [
    "list_files",
    "read_file",
    "search_files",
    "search_content",
    "list_recent_files",
    "write_file",
    "delete_file",
    "create_directory",
    "rename_file",
    "move_file",
    "copy_file",
  ],
  "smart-home": [
    "list_smart_home_devices",
    "get_smart_home_device",
    "control_device",
    "discover_matter_devices",
    "commission_device",
    "get_command_history",
    "run_scene",
  ],
  cameras: [
    "list_cameras",
    "list_discovered_cameras",
    "list_camera_events",
    "scan_for_cameras",
    "accept_discovered_camera",
    "get_camera_snapshot",
    "list_clips",
    "export_clip",
    "get_camera_live_url",
    "share_clip",
  ],
  switch: [
    "get_switch_ports",
    "get_switch_vlans",
    "set_port_vlan",
    "get_switch_poe",
    "set_port_poe",
    "detect_wan_port",
    "setup_camera_ports",
  ],
  calendar: ["create_event", "list_events", "update_event", "delete_event"],
  reminders: ["create_reminder", "list_reminders", "complete_reminder"],
  notifications: ["send_notification", "list_notifications"],
  email: [
    "email_search",
    "email_read",
    "email_summarize_thread",
    "email_draft_reply",
    "email_send",
  ],
  memory: ["memory_recall", "memory_extract_fact"],
  pm: [
    "pm_create_work_item",
    "pm_update_work_item",
    "pm_add_work_item_comment",
    "pm_transition_work_item",
    "pm_list_workspaces",
    "pm_list_projects",
    "pm_list_work_items",
    "pm_get_work_item",
    "pm_search_work_items",
  ],
  erp: [
    "erp_get_schedule_today",
    "erp_find_patient",
    "erp_get_ar_summary",
    "erp_schedule_appointment",
  ],
  business: ["business_profile_get"],
  system: ["get_system_health", "list_drives", "list_storage_pools"],
  data: ["encode_text", "decode_text", "hash_text", "convert_data_format", "format_json"],
};

/** Ordered domain list — drives the filter-chip order in the dashboard. */
export const TOOL_DOMAINS: ToolDomain[] = Object.keys(DOMAIN_GROUPS) as ToolDomain[];

/** Reverse index: tool name → its declared domain. */
const DOMAIN_BY_NAME: ReadonlyMap<string, ToolDomain> = new Map(
  TOOL_DOMAINS.flatMap((domain) =>
    DOMAIN_GROUPS[domain].map((name) => [name, domain] as const),
  ),
);

/**
 * Plain-language, home-user-facing copy for each tool (ADR-002). The
 * registry's `description` is written for the LLM and leaks jargon (VLAN,
 * ubus, § refs, internal product names); the dashboard `/tools` page renders
 * THIS instead. Keyed by the exact registered tool name. A tool with no
 * entry falls back to a humanized name (jargon-free) and is flagged by a unit
 * test, so a newly-added tool can't silently ship agent-facing copy.
 */
export const HOME_DESCRIPTION_BY_NAME: Record<string, string> = {
  // Network
  list_network_devices: "See every device that uses your home network",
  get_network_status: "Check whether your internet and Wi-Fi are working",
  list_dhcp_leases: "See which devices are connected right now and their addresses",
  get_wifi_settings: "View your Wi-Fi name, password, and channel",
  scan_wifi_networks: "Find nearby Wi-Fi networks within range",
  set_wifi_ssid: "Rename your Wi-Fi network",
  set_wifi_channel: "Switch your Wi-Fi to a clearer channel",
  get_firewall_rules: "See what your network is blocking and allowing",
  block_network_device: "Block a device from the internet",
  unblock_network_device: "Let a blocked device back onto the internet",
  set_phone_home_blocking: "Stop cameras and smart devices from sending data to the maker's cloud",
  add_port_forward: "Open an app or service to the internet",
  get_router_system_info: "Check your router's status and how long it's been running",
  restart_router: "Restart your router (takes 30–90 seconds; reconnects all devices automatically)",
  network_summary: "See the health of your home network at a glance",
  list_ap_devices: "See your Wi-Fi extenders that boost coverage",
  approve_ap: "Add a Wi-Fi extender to spread coverage further",
  decommission_ap: "Remove a Wi-Fi extender from your network",
  // Files
  list_files: "Browse the files on your Droplet",
  read_file: "Open and read one of your files",
  search_files: "Find files by name",
  search_content: "Search inside your files for what you need",
  list_recent_files: "See the files you changed most recently",
  write_file: "Save a new file or update an existing one",
  delete_file: "Delete a file from your Droplet",
  create_directory: "Make a new folder",
  rename_file: "Rename a file or folder",
  move_file: "Move a file or folder somewhere else",
  copy_file: "Make a copy of a file or folder",
  // Smart home
  list_smart_home_devices: "See all your smart home devices",
  get_smart_home_device: "Check the status of one smart home device",
  control_device: "Turn a smart device on, off, or adjust it",
  discover_matter_devices: "Find new smart home devices to add",
  commission_device: "Set up a new smart home device",
  get_command_history: "See recent actions taken on your smart devices",
  run_scene: "Run a saved routine like 'movie night' or 'goodnight'",
  // Cameras
  list_cameras: "See all your security cameras and their status",
  list_discovered_cameras: "See new cameras found but not yet added",
  list_camera_events: "See recent motion, people, and cars your cameras spotted",
  scan_for_cameras: "Search for new cameras on your network",
  accept_discovered_camera: "Add a newly found camera and start recording",
  get_camera_snapshot: "Get a still photo from a camera right now",
  list_clips: "Browse saved video clips from your cameras",
  export_clip: "Save a video clip from a camera's recordings",
  get_camera_live_url: "Open a live view of a camera",
  share_clip: "Create a link to share a camera clip with someone",
  // Switch
  get_switch_ports: "See what's plugged into each network port",
  get_switch_vlans: "See how your network ports are grouped",
  set_port_vlan: "Change which group a network port belongs to",
  get_switch_poe: "See how much power each network port is using",
  set_port_poe: "Turn power on or off for a network port",
  detect_wan_port: "Find which port connects to your internet",
  setup_camera_ports: "Set up network ports for your cameras in one step",
  // Calendar
  create_event: "Add an event to your calendar",
  list_events: "See what's on your calendar",
  update_event: "Change an event on your calendar",
  delete_event: "Remove an event from your calendar",
  // Reminders
  create_reminder: "Set a reminder for yourself",
  list_reminders: "See your reminders",
  complete_reminder: "Mark a reminder as done",
  // Notifications
  send_notification: "Send yourself a notification on the dashboard",
  list_notifications: "See notifications you've received",
  // System
  get_system_health: "Check that your Droplet is running smoothly",
  list_drives: "See your storage drives and free space",
  list_storage_pools: "Check your storage pools and whether any need attention",
  // Memory
  memory_recall: "Recall things your Droplet remembers about you",
  memory_extract_fact: "Remember a preference so your Droplet recalls it later",
  // Email
  email_search: "Search your email",
  email_read: "Open and read an email conversation",
  email_summarize_thread: "Get a quick summary of an email conversation",
  email_draft_reply: "Draft a reply to an email for you to review",
  email_send: "Send an email you've approved",
  // Project tracker
  pm_create_work_item: "Add a new task to your project tracker",
  pm_update_work_item: "Update the details of a task",
  pm_add_work_item_comment: "Add a comment to a task",
  pm_transition_work_item: "Move a task to a new status, like done",
  pm_list_workspaces: "See your project tracker workspaces",
  pm_list_projects: "See your projects",
  pm_list_work_items: "See the tasks in a project",
  pm_get_work_item: "See the full details of one task",
  pm_search_work_items: "Search your tasks",
  // ERP (Eaglesoft practice-management integration)
  erp_get_schedule_today: "See the day's appointment schedule from your practice software",
  erp_find_patient: "Look up a patient in your practice software",
  erp_get_ar_summary: "See what patients still owe at a glance",
  erp_schedule_appointment: "Book or move an appointment (you approve it before it's saved)",
  // Business (business-knowledge profile)
  business_profile_get: "Look up what Droplet knows about your business",
  // Data (encode/decode, hashing, format conversion)
  encode_text: "Encode text as base64, hex, or a URL-safe form",
  decode_text: "Decode base64, hex, or URL-encoded text back to plain text",
  hash_text: "Get a checksum-style hash of some text",
  convert_data_format: "Convert data between JSON, CSV, and YAML",
  format_json: "Pretty-print or compact a block of JSON",
};

/** Humanized fallback for a tool with no home description yet — turns
 *  `list_files` into `List files`. Jargon-free by construction, so an
 *  unmapped new tool degrades to a readable name rather than agent copy. */
function sentenceFromName(name: string): string {
  const s = name.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The full read-only catalog, built from the live registry. Iterates the
 * canonical `TOOLS` map so the entry set is exactly the registered tools;
 * the description and safety flags come off each `Tool` (never copied),
 * and the domain is looked up from {@link DOMAIN_GROUPS}. A registered
 * tool with no declared domain throws at module load — caught by the unit
 * test, and a hard signal in any environment that someone added a tool to
 * `registry.ts` without classifying it here.
 */
export const TOOL_CATALOG: ToolCatalogEntry[] = Array.from(TOOLS.values()).map(
  (tool) => {
    const domain = DOMAIN_BY_NAME.get(tool.name);
    if (!domain) {
      throw new Error(
        `tools-core catalog: tool "${tool.name}" is registered but has no ` +
          `domain. Add it to a group in catalog.ts DOMAIN_GROUPS.`,
      );
    }
    return {
      name: tool.name,
      description: tool.description,
      homeDescription:
        HOME_DESCRIPTION_BY_NAME[tool.name] ?? sentenceFromName(tool.name),
      domain,
      requiresWrite: tool.requiresWrite,
      requiresConfirmation: tool.requiresConfirmation,
    };
  },
);
