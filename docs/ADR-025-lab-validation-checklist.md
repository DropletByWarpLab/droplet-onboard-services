# ADR-025 — Lab validation checklist (multi-backend AP onboarding)

> Renumbered from a duplicate "ADR-024" filename on 2026-07-25 (WARP-1563). The decision record for multi-backend coverage-AP onboarding is [ADR-024](ADR-024-multibackend-ap-onboarding.md); this checklist is its lab-validation companion and now owns the previously unassigned ADR-025 slot.
>
> **Not to be confused with ADR-025A** — the Cloudflare Tunnel relay / named-address remote-access decision, which lives in the `droplet-fleet-hq` repo. Older docs that cite a bare "ADR-025" for the relay mean ADR-025A.

The orchestrator backends (UniFi + EasyMesh) are built and unit-tested against mocks. The wire/RF details below could **not** be exercised on this laptop — they need real hardware on the lab LAN + the `feat/adr-024-multibackend-ap-onboarding` branch deployed to the box. This is the punch-list to turn "code-complete" into "validated".

## Prerequisites

- [ ] `feat/adr-024-multibackend-ap-onboarding` deployed to the box at `192.168.1.87` (it is NOT on `origin/main`; the box runs plain main today — deploy/reflash the branch first).
- [ ] **UniFi tail:** a Ubiquiti AP (e.g. U6/U7) + a reachable UniFi Network controller (UDM / CloudKey / self-host) with an official-API key.
- [ ] **EasyMesh tail:** a Wi-Fi-Alliance-certified EasyMesh **agent** AP (TP-Link Archer/RE line is the reference), plugged into `br-lan`.

## UniFi backend — wire shapes to confirm against a real controller

All in `apps/orchestrator/src/services/unifi-network.client.ts` (each marked `// VALIDATE against real controller`). Set `DROPLET_AP_UNIFI_ENABLED=1`, `DROPLET_AP_UNIFI_CONTROLLER_URL`, `DROPLET_AP_UNIFI_API_KEY`.

- [ ] **U1** API-key header name — `X-API-Key` vs `Authorization: Bearer`.
- [ ] **U2** pending-adoption list endpoint + payload shape (`listPendingDevices`, guessed `/proxy/network/integration/v1/devices/pending`).
- [ ] **U3** adopt-by-MAC endpoint + request-body key (`adoptDevice`, `.../devices/adopt`).
- [ ] **U4** WLAN-config push endpoint + body keys `ssid`/`passphrase`/`band` (`pushWlanConfig`, `.../devices/wlan`).
- [ ] **U5** device-list endpoint + `state` field name (`getDeviceStatus`, `.../devices`).
- [ ] **U6** forget/remove endpoint + body key (`forgetDevice`, `.../devices/forget`).
- [ ] **Flow:** factory UniFi AP on `br-lan` → appears in `/api/aps/discovered` as `backend=UNIFI` → `approve_ap` in chat → adopt + WLAN push → `ONLINE` → joins the household SSID.

## EasyMesh backend — prplMesh controller (the open hardware risk)

### Orchestrator client (ubus/data-model shapes)
All in `apps/orchestrator/src/services/easymesh-controller.client.ts` (marked `// VALIDATE against real prplMesh controller`). Set `DROPLET_AP_EASYMESH_ENABLED=1`, `DROPLET_AP_EASYMESH_CONTROLLER_URL`.

- [ ] **E1** 1905.1 topology object/method + AL-MAC / device-info field names (`listOnboardingAgents`).
- [ ] **E2** Multi-AP M1/M2 onboarding method + credential body keys (`onboardAgent`).
- [ ] **E3** agent-status / topology query method + state field (`getAgentStatus`).
- [ ] **E4** agent-remove method + body key (`removeAgent`).
- [ ] **E5** AL-MAC vs discovery-MAC mapping — confirm the approve key (`normalizeMac(mac)`) targets the right agent.

### OpenWrt overlay (DRAFT / UNVALIDATED — `openwrt/`)
- [ ] **R1** prplMesh controller package name + whether it needs a custom **prpl feed** (NOT in stock OpenWrt 24.10).
- [ ] **R2** controller-package build availability for our target (prplMesh prebuilts are Intel/Qualcomm; mt76/bcm27xx/x86 UNCONFIRMED).
- [ ] **R3** can the controller run **agent-disabled** (pure controller-only) on a prplMesh build.
- [ ] **R4** mt76 + this hostapd honor `multi_ap '1'` on the fronthaul BSS **and a real TP-Link EasyMesh agent onboards** — **this is the ADR-024 §2 exit gate.**
- [ ] **R5** prplMesh init-script name + UCI keys (`management_mode`/`operating_mode`) confirmed against a real install.
- [ ] **Single-box fold-in:** once R1–R5 are confirmed, bake the controller package set into `openwrt/singlebox-image/Dockerfile` (the single-box image does not consume the legacy `files/etc/config/wireless` + `99-droplet-setup` drafts — same way hostapd/umdns/dawn are baked today).
- [ ] **Flow:** TP-Link agent on `br-lan` → `/api/aps/discovered` as `backend=EASYMESH` → `approve_ap` → M1/M2 onboard → `ONLINE` → roams cleanly (dawn).

## If a tail can't be validated yet

Both backends are **default-off**, so an un-validated tail ships inert — `origin/main` behavior is unchanged until a flag is flipped. Validation can land as a follow-up once hardware is available; nothing blocks merging the green, flag-gated code.
