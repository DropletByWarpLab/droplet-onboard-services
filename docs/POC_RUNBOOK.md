# Droplet POC — Single-box Runbook

> **Branch:** `poc/single-box` of `DropletByWarpLab/droplet-pi-platform`.
> **Box:** `droplet-c4d4df` (AMD Ryzen 7 7700X, 30 GiB RAM, AMD RDNA4 16 GB
> dGPU, 2× 2 TB SATA, Inland TN320 NVMe root).
> **DO NOT MERGE to main** — single-box is a POC tactic; production stays
> on the dual-CPU v2.6 modular hardware spec.

---

## Quick start

On a fresh box with the cards already installed and a network cable plugged
in (WAN on Realtek port 1 OR WiFi configured in netplan):

```bash
git clone <repo> ~/edge-platform
cd ~/edge-platform
git checkout poc/single-box
sudo ./scripts/setup.sh
```

That single command produces:

- All data drives auto-mounted under `/mnt/droplet/<name>`
- Docker installed; 14 containers built and started
- Host-side `droplet-openwrt-attach.service` installed and enabled
- Customer WiFi AP (`Droplet-POC`) up and serving DHCP
- Local LLM (`llama3.1:8b-instruct-q8_0`) loaded on the dGPU via Ollama
- All drives registered as Nextcloud external storage and writable from
  the dashboard file browser

Open `https://<box-ip>/` (the management NIC's IP) or
`https://droplet-<MAC-suffix>.local/` (mDNS) and walk the setup wizard
to create the first admin user.

---

## Phases shipped on `poc/single-box`

```
fdb4cf2  Phase G   - mobile-responsive grid fixes across 4 pages
7c43ba6  fix:      - collapse phase-7 if-condition
8c2b97e  fix:      - restore verify.sh test
490fe92  Phase F   - /mnt/droplet/ canonical + Nextcloud external auto-register + systemd unit auto-install
c381611  Phase E   - storage auto-detect lib + VPN .env + host AP bring-up artifacts
84f997b  Phase D+  - DHCP + NAT + uci-persist + ubus-over-HTTP (phone CONNECTED)
6ecb0c5  Phase D   - OpenWrt 24.10.2 container + MT7921 WiFi AP
2ff7646  Phase C   - kernel 6.17 + Ollama-on-dGPU + ai-gateway CPU torch
a7b08bb  Phase A+B - baseline + preflight/em-dash fixes + initial override
```

## Hardware map

| Component | Detail | Role |
|---|---|---|
| CPU | AMD Ryzen 7 7700X (8c/16t) | Host + container workloads |
| RAM | 30 GiB | Shared |
| dGPU | AMD RDNA4 (Navi 4x, `gfx1200`, 16 GB) PCI `03:00.0` | **LLM only** (Ollama) |
| iGPU | AMD Raphael (`gfx1036`) PCI `17:00.0` | Frigate hwaccel only (renderD129) |
| Motherboard NIC | (built-in) | `ethmgmt` `192.168.10.1/24` — management/crossover |
| Realtek RTL8125 quad NIC | PCIe ×4, 4× 2.5 GbE | port 1 = WAN, ports 2–4 = LAN bridge (in OpenWrt container, TODO) |
| Intel AX210 WiFi | built-in, `wlp14s0` | Host internet (`FifteenFiftyShadesOfGrey`) — disable for customer ship |
| MediaTek MT7921 WiFi 6 | M.2 on EDM2 carrier, `wlp7s0` | Customer AP (passed to OpenWrt container) |
| SATA × 2 | 2× WDC WD20EARZ 2 TB | `/mnt/droplet/{nvr,data,data2}` |
| NVMe | Inland TN320 238 GB | OS root |

## Network topology

```
Internet
  │
  ▼  (WAN port 1 of Realtek card — TODO: pass into openwrt container)
[OpenWrt container]
  ├─ wlp7s0 (MT7921) ── AP "Droplet-POC", 192.168.20.1/24, DHCP 10–100
  ├─ docker eth0 (bridge net 172.18.0.0/16) ── reaches pi-platform stack
  └─ uhttpd + rpcd ── ubus over HTTP for services/routing/

[Host]
  ├─ ethmgmt 192.168.10.1/24 ── management (crossover to dev machine)
  └─ wlp14s0 (AX210) 192.168.1.234 ── host's internet uplink (POC; disable for ship)

[Compose stack on docker bridge 172.18.0.0/16]
  ├─ orchestrator (Express + Prisma)
  ├─ web-dashboard (Next.js 14)
  ├─ ai-gateway (FastAPI + LiteLLM, CPU torch only)
  ├─ ollama (ROCm image, dGPU pinned via /dev/kfd + /dev/dri/renderD128)
  ├─ mcp-server, file-indexer, routing, camera-discovery, device-identity-svc
  ├─ db (pgvector/pgvector:pg16), cache (redis), broker (mosquitto)
  ├─ nextcloud (29-apache) ── + /mnt/droplet → /host bind
  ├─ frigate (ghcr/blakeblackshear) ── recordings to /mnt/droplet/nvr, iGPU only
  ├─ openwrt (openwrt/rootfs:x86_64-24.10.2) ── customer router/AP/firewall
  └─ gateway (nginx) ── :80 + :443 reverse proxy
```

## Storage layout

```
/dev/nvme0n1 (238 GB)         → / (OS, Docker images + volumes)
/dev/sda1    (400 GB ext4)    → /mnt/droplet/nvr        ← Frigate recordings
/dev/sda2    (1.4 TB ext4)    → /mnt/droplet/data       ← Nextcloud external (writable)
/dev/sdb1    (1.8 TB ext4)    → /mnt/droplet/data2      ← Nextcloud external (writable)
```

All three are bind-mounted by the upstream compose:
```yaml
nextcloud:
  volumes:
    - /mnt/droplet:/host
```
…so `/host/<name>` inside the nextcloud container = `/mnt/droplet/<name>`
on the host. `setup.sh` runs `occ files_external:create` for each one after
the stack is up — they appear in the file browser as `/data`, `/data2`,
`/nvr` and uploads go straight to the host drives.

> **Known UI confusion:** the Nextcloud header shows the *primary* storage's
> free space (the OS-disk Docker volume, ~33 GB) even though the externals
> have terabytes free. Users click *into* `/data` or `/data2` to use the
> big drives. For fresh deploys we should bind-mount `/mnt/droplet/data` to
> `/var/www/html/data` in the nextcloud container so the primary becomes
> the big drive (1.4 TB). Captured below in "Outstanding work".

## Compose override summary

`docker/docker-compose.override.yml` adds (relative to upstream):

- **orchestrator / mcp-server / ai-gateway**: `OPENSSL_CONF=""` and
  `DROPLET_FIPS_REQUIRED=false` (FIPS provider not layered on this hardware)
- **device-identity-svc**: `DROPLET_TPM_BACKEND=mock` (no `/dev/tpm0`)
- **ai-gateway**: `JETSON_OLLAMA_URL=http://ollama:11434` (compose-DNS, not host)
- **frigate**: `/dev/dri/renderD129 → /dev/dri/renderD128` (iGPU only; dGPU isolated)
- **ollama** (NEW service): `ollama/ollama:rocm` image, named volume
  `ollama-data`, `/dev/kfd` + `/dev/dri/renderD128` mapped, `group_add` 993
  (render) + 44 (video), `ROCR_VISIBLE_DEVICES=0` to hide the iGPU. No
  `HSA_OVERRIDE` — container ROCm 7.x has native gfx1200.
- **openwrt** (NEW service): `openwrt/rootfs:x86_64-24.10.2`,
  `command: /sbin/init`, privileged, `NET_ADMIN`+`SYS_ADMIN`, tmpfs `/tmp`
  + `/run`, named volumes `openwrt-config` + `openwrt-overlay`. UDP 51820
  exposed to host for WireGuard.
- **volumes**: `ollama-data`, `openwrt-config`, `openwrt-overlay`

## `.env` POC additions

```
NVR_MEDIA_SOURCE=/mnt/droplet/nvr        # set by storage.sh; Frigate consumes
FRIGATE_CAMERA_FRONT_DOOR_PASSWORD=poc-placeholder

# OpenWrt + WireGuard (per VPN audit)
OPENWRT_HOST=openwrt
OPENWRT_PORT=80
OPENWRT_USERNAME=root                     # OPENWRT_PASSWORD in docker/secrets/openwrt_password
WIREGUARD_VPN_SUBNET=10.13.13.0/24        # no overlap with docker 172.18.0.0/16
WIREGUARD_LISTEN_PORT=51820
WIREGUARD_ENDPOINT_HOST=192.168.1.234     # customer's public hostname for ship
WIREGUARD_LAN_CIDR=192.168.20.0/24
WIREGUARD_DNS=192.168.20.1
```

## Source patches (worth upstreaming to `main`)

1. **`scripts/lib/preflight.sh`** — `sudo -v` → `sudo -n true`. Ubuntu 24.04's
   `Defaults use_pty` makes `sudo -v` request a TTY even with NOPASSWD,
   hanging non-interactive deploys.
2. **`services/device-identity-svc/backends/real.py`** — em-dash in bytes
   literals is a `SyntaxError`. 10 occurrences fixed.
3. **`scripts/lib/local-dns.sh:300`** — `resp_file: unbound variable` under
   `set -u`. Initialize or `${resp_file:-}`.

## New repo content (POC-only — branch only, do not merge)

```
scripts/lib/storage.sh                                ← Phase E/F: auto-detect + mount
                                                        drives at /mnt/droplet/<name>
docker/docker-compose.override.yml                    ← all the POC overrides above
docs/POC_RUNBOOK.md                                   ← this file
openwrt/poc-single-box/
  ├─ droplet-openwrt-attach                           ← host-side bring-up script
  ├─ droplet-openwrt-attach.service                   ← systemd unit
  └─ README.md                                        ← install + theory
```

## Host-side setup that survives reboot

1. `/etc/sudoers.d/99-droplet-poc` — `droplet ALL=(ALL) NOPASSWD: ALL`.
   Required during deploy; remove before ship.
2. `/etc/tmpfiles.d/droplet.conf` — `d /run/droplet 0777 root root -`.
   `/run` is tmpfs; this recreates the device-identity socket dir at boot.
3. `/etc/sudoers.d/99-droplet-poc` (above) + `/etc/apt/preferences.d/rocm.pref`
   — pins AMD repo above Ubuntu noble's stale rocm packages.
4. `/etc/systemd/system/droplet-openwrt-attach.service` — moves MT7921 into
   the container netns + brings up the AP on every container start.
   Installed by `setup.sh` (Phase F) from `openwrt/poc-single-box/`.
5. `/etc/netplan/70-eth.yaml` — MAC-pin the motherboard NIC to `ethmgmt`
   and assign `192.168.10.1/24`. Survives PCIe reshuffles.
6. `/etc/netplan/60-wifi.yaml` — `wlp14s0` (AX210) configured for the host's
   internet uplink. **Disable for customer ship** (host should reach internet
   via the OpenWrt container's WAN, not over WiFi).
7. `/etc/apt/sources.list.d/rocm.list` + `amdgpu.list` + signed-by key —
   AMD's ROCm 6.2.4 apt repo. Pin file gives it priority over Ubuntu noble.
8. `/etc/fstab` — UUID-based mounts for `/mnt/droplet/{nvr,data,data2}`
   with `defaults,nofail 0 2`.

## Recovery playbook

### Can't SSH to 192.168.10.1
PCI reshuffle changed NIC enumeration. Plug a monitor + USB keyboard:
```bash
ip -br link
# motherboard NIC's MAC is 10:ff:e0:c4:d4:df; if netplan didn't match it,
# edit /etc/netplan/70-eth.yaml and `sudo netplan apply`.
```

### WiFi `Droplet-POC` not appearing after reboot
The systemd unit should auto-attach phy1 + start hostapd. Manual check:
```bash
sudo systemctl status droplet-openwrt-attach.service
sudo journalctl -u droplet-openwrt-attach.service -n 30 --no-pager
# Trigger manually:
sudo systemctl restart droplet-openwrt-attach.service
```

### Phone connects but no internet
Verify NAT + default route inside the openwrt container:
```bash
sudo docker exec droplet-openwrt sh -c '
  ip route   # must include "default via 172.18.0.1"
  nft list ruleset | grep masquerade  # must list 192.168.20.0/24 → eth0
  cat /proc/sys/net/ipv4/ip_forward   # must be 1
'
```
All three are set by the attach script — re-run it if any are missing.

### Drives don't appear in dashboard file browser
External storages registration may have been missed. Re-run from setup.sh:
```bash
cd ~/edge-platform
source scripts/setup.sh   # exports register_nextcloud_externals
register_nextcloud_externals
```
…or directly: `sudo docker exec -u www-data droplet-pi-platform-nextcloud-1 php occ files_external:list`.
If list is empty, run `php occ app:enable files_external` then
`php occ files_external:create /<name> local null::null -c "datadir=/host/<name>"`
for each drive.

### Ollama responds with CPU-only (no dGPU)
```bash
sudo docker logs droplet-ollama 2>&1 | grep 'inference compute'
# Want: "library=ROCm compute=gfx1200 ... pci_id=0000:03:00.0 type=discrete"
# If CPU only: rocm-smi (host) confirms dGPU; ROCR_VISIBLE_DEVICES=0 in override
# is set; restart ollama container.
```

### Phase 7 "stack unhealthy"
Orchestrator's `router:false` is cosmetic until `services/routing/` can
reach the openwrt container's `/ubus`. Phase F sets the env vars; the
`droplet-ai` rpcd user inside the container is still TODO — see VPN audit.

## VPN audit (Phase E) — 12-gap status

Read the full doc in commit history (Phase E commit message body). Status:

| # | Gap | Status |
|---|---|---|
| 1 | `OPENWRT_HOST=openwrt` (was 192.168.50.1) | ✅ `.env` Phase E |
| 2 | HTTP reachability over docker bridge | ✅ verified — `curl POST /ubus` from host returns session token |
| 3 | UCI persistence across container restart | ✅ `openwrt-config` named volume |
| 4 | WireGuard interface binds to virtual veth | ⚠ blocked on creating `wg0` inside container; need test |
| 5 | Firewall masquerade for virtual WAN | ⚠ POC has fw4 disabled; needs proper zones for production |
| 6 | DuckDNS endpoint hostname not auto-detected | ⚠ `WIREGUARD_ENDPOINT_HOST` set in `.env` for POC |
| 7 | Routing service startup before openwrt ready | ⚠ no `depends_on` yet; orchestrator currently retries |
| 8 | UDP 51820 not exposed to host | ✅ port mapping in override Phase E |
| 9 | `ROUTING_SERVICE_TOKEN` not from Docker secrets | ⚠ env-based only |
| 10 | VPN subnet overlap with docker bridge | ✅ 10.13.13.0/24 vs 172.18.0.0/16 — no overlap |
| 11 | Session timeout in container restart | ⚠ docs-only |
| 12 | `droplet-ai` user in OpenWrt rpcd ACL | ⚠ POC uses root + password; `droplet-ai` user not provisioned |

End-to-end VPN test (`POST /api/vpn/setup` → mint peer → scan QR → WireGuard
handshake) NOT run yet. Next session.

## Outstanding work (priority order)

1. **Custom `droplet-openwrt` Dockerfile** — bake the opkg packages
   (`hostapd-mbedtls`, `uhttpd`, `rpcd-*`, `iw-full`) into a custom image.
   Avoids the `--force-recreate` package-reinstall path the attach script
   currently has. ~15 min.
2. **Move nextcloud's primary data dir to `/mnt/droplet/data/nextcloud`** —
   eliminates the "33 GB available" confusion. Override volume:
   ```
   nextcloud:
     volumes:
       - /mnt/droplet/data/nextcloud:/var/www/html/data
   ```
   For existing box: stop nextcloud, `rsync -av /var/lib/docker/volumes/droplet-pi-platform_nextcloud-data/_data/data/ /mnt/droplet/data/nextcloud/`, then bring up with the override. ~30 min.
3. **Pass Realtek ports into openwrt netns** — `enp10s0` = WAN, `enp11s0`–`enp13s0` = LAN bridge. Update attach script + uci `/etc/config/network`.
4. **Bridge openwrt LAN ↔ pi-platform docker network** — so customer clients on `192.168.20.x` reach the dashboard at `https://droplet-c4d4df.local/`.
5. **End-to-end VPN test** — `curl POST /api/vpn/setup` through orchestrator, peer mint, QR scan, handshake. Address audit gaps #4/#7/#12 along the way.
6. **Provision `droplet-ai` user in openwrt** — uci-defaults script with the rpcd ACL file shipped under `openwrt/files/usr/share/rpcd/acl.d/`.
7. **Pre-ship hardening** —
   - Remove `/etc/sudoers.d/99-droplet-poc`
   - Rotate `droplet` password from `Droplet123!`
   - Rotate `Droplet-POC` WiFi password and OpenWrt root password
   - Disable host WiFi (`wlp14s0` netplan)
   - Generate customer-specific TLS cert
   - Switch device-identity backend `mock` → `real` once v2.6 TPM is available

## Mobile-responsive fixes shipped (Phase G)

Galaxy S25 Ultra (360 × 800) tested. 5 grid-stacking violations fixed:

- `settings/page.tsx:139` New User form
- `users/page.tsx:532`   Add user role/displayName grid
- `remote-access/page.tsx:279` DuckDNS status grid (was 2 → 3 col; now 1 → 2 → 3)
- `network/page.tsx:812` Hardware info grid
- `network/page.tsx:824` Resources info grid

All others (sidebar, chat layout, file browser, cameras grid, settings sections) were already correctly responsive. Verified by Explore audit across `/files`, `/chat`, `/settings`, `/users`, `/remote-access`, `/cameras`, `/network`.

To verify after future changes: open the dashboard from a phone (or browser dev-tools at 360px wide). Forms should stack vertically; data grids fold to 1 column at <640px.

## Secrets and POC-only items (DO NOT replicate for customer)

- `droplet` user has NOPASSWD sudo (`/etc/sudoers.d/99-droplet-poc`)
- `droplet` password: `Droplet123!`
- OpenWrt root password: `droplet-poc-router`
- WiFi `Droplet-POC` PSK: `droplet-poc-password`
- Self-signed TLS cert with multiple SANs (10-year validity)
- FIPS provider not layered (mock crypto, OpenSSL stock config)
- Device-identity backend = `mock` (no TPM attestation)
- Frigate placeholder camera password in `.env`
- AX210 WiFi password baked into netplan

All listed for cleanup in "Outstanding work" item 7.
