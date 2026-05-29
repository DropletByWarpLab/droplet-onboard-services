import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/index.js";

// Authoritative inventory list — must match `INVENTORY.md`. Update both in
// lockstep when adding/removing handlers.
const EXPECTED_TOOL_NAMES = [
  // network
  "add_port_forward",
  "approve_ap",            // WARP-446
  "block_network_device",
  "decommission_ap",       // WARP-446
  "get_firewall_rules",
  "get_network_status",
  "get_router_system_info",
  "get_wifi_settings",
  "list_ap_devices",       // WARP-446
  "list_dhcp_leases",
  "list_network_devices",
  "scan_wifi_networks",
  "set_wifi_channel",
  "set_wifi_ssid",
  "unblock_network_device",
  // files
  "copy_file",
  "create_directory",
  "delete_file",
  "list_files",
  "list_recent_files",
  "move_file",
  "read_file",
  "rename_file",
  "search_content",
  "search_files",
  "write_file",
  // smart-home
  "accept_discovered_camera",
  "commission_device",
  "control_device",
  "create_event",
  "create_reminder",
  "delete_event",
  "detect_wan_port",
  "discover_matter_devices",
  "export_clip",
  "get_camera_live_url",
  "get_camera_snapshot",
  "get_command_history",
  "get_smart_home_device",
  "get_switch_poe",
  "get_switch_ports",
  "get_switch_vlans",
  "get_system_health",
  "list_camera_events",
  "list_cameras",
  "list_clips",
  "list_discovered_cameras",
  "list_drives",
  "list_events",
  "list_notifications",
  "list_reminders",
  "list_smart_home_devices",
  "scan_for_cameras",
  "send_notification",
  "set_port_poe",
  "set_port_vlan",
  "setup_camera_ports",
  "share_clip",
  "complete_reminder",
  "update_event",
  // WARP-461 — memory facts (Phase B4)
  "memory_extract_fact",
  "memory_recall",
  // WARP-466 — email tools (Phase D2)
  "email_draft_reply",
  "email_read",
  "email_search",
  "email_send",
  "email_summarize_thread",
  // WARP-470 — network summary (Phase F2)
  "network_summary",
  // WARP-474 — smart-home scenes (Phase G2)
  "run_scene",
  // WARP-509 — Plane PM write tools
  "pm_add_work_item_comment",
  "pm_create_work_item",
  "pm_transition_work_item",
  "pm_update_work_item",
  // WARP-508 — Plane PM read tools
  "pm_get_work_item",
  "pm_list_projects",
  "pm_list_work_items",
  "pm_list_workspaces",
  "pm_search_work_items",
];

describe("TOOLS registry", () => {
  it("registers every name in INVENTORY.md", () => {
    const actual = Array.from(TOOLS.keys()).sort();
    const expected = [...EXPECTED_TOOL_NAMES].sort();
    // Helpful diff if a name is missing or unexpected.
    const missing = expected.filter((n) => !actual.includes(n));
    const extra = actual.filter((n) => !expected.includes(n));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("flags write+confirmation correctly per tool", () => {
    expect(TOOLS.get("block_network_device")?.requiresWrite).toBe(true);
    expect(TOOLS.get("block_network_device")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("list_files")?.requiresWrite).toBe(false);
    expect(TOOLS.get("write_file")?.requiresWrite).toBe(true);
    expect(TOOLS.get("write_file")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("set_wifi_ssid")?.requiresConfirmation).toBe(true);
    // WARP-508/509 — embedded Plane PM. Read tools are read-only; write
    // tools (create / update / comment / transition) are
    // requiresWrite=true AND requiresConfirmation=true because every
    // Plane write hits a customer's tracked project state.
    expect(TOOLS.get("pm_list_workspaces")?.requiresWrite).toBe(false);
    expect(TOOLS.get("pm_get_work_item")?.requiresWrite).toBe(false);
    expect(TOOLS.get("pm_create_work_item")?.requiresWrite).toBe(true);
    expect(TOOLS.get("pm_create_work_item")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("pm_transition_work_item")?.requiresWrite).toBe(true);
    expect(TOOLS.get("pm_transition_work_item")?.requiresConfirmation).toBe(true);
  });
});
