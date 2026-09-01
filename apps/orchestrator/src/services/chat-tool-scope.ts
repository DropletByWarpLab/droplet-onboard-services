/**
 * WARP-1424 (under the WARP-1423 tool-gap rollout) — default chat tool scope.
 * WARP-2448 — retained alongside per-turn selection, deliberately. Read below
 * before tuning either.
 *
 * ── the size problem this was born from ────────────────────────────
 *
 * The full registry serialises to far more `tools[]` than the shipping
 * single-box context window holds (OLLAMA_CONTEXT_LENGTH=16384, the WARP-854
 * fix), let alone alongside the fixed system blocks. Advertising everything
 * would push every owner chat turn into degradeToFit (dropping the business +
 * persona blocks) and beyond.
 *
 * This comment used to quote "94 → ~127 tools, ~85K chars (~21K tokens)".
 * Those figures were already stale when WARP-2348 measured them, and any
 * replacement literal would go stale the same way — the registry grew by three
 * tools in the 54 commits between that ticket being researched and being
 * picked up. So the numbers now live in ONE place, re-derived on every test
 * run: `tool-budget.service.test.ts` measures the real serialisation and
 * `base-prompt-budget.test.ts` holds the line in CI. Read them; do not
 * re-inline a count here.
 *
 * ── WARP-2547: THIS LIST IS NOT A BUDGET LEVER (read before adding) ─
 *
 * If you arrived here because `base-prompt-budget.test.ts` went red when you
 * registered a tool: adding a name below is almost certainly the wrong fix,
 * and since WARP-2547 it is not even the cheap one.
 *
 * That assertion used to be a flat `poolChars < 60000`. It ran out of room —
 * 59 chars spare after WARP-2546 — and three consecutive tickets then paid it
 * in capability rather than in thought: WARP-2581 scoped
 * `money_list_open_documents` out of chat purely to stay green, and WARP-2098
 * compressed a `list_drives` description that had just been made MORE
 * accurate. Note what an entry below actually costs: it makes a tool
 * unreachable in chat ENTIRELY, not "deselected for this turn". Spending that
 * on a round number ships a dead tool to buy a green canary.
 *
 * The ceiling is now a function of the pool's own tool count (mean serialized
 * chars/tool ≤ PER_TOOL_MAX_CHARS / 2), so registering an ordinary tool WIDENS
 * the headroom instead of consuming it. A red there now means the AVERAGE
 * advertised tool has bloated: that is a group to trim, not a name to add here.
 *
 * So the only reason to add a name below is the one this file exists for —
 * POLICY, that chat should not be able to do this at all by default. If the
 * sentence you are about to write contains "budget", "headroom", "tripwire" or
 * a char count, it belongs in the other file, not this one.
 *
 * ── TWO MECHANISMS, ONE PROBLEM — why both still exist ─────────────
 *
 * Per-turn selection (`tool-selection.service.ts`) also shrinks the prompt, so
 * the obvious question is why this list survives it. They answer different
 * questions and neither subsumes the other:
 *
 *   • THIS LIST IS POLICY. It is about what chat should be ABLE to do at all,
 *     independent of the turn. "Chat must not be able to delete camera
 *     evidence by default" is not a relevance judgement — it stays true on a
 *     turn that is entirely about cameras, which is exactly the turn where a
 *     relevance scorer would most want to advertise `delete_clip`.
 *   • SELECTION IS RELEVANCE. It is about which of the permitted tools this
 *     particular sentence needs, and it changes every turn.
 *
 * Collapsing policy into relevance would mean the only thing standing between
 * a prompt-steered model and clip deletion is a keyword regex. So the layering
 * is: this list narrows the POOL, then selection narrows the TURN. Selection
 * can never re-admit what this list removed — the pool is its ceiling.
 *
 * KNOWN OVERLAP, documented rather than silently left (WARP-2448 AC: "no tool
 * is unreachable for two different reasons at once without that being
 * documented"). Measured, not assumed — `chat-tool-scope.test.ts` recomputes
 * this on every run, so it cannot go stale the way the size numbers did:
 *
 *   • `notifications` — selection HAS a keyword rule (notify/alerts), and
 *     BOTH of the domain's tools (`send_notification`, `list_notifications`)
 *     are excluded here. The rule therefore advertises nothing on any turn.
 *     A tool unreachable for two reasons at once; this is the documentation
 *     that AC asks for.
 *   • `pm` — ADR-045 slice D emptied it. Every local pm WRITE collapsed into
 *     `business_create` / `business_update`, and the five surviving reads
 *     were already excluded, so no local `pm_*` tool is in the pool and the
 *     rule advertises nothing LOCAL — the second domain in that state after
 *     `notifications`, and documented here for the same reason.
 *
 *     The rule is RETAINED, and not out of sentiment. Two jobs survive the
 *     emptying: it is the route by which a remote Atlassian `pm` catalog
 *     becomes selectable (WARP-2316 — this list names LOCAL tools, so a
 *     remote tool never passes through it), and it now also claims the
 *     `business` domain, which is where the writes went. "add a ticket for
 *     the broken dishwasher" is a pm sentence that must reach
 *     `business_create`, and the pm rule is what carries it there.
 *     WARP-2058's comment ("not one pm_* tool was ever advertised") is
 *     accurate again, for a completely different reason.
 *   • `switch`, `erp` — fully excluded AND ruleless. Coherent: no rule
 *     promises something the pool cannot deliver.
 *
 * None of these is fixed by deleting one side. The `notifications` and `pm`
 * rules are what make REMOTE tools in those domains selectable once
 * registered (Atlassian → `pm`, WARP-2316), because this list names LOCAL
 * tools only and a remote tool never passes through it.
 *
 * ── what is excluded, and why ──────────────────────────────────────
 *
 * The specialist/admin surfaces that have dedicated dashboard UI or are
 * power-user flows better driven through an external MCP client (which still
 * sees the FULL registry — this scope applies only to the orchestrator's own
 * chat advertisement, and an explicit `allowed_tools` on the request always
 * overrides it):
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
 *
 * SCOPE: local registry tools only. Runtime-registered remote tools
 * (WARP-2300) never pass through this list — their equivalent policy gate is
 * per-server allowlisting (WARP-2321), which is a different mechanism in a
 * different file for the same reason this one is not selection.
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
  // ADR-045 — the `crm_*` and `pm_*` families are gone from the registry
  // entirely (slice C took the reads, slice D the writes), so `crm_move_deal_stage`
  // and every `pm_*` name that used to sit here is unregistered and would be
  // inert. They are removed rather than left: dead entries in the one list a
  // reader consults to answer "can chat do X" are exactly how WARP-2058's
  // comment went stale.
  //
  // `business_find` and `business_timeline` are DELIBERATELY not listed. That
  // is the decision site 7 asks for — "who have we not chased?" is the
  // sentence the whole CRM suite exists for, and a tool only the dashboard can
  // reach cannot answer it. `business_create` and `business_update` stay in
  // chat for the same reason: an assistant that can describe a pipeline it
  // cannot move is the state this collapse exists to end.
  //
  // WARP-2581 — money. Reachable over /api/money and MCP.
  //
  // ⚠ WARP-2547 — this is the one entry in this list with NO policy reason.
  // It was excluded solely to keep the flat 60,000-char tripwire green
  // (that assertion sat 59 chars from red at the time). That tripwire is
  // gone, so the justification for this line is gone with it: the tool
  // serializes to 743 chars against ~23,000 of headroom, and re-admitting it
  // would still leave ~23,300 (it raises the ceiling by 1000 and the pool by
  // 743). Budget is no longer an argument either way.
  //
  // Left excluded here ON PURPOSE, because putting a money tool in front of
  // the chat model is a product call about what chat may read, not a test
  // fix, and WARP-2547 is scoped to the tripwire. Whoever owns that call
  // should delete this line rather than re-derive the argument — but do not
  // cite budget as the reason it is still here, because that reason is spent.
  "money_list_open_documents",
  // ADR-045 slice D — `business_link`, and the reason is POLICY, not budget.
  //
  // An earlier draft of this entry argued from the pool ceiling, the way
  // `crm_move_deal_stage` used to. WARP-2547 spent that argument for every
  // entry in this list at once (see the note above), and re-using it here
  // would be citing a reason that no longer exists.
  //
  // The reason that survives is the one the list is for: only two of this
  // tool's edges are live on this box (deal→project and deal→customer, both
  // columns on CrmDeal); the rest return a self-describing refusal until
  // their tables land. A verb whose dominant runtime behaviour is a refusal
  // is config-heavy power-user fare — the same category as `create_scene` and
  // `set_detection_zones` above it — and belongs to the dashboard and
  // external MCP clients, which still get it.
  //
  // REVISIT WHEN a LINK_EDGES row flips to `live`: at that point it is doing
  // real work on a chat turn and the policy reason expires too.
  "business_link",
  // erp vertical suite (external MCP / dedicated UI)
  "erp_get_schedule_today",
  "erp_find_patient",
  "erp_get_ar_summary",
  "erp_schedule_appointment",
  // (The pm vertical suite's names lived here. See the ADR-045 note above the
  // `business_link` entry: every one of them is unregistered now, and project
  // and work-item work is reachable through `business_find` /
  // `business_create` / `business_update` from the `business` domain.)
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
  // 2026-07-23 business-identity rollout — window-headroom reclaim. The
  // category-level tool guidance grew the never-dropped fixed blocks
  // (+2200-char cap) and pushed the worst-case canary 33 tokens over the
  // 16384 window; these four are config-heavy/power-user fare per this
  // list's philosophy (create_scene is the single LARGEST schema in chat
  // scope at ~1.9K chars) and reclaim ~1000 tokens for history. Dashboard
  // and external MCP clients still get them; explicit allowed_tools
  // overrides as always.
  "create_scene",
  "remove_device",
  "restore_file_version",
  "list_file_versions",
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
