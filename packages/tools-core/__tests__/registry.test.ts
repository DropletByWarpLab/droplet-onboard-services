// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

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
  "read_document_text",    // WARP-2057
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
  // WARP-1447 — smart-home depth: unpair (two-step confirm), scene
  // authoring (two-step confirm), room assignment (write, no confirm)
  "remove_device",
  "create_scene",
  "assign_device_room",
  // ADR-045 — the `pm` and `crm` tool families are GONE, and that is the
  // decision this list exists to make somebody sign.
  //
  // Slice C replaced WARP-508's five PM reads and WARP-2546's five CRM reads
  // with `business_find` / `business_timeline`. Slice D replaced WARP-509's
  // five PM writes and the two CRM writes with `business_create` /
  // `business_update` / `business_link`. Seventeen names out, five in, all
  // listed under business below.
  //
  // Both DOMAINS survive with their DOMAIN_RULES entries and hold zero local
  // tools — that is deliberate, not leftover. A rule is the route a REMOTE
  // catalog registered into `pm` (Atlassian, WARP-2316) or `crm` (HubSpot)
  // becomes selectable, because the exclusion list names LOCAL tools only.
  // `chat-tool-scope.test.ts` pins both as documented dead rules.
  // WARP-1094 — ERP-connector (Eaglesoft) tools
  "erp_get_schedule_today",
  "erp_find_patient",
  "erp_get_ar_summary",
  "erp_schedule_appointment",
  // WARP-1120 — business-knowledge layer (read-only Tier 1)
  "business_profile_get",
  // ADR-045 slice D — the write verbs (Tier-2: write + confirmation).
  // Seven tools in, three out; the registry gets SMALLER by four.
  "business_create",
  "business_update",
  "business_link",
  // ADR-045 slice C — the business graph, read half. Two verbs over one typed
  // graph, replacing ten noun-shaped CRM/PM reads. Both Tier-1.
  "business_find",
  "business_timeline",
  // WARP-1685 — Messages sends (Tier-2: write + two-phase confirmation)
  "team_chat_send_message",
  "team_chat_send_meeting_invite",
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
  // WARP-1425 — forget a memory fact (Tier-2) + countdown timer (Write-tier)
  "memory_forget",
  "set_timer",
  // WARP-1426 — single-turn-completion tools (both Tier-1)
  "translate_text",
  "summarize_file",
  // WARP-1436 — ambient web data via screened egress (both Tier-1)
  "get_weather",
  "currency_convert",
  // WARP-1440 — camera depth (search/health Tier-1; toggle/zones/delete Tier-2)
  "search_camera_events",
  "get_camera_health",
  "get_camera_storage",
  "set_camera_detection",
  "set_detection_zones",
  "delete_clip",
  // WARP-1893 — cameras: rename to a household-facing label
  "rename_camera",
  // WARP-1443 — network depth (reads Tier-1; password/schedule Tier-2)
  "get_bandwidth_usage",
  "list_vpn_peers",
  "list_threat_events",
  "set_wifi_password",
  "set_device_schedule",
  // WARP-1450 — appliance ops (reads Tier-1 incl. role-gated audit; apply Tier-2)
  "get_drive_health",
  "get_audit_log",
  "get_update_status",
  "apply_update",
  // WARP-1452 — PIM search (both Tier-1, pure prisma)
  "search_calendar_events",
  "search_contacts",
  // WARP-1456 — file versions + share; WARP-1458 — create_document
  "list_file_versions",
  "restore_file_version",
  "share_file",
  "create_document",
  // WARP-2211/2212 — document generation (a finished file), as opposed to
  // create_document's empty seed.
  "create_pdf_report",
  "create_word_document",
  "create_spreadsheet",
  // WARP-2664 — file cleanup: read-only report, then organize (write +
  // confirm) and bulk delete-to-trash (write + confirm).
  "analyze_file_cleanup",
  "organize_files",
  "delete_files",
  // WARP-1861 — GPU telemetry (Tier-1 read, via device-bridge)
  "get_gpu_status",
  // WARP-2497 — cloud connectors (Stripe/HubSpot/Mailchimp). ONE tool for all
  // three vendors and all ten datasets; the dataset arg picks the provider.
  "cloud_query_dataset",
  // money (WARP-2581) — excluded from the chat pool, MCP/API reachable
  "money_list_open_documents",
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
    // WARP-2669 — `delete_file` had no assertion here at all, which is part
    // of how it kept `requiresConfirmation: false` while the confirmation
    // contract doc (§3) used it as its worked example of a gated tool and
    // three orchestrator suites used it as their confirming fixture. It is a
    // RECURSIVE delete: a directory goes with everything inside it. Pinned
    // now so a future flip back is a decision somebody has to write down.
    expect(TOOLS.get("delete_file")?.requiresWrite).toBe(true);
    expect(TOOLS.get("delete_file")?.requiresConfirmation).toBe(true);
    // Interceptor-owned, not route-owned: `DELETE /api/files` runs no Tier-2
    // gate of its own, so there is no route challenge to stand down for.
    expect(TOOLS.get("delete_file")?.confirmationOwner).toBeUndefined();
    // ...and no `confirmed` boolean in the schema, so the legacy path (§3) is
    // closed to it and only a human-minted token gets through.
    expect(
      Object.keys(
        (TOOLS.get("delete_file")?.inputSchema as { properties: Record<string, unknown> })
          .properties,
      ),
    ).toEqual(["path"]);
    expect(TOOLS.get("set_wifi_ssid")?.requiresConfirmation).toBe(true);
    // WARP-508/509 — embedded Plane PM. Read tools are read-only; write
    // tools (create / update / comment / transition) are
    // requiresWrite=true AND requiresConfirmation=true because every
    // Plane write hits a customer's tracked project state.
    // ADR-045 slice C — the PM read tools are gone; the graph reads that
    // replaced them carry the Read tier now, and they are what this pair of
    // assertions is for (a read that is silently flagged write loses nothing
    // visible until RBAC narrows it away for a family role).
    expect(TOOLS.get("business_find")?.requiresWrite).toBe(false);
    expect(TOOLS.get("business_find")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("business_timeline")?.requiresWrite).toBe(false);
    expect(TOOLS.get("business_timeline")?.requiresConfirmation).toBe(false);
    // ADR-045 slice D — the tier moved with the capability: creating a task
    // and transitioning one are both `business_*` verbs now, and both stay
    // write + confirmation.
    expect(TOOLS.get("business_create")?.requiresWrite).toBe(true);
    expect(TOOLS.get("business_create")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("business_update")?.requiresWrite).toBe(true);
    expect(TOOLS.get("business_update")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("business_link")?.requiresWrite).toBe(true);
    expect(TOOLS.get("business_link")?.requiresConfirmation).toBe(true);
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
    // WARP-1425 — memory_forget disables a stored fact (Tier-2: write +
    // confirm, like memory_extract_fact); set_timer creates a Reminder row
    // (Write-tier, no confirm — same tier as create_reminder).
    expect(TOOLS.get("memory_forget")?.requiresWrite).toBe(true);
    expect(TOOLS.get("memory_forget")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("set_timer")?.requiresWrite).toBe(true);
    expect(TOOLS.get("set_timer")?.requiresConfirmation).toBe(false);
    // WARP-1426 — completion-backed tools are Tier-1 (read-only; the LLM
    // call writes no state).
    expect(TOOLS.get("translate_text")?.requiresWrite).toBe(false);
    expect(TOOLS.get("translate_text")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("summarize_file")?.requiresWrite).toBe(false);
    expect(TOOLS.get("summarize_file")?.requiresConfirmation).toBe(false);
    // WARP-1436 — ambient web-data tools are Tier-1 (read-only; egress is
    // gated + audited server-side, not a state write).
    expect(TOOLS.get("get_weather")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_weather")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("currency_convert")?.requiresWrite).toBe(false);
    expect(TOOLS.get("currency_convert")?.requiresConfirmation).toBe(false);
    // WARP-1440 — camera reads are Tier-1; detection toggle, zone writes,
    // and clip deletion are Tier-2 (write + handler-enforced confirmation).
    expect(TOOLS.get("search_camera_events")?.requiresWrite).toBe(false);
    expect(TOOLS.get("search_camera_events")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("get_camera_health")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_camera_health")?.requiresConfirmation).toBe(false);
    // WARP-1850 — read-only storage reporting; never mutates retention.
    expect(TOOLS.get("get_camera_storage")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_camera_storage")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("set_camera_detection")?.requiresWrite).toBe(true);
    expect(TOOLS.get("set_camera_detection")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("set_detection_zones")?.requiresWrite).toBe(true);
    expect(TOOLS.get("set_detection_zones")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("delete_clip")?.requiresWrite).toBe(true);
    expect(TOOLS.get("delete_clip")?.requiresConfirmation).toBe(true);
    // WARP-1893 — a write (so non-privileged roles never see it) but
    // deliberately NOT confirmation-gated: a display name destroys nothing
    // and is instantly reversible, unlike delete_clip above.
    expect(TOOLS.get("rename_camera")?.requiresWrite).toBe(true);
    expect(TOOLS.get("rename_camera")?.requiresConfirmation).toBe(false);
    // WARP-1443 — network reads are Tier-1 (list_threat_events additionally
    // role-gates INSIDE the handler, WARP-845); password/schedule are Tier-2.
    expect(TOOLS.get("get_bandwidth_usage")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_bandwidth_usage")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("list_vpn_peers")?.requiresWrite).toBe(false);
    expect(TOOLS.get("list_vpn_peers")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("list_threat_events")?.requiresWrite).toBe(false);
    expect(TOOLS.get("list_threat_events")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("set_wifi_password")?.requiresWrite).toBe(true);
    expect(TOOLS.get("set_wifi_password")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("set_device_schedule")?.requiresWrite).toBe(true);
    expect(TOOLS.get("set_device_schedule")?.requiresConfirmation).toBe(true);
    // WARP-1447 — smart-home depth: destructive unpair + scene authoring are
    // Tier-2; room assignment is a reversible write (no confirm, like
    // create_reminder).
    expect(TOOLS.get("remove_device")?.requiresWrite).toBe(true);
    expect(TOOLS.get("remove_device")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("create_scene")?.requiresWrite).toBe(true);
    expect(TOOLS.get("create_scene")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("assign_device_room")?.requiresWrite).toBe(true);
    expect(TOOLS.get("assign_device_room")?.requiresConfirmation).toBe(false);
    // WARP-1450 — appliance ops: reads are Tier-1 (audit/update-status also
    // role-gate the human INSIDE the handler); apply_update is Tier-2.
    expect(TOOLS.get("get_drive_health")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_drive_health")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("get_audit_log")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_audit_log")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("get_update_status")?.requiresWrite).toBe(false);
    expect(TOOLS.get("get_update_status")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("apply_update")?.requiresWrite).toBe(true);
    expect(TOOLS.get("apply_update")?.requiresConfirmation).toBe(true);
    // WARP-1452 — PIM search tools are Tier-1 pure-prisma reads.
    expect(TOOLS.get("search_calendar_events")?.requiresWrite).toBe(false);
    expect(TOOLS.get("search_calendar_events")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("search_contacts")?.requiresWrite).toBe(false);
    expect(TOOLS.get("search_contacts")?.requiresConfirmation).toBe(false);
    // WARP-1456 — list is Tier-1; restore + share are Tier-2 (destructive/
    // public-link footgun). WARP-1458 — create_document is a plain write.
    expect(TOOLS.get("list_file_versions")?.requiresWrite).toBe(false);
    expect(TOOLS.get("list_file_versions")?.requiresConfirmation).toBe(false);
    expect(TOOLS.get("restore_file_version")?.requiresWrite).toBe(true);
    expect(TOOLS.get("restore_file_version")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("share_file")?.requiresWrite).toBe(true);
    expect(TOOLS.get("share_file")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("create_document")?.requiresWrite).toBe(true);
    expect(TOOLS.get("create_document")?.requiresConfirmation).toBe(false);
    // WARP-2212 — the generators are plain writes too. They create a NEW file
    // at a path the caller named, and POST /api/files/render refuses an
    // existing one (409) — enforced atomically by the `If-None-Match: *`
    // create-new guard on the WebDAV PUT itself (WARP-2523), with the exists?
    // pre-check as a fast path — so there is no overwrite for a confirmation
    // to guard against.
    for (const name of ["create_pdf_report", "create_word_document", "create_spreadsheet"]) {
      expect(TOOLS.get(name)?.requiresWrite, name).toBe(true);
      expect(TOOLS.get(name)?.requiresConfirmation, name).toBe(false);
    }
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
