import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_CATALOG } from "../src/index.js";

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
  "restart_router",          // WARP-864
  "get_wifi_settings",
  "list_ap_devices",       // WARP-446
  "list_dhcp_leases",
  "list_network_devices",
  "scan_wifi_networks",
  "set_phone_home_blocking", // WARP-613
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
  // BUG-3 — read-only mdadm pool inventory (destructive ops are NOT tools).
  "list_storage_pools",
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
  // WARP-1094 — ERP-connector (Eaglesoft) tools
  "erp_get_schedule_today",
  "erp_find_patient",
  "erp_get_ar_summary",
  "erp_schedule_appointment",
  // WARP-1120 — business-knowledge layer (read-only Tier 1)
  "business_profile_get",
  // WARP-899/WARP-900 — data-utility domain (all Tier-1 read/pure-computation)
  "encode_text",
  "decode_text",
  "hash_text",
  "convert_data_format",
  "format_json",
  // WARP-901 — misc dev utilities (data domain, all Tier-1)
  "timestamp_convert",
  "uuid_generate",
  "regex_test",
  // WARP-1424 — everyday utility tools (data domain, all Tier-1)
  "calculate",
  "unit_convert",
  "get_current_datetime",
  "date_math",
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
    // WARP-1094 — ERP-connector (Eaglesoft). The three reads are Read-tier;
    // erp_schedule_appointment is Write-tier (every ERP write hits a live
    // third-party PMS through the confirmed outbox pipeline, brief §11.6).
    expect(TOOLS.get("erp_get_schedule_today")?.requiresWrite).toBe(false);
    expect(TOOLS.get("erp_get_schedule_today")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("erp_find_patient")?.requiresWrite).toBe(false);
    expect(TOOLS.get("erp_get_ar_summary")?.requiresWrite).toBe(false);
    expect(TOOLS.get("erp_schedule_appointment")?.requiresWrite).toBe(true);
    expect(TOOLS.get("erp_schedule_appointment")?.requiresConfirmation).toBe(true);
    // WARP-1120 — business_profile_get is a Tier-1 read (no write, no confirm).
    expect(TOOLS.get("business_profile_get")?.requiresWrite).toBe(false);
    expect(TOOLS.get("business_profile_get")?.requiresConfirmation).toBe(false);
    // WARP-899/WARP-900 — data-utility tools are all Tier-1 (no write, no confirm).
    expect(TOOLS.get("encode_text")?.requiresWrite).toBe(false);
    expect(TOOLS.get("encode_text")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("decode_text")?.requiresWrite).toBe(false);
    expect(TOOLS.get("decode_text")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("hash_text")?.requiresWrite).toBe(false);
    expect(TOOLS.get("hash_text")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("convert_data_format")?.requiresWrite).toBe(false);
    expect(TOOLS.get("convert_data_format")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("format_json")?.requiresWrite).toBe(false);
    expect(TOOLS.get("format_json")?.requiresConfirmation).toBe(false);
    // WARP-901 — misc dev utilities are all Tier-1 (no write, no confirm).
    expect(TOOLS.get("timestamp_convert")?.requiresWrite).toBe(false);
    expect(TOOLS.get("timestamp_convert")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("uuid_generate")?.requiresWrite).toBe(false);
    expect(TOOLS.get("uuid_generate")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("regex_test")?.requiresWrite).toBe(false);
    expect(TOOLS.get("regex_test")?.requiresConfirmation).toBe(false);
    // WARP-1424 — everyday utility tools are all Tier-1 (no write, no confirm).
    expect(TOOLS.get("calculate")?.requiresWrite).toBe(false);
    expect(TOOLS.get("calculate")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("unit_convert")?.requiresWrite).toBe(false);
    expect(TOOLS.get("unit_convert")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("get_current_datetime")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_current_datetime")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("date_math")?.requiresWrite).toBe(false);
    expect(TOOLS.get("date_math")?.requiresConfirmation).toBe(false);
  });

  // ── TOOLS-08 — cross-cutting invariants over the WHOLE registry ──
  // The per-tool spot-checks above only pin a handful of tools. WRITE_TOOLS
  // and the RBAC narrowing in the orchestrator are DERIVED from these two
  // booleans, so a single mis-flagged tool silently drops its role gate.
  // These property tests enforce the invariants for every registered tool.

  it("every tool requiring confirmation also requires write (confirm ⇒ write)", () => {
    const offenders = Array.from(TOOLS.values())
      .filter((t) => t.requiresConfirmation && !t.requiresWrite)
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it("every tool whose name starts with a mutating verb is flagged requiresWrite", () => {
    // Prefixes that are unambiguously mutating in this codebase. Verbs that
    // have read-only members (scan_, detect_, discover_, get_, list_,
    // search_) are deliberately NOT here. If a genuinely read-only tool ever
    // needs one of these prefixes, add it to READ_ONLY_EXCEPTIONS with a
    // comment — that makes the carve-out explicit rather than silent.
    const MUTATING_PREFIXES = [
      "set_",
      "add_",
      "delete_",
      "block_",
      "unblock_",
      "commission_",
      "decommission_",
      "approve_",
      "send_",
      "run_",
      "write_",
      "move_",
      "copy_",
      "rename_",
      "create_",
      "transition_",
      "complete_",
      "accept_",
      "setup_",
      "export_",
      "share_",
    ];
    const READ_ONLY_EXCEPTIONS = new Set<string>([
      // (intentionally empty — no read-only tool currently uses a
      // mutating-verb prefix)
    ]);

    const offenders = Array.from(TOOLS.values())
      .filter(
        (t) =>
          MUTATING_PREFIXES.some((p) => t.name.startsWith(p)) &&
          !READ_ONLY_EXCEPTIONS.has(t.name) &&
          !t.requiresWrite,
      )
      .map((t) => t.name);
    // A mutating-verb tool with requiresWrite:false is exactly the WARP-466
    // email_draft_reply regression class — fail loudly.
    expect(offenders).toEqual([]);
  });

  it("TOOL_CATALOG is in 1:1 correspondence with TOOLS (completeness)", () => {
    // Catalog completeness is enforced at module load by a throw; this pins
    // it as a regression test and guards against drift.
    expect(TOOL_CATALOG.length).toBe(TOOLS.size);
    const catalogNames = TOOL_CATALOG.map((e) => e.name).sort();
    const toolNames = Array.from(TOOLS.keys()).sort();
    expect(catalogNames).toEqual(toolNames);
  });
});
