/**
 * WARP-1455 — the tool→route manifest (the structural guard against
 * shipping a dead LLM tool).
 *
 * ## What this is
 *
 * A typed, hand-maintained mapping: one entry per registered tool,
 * declaring the HTTP client it dispatches through and every route hop it
 * calls. It is the single source of truth that closes the "shipped-but-
 * dead MCP tool" bug class for good:
 *
 *   1. `packages/tools-core/__tests__/tool-routes.test.ts` (the CI gate)
 *      asserts EVERY registered tool has exactly one entry here, and that
 *      each entry's declared hops match what the handler source actually
 *      calls (method + path shape). A new tool with no row — or a manifest
 *      that lies about the route — fails the build.
 *   2. `apps/orchestrator/src/__tests__/tools-mcp-admission.test.ts`
 *      drives / verifies that every `kind: "admit"` hop admits the
 *      `_service:mcp` principal — the direct inverse of the bug (a handler
 *      dispatching to a route the mcp principal can't reach → 401/403 →
 *      the tool ships registered but dead).
 *
 * ## `client`
 *
 * The `ctx.http.*` client the tool's handler uses (see
 * `packages/tools-core/src/types.ts` `ToolContext.http`):
 *
 *   - `"orchestrator"` — `ctx.http.orchestrator.*` against the
 *     orchestrator's own REST surface (`http://orchestrator:3000`). The
 *     mcp-server's `createHttpClient` auto-injects the service-principal
 *     Bearer for this target.
 *   - `"nextcloud"`    — `ctx.http.nextcloud.*`. Despite the name this
 *     target points at the orchestrator's `/api/files` surface
 *     (`FILES_API_URL`, WARP-861) and the same service Bearer is injected
 *     (mcp-server `index.ts` `createHttpClient`). `pathPattern`s below are
 *     the FULL orchestrator path (`/api/files/...`), not the base-relative
 *     path the handler passes.
 *   - `"none"`         — pure-prisma / pure-compute / `ctx.matter` /
 *     URL-string / stub tool. No `ctx.http` hop at all. Listed with
 *     `hops: []` so the completeness gate knows the tool was considered
 *     (a `ctx.matter` tool is `"none"`: the MatterController is not an
 *     `ctx.http` client — its own HTTP admission is covered elsewhere).
 *
 * A handler that uses more than one client (only `summarize_file` today —
 * it reads the file via `nextcloud` then summarises via `orchestrator`)
 * carries `client` = its primary surface and lists BOTH clients' hops; the
 * completeness gate matches hops by (method, full-path-shape), not by the
 * single `client` label.
 *
 * ## `kind`
 *
 *   - `"admit"`          — the handler calls this route, so the
 *     `_service:mcp` principal MUST reach it (`requireRoleOrMcpService`,
 *     an open read, `requireRole(..., "service")`, or a custom guard that
 *     admits the mcp id). The admission suite proves it does.
 *   - `"dashboard-only"` — a Tier-2 confirmation route the tool's flow
 *     HANDS OFF to but does NOT call directly: the switch/network write
 *     tools return the orchestrator's 202 `confirmationToken` and the
 *     dashboard (a human who already clicked "confirm") completes the
 *     handshake on this route. It is `requireRole` human-only BY DESIGN;
 *     listing it documents that intent and the admission suite pins that
 *     it stays human-only. Excluded from the handler-call cross-check
 *     (the whole point is that the tool does not call it).
 *
 * ## Maintaining this file
 *
 * When you add a tool that makes an HTTP call, add its entry here and make
 * sure the backing orchestrator route admits the mcp principal
 * (`requireRoleOrMcpService`) — the completeness gate fails otherwise. See
 * the `add-llm-tool` skill.
 *
 * Paths carry `:param` segments (e.g. `/api/cameras/events/:eventId`); the
 * cross-check matches path SHAPE (segment count + literal segments), so the
 * exact param name here is documentation, not load-bearing.
 *
 * ## Runtime-registered tools have no row here, on purpose (WARP-2418)
 *
 * A tool advertised by a remote MCP server (ADR-043) dials no orchestrator
 * route of ours, so there is nothing for the admission suite to prove and a
 * row would be a fiction the cross-check would then have to be taught to
 * skip. The completeness gate is keyed off `registry.ts`, which such a tool
 * is never in, so this needs no exemption — it needs only to be said, since
 * "the manifest is complete" and "the manifest covers every tool the model
 * can name" stopped being the same sentence the moment a catalog could
 * arrive over a socket. Those tools live in
 * `apps/orchestrator/src/services/runtime-tool-registry.service.ts`.
 */

export type ToolClient = "orchestrator" | "nextcloud" | "none";

export interface ToolRouteHop {
  method: "get" | "post" | "patch" | "put" | "delete";
  /** Orchestrator path WITH `:param` segments (full path, incl. `/api`). */
  pathPattern: string;
  kind: "admit" | "dashboard-only";
}

export interface ToolRouteEntry {
  tool: string;
  client: ToolClient;
  hops: ToolRouteHop[];
}

/** Convenience: an `admit` hop. */
const admit = (
  method: ToolRouteHop["method"],
  pathPattern: string,
): ToolRouteHop => ({ method, pathPattern, kind: "admit" });

/** Convenience: a `dashboard-only` (human-only confirm) hop. */
const dashboardOnly = (
  method: ToolRouteHop["method"],
  pathPattern: string,
): ToolRouteHop => ({ method, pathPattern, kind: "dashboard-only" });

/** A `client: "none"` entry — no HTTP hop. */
const none = (tool: string): ToolRouteEntry => ({ tool, client: "none", hops: [] });

export const TOOL_ROUTES: ToolRouteEntry[] = [
  // ── network ────────────────────────────────────────────────────────────
  none("list_network_devices"), // ctx.prisma
  { tool: "get_network_status", client: "orchestrator", hops: [admit("get", "/api/network/status")] },
  { tool: "list_dhcp_leases", client: "orchestrator", hops: [admit("get", "/api/network/dhcp/leases")] },
  { tool: "get_wifi_settings", client: "orchestrator", hops: [admit("get", "/api/network/wifi")] },
  { tool: "scan_wifi_networks", client: "orchestrator", hops: [admit("get", "/api/network/wifi/scan")] },
  { tool: "set_wifi_ssid", client: "orchestrator", hops: [admit("post", "/api/network/wifi/ssid")] },
  { tool: "set_wifi_channel", client: "orchestrator", hops: [admit("post", "/api/network/wifi/channel")] },
  { tool: "get_firewall_rules", client: "orchestrator", hops: [admit("get", "/api/network/firewall")] },
  { tool: "block_network_device", client: "orchestrator", hops: [
    admit("post", "/api/network/firewall/block"),
    // Tier-2 handshake completion is human-only (dashboard), not the tool.
    dashboardOnly("post", "/api/network/command/confirm"),
  ] },
  { tool: "unblock_network_device", client: "orchestrator", hops: [admit("post", "/api/network/firewall/unblock")] },
  { tool: "set_phone_home_blocking", client: "orchestrator", hops: [
    admit("patch", "/api/network/groups/:id"),
    admit("patch", "/api/network/phone-home"),
  ] },
  { tool: "add_port_forward", client: "orchestrator", hops: [admit("post", "/api/network/firewall/port-forward")] },
  { tool: "get_router_system_info", client: "orchestrator", hops: [admit("get", "/api/network/system")] },
  { tool: "restart_router", client: "orchestrator", hops: [admit("post", "/api/network/system/reboot")] },
  { tool: "network_summary", client: "orchestrator", hops: [admit("get", "/api/network/summary")] },
  none("list_ap_devices"), // ctx.prisma
  { tool: "approve_ap", client: "orchestrator", hops: [admit("post", "/api/aps/:mac/approve")] },
  { tool: "decommission_ap", client: "orchestrator", hops: [admit("post", "/api/aps/:mac/decommission")] },
  { tool: "get_bandwidth_usage", client: "orchestrator", hops: [
    admit("get", "/api/network/summary"),
    admit("get", "/api/network/throughput"),
  ] },
  { tool: "list_vpn_peers", client: "orchestrator", hops: [admit("get", "/api/vpn/peers")] },
  { tool: "list_threat_events", client: "orchestrator", hops: [admit("get", "/api/activity")] },
  { tool: "set_wifi_password", client: "orchestrator", hops: [admit("post", "/api/network/wifi/password")] },
  { tool: "set_device_schedule", client: "orchestrator", hops: [
    admit("get", "/api/network/schedules"),
    admit("post", "/api/network/schedules"),
    admit("patch", "/api/network/schedules/:id"),
    admit("delete", "/api/network/schedules/:id"),
  ] },

  // ── files (nextcloud client → orchestrator /api/files) ──────────────────
  { tool: "list_files", client: "nextcloud", hops: [admit("get", "/api/files")] },
  { tool: "read_file", client: "nextcloud", hops: [admit("get", "/api/files/download")] },
  { tool: "search_files", client: "nextcloud", hops: [admit("get", "/api/files/search")] },
  none("search_content"), // ctx.searchHybrid shim (no ctx.http hop)
  none("read_document_text"), // ctx.readDocumentText shim (no ctx.http hop)
  { tool: "list_recent_files", client: "nextcloud", hops: [admit("get", "/api/files/recents")] },
  { tool: "write_file", client: "nextcloud", hops: [admit("post", "/api/files/upload")] },
  // WARP-2212: the three generators all dispatch one spec to the same render
  // route. `nextcloud` because that client targets the orchestrator's
  // /api/files surface (FILES_API_URL) and carries the caller's NC
  // credentials — the document must land in the CALLER's storage.
  { tool: "create_pdf_report", client: "nextcloud", hops: [admit("post", "/api/files/render")] },
  { tool: "create_word_document", client: "nextcloud", hops: [admit("post", "/api/files/render")] },
  { tool: "create_spreadsheet", client: "nextcloud", hops: [admit("post", "/api/files/render")] },
  // WARP-2664 — file cleanup. analyze walks the tree through the same
  // listing hop list_files uses; organize lists once then mkdir + move per
  // file; delete_files reads the parent listing before every delete so a
  // folder passed as a file is refused rather than trashed recursively.
  { tool: "analyze_file_cleanup", client: "nextcloud", hops: [admit("get", "/api/files")] },
  { tool: "organize_files", client: "nextcloud", hops: [
    admit("get", "/api/files"),
    admit("post", "/api/files/mkdir"),
    admit("post", "/api/files/move"),
  ] },
  { tool: "delete_files", client: "nextcloud", hops: [
    admit("get", "/api/files"),
    admit("delete", "/api/files"),
  ] },
  { tool: "delete_file", client: "nextcloud", hops: [admit("delete", "/api/files")] },
  { tool: "create_directory", client: "nextcloud", hops: [admit("post", "/api/files/mkdir")] },
  { tool: "rename_file", client: "nextcloud", hops: [admit("post", "/api/files/move")] },
  { tool: "move_file", client: "nextcloud", hops: [admit("post", "/api/files/move")] },
  { tool: "copy_file", client: "nextcloud", hops: [admit("post", "/api/files/copy")] },
  // summarize_file: reads via nextcloud, summarises via orchestrator /api/llm/complete.
  { tool: "summarize_file", client: "nextcloud", hops: [
    admit("get", "/api/files/download"),
    admit("post", "/api/llm/complete"),
  ] },
  { tool: "list_file_versions", client: "nextcloud", hops: [admit("get", "/api/files/versions")] },
  { tool: "restore_file_version", client: "nextcloud", hops: [admit("post", "/api/files/versions/restore")] },
  { tool: "share_file", client: "nextcloud", hops: [admit("post", "/api/files/share")] },
  { tool: "create_document", client: "nextcloud", hops: [
    admit("get", "/api/files/download"),
    admit("post", "/api/files/upload"),
  ] },

  // ── smart-home ──────────────────────────────────────────────────────────
  none("list_smart_home_devices"), // ctx.matter
  none("get_smart_home_device"), // ctx.matter
  none("control_device"), // ctx.matter
  none("discover_matter_devices"), // ctx.matter
  none("commission_device"), // ctx.matter
  none("get_command_history"), // ctx.matter.getAuditLog
  { tool: "run_scene", client: "orchestrator", hops: [
    admit("get", "/api/scenes"),
    admit("post", "/api/scenes/:id/run"),
  ] },
  none("remove_device"), // ctx.matter
  { tool: "create_scene", client: "orchestrator", hops: [admit("post", "/api/scenes")] },
  { tool: "assign_device_room", client: "orchestrator", hops: [
    admit("get", "/api/matter/rooms"),
    admit("post", "/api/matter/rooms"),
    admit("patch", "/api/matter/devices/:nodeId/alias"),
  ] },

  // ── cameras ─────────────────────────────────────────────────────────────
  { tool: "list_cameras", client: "orchestrator", hops: [admit("get", "/api/cameras")] },
  // WARP-1847: was `none` (ctx.prisma). The direct
  // `{ enabled: false, autoDiscovered: true }` query could never match a
  // freshly discovered camera, so this now reads the orchestrator's merged
  // live + DB candidate list — the same one the dashboard renders.
  { tool: "list_discovered_cameras", client: "orchestrator", hops: [
    admit("get", "/api/cameras/discovered"),
  ] },
  { tool: "list_camera_events", client: "orchestrator", hops: [
    admit("get", "/api/cameras/:name/events"),
    admit("get", "/api/cameras/events/recent"),
  ] },
  { tool: "scan_for_cameras", client: "orchestrator", hops: [admit("post", "/api/cameras/scan")] },
  // WARP-1847: was `none` (ctx.prisma). A live candidate's id is `mac:<MAC>`,
  // which has no camera row to flip `enabled` on — and only camera-discovery
  // holds the probed RTSP URL and verifies the stream before the Frigate write.
  { tool: "accept_discovered_camera", client: "orchestrator", hops: [
    admit("post", "/api/cameras/discovered/:id/accept"),
  ] },
  none("get_camera_snapshot"), // returns a URL string (no ctx.http hop)
  { tool: "list_clips", client: "orchestrator", hops: [admit("get", "/api/cameras/clips")] },
  { tool: "export_clip", client: "orchestrator", hops: [admit("post", "/api/cameras/:name/clips/export")] },
  none("get_camera_live_url"), // returns a URL string (no ctx.http hop)
  { tool: "share_clip", client: "orchestrator", hops: [admit("post", "/api/cameras/clips/share")] },
  { tool: "search_camera_events", client: "orchestrator", hops: [admit("get", "/api/cameras/events/search")] },
  { tool: "get_camera_health", client: "orchestrator", hops: [admit("get", "/api/cameras/system")] },
  { tool: "get_camera_storage", client: "orchestrator", hops: [admit("get", "/api/cameras/storage")] },
  { tool: "set_camera_detection", client: "orchestrator", hops: [
    admit("post", "/api/cameras/:name/enable"),
    admit("post", "/api/cameras/:name/disable"),
    admit("post", "/api/cameras/command/confirm"),
  ] },
  { tool: "set_detection_zones", client: "orchestrator", hops: [admit("patch", "/api/cameras/:name/settings")] },
  { tool: "delete_clip", client: "orchestrator", hops: [admit("delete", "/api/cameras/events/:eventId")] },
  // WARP-1893: two hops — the GET resolves the user's phrasing ("the driveway
  // camera") to a config key before the PATCH writes the new label.
  { tool: "rename_camera", client: "orchestrator", hops: [
    admit("get", "/api/cameras"),
    admit("patch", "/api/cameras/:name"),
  ] },

  // ── switch ──────────────────────────────────────────────────────────────
  { tool: "get_switch_ports", client: "orchestrator", hops: [admit("get", "/api/switch/ports")] },
  { tool: "get_switch_vlans", client: "orchestrator", hops: [admit("get", "/api/switch/vlans")] },
  { tool: "set_port_vlan", client: "orchestrator", hops: [admit("post", "/api/switch/vlans/:vlanId/membership")] },
  { tool: "get_switch_poe", client: "orchestrator", hops: [admit("get", "/api/switch/poe")] },
  { tool: "set_port_poe", client: "orchestrator", hops: [
    admit("post", "/api/switch/poe/:port/enable"),
    admit("post", "/api/switch/poe/:port/disable"),
    // Tier-2 handshake completion is human-only (dashboard), not the tool.
    dashboardOnly("post", "/api/switch/command/confirm"),
  ] },
  { tool: "detect_wan_port", client: "orchestrator", hops: [admit("post", "/api/switch/wan/detect")] },
  { tool: "setup_camera_ports", client: "orchestrator", hops: [admit("post", "/api/switch/setup/cameras")] },

  // ── calendar ────────────────────────────────────────────────────────────
  none("create_event"), // ctx.prisma
  none("list_events"), // ctx.prisma
  none("update_event"), // ctx.prisma
  none("delete_event"), // ctx.prisma
  none("search_calendar_events"), // ctx.prisma

  // ── reminders ───────────────────────────────────────────────────────────
  none("create_reminder"), // ctx.prisma
  none("list_reminders"), // ctx.prisma
  none("complete_reminder"), // ctx.prisma
  none("set_timer"), // ctx.prisma

  // ── notifications ───────────────────────────────────────────────────────
  none("send_notification"), // ctx.prisma
  none("list_notifications"), // ctx.prisma

  // ── system ──────────────────────────────────────────────────────────────
  { tool: "get_system_health", client: "orchestrator", hops: [admit("get", "/api/orchestrator/health")] },
  { tool: "get_gpu_status", client: "orchestrator", hops: [admit("get", "/api/hardware/gpu")] },
  { tool: "list_drives", client: "orchestrator", hops: [admit("get", "/api/storage/drives")] },
  { tool: "list_storage_pools", client: "orchestrator", hops: [admit("get", "/api/storage/pools")] },
  { tool: "get_drive_health", client: "orchestrator", hops: [admit("get", "/api/storage/drives")] },
  { tool: "get_audit_log", client: "orchestrator", hops: [admit("get", "/api/activity")] },
  { tool: "get_update_status", client: "orchestrator", hops: [admit("get", "/api/updates/status")] },
  { tool: "apply_update", client: "orchestrator", hops: [
    admit("get", "/api/updates/status"),
    admit("post", "/api/updates/apply-now"),
  ] },

  // ── email ───────────────────────────────────────────────────────────────
  { tool: "email_search", client: "orchestrator", hops: [admit("get", "/api/email/:accountId/threads")] },
  { tool: "email_read", client: "orchestrator", hops: [admit("get", "/api/email/:accountId/threads/:threadId")] },
  { tool: "email_summarize_thread", client: "orchestrator", hops: [admit("get", "/api/email/:accountId/threads/:threadId/analysis")] },
  { tool: "email_draft_reply", client: "orchestrator", hops: [admit("post", "/api/email/:accountId/drafts")] },
  { tool: "email_send", client: "orchestrator", hops: [admit("post", "/api/email/drafts/:id/send")] },
  none("search_contacts"), // ctx.prisma (derived from indexed senders)

  // ── memory ──────────────────────────────────────────────────────────────
  none("memory_recall"), // ctx.prisma
  none("memory_extract_fact"), // ctx.prisma
  none("memory_forget"), // ctx.prisma

  // ── pm (native, orchestrator /api/pm/* via callOrch) ────────────────────
  // ADR-045 slice D — the pm write rows moved to the `business_*` block
  // below, which declares the same hops from one tool each.

  // WARP-2546 — CRM. ADR-045 slice C removed the five read rows; the two
  // write rows stay until slice D.
  // ADR-045 slice D — `crm_log_activity` → `business_create({entity:"note"})`
  // and `crm_move_deal_stage` → `business_update({entity:"deal", state})`.
  // Note the second one no longer needs `POST /api/crm/deals/:id/stage` at
  // all: since WARP-2579 the PATCH applies the move inside the same
  // transaction as the field update, STAGE_CHANGE timeline row included.

  // ── erp (ERP_NOT_CONNECTED stubs — no ctx.http hop yet) ─────────────────
  none("erp_get_schedule_today"),
  none("erp_find_patient"),
  none("erp_get_ar_summary"),
  none("erp_schedule_appointment"),

  // ── money (WARP-2581) ───────────────────────────────────────────────────
  {
    tool: "money_list_open_documents",
    client: "orchestrator",
    hops: [admit("get", "/api/money/documents")],
  },

  // ── cloud (WARP-2497) ───────────────────────────────────────────────────
  // Lives under /api/erp/* because the cloud connectors reuse the ERP
  // route surface and its connector-grant gate; the tool domain is `cloud`.
  { tool: "cloud_query_dataset", client: "orchestrator", hops: [admit("get", "/api/erp/dataset/:dataset")] },

  // ── business ────────────────────────────────────────────────────────────
  none("business_profile_get"), // ctx.prisma

  // ADR-045 slice D — the write verbs. `business_create` dispatches to SIX
  // routes across two back ends, so every one is declared: the drift gate
  // checks the LIST, and an undeclared hop is how a tool ships with a route
  // the mcp principal cannot reach.
  //
  // Two routes are deliberately ABSENT because two entities are:
  // `POST /api/crm/companies/:id/contacts` and `PATCH /api/pm/projects/:id`
  // are both `requireRole(...WRITE)` and do NOT admit `_service:mcp`, so
  // `contact` is not a creatable entity and `project` is not an updatable
  // one. Adding either branch would ship a 403 with a schema in front of it.
  {
    tool: "business_create",
    client: "orchestrator",
    hops: [
      admit("post", "/api/crm/companies"),
      admit("post", "/api/crm/deals"),
      admit("post", "/api/pm/projects"),
      admit("post", "/api/pm/projects/:id/work-items"),
      admit("post", "/api/crm/activities"),
      admit("post", "/api/pm/work-items/:id/comments"),
    ],
  },
  {
    tool: "business_update",
    client: "orchestrator",
    hops: [
      admit("patch", "/api/crm/companies/:id"),
      admit("patch", "/api/crm/deals/:id"),
      admit("patch", "/api/pm/work-items/:id"),
    ],
  },
  // One hop, because both live edges are columns on the DEAL
  // (`CrmDeal.projectId`, `CrmDeal.companyId` — WARP-2117). The other seven
  // edges in LINK_EDGES are `not_built` and make no call at all.
  {
    tool: "business_link",
    client: "orchestrator",
    hops: [admit("patch", "/api/crm/deals/:id")],
  },

  // ADR-045 slice C — the business graph. `business_find` dispatches a
  // different call per `entity`, and on `entity:"customer"` with an `id` it
  // makes four, so EVERY branch is declared: the cross-check is bidirectional,
  // and an undeclared hop is how a tool ships with a route the mcp principal
  // cannot reach.
  //
  // `/api/crm/companies/:id/record` (WARP-2563) replaced the bare
  // `/api/crm/companies/:id` on the customer branch (WARP-2583 review): the
  // record carries the company AND every deal of theirs, open and closed, AND
  // the projects that name the company — the two edges a customer's delivery
  // work hangs off. The bare read only ever saw the company.
  //
  // `/api/crm/contacts` and `/api/crm/contacts/:id` are NEW in this change
  // (routes/crm.ts). They exist because the CRM had no way to read its own
  // people at all: `/api/contacts` is owner-scoped and 403s `_service:mcp`
  // outright (`contacts_require_a_user`), so a hop there would ship dead.
  {
    tool: "business_find",
    client: "orchestrator",
    hops: [
      admit("get", "/api/crm/companies"),
      admit("get", "/api/crm/companies/:id/record"),
      admit("get", "/api/crm/contacts"),
      admit("get", "/api/crm/contacts/:id"),
      admit("get", "/api/crm/deals"),
      admit("get", "/api/crm/deals/:id"),
      admit("get", "/api/crm/summary"),
      admit("get", "/api/pm/projects"),
      admit("get", "/api/pm/projects/:id"),
      admit("get", "/api/pm/projects/:id/work-items"),
      admit("get", "/api/pm/work-items"),
      admit("get", "/api/pm/work-items/:id"),
    ],
  },
  {
    tool: "business_timeline",
    client: "orchestrator",
    hops: [
      admit("get", "/api/crm/activities"),
      admit("get", "/api/pm/work-items/:id/activity"),
      admit("get", "/api/pm/work-items/:id/comments"),
    ],
  },

  // ── team chat (WARP-1685) ───────────────────────────────────────────────
  // Both tools act as the forwarded X-Droplet-User human; the routes admit
  // the mcp principal via requireRoleOrMcpService (routes/team-chat.ts).
  {
    tool: "team_chat_send_message",
    client: "orchestrator",
    hops: [
      admit("get", "/api/team-chat/contacts"),
      admit("post", "/api/team-chat/threads"),
      admit("post", "/api/team-chat/threads/:id/messages"),
    ],
  },
  {
    tool: "team_chat_send_meeting_invite",
    client: "orchestrator",
    hops: [
      admit("get", "/api/team-chat/contacts"),
      admit("post", "/api/team-chat/threads"),
      admit("post", "/api/team-chat/threads/:id/meetings"),
    ],
  },

  // ── data ────────────────────────────────────────────────────────────────
  none("encode_text"),
  none("decode_text"),
  none("hash_text"),
  none("convert_data_format"),
  none("format_json"),
  none("timestamp_convert"),
  none("uuid_generate"),
  none("regex_test"),
  none("calculate"),
  none("unit_convert"),
  none("get_current_datetime"),
  none("date_math"),
  { tool: "translate_text", client: "orchestrator", hops: [admit("post", "/api/llm/complete")] },
  { tool: "get_weather", client: "orchestrator", hops: [admit("get", "/api/web/weather")] },
  { tool: "currency_convert", client: "orchestrator", hops: [admit("get", "/api/web/rates")] },
];
