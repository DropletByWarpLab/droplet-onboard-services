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
| read_file | files | Read text content of a Nextcloud file, 10k characters per call, paged via `offset`/`next_offset` (`null` only when exhausted); binary rejected with a pointer at `read_document_text`. WARP-2194. | false | false | gateway |
| search_files | files | Filename substring search across the user's Nextcloud. | false | false | both |
| search_content | files | Semantic full-text search via gRPC embedder + pgvector. | false | false | orchestrator |
| read_document_text | files | Full extracted text of one document in chunk order, paged via `next_chunk`; NOT_INDEXED when the file has no extracted text. Reads PDFs/scans `read_file` rejects. WARP-2057. | false | false | orchestrator |
| list_recent_files | files | 30 most recently modified files. | false | false | orchestrator |
| write_file | files | Create or overwrite a file (UTF-8 or base64; max 10 MB). | true | false | orchestrator |
| delete_file | files | Delete a file, or a directory AND EVERYTHING INSIDE IT, to the Nextcloud trash (restorable from the dashboard; emptying the trash stays dashboard-only). Write-tier + interceptor-owned confirmation as of WARP-2669 — it shipped `false` from the WARP-102 port, which triaged destructiveness for network/switch/smart-home and never did the files domain; `docs/tool-confirmation-contract.md` §3 had been using this tool as its worked example of a challenging one the whole time. No `confirmed` flag in the schema, so only a human-minted token gets through. | true | true | orchestrator |
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
| remove_device | smart-home | Unpair (decommission) a Matter device by name or node id. Destructive: handler-enforced two-step confirmation. WARP-1447. | true | true | WARP-1447 |
| create_scene | smart-home | Create a named scene from device actions (device names resolved to nodeIds before the confirmation echo; run later via run_scene or the dashboard scheduler). Write-tier: handler-enforced two-step confirmation. WARP-1447. | true | true | WARP-1447 |
| assign_device_room | smart-home | Put a Matter device in a room (`PATCH /api/matter/devices/:nodeId/alias`, `{roomId}`-only body so the display name is never touched; auto-creates the room). WARP-1447. | true | false | WARP-1447 |
| get_drive_health | system | Per-drive SMART status + temperature via `/api/storage/drives` (WARP-612 collector); clean informative result with an enable hint while `DRIVE_SMART_ENABLED` is off. WARP-1450. | false | false | orchestrator → device-bridge |
| get_audit_log | system | Household audit trail over the HMAC-chained ActivityRow log (`/api/activity`); handler role-gated to owner/admin (WARP-845 forwarded role). WARP-1450. | false | false | orchestrator |
| get_update_status | system | OTA status: current/pending verified update, apply phase, last verdict, channel settings (`/api/updates/status`); handler role-gated owner/admin. WARP-1450. | false | false | orchestrator |
| apply_update | system | Apply the pending cosign-verified update via `/api/updates/apply-now`: fire-and-return on the 202 (never awaits — services restart, chat may drop); honesty codes surfaced verbatim; handler role-gated owner/admin + two-step confirmation. WARP-1450. | true | true | orchestrator |
| search_calendar_events | calendar | Case-insensitive text search over title/description/location on the local calendar (+ optional date range); pure prisma, `ctx.userId`-scoped. WARP-1452. | false | false | prisma |
| search_contacts | email | Contacts derived on-read from indexed mail senders (address, name, last seen, message count; ranked by frequency then recency); `ctx.userId`-scoped via EmailAccount. WARP-1452. | false | false | prisma |
| list_file_versions | files | List a file's saved versions (Nextcloud WebDAV PROPFIND via `/api/files/versions`). WARP-1456. | false | false | orchestrator → nextcloud |
| restore_file_version | files | Roll a file back to an earlier version (`/api/files/versions/restore`; Nextcloud keeps the pre-restore content as a new version); handler-enforced confirmation. WARP-1456. | true | true | orchestrator → nextcloud |
| share_file | files | Create a Nextcloud public share link (expiry/permissions/optional password; password never echoed); handler-enforced confirmation (public-link footgun). WARP-1456. | true | true | orchestrator → nextcloud |
| create_document | files | Create a new empty .docx/.xlsx from committed OOXML seed templates via the files write path; opens in the dashboard Files app (OnlyOffice when enabled). WARP-1458 (needs the WARP-1460 upload-route fix). | true | false | orchestrator → nextcloud |
| create_pdf_report | files | Render a titled Markdown body to PDF via POST /api/files/render → services/doc-render (reportlab) and save it to the user's files. WARP-2211/2212. | true | false | nextcloud |
| create_word_document | files | Render a titled Markdown body to .docx via POST /api/files/render → services/doc-render (python-docx); stays editable in the dashboard's Office editor. WARP-2211/2212. | true | false | nextcloud |
| create_spreadsheet | files | Render sheets of columns+rows to .xlsx via POST /api/files/render → services/doc-render (openpyxl); native cell types, no coercion. WARP-2211/2212. | true | false | nextcloud |
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
| detect_wan_port | switch | Auto-detect which switch port is the WAN uplink. | true | true | gateway |
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
| get_gpu_status | system | Live GPU counters (utilisation, VRAM used/total, power, temperature) plus the processes holding the card and the container each belongs to, via `/api/hardware/gpu` → host device-bridge `/gpu`. Route is `requireRoleOrMcpService` so the tool is actually reachable; the handler is therefore role-gated to owner/admin (WARP-845 forwarded role) — the route only ever sees the service principal, and the payload is host process data. Counters may be null — an idle card is runtime-suspended and unreadable, which is not 0%. WARP-1861. | false | false | orchestrator |
| list_drives | system | Mounted data drives (NVMe partitions + USB) with usage. | false | false | orchestrator |
| list_storage_pools | system | mdadm software-RAID pools: device, level, health (active/degraded/resyncing/failed), members. Empty when none. Read-only — destructive pool ops are NOT tools (ADR-019). BUG-3. | false | false | BUG-3 |
| memory_recall | memory | Recall durable memory facts about the user/workspace whose text contains the query (optional category filter). Tier-1 read. WARP-461. | false | false | WARP-461 |
| memory_extract_fact | memory | Persist a durable memory fact (preference / workflow / scope / schedule). Tier-2 write — handler-enforced confirmation: first call returns confirmation_required; writes only on a confirmed re-issue (confirmed: true) after the user approves in chat. WARP-461. | true | true | WARP-461 |
| email_search | email | List email threads in an account, filtered by triage tab (inbox/triaged/archived) or `droplet`. WARP-466. | false | false | WARP-466 |
| email_read | email | Fetch the full content of an email thread (subject, sender, every message in order). WARP-466. | false | false | WARP-466 |
| email_summarize_thread | email | Structured analysis of a thread (summary, callouts, suggested actions, related refs) for the AI side panel. WARP-466. | false | false | WARP-466 |
| email_draft_reply | email | Draft a reply (writes EmailDraft, draftedByDroplet=true). Write tier, no confirm (draft is reversible); does NOT send. WARP-466. | true | false | WARP-466 |
| email_send | email | Send a drafted email. Write tier + confirmation (mail leaves the LAN). WARP-466. | true | true | WARP-466 |
| pm_create_project | pm | Create a project in the tracker. WARP-2058. | true | true | orchestrator |
| pm_create_work_item | pm | Create a work item (issue) under a project. WARP-509. | true | true | orchestrator |
| pm_update_work_item | pm | Update fields on an existing work item. WARP-509. | true | true | orchestrator |
| pm_add_work_item_comment | pm | Add a comment to a work item. WARP-509. | true | true | orchestrator |
| pm_transition_work_item | pm | Move a work item into a new state. WARP-509. | true | true | orchestrator |
| pm_list_workspaces | pm | List all project workspaces. WARP-508. | false | false | orchestrator |
| pm_list_projects | pm | List projects in a workspace. WARP-508. | false | false | orchestrator |
| pm_list_work_items | pm | List work items in a project (optional state/assignee filters). WARP-508. | false | false | orchestrator |
| pm_get_work_item | pm | Fetch a single work item by id. WARP-508. | false | false | orchestrator |
| pm_search_work_items | pm | Search work items in a workspace by query. WARP-508. | false | false | orchestrator |
| crm_search_customers | crm | Search CRM customers (companies) by name or web domain. WARP-2546. | false | false | orchestrator |
| crm_get_customer | crm | One customer with their open deals and recent timeline. WARP-2546. | false | false | orchestrator |
| crm_list_deals | crm | List deals, filtered by outcome / customer / idle days. WARP-2546. | false | false | orchestrator |
| crm_get_deal | crm | One deal with its recent timeline. WARP-2546. | false | false | orchestrator |
| crm_pipeline_summary | crm | Deal count and value per pipeline stage. WARP-2546. | false | false | orchestrator |
| crm_log_activity | crm | Append a note/call/meeting/task/email to a customer's or deal's timeline. WARP-2546. | true | true | orchestrator |
| crm_move_deal_stage | crm | Move a deal to another stage in its own pipeline. WARP-2546. | true | true | orchestrator |
| erp_get_schedule_today | erp | Get the practice's appointment schedule for a day (Eaglesoft). Read-only. Returns ERP_NOT_CONNECTED until WARP-1095+. | false | false | orchestrator → erp-connector |
| erp_find_patient | erp | Search patients in the ERP (Eaglesoft) by name, minimum-necessary fields. Read-only. Returns ERP_NOT_CONNECTED until WARP-1095+. | false | false | orchestrator → erp-connector |
| erp_get_ar_summary | erp | Accounts-receivable summary (aggregated in SQL) from the ERP (Eaglesoft). Read-only. Returns ERP_NOT_CONNECTED until WARP-1095+. | false | false | orchestrator → erp-connector |
| erp_schedule_appointment | erp | Schedule/reschedule an appointment (Eaglesoft). Write tier + confirmation; stages a write request, never writes directly. Returns ERP_NOT_CONNECTED until WARP-1095+. | true | true | orchestrator → erp-connector |
| money_list_open_documents | money | Invoices and bills this box has LANDED from the connected cloud ledgers (`ErpDocument`), via `GET /api/money/documents`: who owes what, what is due, what is overdue. Read-only — the vendor stays the system of record. Balances are what remains UNPAID, not the invoiced total, and figures from different ledgers are never added (a ledger's currency is usually its own home currency, which the box does not know). Excluded from the chat pool while the base-prompt budget tripwire stands; MCP- and API-reachable. WARP-2581. | false | false | orchestrator |
| cloud_query_dataset | cloud | Read business records from the connected cloud SaaS accounts by dataset name (`charge`/`invoice` → Stripe, `contact`/`company`/`deal`/`ticket`/`engagement` → HubSpot, `campaign`/`audience_member`/`ecommerce_order` → Mailchimp) via `GET /api/erp/dataset/:dataset`. ONE tool for all three vendors — a tool per vendor or per dataset would add ten blocks to the registry serialization the canary already caps. Read-only. WARP-2497. | false | false | orchestrator → erp-connector |
| start_agent_run | agent_runs | Start a durable background run: Droplet works on a multi-step goal unattended (minutes, not seconds), parks on any Tier-2 action for the owner's approval, and notifies when done. POST `/api/agent-runs` on behalf of the acting user, whose role the route checks (no privilege laundering). Refuses inside a run. Write-tier + confirmation (it spends compute unattended). WARP-2180. | true | true | orchestrator |
| list_agent_runs | agent_runs | List the acting user's background runs, newest first, with state, step count, result preview and any action a run waits on. GET `/api/agent-runs`. Read-only. WARP-2180. | false | false | orchestrator |
| business_profile_get | business | Read the structured business profile (what-we-do, customers, team, tools, typical day, goals + summary). Read-only; role-filtered (family sees the summary only). WARP-1120. | false | false | orchestrator |
| team_chat_send_message | team_chat | Send a Messages (team chat) text on the acting human's behalf — recipients (usernames; direct deduped, several = group) or thread_id. Write tier + handler-enforced two-phase confirmation; X-Droplet-User identity. WARP-1685. | true | true | WARP-1685 |
| team_chat_send_meeting_invite | team_chat | Schedule a meeting in a Messages thread (invite card + RSVP + organizer-calendar mirror + pre-start reminder). Write tier + handler-enforced two-phase confirmation; X-Droplet-User identity. WARP-1685. | true | true | WARP-1685 |
| encode_text | data | Encode text as base64, base64url, hex, or URL (percent-encoding). Pure computation. WARP-899. | false | false | WARP-899 |
| decode_text | data | Decode text from base64, base64url, hex, or URL (percent-encoding); rejects malformed input per encoding. Pure computation. WARP-899. | false | false | WARP-899 |
| hash_text | data | Hex digest of text via Node crypto (sha256/sha1/md5); non-security-grade, unsalted/unstretched. Pure computation. WARP-899. | false | false | WARP-899 |
| convert_data_format | data | Convert between JSON, CSV, and YAML. JSON<->YAML lossless; JSON<->CSV lossless for flat string-valued records (no type-guessing). WARP-900. | false | false | WARP-900 |
| format_json | data | Pretty-print or minify a JSON document in place. WARP-900. | false | false | WARP-900 |
| timestamp_convert | data | Convert between Unix epoch (seconds/milliseconds) and ISO-8601; auto-detects the input form. Pure computation. WARP-901. | false | false | WARP-901 |
| uuid_generate | data | Generate one or more RFC 4122 v4 UUIDs (count capped at 100). Pure computation. WARP-901. | false | false | WARP-901 |
| regex_test | data | Test/extract with a bounded regex: pattern/input length caps + a hard worker-thread execution timeout that kills pathological (catastrophic-backtracking) patterns instead of hanging. WARP-901. | false | false | WARP-901 |
| calculate | data | Safe arithmetic/scientific expression evaluator — hand-rolled parser (no eval), `+ - * / % ^`, parens, trig/log/rounding functions, `pi`/`e`; NaN/Infinity surface as errors. Pure computation. WARP-1424. | false | false | WARP-1424 |
| unit_convert | data | Convert between units of length, mass, temperature (affine °C/°F/K), volume (US), area, speed, and data size (decimal kB vs binary KiB). Pure computation. WARP-1424. | false | false | WARP-1424 |
| get_current_datetime | data | Current date/time on the box, optionally rendered in an IANA timezone (ISO-with-offset + UTC + epoch + weekday). Pure computation. WARP-1424. | false | false | WARP-1424 |
| date_math | data | Calendar arithmetic: add/subtract durations with month-end clamping, signed diff between two dates, next-weekday. Pure computation. WARP-1424. | false | false | WARP-1424 |
| memory_forget | memory | Soft-disable a remembered fact (`active=false`, row retained for the evidence chain); handler-enforced confirmation flow; WARP-845 audience-gated with no existence leak. WARP-1425. | true | true | prisma |
| set_timer | reminders | Countdown timer as a Reminder row with server-side `dueAt = now + duration` (≤7 days); cancel/list deliberately ride `complete_reminder`/`list_reminders`. WARP-1425. | true | false | prisma |
| translate_text | data | Translate text between languages via the orchestrator's single-turn completion endpoint (`/api/llm/complete`); returns only the translation. WARP-1426. | false | false | orchestrator → ai-gateway |
| summarize_file | files | Read a file (Nextcloud download, read_file semantics) then summarize via `/api/llm/complete`; content past 24k chars is dropped with a `truncated` flag. WARP-1426. | false | false | nextcloud + orchestrator → ai-gateway |
| get_weather | data | Current weather + 7-day forecast for a named place via the screened `/api/web/weather` route (ambient_data off-LAN channel, fail-closed; Open-Meteo). WARP-1436. | false | false | orchestrator → web-fetch |
| currency_convert | data | Convert an amount between currencies using cached ECB daily reference rates via `/api/web/rates`; result carries `ratesAsOf` + `stale`. WARP-1436. | false | false | orchestrator → web-fetch |
| search_camera_events | cameras | Natural-language (CLIP semantic) search over recorded camera events via `/api/cameras/events/search`; clean SEMANTIC_SEARCH_DISABLED error when Frigate's feature is off. WARP-1440. | false | false | orchestrator → frigate |
| get_camera_health | cameras | Per-camera stream fps/status + detector/GPU/storage/uptime via `/api/cameras/system`. WARP-1440. | false | false | orchestrator → frigate |
| get_camera_storage | cameras | Per-camera NVR disk usage, measured bitrate, share of volume + near-full flag via `/api/cameras/storage`. Nulls mean "not measured", never zero. WARP-1850. | false | false | orchestrator → frigate |
| set_camera_detection | cameras | Runtime enable/disable of a camera's detection+recording (no NVR restart); completes the server's WARP-41 disable confirmation handshake. WARP-1440. | true | true | orchestrator → frigate |
| set_detection_zones | cameras | Replace a camera's motion zones (+ optional masks) via `PATCH /api/cameras/:name/settings`; save restarts Frigate (~5–15 s) — confirmation echo warns. WARP-1440. | true | true | orchestrator → frigate |
| delete_clip | cameras | Permanently delete a recorded event/clip (`DELETE /api/cameras/events/:id`, new endpoint); handler-enforced confirmation. WARP-1440. | true | true | orchestrator → frigate |
| rename_camera | cameras | Change a camera's household-facing `displayName` via `PATCH /api/cameras/:name` (new endpoint). Resolves the argument against BOTH the config key and the current display name, and refuses ambiguous matches rather than guessing. Never touches `Camera.name` — that is the Frigate config key owning recording paths and event history. No confirmation: reversible and destroys nothing. WARP-1893. | true | false | orchestrator |
| get_bandwidth_usage | network | WAN bandwidth: current rates + today/month aggregates via `/api/network/summary`, optional `1h|6h|24h|7d` series via `/api/network/throughput`. WAN-aggregate only (no per-device accounting exists). WARP-1443. | false | false | orchestrator |
| list_vpn_peers | network | List WireGuard remote-access peers (key-like fields stripped, incl. public keys). Peer creation stays human-only pending WARP-1444. WARP-1443. | false | false | orchestrator |
| list_threat_events | network | Curated security feed over ActivityRow (kinds network+auth, severity warn/error, incl. WARP-268 egress anomalies). Handler role-gated to owner/admin (WARP-845 forwarded role) — the route only sees the service principal. WARP-1443. | false | false | orchestrator |
| set_wifi_password | network | Rotate the Wi-Fi password (WPA2-PSK 8–63 printable ASCII); the password never appears in any tool response; confirmation warns every device must reconnect. WARP-1443. | true | true | orchestrator → routing |
| set_device_schedule | network | Per-device internet schedules over the WARP-93/94 Schedule CRUD: set (create-or-replace weekly block windows), clear, list. Windows BLOCK during the window; confirmation echo states the direction. WARP-1443. | true | true | orchestrator (prisma + ticker) |

## Deferred (not ported in WARP-102)

| Name | Reason |
|---|---|
| list_sync_targets | Hits `/api/sync/targets` which does not exist in `apps/orchestrator/src/routes/`. No backing endpoint. Defer to a follow-up ticket once the sync surface is real. |
| trigger_sync | Hits `/api/sync/trigger` which does not exist in `apps/orchestrator/src/routes/`. No backing endpoint. Defer to a follow-up ticket once the sync surface is real. |

## Counts

- Registered: 148 tools. (56 base [WARP-100 ×5 + WARP-102 ×51] + 15 pre-PR additions [WARP-446 ×3 AP tools, WARP-613 ×1 `set_phone_home_blocking`, PM ×9 WARP-508/509, ×2 other] + 9 previous PRs [memory ×2 WARP-461, email ×5 WARP-466, `network_summary` WARP-470, `run_scene` WARP-474] + 1 WARP-864 [`restart_router`] + 4 WARP-1094 [ERP-connector: 3 Read-tier + 1 Write-tier `erp_schedule_appointment`] + 1 WARP-1120 [business-knowledge: `business_profile_get`] + 5 WARP-899/WARP-900 [data domain: `encode_text`, `decode_text`, `hash_text`, `convert_data_format`, `format_json`, all Read-tier] + 3 WARP-901 [data domain: `timestamp_convert`, `uuid_generate`, `regex_test`, all Read-tier] + 4 WARP-1424 [data domain: `calculate`, `unit_convert`, `get_current_datetime`, `date_math`, all Read-tier] + 2 WARP-1425 [`memory_forget` (Write-tier + confirmation), `set_timer` (Write-tier)] + 2 WARP-1426 [`translate_text`, `summarize_file`, both Read-tier] + 2 WARP-1436 [`get_weather`, `currency_convert`, both Read-tier] + 5 WARP-1440 [cameras: `search_camera_events`, `get_camera_health` Read-tier; `set_camera_detection`, `set_detection_zones`, `delete_clip` Write-tier + confirmation] + 5 WARP-1443 [network: `get_bandwidth_usage`, `list_vpn_peers`, `list_threat_events` Read-tier; `set_wifi_password`, `set_device_schedule` Write-tier + confirmation] + 3 WARP-1447 [smart-home: `assign_device_room` Write-tier; `create_scene`, `remove_device` Write-tier + confirmation] + 4 WARP-1450 [system: `get_drive_health`, `get_audit_log`, `get_update_status` Read-tier; `apply_update` Write-tier + confirmation] + 2 WARP-1452 [PIM: `search_calendar_events`, `search_contacts`, both Read-tier pure-prisma] + 4 WARP-1456/1458 [files: `list_file_versions` Read-tier; `restore_file_version`, `share_file` Write-tier + confirmation; `create_document` Write-tier] + 2 WARP-1685 [team_chat: `team_chat_send_message`, `team_chat_send_meeting_invite`, both Write-tier + two-phase confirmation] + 1 WARP-1850 [cameras: `get_camera_storage` Read-tier] + 1 WARP-1861 [system: `get_gpu_status` Read-tier] + 1 WARP-1893 [cameras: `rename_camera` Write-tier, no confirmation] + 2 WARP-2057/WARP-2058 [files: `read_document_text` Read-tier; pm: `pm_create_project` Write-tier + confirmation] + 3 WARP-2211/WARP-2212 [files: `create_pdf_report`, `create_word_document`, `create_spreadsheet`, all Write-tier, no confirmation — each creates a NEW file at a path the caller named and the render route refuses an existing one] + 1 WARP-2497 [cloud: `cloud_query_dataset` Read-tier — a SINGLE tool spanning Stripe, HubSpot and Mailchimp and all ten datasets, because the registry's serialized size is the binding constraint] + 2 WARP-2180 [agent_runs: `start_agent_run` Write-tier + confirmation, `list_agent_runs` Read-tier] = 148 — the running total here lagged the registry by eight before this edit; the number that is actually pinned is `TOOLS.size` in `__tests__/registry.test.ts`, and it read 146 before these two landed.) The prior "84" here undercounted the live registry by one (the fuzzy `other` bucket); WARP-1120 corrected it and added the business tool; WARP-899/WARP-900, WARP-901, and WARP-1424 together build out the data-utility domain (12 tools). This count is pinned by `__tests__/registry.test.ts` (`EXPECTED_TOOL_NAMES` and `TOOL_CATALOG.length === TOOLS.size`); update both in lockstep when adding/removing a tool.
- Deferred: 2 tools.
- Reconciled / collapsed: 4 (`block_device`, `unblock_device`, `get_cameras`, `get_camera_events`/`list_recent_camera_events`, `get_wifi_info`, `list_devices`/`get_connected_devices`) — all merged into the canonical names listed above.
