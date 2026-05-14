# POC Resume — start here next session

> Sister doc to `POC_RUNBOOK.md`. The runbook is the *what* (full state,
> compose layout, configs). This file is the *what's next* — what to do
> first when you (Claude or human) sit down to continue work on this POC.

## TL;DR — where things stand

14 commits on the `poc/single-box` branch of
[DropletByWarpLab/droplet-pi-platform](https://github.com/DropletByWarpLab/droplet-pi-platform/tree/poc/single-box):

```
<this>    Phase L   - routing service can finally drive OpenWrt: WG packages
                       installed, root password set from docker secret, wg-sync
                       poll loop pushes UCI peer changes to kernel. router:true
                       at last in /api/health.
55295c3  Phase K   - LAN bridge: DNAT 192.168.20.1:80/443 -> gateway + dnsmasq
                       points phones at openwrt for DNS, droplet.local maps locally
9d4909c  Phase J   - docs/POC_RESUME.md session handoff guide
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
- **Phase K**: AP clients can reach the dashboard at `https://droplet.local/`
  (dnsmasq maps the name to openwrt, openwrt DNATs :443 -> gateway). Needs
  one phone test from Stefan to confirm end-to-end; mechanism is verified
  (DNS resolves, nft DNAT rules in place, forward+postrouting clean).

**Doesn't work yet** (in priority for next session):
1. **Setup wizard (Phase M)** — Stefan asked for a customer-facing first-run
   experience that walks the photo-studio owner through: welcome / how-it-works
   → studio branding (SSID, PSK, hostname) → DuckDNS subdomain + token →
   create admin → add first WG device → done. Persists state so the customer
   can resume. Backend hooks: write to a config-store (sqlite?) and trigger
   re-run of `droplet-openwrt-attach` with the new DROPLET_AP_* env vars.
   POPULATE `WIREGUARD_ENDPOINT_HOST` from the DuckDNS step.
2. **Help/manual + walkthrough (Phase N)** — global "?" button in nav, static
   manual page (Files / Chat / Cameras / Remote Access / who to call),
   replayable "how it works" cards.
3. **Customer branding** — env knobs exist (`DROPLET_AP_*`); wizard from
   Phase M will populate them via `/etc/default/droplet-openwrt-attach`.
4. **Pre-ship hardening** — single checklist runthrough (NOPASSWD sudo, `Droplet123!`, host WiFi off, customer TLS, etc.).

**Phase L unblocked**:
- Router stats (orchestrator `/api/health` now returns `router:true`)
- VPN end-to-end (full peer lifecycle works: setup wg0, add peers via API,
  delete peers, kernel state matches UCI within ~2s via wg-sync poll loop)
- DuckDNS endpoint config exists but `WIREGUARD_ENDPOINT_HOST` is still
  unset — wizard (Phase M) populates it from the customer's DuckDNS entry.

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

## Top thing to do first (Phase M — setup wizard)

Stefan asked for a customer-facing first-run experience. The photo studio
owner sits down in front of the dashboard and the box walks him through:

1. **Welcome / how-it-works** — short cards: "Your files live on this device,
   not in the cloud", "AI runs locally on the dGPU", "Cameras record here,
   not streamed out", "Remote access goes through WireGuard, encrypted
   end-to-end". One sentence + an icon per card.
2. **Studio branding** — text inputs for studio name, WiFi SSID (default
   `Droplet-POC`), WiFi password (default `droplet-poc-password`),
   hostname customers type in their phone (default `droplet.local`).
   Writes to `/etc/default/droplet-openwrt-attach` and re-runs
   `droplet-openwrt-attach` so the AP changes immediately.
3. **Remote access setup** — DuckDNS subdomain + token (existing
   `/api/duckdns/config` endpoint). Save the subdomain into
   `WIREGUARD_ENDPOINT_HOST` so the WG conf served to peers includes the
   right endpoint. Show "Why DuckDNS?" inline help.
4. **Create admin** — username / password / email. Hooks into Nextcloud's
   existing admin setup (Nextcloud already prompts for this on first
   visit; the wizard either redirects there or wraps the same API).
5. **Add first WG device** — name the device (`Stefan's iPhone`), display
   QR code, "scan with the WireGuard app", "tap Connect", "done".
6. **You're set** — summary screen showing WiFi name + password,
   `droplet.local` URL for AP clients, DuckDNS URL for remote, "open Files
   to upload your first photo" CTA.

State persists in a `setup_progress` row in the orchestrator's DB so the
customer can navigate away and resume. Show a "Setup not complete" banner
on every other page until step 6 lands.

Frontend lives at `apps/web-dashboard/src/app/setup/page.tsx` (new). It
gates the rest of the dashboard via middleware that redirects to /setup
when `setup_progress.completed = false`. Each step is its own subroute so
back/forward in the browser works.

Backend additions:
- `apps/orchestrator/src/routes/setup.ts` — GET /api/setup/status,
  POST /api/setup/branding, POST /api/setup/complete
- a small `apps/orchestrator/src/db/setup.ts` Prisma model
- a host-side helper to write `/etc/default/droplet-openwrt-attach` and
  trigger `systemctl restart droplet-openwrt-attach`

### Phase N — help / manual

After Phase M lands. Adds a global "?" button (`apps/web-dashboard/src/components/HelpButton.tsx`),
a `/help` page rendering static markdown from `apps/web-dashboard/src/help/`,
sections per feature, and a "replay how-it-works" link that re-shows the
Phase M step-1 cards as a standalone modal.

### Custom `droplet-openwrt` Dockerfile

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
                   rpcd-mod-iwinfo rpcd-mod-file \
                   wireguard-tools kmod-wireguard luci-proto-wireguard && \
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
- **Web UI** (after Phase K): open browser → `https://droplet.local/` or
  `https://droplet/` → accept the self-signed cert → setup wizard → create
  admin. (Old fallback: `https://192.168.1.234/` from the host's WiFi IP
  on FifteenFiftyShadesOfGrey if DNS doesn't take — phone may need to
  forget+rejoin the AP once after Phase K landed, so it re-DHCPs and gets
  192.168.20.1 as DNS server.)
- **Upload photos**: drag-drop into `Files` → they land on 1.4 TB SATA
- **Chat**: open `Chat` → pick `llama3.1:8b-instruct-q8_0` → ask anything
  → tokens stream from the dGPU

What NOT to show yet:
- `/network` page (router stats incomplete)
- `/cameras` page (no cameras configured)
- `/remote-access` (VPN end-to-end not validated)

## Phase K verification checklist (run once with a real phone)

After Phase K, do this once to confirm AP-side dashboard reach works:

1. Forget the `Droplet-POC` network on the phone (so the next connect
   triggers a fresh DHCP lease — old leases still cache `8.8.8.8` as DNS).
2. Reconnect to `Droplet-POC` / password `droplet-poc-password`.
3. Confirm phone got `192.168.20.1` as DNS server (in iOS: Settings →
   Wi-Fi → ⓘ → DNS; in Android: same path under network details).
4. Open browser → `https://droplet.local/` → accept cert → dashboard.
5. If it fails: on the box, `sudo docker exec droplet-openwrt cat /tmp/dhcp.leases`
   should show the phone's MAC + IP; `nft list chain ip nat prerouting`
   should show non-zero counters (TODO: add `counter` to the rules); and
   `tcpdump -i wlp7s0 port 443` on the openwrt container should see SYN
   packets arriving from the phone.
