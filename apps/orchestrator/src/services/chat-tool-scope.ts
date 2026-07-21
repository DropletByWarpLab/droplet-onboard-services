/**
 * WARP-1424 (under the WARP-1423 tool-gap rollout) — default chat tool scope.
 *
 * The WARP-1423 rollout grows the registry from 94 to ~127 tools, and the
 * full registry serializes to ~85K chars (~21K tokens) of `tools[]` schemas —
 * it no longer fits the shipping single-box context window
 * (OLLAMA_CONTEXT_LENGTH=16384, the WARP-854 fix) at all, let alone alongside
 * the fixed system blocks (see base-prompt-budget.test.ts, the WARP-1118
 * canary). Advertising everything would push every owner chat turn into
 * degradeToFit (dropping the business + persona blocks) and beyond.
 *
 * So default chat advertises the registry MINUS this exclusion set — the
 * same per-turn scoping pattern the voice pipeline ships (WARP-1432,
 * VOICE_ALLOWED_TOOLS). Excluded here are the specialist/admin surfaces that
 * have dedicated dashboard UI or are power-user flows better driven through
 * an external MCP client (which still sees the FULL registry — this scope
 * applies only to the orchestrator's own chat advertisement, and an explicit
 * `allowed_tools` on the request always overrides it):
 *
 *   - switch fabric + AP/network admin (VLANs, PoE, port-forwards, SSID/channel)
 *   - camera fleet admin (discovery/accept) and clip deletion (chat must not
 *     be able to delete camera evidence by default)
 *   - Matter commissioning internals + smart-home config-heavy writes
 *   - erp / pm vertical suites, developer data utilities (regex/hash/uuid/…)
 *   - box-admin writes (apply_update, storage pools, Wi-Fi rotation, VPN peers)
 *
 * Adding a tool to the registry WITHOUT listing it here advertises it to
 * chat and grows the wire payload — the WARP-1118 canary enforces the size
 * budget in CI, so that growth is always a deliberate, measured decision.
 * Names listed here that are not (yet) registered are inert.
 */
export const EXCLUDED_FROM_CHAT_TOOLS: ReadonlySet<string> = new Set([
  // switch fabric (dashboard/installer surface)
  "get_switch_ports",
  "get_switch_vlans",
  "set_port_vlan",
  "get_switch_poe",
  "set_port_poe",
  "detect_wan_port",
  "setup_camera_ports",
  // erp vertical suite (external MCP / dedicated UI)
  "erp_get_schedule_today",
  "erp_find_patient",
  "erp_get_ar_summary",
  "erp_schedule_appointment",
  // pm vertical suite (external MCP / dedicated UI)
  "pm_create_work_item",
  "pm_update_work_item",
  "pm_add_work_item_comment",
  "pm_transition_work_item",
  "pm_list_workspaces",
  "pm_list_projects",
  "pm_list_work_items",
  "pm_get_work_item",
  "pm_search_work_items",
  // developer data utilities (WARP-899/900/901 — MCP-client fare)
  "encode_text",
  "decode_text",
  "hash_text",
  "convert_data_format",
  "format_json",
  "timestamp_convert",
  "uuid_generate",
  "regex_test",
  // network admin depth (dashboard surface)
  "list_dhcp_leases",
  "scan_wifi_networks",
  "set_wifi_ssid",
  "set_wifi_channel",
  "get_firewall_rules",
  "add_port_forward",
  "get_router_system_info",
  "restart_router",
  "list_ap_devices",
  "approve_ap",
  "decommission_ap",
  // camera fleet admin + clip deletion
  "list_discovered_cameras",
  "scan_for_cameras",
  "accept_discovered_camera",
  "get_camera_live_url",
  "delete_clip",
  // smart-home commissioning/config internals
  "commission_device",
  "discover_matter_devices",
  "get_command_history",
  "set_detection_zones",
  // box-admin writes + misc
  "list_storage_pools",
  "send_notification",
  "list_notifications",
  "copy_file",
  "list_recent_files",
  "set_device_schedule",
  "set_wifi_password",
  "list_vpn_peers",
  "apply_update",
]);
