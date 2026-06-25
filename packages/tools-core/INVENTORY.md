# Tool Inventory

Authoritative inventory of every tool exposed by `@droplet/tools-core` after the WARP-102 bulk port. Generated from the union of `apps/orchestrator/src/services/llm-tools.ts` (TS, in-process registry) and `services/ai-gateway/tools/executor.py` (Python, HTTP loopback registry), with the name reconciliation table from spec §6.2 applied and RBAC flags from spec §6.3 applied.

`Source` legend:
- `orchestrator` — handler logic was lifted from `llm-tools.ts` (Prisma + service-layer calls).
- `gateway` — handler logic was lifted from `executor.py` (HTTP back to orchestrator REST API; ported as TS that calls the matching `ctx.http.*` client).
- `both` — both registries had this; canonical name kept, near-duplicate collapsed.

| Name | Domain | Description | requiresWrite | requiresConfirmation | Source |
|---|---|---|---|---|---|
| list_network_devices | network | List every network device the registry knows about (MAC, IP, hostname, vendor, presence, blocked flag). | false | false | both (was: `list_devices`/`get_connected_devices` in gateway) |
| get_network_status | network | WAN/LAN interface state, WiFi state, connected device count, router system info. | false | false | gateway |
| list_dhcp_leases | network | Live DHCP lease table from the router. | false | false | orchestrator |
| get_wifi_settings | network | Current Wi-Fi SSID, channel, encryption mode, associated wireless clients. | false | false | both (canonical name `get_wifi_settings`; was `get_wifi_info` in orchestrator) |
| scan_wifi_networks | network | Scan for nearby Wi-Fi networks; returns SSID, signal, channel, encryption. | false | false | gateway |
| set_wifi_ssid | network | Change the Wi-Fi SSID (1–32 chars). | true | true | gateway |
| set_wifi_channel | network | Change the Wi-Fi channel ('auto' or numeric). | true | true | gateway |
| get_firewall_rules | network | List firewall zones, rules, and port forwards. | false | false | gateway |
| block_network_device | network | Block a device from internet access by MAC. | true | true | both (canonical name; was `block_device` in orchestrator) |
| unblock_network_device | network | Restore internet for a previously blocked MAC. | true | true | both (canonical name; was `unblock_device` in orchestrator) |
| set_phone_home_blocking | network | Block or allow 'phone home' (internet/WAN egress) for IoT, camera, and smart-home devices while keeping them working on the local network and on time (NTP + local DNS stay allowed). scope 'master' toggles the whole feature, 'cameras' the camera VLAN, 'group' a single device group (pass groupId). | true | true | WARP-613 |
| add_port_forward | network | Add a port-forward rule (external port -> internal IP:port, tcp/udp). | true | true | gateway |
| network_summary | network | One-shot network-health snapshot (WAN throughput, active clients, DNS blocked today, off-LAN bytes this month) rendered as a KPI card. WARP-470. | false | false | WARP-470 |
| get_router_system_info | network | Router hardware, OpenWrt version, uptime, CPU/memory. | false | false | gateway |
| restart_router | network | Reboot the router. Drops all connected devices for 30–90 seconds while it restarts. Owner-only. May require a confirmation step in the Droplet dashboard. | true | true | WARP-864 |
| list_ap_devices | network | List every coverage-extender AP the orchestrator knows about (status, model, IP, audit columns). | false | false | WARP-446 |
| approve_ap | network | Approve a discovered extender AP and push wireless config. | true | true | WARP-446 |
| decommission_ap | network | Remove an extender AP from the household network. | true | true | WARP-446 |
| list_files | files | List entries at a Nextcloud path. | false | false | both |
| read_file | files | Read text content of a Nextcloud file (capped at 10k chars; binary rejected). | false | false | gateway |
| search_files | files | Filename substring search across the user's Nextcloud. | false | false | both |
| search_content | files | Semantic full-text search via gRPC embedder + pgvector. | false | false | orchestrator |
| list_recent_files | files | 30 most recently modified files. | false | false | orchestrator |
| write_file | files | Create or overwrite a file (UTF-8 or base64; max 10 MB). | true | false | orchestrator |
| delete_file | files | Delete a file or directory (Nextcloud trash). | true | false | orchestrator |
| create_directory | files | Create a directory. | true | false | orchestrator |
| rename_file | files | Rename in place (basename only). | true | false | orchestrator |
| move_file | files | Move file or directory to a new path. | true | false | orchestrator |
| copy_file | files | Copy file or directory to a new path. | true | false | orchestrator |
| list_smart_home_devices | smart-home | List Matter devices grouped by category. | false | false | gateway |
| get_smart_home_device | smart-home | Detail for a single Matter device by node id. | false | false | gateway |
| control_device | smart-home | Send a Matter command (turn_on/off/toggle/set_brightness/set_temperature/lock/unlock). | true | true | gateway |
| discover_matter_devices | smart-home | Scan local Wi-Fi for new Matter devices (~15s). | false | false | gateway |
| commission_device | smart-home | Pair a new Matter device by pairing code. | true | false | gateway |
| get_command_history | smart-home | Recent command audit log (filterable by node id). | false | false | gateway |
| run_scene | smart-home | Run a saved smart-home scene by id or name (may batch lock/thermostat/light actions). Destructive: requires user confirmation. WARP-474. | true | true | WARP-474 |
| list_cameras | cameras | List configured cameras with detect/record state. | false | false | both (canonical name; was `get_cameras` in gateway) |
| list_discovered_cameras | cameras | Pending IP cameras the discovery service has found. | false | false | orchestrator |
| list_camera_events | cameras | Recent Frigate detection events (filterable by camera, limit). | false | false | both (canonical name; was `list_recent_camera_events` in orchestrator and `get_camera_events` in gateway) |
| scan_for_cameras | cameras | Kick an on-demand ONVIF + RTSP scan. | true | false | orchestrator |
| accept_discovered_camera | cameras | Accept a discovered camera into the Frigate config. | true | false | orchestrator |
| get_camera_snapshot | cameras | Return the snapshot URL for a camera. | false | false | gateway |
| list_clips | cameras | List recent camera clips (events with `has_clip=true`). | false | false | orchestrator |
| export_clip | cameras | Render a custom-range clip and save it to the user's Nextcloud. | true | false | orchestrator |
| get_camera_live_url | cameras | Dashboard URL for a live camera view. | false | false | orchestrator |
| share_clip | cameras | Issue a short-lived signed URL for a saved clip. | true | true | orchestrator |
| get_switch_ports | switch | Status of all ports on the managed PoE switch. | false | false | gateway |
| get_switch_vlans | switch | List VLANs and port memberships. | false | false | gateway |
| set_port_vlan | switch | Assign a switch port to a VLAN (tagged/untagged). | true | true | gateway |
| get_switch_poe | switch | PoE power-delivery status per port. | false | false | gateway |
| set_port_poe | switch | Enable/disable PoE on a port. | true | true | gateway |
| detect_wan_port | switch | Auto-detect which switch port is the WAN uplink. | true | false | gateway |
| setup_camera_ports | switch | One-click VLAN + port setup for cameras. | true | true | gateway |
| create_event | calendar | Create a calendar event on the user's local Droplet calendar. | true | false | orchestrator |
| list_events | calendar | List calendar events in a time range. | false | false | orchestrator |
| update_event | calendar | Update fields on an existing local event. | true | false | orchestrator |
| delete_event | calendar | Delete a local calendar event. | true | false | orchestrator |
| create_reminder | reminders | Create a reminder with a due time. | true | false | orchestrator |
| list_reminders | reminders | List the user's reminders. | false | false | orchestrator |
| complete_reminder | reminders | Mark a reminder completed (or un-complete). | true | false | orchestrator |
| send_notification | notifications | Send an immediate in-app toast notification. | true | false | orchestrator |
| list_notifications | notifications | List recent notifications dispatched to the user. | false | false | orchestrator |
| get_system_health | system | Aggregate health of every component (DB, Redis, MQTT, router, Frigate, ai-gateway). | false | false | both |
| list_drives | system | Mounted data drives (NVMe partitions + USB) with usage. | false | false | orchestrator |
| list_storage_pools | system | mdadm software-RAID pools: device, level, health (active/degraded/resyncing/failed), members. Empty when none. Read-only — destructive pool ops are NOT tools (ADR-019). BUG-3. | false | false | BUG-3 |
| memory_recall | memory | Recall durable memory facts about the user/workspace whose text contains the query (optional category filter). Tier-1 read. WARP-461. | false | false | WARP-461 |
| memory_extract_fact | memory | Persist a durable memory fact (preference / workflow / scope / schedule). Tier-2 write — handler-enforced confirmation: first call returns confirmation_required; writes only on a confirmed re-issue (confirmed: true) after the user approves in chat. WARP-461. | true | true | WARP-461 |
| email_search | email | List email threads in an account, filtered by triage tab (inbox/triaged/archived) or `droplet`. WARP-466. | false | false | WARP-466 |
| email_read | email | Fetch the full content of an email thread (subject, sender, every message in order). WARP-466. | false | false | WARP-466 |
| email_summarize_thread | email | Structured analysis of a thread (summary, callouts, suggested actions, related refs) for the AI side panel. WARP-466. | false | false | WARP-466 |
| email_draft_reply | email | Draft a reply (writes EmailDraft, draftedByDroplet=true). Write tier, no confirm (draft is reversible); does NOT send. WARP-466. | true | false | WARP-466 |
| email_send | email | Send a drafted email. Write tier + confirmation (mail leaves the LAN). WARP-466. | true | true | WARP-466 |
| pm_create_work_item | pm | Create a work item (issue) under a project. WARP-509. | true | true | orchestrator |
| pm_update_work_item | pm | Update fields on an existing work item. WARP-509. | true | true | orchestrator |
| pm_add_work_item_comment | pm | Add a comment to a work item. WARP-509. | true | true | orchestrator |
| pm_transition_work_item | pm | Move a work item into a new state. WARP-509. | true | true | orchestrator |
| pm_list_workspaces | pm | List all project workspaces. WARP-508. | false | false | orchestrator |
| pm_list_projects | pm | List projects in a workspace. WARP-508. | false | false | orchestrator |
| pm_list_work_items | pm | List work items in a project (optional state/assignee filters). WARP-508. | false | false | orchestrator |
| pm_get_work_item | pm | Fetch a single work item by id. WARP-508. | false | false | orchestrator |
| pm_search_work_items | pm | Search work items in a workspace by query. WARP-508. | false | false | orchestrator |

## Deferred (not ported in WARP-102)

| Name | Reason |
|---|---|
| list_sync_targets | Hits `/api/sync/targets` which does not exist in `apps/orchestrator/src/routes/`. No backing endpoint. Defer to a follow-up ticket once the sync surface is real. |
| trigger_sync | Hits `/api/sync/trigger` which does not exist in `apps/orchestrator/src/routes/`. No backing endpoint. Defer to a follow-up ticket once the sync surface is real. |

## Counts

- Registered: 80 tools. (56 base [WARP-100 ×5 + WARP-102 ×51] + 14 pre-PR additions [WARP-446 ×3 AP tools, WARP-613 ×1 `set_phone_home_blocking`, PM ×9 WARP-508/509, ×1 other] + 9 previous PRs [memory ×2 WARP-461, email ×5 WARP-466, `network_summary` WARP-470, `run_scene` WARP-474] + 1 WARP-864 [`restart_router`] = 80.) This count is pinned by `__tests__/registry.test.ts` (`EXPECTED_TOOL_NAMES` and `TOOL_CATALOG.length === TOOLS.size`); update both in lockstep when adding/removing a tool.
- Deferred: 2 tools.
- Reconciled / collapsed: 4 (`block_device`, `unblock_device`, `get_cameras`, `get_camera_events`/`list_recent_camera_events`, `get_wifi_info`, `list_devices`/`get_connected_devices`) — all merged into the canonical names listed above.
