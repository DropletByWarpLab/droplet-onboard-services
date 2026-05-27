# Smart-port Phase 2 — what landed vs. what's deferred

## Landed in this branch

- **`services/camera-discovery/frigate_client.py`** — `VENDOR_RTSP_TEMPLATES` + `build_rtsp_url(vendor, ip, user, pw)` helper covering Hanwha, Hikvision, Axis, Dahua, Reolink, Amcrest. URL-escapes embedded credentials. 12 unit tests in `services/camera-discovery/tests/test_frigate_client_vendor_urls.py`.

- **`build_rtsp_url` integration into `accept_camera`** — `services/camera-discovery/main.py:700-720` now calls `build_rtsp_url(vendor, ip, user, pw)` when the camera has a known vendor + cached init credentials, falling back to the probe URL otherwise. The `_initialized_creds: dict[str, dict]` cache (keyed by IP, value `{vendor, username, password}`) survives between `initialize_camera` and `accept_camera`; rejecting a camera evicts its entry so a later re-add doesn't replay stale creds. The `add_camera_to_frigate` tool stays for the unknown-vendor fallback path.

- **`scripts/lantronix-reip.sh`** — the runbook from [WARP-400](https://warp-lab.atlassian.net/browse/WARP-400) §4 turned into a script with hard pre-checks. Will not run unless the operator's workstation has an IP on the destination subnet, can ping the gateway, and the switch responds at the current IP. Designed to be run by-hand from the box while the operator is physically present.

## Deferred (follow-ups on this branch or as siblings)

### VLAN 10 reactivation (`docker/openwrt/etc/config/{network,dhcp}` + `nftables.d/cams.nft`)

Touches the box's running host-net + container-net stack. The current POC overrides in `services/poc/droplet-poc-host-net.{sh,defaults,service}` already shape that stack in a way that has to be reconciled with VLAN 10 returning. Doing this blind from a feature branch risks losing the existing camera path. Plan: spin up a second branch with the operator present at the box, iterate the UCI + nftables config live, then PR.

### Lantronix mgmt re-IP execution

`scripts/lantronix-reip.sh` is committed but **was NOT run**. The actual re-IP requires the operator physically near the box (to recover via the front-panel console if a pre-check is bypassed and the re-IP misfires). The Phase 2 PR ships the script + runbook; firing it is a separate operator action that updates `LANTRONIX_HOST` in `.env` afterwards.

## Pointers for the next session

- Memory: [[project_droplet_v2_hw]] for the v2.6 chassis context; [[project_photo_studio_poc_state]] for the box state at deploy time; [[reference_layout_playbook]] for hardware-side conventions when the Phase 6 dashboard "Network" tab eventually surfaces port-level UI.
- Shared brain: `shared_brain/projects/droplet-pi-platform/docs/llm-safety-tiers.md` for the Tier-2 = dashboard-confirm contract that Phase 4's deferral interceptor enforces in autonomous mode.
- Convention: per [[feedback_align_with_shared_brain]], any OpenWRT/routing change in the deferred VLAN work MUST cross-check the existing routing patterns first; do not invent a parallel UCI scheme.
