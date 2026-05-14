# Droplet POC — Single-box Runbook

> Captures the actual configuration of the photo-studio POC box
> (`droplet-sys`, Ryzen 7 7700X, 30 GiB RAM, AMD Navi 10 XL 16 GB dGPU).
> Targets the `poc/single-box` branch of
> `DropletByWarpLab/droplet-pi-platform`. **Do not merge to main** —
> production stays on dual-CPU dev hardware (Pi + Jetson) and
> ultimately ships on the v2.6 custom platform.

## Status snapshot (last updated 2026-05-14 after Phase C)

| Area | State |
|---|---|
| Box reachable on ethmgmt (192.168.10.1) + wlp14s0 (192.168.1.234) | ✅ |
| Docker stack (13 containers) | ✅ all running, orchestrator healthcheck "unhealthy" because routing service can't reach OpenWrt (cosmetic) |
| Dashboard at `https://192.168.10.1/` | ✅ first-run wizard armed |
| 2× 2 TB drives partitioned + mounted (`/mnt/nvr`, `/mnt/data`, `/mnt/data2`) with fstab UUIDs | ✅ |
| Frigate bound to `/mnt/nvr` via `NVR_MEDIA_SOURCE` in `.env` | ✅ |
| Kernel upgraded to **6.17.0-23-generic HWE** (from 6.8.0-100) | ✅ |
| **dGPU detected** by ROCm: `gfx1200`, 16 GB VRAM, PCI 0000:03:00.0 (Navi 48 / RDNA4 / R9070-class) | ✅ |
| ROCm runtime (rocm-hip-runtime, hsa-rocr, rocminfo, rocm-smi-lib) | ✅ |
| Ollama installed, pinned to dGPU only via systemd drop-in (`ROCR_VISIBLE_DEVICES=0`, `HSA_OVERRIDE_GFX_VERSION=11.0.0`) | ✅ |
| Models: `llama3.1:8b-instruct-q8_0` + `nomic-embed-text` | ✅ pulled |
| ai-gateway points at host Ollama via `JETSON_OLLAMA_URL=http://host.docker.internal:11434` | ✅ |
| ai-gateway image rebuilt CPU-only (no CUDA wheels) | ✅ |
| Frigate's `/dev/dri` remapped: host renderD129 (iGPU) → container renderD128. dGPU isolated. | ✅ |
| OpenWrt-in-container | ⛔ next major lift |
| Routing service repointed at OpenWrt container | ⛔ blocked on above |
| First admin account in dashboard wizard | ⛔ user action — visit `https://192.168.10.1/` and walk through |

## Hardware map

```
PCIe ::  03:00.0  AMD Navi 10 XL dGPU 16 GB     -> RESERVED for Ollama (LLM only)
        12:00.0  AMD Raphael iGPU              -> non-LLM video decode (Frigate if needed)
         X:00.0  Realtek RTL8125 quad NIC      -> 4× r8169
        14:00.0  Intel AX210 WiFi 6E (built-in)-> wlp14s0, host WiFi
         7:00.0  MediaTek MT7921 WiFi 6        -> wlp7s0, RESERVED for OpenWrt-container AP
       SATA:     2× WDC WD20EARZ 2 TB          -> sda, sdb
       NVMe:     Inland TN320 238 G            -> nvme0n1 root
       NIC:      motherboard ethernet          -> ethmgmt (MAC-pinned)
```

| Interface | MAC | Driver | Role | Persistence |
|---|---|---|---|---|
| `ethmgmt` | `10:ff:e0:c4:d4:df` | (kernel) | Management `192.168.10.1/24` | `/etc/netplan/70-eth.yaml` match-by-MAC + set-name |
| `enp10s0`–`enp13s0` | `98:b7:85:25:0b:43`–`:46` | r8169 | port 1 = WAN, 2–4 = LAN bridge | (no netplan; OpenWrt container will own these) |
| `wlp14s0` | `fc:b3:aa:cb:2f:a5` | iwlwifi | Host WiFi `192.168.1.234/24` to `FifteenFiftyShadesOfGrey` | `/etc/netplan/60-wifi.yaml` |
| `wlp7s0` | `28:2e:89:a1:cb:b0` | mt7921e | **Pass through to OpenWrt container as customer AP** | (leave DOWN on host) |

## Storage layout

```
/dev/sda  1.8 T
├── /dev/sda1  400 G ext4  label=nvr     UUID=4394f881-7b1e-4d3c-a21d-cb4df89cfdde  -> /mnt/nvr
└── /dev/sda2  1.4 T ext4  label=data    UUID=db4028c0-3282-4df8-8936-96cdf06a1b54  -> /mnt/data
/dev/sdb  1.8 T
└── /dev/sdb1  1.8 T ext4  label=data2   UUID=1380a14d-b6fc-47ba-9661-827e0e7ebe7d  -> /mnt/data2
```

`/etc/fstab` entries are UUID-based with `defaults,nofail 0 2` — a missing
drive won't break boot. Owned by `droplet:droplet`.

## Netplan files (under `/etc/netplan/`, mode 600)

**`70-eth.yaml`** — pin management NIC by MAC:
```yaml
network:
  version: 2
  ethernets:
    ethmgmt:
      match:
        macaddress: "10:ff:e0:c4:d4:df"
      set-name: ethmgmt
      dhcp4: true
      addresses:
        - 192.168.10.1/24
```

**`60-wifi.yaml`** — host WiFi via AX210 (no `match:` — networkd backend doesn't support it for WiFi):
```yaml
network:
  version: 2
  wifis:
    wlp14s0:
      dhcp4: true
      access-points:
        "FifteenFiftyShadesOfGrey":
          password: "girlsgonewireless"
```

> Trap encountered: SSID was case-mismatched in the original installer
> (`fifteenfiftyshadesofgrey` vs the broadcast `FifteenFiftyShadesOfGrey`).
> WPA scans silently miss the AP if the case is wrong.

## POC compose override (`docker/docker-compose.override.yml`)

```yaml
services:
  orchestrator:
    environment:
      OPENSSL_CONF: ""             # FIPS provider not layered; default cfg
      DROPLET_FIPS_REQUIRED: "false"
  mcp-server:
    environment:
      OPENSSL_CONF: ""
      DROPLET_FIPS_REQUIRED: "false"
  ai-gateway:
    environment:
      OPENSSL_CONF: ""
      DROPLET_FIPS_REQUIRED: "false"
      # After Ollama install: uncomment next line so ai-gateway talks to host Ollama
      # JETSON_OLLAMA_URL: "http://host.docker.internal:11434"
  device-identity-svc:
    environment:
      DROPLET_TPM_BACKEND: "mock"  # no /dev/tpm0 on this box
      DROPLET_FIPS_REQUIRED: "false"
```

Always invoke compose with both files:
```bash
sudo docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.override.yml \
  --env-file .env --profile full \
  up -d
```

## .env additions

```
NVR_MEDIA_SOURCE=/mnt/nvr
FRIGATE_CAMERA_FRONT_DOOR_PASSWORD=poc-placeholder
```

The `FRIGATE_CAMERA_*` is a placeholder for an example camera in
`docker/frigate/config.yml` that template-references the env var. Without
the placeholder Frigate's pydantic validation throws `KeyError` and
crash-loops. When real cameras are added, this can be removed.

## System bits set up on the host

| What | Why | Where |
|---|---|---|
| `/etc/sudoers.d/99-droplet-poc` | `droplet ALL=(ALL) NOPASSWD: ALL` so deploys don't hang on `sudo -v` | host file (DELETE before customer ship) |
| `/etc/tmpfiles.d/droplet.conf` | Creates `/run/droplet` at boot so device-identity-svc's gRPC socket dir survives reboots | host file |
| `/var/lib/droplet/tpm` (chmod 777) | Mock TPM artifact storage (bind-mounted into device-identity-svc) | host dir |
| `/etc/apt/preferences.d/rocm.pref` | Pin AMD repo at priority 600 so its `rocminfo` wins over Ubuntu noble's older one | host file |

## Source patches required (each is a real upstream bug; PR these to `main`)

1. **`scripts/lib/preflight.sh` lines 28+30** — `sudo -v` → `sudo -n true`.
   Ubuntu 24.04 with `Defaults use_pty` makes `sudo -v` request a TTY
   even with NOPASSWD, hanging non-interactive deploys.
2. **`services/device-identity-svc/backends/real.py`** (10 sites total) —
   em-dash (`—`) inside `b"..."` bytes literals is a hard `SyntaxError`.
   Replace all `—`/`–` with ASCII `-`. Verified via UTF-8 byte
   substitution: `data.replace(b'\xe2\x80\x94', b'-')`.
3. **`scripts/lib/local-dns.sh` line 300** — `resp_file: unbound
   variable` under `set -u`. Initialize or use `${resp_file:-}`.

## Container quirks worth fixing upstream

1. **`device-identity-svc` user UID mismatch**: Dockerfile creates `droplet`
   user with `useradd -r` (UID 997), but the bind-mounted host dirs
   `/var/lib/droplet` and `/run/droplet` need permissive ownership. POC
   uses chmod 777; production should either UID-align or use docker
   volumes instead of bind mounts.
2. **Frigate `config.yml` references undefined env**:
   `{FRIGATE_CAMERA_FRONT_DOOR_PASSWORD}` is in the default config
   template but never defined; Frigate refuses to start. Either remove
   the example camera from the default template, or set the var to a
   placeholder.
3. **Orchestrator healthcheck strict**: requires `router` and `switch` to be
   `true`, but those are external dependencies. POC marks orchestrator
   "unhealthy" cosmetically. Healthcheck should treat them as
   "degraded-but-functional" rather than "unhealthy."

## Recovery playbook

### Can't SSH to 192.168.10.1
PCI bus may have reshuffled. Use a monitor + USB keyboard at the box:
```bash
ip -br link
# Locate the motherboard NIC by its MAC 10:ff:e0:c4:d4:df. If the
# netplan match-by-MAC didn't bring up ethmgmt, edit /etc/netplan/70-eth.yaml.
sudo netplan apply
```

### WiFi not associating
Check `wpa_cli -i <iface> status`. If it stays `SCANNING`, verify SSID **case**
matches what's broadcast (`sudo wpa_cli -i <iface> scan_results | grep -i fifteen`).
Common pitfall.

### `device-identity-svc` crashlooping
Three likely causes (in order):
1. `/run/droplet` missing (tmpfs wipe on reboot). Run `sudo systemd-tmpfiles --create`.
2. `/var/lib/droplet/tpm` missing or root-only. Run `sudo mkdir -p /var/lib/droplet/tpm && sudo chmod -R 0777 /var/lib/droplet`.
3. compose was invoked without the `-f docker-compose.override.yml`, so `DROPLET_TPM_BACKEND` defaults to `real` and fails. Always include both compose files.

### Apt complains about held packages around ROCm
```bash
cat /etc/apt/preferences.d/rocm.pref   # should show pin priority 600
apt-cache policy rocminfo              # should show 1.0.0.60204 at priority 600
```
If it doesn't, the pin file is missing. See "System bits set up on the host" above.

### Apt hangs on needrestart prompt during install
Use:
```bash
sudo env NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive \
  apt-get install -y ...
```

### `sudo apt-get install` says "dpkg was interrupted"
```bash
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a dpkg --configure -a
sudo apt-get -f install -y
```

## Phase C done (2026-05-14)

Kernel upgrade unlocked the dGPU; Ollama runs as a compose service pinned to it.

**Kernel upgrade:**
- `apt install linux-image-generic-hwe-24.04 linux-headers-generic-hwe-24.04` → kernel 6.17.0-23. Grub auto-picked it as default; old 6.8.0-100 kept as fallback.
- After reboot, `rocminfo` (host) shows 3 agents: CPU, gfx1200 (dGPU), gfx1036 (iGPU).
- `dmesg` confirms `amdgpu 0000:03:00.0: VRAM: 16304M`, IP blocks `soc24_common, gmc_v12_0, gfx_v12_0, vcn_v5_0_0, mes_v12_0` — all v12 = RDNA4 / Navi 4x.

**Ollama runs as a compose service** (NOT a native systemd install). Mirrors the `droplet-jetson-ai` container pattern, but uses the official `ollama/ollama:rocm` image for AMD instead of NVIDIA:
```yaml
ollama:
  image: ollama/ollama:rocm
  container_name: droplet-ollama
  devices:
    - "/dev/kfd:/dev/kfd"
    - "/dev/dri/renderD128:/dev/dri/renderD128"   # dGPU ONLY (renderD129 = iGPU, not mapped)
  group_add: ["993", "44"]                         # NUMERIC GIDs (render, video) — names don't resolve from image's /etc/group
  environment:
    ROCR_VISIBLE_DEVICES: "0"
    OLLAMA_HOST: "0.0.0.0:11434"
    OLLAMA_KEEP_ALIVE: "24h"
  volumes:
    - ollama-data:/root/.ollama
```

**Lessons learned along the way (each a real trap):**
1. **Initial native install was wrong.** `curl install.sh | sh` worked but drifts from the repo's container-first design. Stopped + uninstalled + redid as a compose service. Both approaches detect the GPU, but the container path is the canonical one.
2. **`group_add` needs numeric GIDs**, not names. Docker resolves names against the *image's* `/etc/group`, where `render`/`video` don't exist. Host has `render:993, video:44` — pass those.
3. **`HSA_OVERRIDE_GFX_VERSION=11.0.0` is wrong for the container.** The container's bundled ROCm 7.x (`libhipblas.so.3.2.70201`) natively supports `gfx1200, gfx1201` (RDNA4) — verified by listing `/usr/lib/ollama/rocm/rocblas/library/`. The override was needed only briefly when we tested the host-installed ROCm 6.2.4 which didn't list gfx1200. **Native gfx1200 works fine in the container — leave HSA_OVERRIDE unset.**
4. **`ROCR_VISIBLE_DEVICES=0` is still needed** to hide the iGPU (gfx1036) from Ollama. The container's TensileLibrary doesn't include gfx1036 kernels (host's iGPU). Without this, Ollama tries both GPUs at boot and the iGPU init errors with "Illegal seek for GPU arch: gfx1036".
5. **ai-gateway reaches Ollama via compose service DNS** (`http://ollama:11434`), not `host.docker.internal`. Cleaner. Upstream compose's `extra_hosts: host.docker.internal:host-gateway` remains for orchestrator/routing — unrelated.

**ai-gateway requirements.txt rewrite** (before this fix it pulled 5+ GB of CUDA wheels even though `torch --index-url https://download.pytorch.org/whl/cpu` was specified per-line):
```
--extra-index-url https://download.pytorch.org/whl/cpu

torch>=2.3.0
sentence-transformers>=3.0.0
...
```
Top-level `--extra-index-url` directive + `torch` listed BEFORE `sentence-transformers` is the only combo that works reliably with modern pip. Verified after rebuild:
- `pip list` shows `torch 2.12.0+cpu` (no `+cu`)
- Image size dropped from ~7 GB to **2.23 GB** (saved ~4.5 GB)

**End-to-end wiring verified:**
- `docker exec ai-gateway python -c "import httpx; print(httpx.get('http://ollama:11434/api/version').text)"` → `{"version":"0.23.4"}`
- `curl -k https://192.168.10.1/api/health` → `aiGateway:true`
- Frigate's `/dev/dri` device mapped to host's `renderD129` (iGPU), leaving the dGPU truly LLM-only.

## Phase D — OpenWrt container with WiFi AP (2026-05-14)

Real `openwrt/rootfs:x86_64-24.10.2` running as a compose service. MT7921 WiFi card passed into the container's network namespace. hostapd broadcasting `Droplet-POC` SSID on 2.4 GHz channel 6.

**Compose service** (`openwrt` in `docker-compose.override.yml`):
- Image: `openwrt/rootfs:x86_64-24.10.2` (4.5 MB rootfs, official OpenWrt org)
- `command: /sbin/init` (procd)
- `privileged: true`, plus `NET_ADMIN`+`SYS_ADMIN` caps
- `tmpfs: /tmp, /run`, `volumes: openwrt-config /etc/config, openwrt-overlay /overlay` (uci configs + opkg state survive restart)

**MT7921 PHY passthrough** (manual for now, needs scripting):
```bash
OWRT_PID=$(sudo docker inspect droplet-openwrt --format '{{.State.Pid}}')
sudo iw phy phy1 set netns $OWRT_PID    # phy1 is the MT7921 (host's iwlwifi phy0 stays put)
```

**Inside-container bootstrap** (also ad-hoc; persist via uci next iteration):
```bash
# Network bootstrap (Docker's IP was wiped by procd's netifd):
ip addr add 172.18.0.15/16 dev eth0      # whatever Docker had assigned; check `docker inspect`
ip route add default via 172.18.0.1
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 1.1.1.1" >> /etc/resolv.conf
/etc/init.d/firewall stop && /etc/init.d/firewall disable   # POC: open. Configure zones properly later.

# Install hostapd
opkg update
opkg install hostapd-mbedtls hostapd-utils wireless-regdb iw-full

# Hostapd config (POC; rotate the password before customer ship)
cat > /etc/hostapd.conf <<EOF
interface=wlp7s0
driver=nl80211
ssid=Droplet-POC
hw_mode=g
channel=6
country_code=US
ieee80211d=1
auth_algs=1
wpa=2
wpa_passphrase=droplet-poc-password
wpa_key_mgmt=WPA-PSK
wpa_pairwise=CCMP
rsn_pairwise=CCMP
ieee80211w=1
EOF

ip link set wlp7s0 up
ip addr add 192.168.20.1/24 dev wlp7s0
hostapd -B -P /run/hostapd.pid /etc/hostapd.conf
```

**Verified end-to-end** (2026-05-14 03:55 UTC):
- `iw dev wlp7s0 info`: `ssid Droplet-POC, type AP, channel 6`
- Stefan's Galaxy S25 Ultra connected, DHCP lease `192.168.20.59`, RSSI `-49 dBm`, MFP/PMF active
- `ubus call iwinfo assoclist {"device":"wlp7s0"}` returned the client correctly
- ubus over HTTP authenticated from host (172.18.0.1) using root + `droplet-poc-router` — `system.board` returns OpenWrt 24.10.2 on `Gigabyte B650 GAMING X AX V2`

### uci configs (persisted in `/etc/config/` inside the container — `openwrt-config` named volume)

These are what survives a `docker restart droplet-openwrt`. The container's procd reads them at boot. Note: bring-up still depends on the host script moving phy1 into the container's netns first (see "host-side automation" below).

```
# /etc/config/network
config interface "loopback"
	option device "lo"
	option proto "static"
	option ipaddr "127.0.0.1"
	option netmask "255.0.0.0"

config globals "globals"
	option ula_prefix "fd4a:4a28:f13a::/48"

# Docker-managed eth0 — proto 'none' tells netifd not to touch it.
# Docker has already assigned the IP via netlink before procd ran.
config interface "docker"
	option device "eth0"
	option proto "none"

config device "br_lan_dev"
	option type "bridge"
	option name "br-lan"

config interface "lan"
	option device "br-lan"
	option proto "static"
	option ipaddr "192.168.20.1"
	option netmask "255.255.255.0"
```

```
# /etc/config/wireless
config wifi-device "radio0"
	option type "mac80211"
	option path "platform/?wlp7s0"
	option channel "6"
	option band "2g"
	option htmode "HT20"
	option country "US"
	option disabled "0"

config wifi-iface "default_radio0"
	option device "radio0"
	option network "lan"
	option mode "ap"
	option ssid "Droplet-POC"
	option encryption "psk2"
	option key "droplet-poc-password"
	option ieee80211w "1"
```

```
# /etc/config/dhcp (DHCP+DNS server on lan interface; ignore on docker side)
config dnsmasq
	option domainneeded "1"
	option authoritative "1"
	option localise_queries "1"
	option local "/lan/"
	option domain "lan"
	option leasefile "/tmp/dhcp.leases"

config dhcp "lan"
	option interface "lan"
	option start "10"
	option limit "150"
	option leasetime "12h"
	option dhcpv4 "server"

config dhcp "docker"
	option interface "docker"
	option ignore "1"
```

```
# /etc/config/firewall (POC: permissive between lan and docker; tighten for customer)
config defaults
	option syn_flood "1"
	option input "ACCEPT"
	option output "ACCEPT"
	option forward "ACCEPT"

config zone
	option name "lan"
	list network "lan"
	option input "ACCEPT"
	option output "ACCEPT"
	option forward "ACCEPT"

config zone
	option name "wan"
	list network "docker"
	option input "ACCEPT"
	option output "ACCEPT"
	option forward "ACCEPT"
	option masq "1"
	option mtu_fix "1"

config forwarding
	option src "lan"
	option dest "wan"
```

```
# /etc/config/uhttpd (HTTP only on :80, /ubus exposed for ubus-over-HTTP)
config uhttpd "main"
	list listen_http "0.0.0.0:80"
	option home "/www"
	option rfc1918_filter "0"
	option script_timeout "60"
	option network_timeout "30"
	option ubus_prefix "/ubus"
```

### Root password (for ubus-over-HTTP auth)

OpenWrt's default root has no password — uhttpd-mod-ubus's `session.login` rejects empty-password logins. POC password set inside the container:
```
echo -e "droplet-poc-router\ndroplet-poc-router" | passwd root
```
This needs to be rotated before customer ship + the password committed into the secrets pipeline (DROPLET_ENV `OPENWRT_PASSWORD` already exists in setup.sh's secrets — wire to a uci script).

### Host-side automation — STILL NEEDED

The PHY netns move and the inside-container default-route fix are currently manual. A systemd unit on the host should run them automatically:

```
# /etc/systemd/system/droplet-openwrt-attach.service
[Unit]
Description=Attach MT7921 PHY + restore route in droplet-openwrt
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/bash -c 'until docker inspect -f "{{.State.Running}}" droplet-openwrt 2>/dev/null | grep -q true; do sleep 1; done'
ExecStart=/bin/bash -c '\
  PID=$(docker inspect -f "{{.State.Pid}}" droplet-openwrt); \
  iw phy phy1 set netns $PID; \
  IP=$(docker inspect -f "{{(index (index .NetworkSettings.Networks).IPAMConfig).IPv4Address}}{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" droplet-openwrt); \
  GW=$(docker inspect -f "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}" droplet-openwrt); \
  docker exec droplet-openwrt sh -c "ip addr add ${IP}/16 dev eth0 2>/dev/null; ip route add default via ${GW} 2>/dev/null; echo nameserver 8.8.8.8 > /etc/resolv.conf; echo nameserver 1.1.1.1 >> /etc/resolv.conf"; \
  docker exec droplet-openwrt /etc/init.d/network restart; \
  docker exec droplet-openwrt /etc/init.d/dnsmasq restart; \
  docker exec droplet-openwrt /etc/init.d/firewall restart \
'
[Install]
WantedBy=multi-user.target
```

This stays a TODO — write the file, `systemctl enable droplet-openwrt-attach.service`, validate via a container restart.

## Outstanding for OpenWrt-container (in priority order)

These are required before customer-shippable. Each is a separate small task:

1. **uci-persist the network/firewall/hostapd config.** Replace the ad-hoc `ip addr` and `/etc/hostapd.conf` commands above with `/etc/config/network`, `/etc/config/wireless`, `/etc/config/firewall` entries. Then OpenWrt's procd brings everything up automatically on container restart. Specifics:
   - `/etc/config/network`: add `lan` interface on `wlp7s0` (192.168.20.1/24), `wan` interface on a Realtek port (enp10s0 when added later via passthrough), keep eth0 = docker DHCP
   - `/etc/config/wireless`: define `radio0` for phy1 with the SSID/password/encryption
   - `/etc/config/firewall`: zones `lan` (accept), `wan` (drop), with masquerade
2. **Auto-attach the MT7921 PHY on container start.** Currently manual. Need a systemd unit on the host that runs on every `docker start droplet-openwrt`:
   ```
   [Unit]
   Description=Attach MT7921 PHY to droplet-openwrt container
   After=docker.service
   [Service]
   ExecStartPre=/bin/bash -c 'while ! docker inspect -f "{{.State.Running}}" droplet-openwrt 2>/dev/null | grep -q true; do sleep 1; done'
   ExecStart=/bin/bash -c 'iw phy phy1 set netns $(docker inspect -f "{{.State.Pid}}" droplet-openwrt)'
   [Install]
   WantedBy=multi-user.target
   ```
3. **Add dnsmasq for DHCP + DNS to clients on 192.168.20.0/24.** Already installed in OpenWrt; just needs `/etc/config/dhcp` entry pointing at `lan` interface.
4. **Move the 4 Realtek ports into the container's netns too** (or use macvlan), so the OpenWrt container owns the WAN port + LAN bridge ports. Plan:
   - enp10s0 → WAN (DHCP from upstream)
   - enp11s0–enp13s0 → bridged into `br-lan` alongside `wlp7s0`
5. **Bridge OpenWrt's customer LAN (192.168.20.0/24) to the Pi-platform docker network** so customer clients reach the Droplet's dashboard at https://192.168.20.1/ (port-forwarded by OpenWrt to host's Nginx).
6. **Expose ubus over HTTP** so `services/routing/` can call it. Install `rpcd`, `rpcd-mod-rpcsys`, `uhttpd`, `uhttpd-mod-ubus`. Configure orchestrator's `OPENWRT_HOST` env to point at the openwrt container. Verify `/api/health` flips `router:false → true`.
7. **Rotate the placeholder WiFi password** `droplet-poc-password` to something customer-specific. Bring secret into `.env` and reference from uci.

## Outstanding work (in priority order — non-OpenWrt)

1. **OpenWrt-in-container** — the heaviest remaining lift. Plan:
   - Pull `openwrtorg/rootfs:24.10.0-x86-64` (or build via repo's
     `openwrt/build.sh`). The image needs `--privileged` and macvlan
     network access; running with `NET_ADMIN`+`SYS_ADMIN` caps + a
     dedicated network namespace is the safer path.
   - WAN: macvlan slave of `enp10s0` (Realtek card port 1).
   - LAN bridge: macvlan slaves of `enp11s0–enp13s0` + the MT7921 WiFi.
   - WiFi passthrough: `iw phy phy0 set netns $(docker inspect -f '{{.State.Pid}}' openwrt)`
     to move the radio into the container's netns. Container runs
     `hostapd` on it.
   - Inside container: `dnsmasq`, `nftables` rules, and a small JSON-RPC
     shim or actual `ubus` daemon so `services/routing/` can talk to it.
7. **Repoint services/routing/** — set `OPENWRT_HOST` in `.env` to the
   container's IP. Verify orchestrator's router-aware healthcheck
   transitions from false → true.
8. **Fix mDNS hostname collision** — every Droplet currently advertises
   `droplet-ai.local`; this caused me to SSH into a different Jetson
   device on the same LAN by accident. Configure setup.sh's avahi
   stanza to use a per-device hostname (e.g. `droplet-<short-uuid>`).
9. **Pre-ship hardening**:
   - Remove `/etc/sudoers.d/99-droplet-poc`
   - Rotate `droplet` password (still `Droplet123!`)
   - Disable `wlp14s0` host WiFi
   - Strip POC compose override before customer ship (replace with
     production values when v2.6 hardware is ready)
   - Generate customer-specific TLS cert
   - Switch device-identity backend from `mock` to `real` once TPM is
     available on production silicon

## Sensitive items (POC only — DO NOT replicate on customer ship)

- `droplet` user has `NOPASSWD: ALL` sudo
- `droplet` password is the original `Droplet123!`
- All TLS uses self-signed cert (10-year validity, multiple SANs)
- FIPS provider not layered (OpenSSL stock config; mock crypto only)
- Device-identity backend = `mock` (no real attestation)
- WiFi WPA password baked into netplan file (rotate before ship)

## Quick reference: bring up the stack from scratch on this box

```bash
cd ~/edge-platform
sudo docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.override.yml \
  --env-file .env --profile full \
  up -d

# Verify
curl -sk https://localhost/api/health | jq .
sudo docker ps --format 'table {{.Names}}\t{{.Status}}'
```
