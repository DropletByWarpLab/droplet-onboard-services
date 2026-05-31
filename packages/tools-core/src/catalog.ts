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
  | "system";

export interface ToolCatalogEntry {
  name: string;
  description: string;
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
    "add_port_forward",
    "get_router_system_info",
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
  system: ["get_system_health", "list_drives"],
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
      domain,
      requiresWrite: tool.requiresWrite,
      requiresConfirmation: tool.requiresConfirmation,
    };
  },
);
