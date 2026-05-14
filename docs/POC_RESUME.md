# POC Resume — start here next session

> Sister doc to `POC_RUNBOOK.md`. The runbook is the *what* (full state,
> compose layout, configs). This file is the *what's next* — what to do
> first when you (Claude or human) sit down to continue work on this POC.

## TL;DR — where things stand

11 commits on the `poc/single-box` branch of
[DropletByWarpLab/droplet-pi-platform](https://github.com/DropletByWarpLab/droplet-pi-platform/tree/poc/single-box):

```
995bc53  Phase I   - move Nextcloud user uploads to big SATA drive
1a6c2a4  Phase H   - comprehensive POC_RUNBOOK rewrite
fdb4cf2  Phase G   - mobile-responsive grid fixes
7c43ba6  fix       - phase-7 if-condition
8c2b97e  fix       - verify.sh test
490fe92  Phase F   - /mnt/droplet/ canonical + Nextcloud externals auto-register + systemd unit auto-install
c381611  Phase E   - storage auto-detect lib + VPN .env + host AP bring-up artifacts
84f997b  Phase D+  - DHCP + NAT + uci-persist + ubus-over-HTTP
6ecb0c5  Phase D   - OpenWrt 24.10.2 container + MT7921 AP
2ff7646  Phase C   - kernel 6.17 + Ollama-on-dGPU + ai-gateway CPU torch
a7b08bb  Phase A+B - baseline + preflight/em-dash fixes
```

**Works today** (verified, customer can use):
- File browser at `https://192.168.10.1/` — uploads land on 1.4 TB SATA
- Local AI chat — `llama3.1:8b-instruct-q8_0` on the RDNA4 dGPU
- WiFi AP `Droplet-POC` — phone connects, DHCP, NAT'd internet
- Mobile-responsive dashboard
- Frigate ready (no cameras connected yet, but recording path is `/mnt/droplet/nvr`)
- Drives auto-detect on first boot (fresh `setup.sh` produces all of this)

**Doesn't work yet** (in priority for next session):
1. **LAN bridge** — clients on the AP (192.168.20.x) can reach the internet but can't reach the dashboard. They have to plug into the management ethernet to admin the box. This is the customer-experience blocker.
2. **Router stats** — orchestrator's `/api/health` reports `router:false`. The dashboard's `/network` page partially works but device list / firewall rules / wireless clients return errors. Need to wire `services/routing/` to OpenWrt's `/ubus` (config is in `.env` from Phase E, but path not exercised).
3. **Customer branding** — `Droplet-POC` SSID, `droplet-poc-password` PSK, no photo-studio name anywhere. 1-line `.env` change + uci re-apply.
4. **VPN end-to-end** — `POST /api/vpn/setup` against the containerized OpenWrt. Audit says 6 of 12 gaps still open (see Phase E commit body).
5. **Pre-ship hardening** — single checklist runthrough (NOPASSWD sudo, `Droplet123!`, host WiFi off, customer TLS, etc.).

## Where I/you are working from

```
This Windows machine (Stefan's dev box):
  C:\Users\Stefan\Documents\GitHub\droplet-pi-platform   ← local repo, can push to GitHub
  C:\Users\Stefan\Documents\3D print code for images\    ← scratch + paramiko SSH helpers
  Wi-Fi: 192.168.1.112  +  Ethernet 2: 192.168.10.2 (crossover)

POC box (sitting next to Stefan):
  hostname: droplet-sys
  mDNS:     droplet-c4d4df.local
  IPs:      192.168.10.1  (crossover via "ethmgmt" — MAC-pinned)
            192.168.1.234 (WiFi via wlp14s0 = host's internet uplink)
  SSH:      droplet / Droplet123!  (passwordless sudo via /etc/sudoers.d/99-droplet-poc)
  Repo:     /home/droplet/edge-platform  (currently on poc/single-box; can't push to origin from here — auth lives on Stefan's other GH account)
```

## How to reach the box quickly

Two helpers exist in the scratch dir:

```powershell
$py  = 'C:\Users\Stefan\AppData\Local\Microsoft\WindowsApps\python.exe'
$ssh = 'C:\Users\Stefan\Documents\3D print code for images\_droplet_ssh.py'
$put = 'C:\Users\Stefan\Documents\3D print code for images\_droplet_put.py'    # SFTP up
$get = 'C:\Users\Stefan\Documents\3D print code for images\_droplet_get.py'    # SFTP down
```

`_droplet_ssh.py` accepts a command via argv OR stdin and runs it via paramiko
on `droplet@192.168.10.1`. UTF-8 stdout, line-buffered, prints `=== EXIT N ===`
at the end. Reads `DROPLET_HOST` env var if you need to target a different IP.

PowerShell pattern:
```powershell
$cmd = @'
echo "=== state ==="
sudo docker ps --format 'table {{.Names}}\t{{.Status}}'
'@
$cmd | & $py $ssh
```

## Git workflow (important — the box can't push)

The box's `gh` is logged in as `stefan17x-eng`, which can't see
`DropletByWarpLab` org repos. The Windows machine's `git` uses GitHub
Credential Manager pointing at Stefan's *other* account (the one with org
access). So:

```
Box:                                     Windows:
  Edit files on /home/droplet/...          
  git add + git commit                  
  git bundle create /tmp/X.bundle  ──→   _droplet_get.py X.bundle
                                          git fetch X.bundle poc/single-box:poc/single-box -f
                                          git push origin poc/single-box
```

Or do edits on Windows, commit there, push, then SFTP the changed files
to the box (`_droplet_put.py`). Both patterns are used in past commits.

**Don't try `git pull` on the box** — it'll fail with a permission error
on origin. Either bundle ← Windows, or just SFTP individual files and `git
checkout -- <file>` to clean up the box's working tree.

## Top 3 things to do first

### 1. LAN bridge (biggest customer-experience win)

Goal: clients on the `192.168.20.x` AP can reach the dashboard at
`https://droplet-c4d4df.local/` without needing to plug into the
management ethernet.

The shape: a veth pair (or macvlan) between OpenWrt's `br-lan` (inside the
container) and the pi-platform docker network (`droplet-pi-platform_default`
at `172.18.0.0/16`). OpenWrt port-forwards `:80` and `:443` from its WAN
side (or directly via a route) to the nginx gateway container.

Simplest path to verify quickly: add a route inside OpenWrt:
```
ip route add 172.18.0.0/16 via 172.18.0.1 dev eth0
```
…then test from a phone on the AP: `curl -k https://172.18.0.<nginx-ip>/`.
If that works, the customer-facing version is OpenWrt forwarding 80/443
from a customer-facing hostname (likely `droplet-c4d4df.local` resolved
via OpenWrt's dnsmasq).

### 2. Router stats wire-up

Right now `services/routing/` is up but the orchestrator's
`device-reconcile-poller` returns 503s for DHCP / firewall / wireless
endpoints. Means: env vars are set (Phase E), but services/routing/ isn't
actually authing to the openwrt container's ubus correctly, OR the
OpenWrt-side `droplet-ai` user doesn't exist.

Start here:
```bash
sudo docker exec droplet-pi-platform-routing-1 sh -c '
  curl -s http://openwrt:80/ubus -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\",\"params\":[\"00000000000000000000000000000000\",\"session\",\"login\",{\"username\":\"root\",\"password\":\"droplet-poc-router\"}]}"'
```
Compare against the working hostpath that I documented in Phase E (which
used `OPENWRT_USERNAME=root`). Likely the routing service is configured
for `OPENWRT_USERNAME=droplet-ai` which doesn't exist yet inside the
container.

Fix: either provision a `droplet-ai` user inside OpenWrt (uci-defaults
script + rpcd ACL — there's a template at `openwrt/files/usr/share/rpcd/acl.d/droplet-ai.json`
upstream that needs to be installed inside the container), or override
the orchestrator's env to use `root` everywhere.

### 3. Custom `droplet-openwrt` Dockerfile

Right now every `docker compose up --force-recreate openwrt` wipes the
container's writable layer, and the host-side `droplet-openwrt-attach`
systemd unit has to `opkg install hostapd-mbedtls hostapd-utils
wireless-regdb iw-full uhttpd uhttpd-mod-ubus rpcd rpcd-mod-rpcsys
rpcd-mod-iwinfo rpcd-mod-file` every time. ~30s of opkg work + needs
internet from inside the container.

Right shape:
```
docker/openwrt/Dockerfile:
  FROM openwrt/rootfs:x86_64-24.10.2
  RUN echo "nameserver 8.8.8.8" > /etc/resolv.conf && \
      opkg update && \
      opkg install hostapd-mbedtls hostapd-utils wireless-regdb iw-full \
                   uhttpd uhttpd-mod-ubus rpcd rpcd-mod-rpcsys \
                   rpcd-mod-iwinfo rpcd-mod-file && \
      rm /etc/resolv.conf
  CMD ["/sbin/init"]
```

Update compose override:
```
openwrt:
  build:
    context: ./docker/openwrt
    dockerfile: Dockerfile
  image: droplet-openwrt:latest
  # ... rest unchanged
```

Then `droplet-openwrt-attach` script can drop the `if ! command -v hostapd`
opkg-install block.

## Time-wasters that already cost real session time — don't repeat

- **`sudo -v` on Ubuntu 24.04 with NOPASSWD** still wants a TTY because
  `Defaults use_pty`. Use `sudo -n true` for the "can I sudo without
  prompting?" check. preflight.sh is fixed; this is just a "if you write
  any other deploy code" warning.
- **needrestart's dpkg hook hangs apt-get even with NEEDRESTART_MODE=a.**
  Disable it: `mv /etc/apt/apt.conf.d/99needrestart{,.disabled}` +
  `mv /etc/dpkg/dpkg.cfg.d/needrestart{,.disabled}`.
- **`amdgpu-install` package's post-install hook hangs** in non-interactive
  mode. Don't install it; install `rocm-hip-runtime rocminfo rocm-smi-lib`
  directly after pinning the AMD repo at priority 600.
- **PowerShell here-strings → paramiko → bash mangles em-dashes** (`—`
  becomes `?` in transit) and **DROPS the `--brief` flag on `ip -br` calls
  inside busybox**. Use ASCII dashes in scripts; use plain `ip link` not
  `ip -br link` when invoking via docker exec into a busybox container.
- **`lsblk -pno NAME` includes `├─`/`└─` tree-drawing chars.** Use
  `lsblk -lpno NAME` (LIST mode) for grep-friendly output.
- **`pkill -f 'something docker'` kills the SSH shell** if the shell's
  command line contains the pattern. Use `pgrep -x` or specific PIDs.
- **Docker's network init doesn't run DHCP** — it assigns IPs via netlink
  at container creation. OpenWrt's netifd will TEAR DOWN the pre-assigned
  IP on its eth0 if `proto: dhcp` is set. Use `proto: none` for the docker
  interface in OpenWrt's `/etc/config/network`.
- **`group_add` in docker-compose needs numeric GIDs** if the image doesn't
  have those group names in its `/etc/group`. The host's `render`=993 and
  `video`=44.
- **`HSA_OVERRIDE_GFX_VERSION=11.0.0` IS WRONG** for the ollama/ollama:rocm
  image — its bundled ROCm 7.x natively supports gfx1200. The override
  was needed for the host's older ROCm 6.2.4 only. Don't carry it over.

## Files that matter most

```
docs/POC_RUNBOOK.md                                   ← read this first; full state
docs/POC_RESUME.md                                    ← this file
scripts/lib/storage.sh                                ← drive auto-detect (Phase E/F)
scripts/setup.sh                                      ← entry point; integrates storage.sh + nextcloud-externals
docker/docker-compose.override.yml                    ← all POC delta (FIPS off, mock TPM, ollama+openwrt services, nextcloud bind to big drive)
openwrt/poc-single-box/droplet-openwrt-attach         ← host-side AP bring-up script
openwrt/poc-single-box/droplet-openwrt-attach.service ← systemd unit (auto-installed by setup.sh)
openwrt/poc-single-box/README.md                      ← theory of the host-side automation
```

## Customer demo right now

Tell the customer:
- **WiFi**: scan for `Droplet-POC`, password is `droplet-poc-password`
- **Web UI**: open browser → `https://192.168.1.234/` (the host's WiFi IP
  on FifteenFiftyShadesOfGrey, until the LAN bridge is up) → accept the
  self-signed cert → setup wizard → create admin
- **Upload photos**: drag-drop into `Files` → they land on 1.4 TB SATA
- **Chat**: open `Chat` → pick `llama3.1:8b-instruct-q8_0` → ask anything
  → tokens stream from the dGPU

What NOT to show yet:
- `/network` page (router stats incomplete)
- `/cameras` page (no cameras configured)
- `/remote-access` (VPN end-to-end not validated)
