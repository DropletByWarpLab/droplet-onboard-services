# Droplet Appliance OS Image (app box)

Flashable **Pi OS (arm64) Lite + Docker + the full Droplet stack** SD-card
image. Built by [`scripts/build-image.sh`](../scripts/build-image.sh) with
[pi-gen](https://github.com/RPi-Distro/pi-gen). This is the **application /
orchestration appliance** — the AI + dashboard + services host.

> **Router firmware is a separate image.** The OpenWrt router firmware is built
> by [`openwrt/build.sh`](../openwrt/build.sh) and lives under `openwrt/`. This
> directory builds the *app* half of a **dual-image** topology — see below.

## Topology — DUAL-IMAGE

The production product is **multi-box / dual-CPU**: a dedicated compute/AI host
and a separate Pi 5 OpenWrt router. Two images, one per box:

| Image | Built by | Box | Role |
|---|---|---|---|
| **App appliance** (this dir) | `scripts/build-image.sh` (pi-gen) | Compute / AI host | Ubuntu/Pi-OS + Docker + orchestrator, dashboard, ai-gateway, MCP, routing, file-indexer, etc. |
| **Router firmware** | `openwrt/build.sh` (OpenWrt ImageBuilder) | Pi 5 router | WAN/LAN, Wi-Fi AP, ubus JSON-RPC control plane, WireGuard |

This dual-image split is the canonical production shape:

- **ADR-005 canonical-system-architecture** (shared_brain /
  `droplet-pi-platform/docs/ADR-005-canonical-system-architecture.md`) pins the
  multi-box diagram as the architectural source of truth — any change touching
  more than one box on the diagram must cite it. Two boxes ⇒ two images.
- **[`docs/SINGLE_BOX.md`](../docs/SINGLE_BOX.md)** documents the deployment-shape
  matrix. This image targets the **`multi-box`** shape (separate compute host +
  Pi 5 OpenWrt router). The `single-box` shape keeps its own
  `setup.sh`-on-bare-Ubuntu path (everything, including OpenWrt-in-container, on
  one x86 box) and does **not** use this Pi image.
- The repo-local **ADR-005-ap** (`docs/ADR-005-ap-auto-onboarding.md`) supplies
  the *explicit-state* convention this image's first-boot guard follows ("why an
  enum, not a derived flag").

Why not one combined image? OpenWrt (router) and Pi OS (app) are different
operating systems with different kernels, package managers, and update
cadences. Baking both into one SD card would couple two independent release
streams and break the OpenWrt sysupgrade path. The two builders cross-reference
each other so they stay discoverable.

## Host requirements

`build-image.sh` must run on a **Linux host (x86_64 or arm64)**. It **cannot run
on Windows or macOS** — pi-gen needs Linux-only `binfmt_misc` + `debootstrap` +
`qemu-user-static`, and the build emits a Raspberry Pi `.img`. The script fails
fast on a non-Linux host (same host requirement as `openwrt/build.sh`).

- Linux (Ubuntu 22.04+ recommended)
- Docker (the build uses pi-gen's containerized `build-docker.sh`)
- `qemu-user-static` + `binfmt_misc` registered for arm64 (when building on x86_64):
  ```bash
  sudo apt-get install -y qemu-user-static binfmt-support
  docker run --privileged --rm tonistiigi/binfmt --install arm64
  ```
- `git` on the host; ~12 GB free disk; internet

On Windows, run the build inside **WSL2 (Ubuntu)** or a Linux CI runner.

## Quick start

```bash
# From the repo root, on a Linux build host:
./scripts/build-image.sh            # build the app appliance image (default)
./scripts/build-image.sh --help     # options + env knobs
```

Env knobs:

| Var | Default | Meaning |
|---|---|---|
| `DROPLET_IMAGE_RELEASE_REF` | current branch HEAD, else `main` | git ref the image clones the repo at |
| `PIGEN_TAG` | pinned bookworm tag | pi-gen toolchain tag |

Output lands in [`image/output/`](./output) as `*.img.gz` (+ `*.img.gz.sha256`).

## What gets baked vs generated on first boot

**Baked at build time** (offline-capable first boot):

- Pi OS Bookworm Lite (arm64), hostname `droplet`, SSH **key-only** (no baked password)
- Docker Engine 25+ + Compose v2 (from Docker's apt repo, for `docker compose`)
- The repo cloned to `/opt/droplet/edge-platform` at `DROPLET_IMAGE_RELEASE_REF`
- The docker-compose stack's container images pre-pulled / pre-built
- `droplet-firstboot.service` (oneshot) enabled

**Generated on FIRST BOOT — never baked:**

- All device-unique secrets (`.env`, `audit.key`, TLS cert, MQTT password) via
  `scripts/setup.sh` → `scripts/lib/secrets.sh` (`openssl rand`). This mirrors
  the OpenWrt `openwrt/files/etc/uci-defaults/99-droplet-setup` precedent
  (per-device root + `droplet-ai` passwords from `/dev/urandom` on first boot).
- The steady-state `droplet.service` (installed by `setup.sh --systemd`).

No two devices share credentials, and no secret is ever in a tracked file or in
the image.

## First-boot sequence

```
power on
  │
  ├─ kernel + systemd
  ├─ rootfs auto-expand (raspi-config do_expand_rootfs / pi-gen default)
  │     └─ MUST run before setup.sh so its ">= 8 GB free" preflight passes
  ├─ docker.service                          (enabled at build time)
  │
  └─ droplet-firstboot.service  (oneshot, RemainAfterExit)
        ConditionPathExists=!/var/lib/droplet/.firstboot-done   ← explicit guard
        After=network-online.target docker.service
        │
        └─ ExecStart=/opt/droplet/edge-platform/scripts/setup.sh --systemd
              ├─ generate device-unique secrets (.env, audit.key, TLS, MQTT)
              ├─ build/start the docker-compose stack
              └─ install + enable droplet.service
        └─ ExecStartPost: touch /var/lib/droplet/.firstboot-done  (success-only)
              (a failed first boot leaves the sentinel absent → next boot retries)
  │
  └─ droplet.service                          (Before=droplet.service ordering)
        docker compose up -d   ← steady-state stack on every subsequent boot
```

The first-boot unit is baked statically at
[`stage-droplet/files/droplet-firstboot.service`](./stage-droplet/files/droplet-firstboot.service)
and has a runtime/self-heal twin in
`scripts/lib/systemd.sh::install_firstboot_service` (kept in lockstep so a
manually-provisioned host and a flashed image install the same unit).

## Flash the image

Any one of:

1. **Raspberry Pi Imager** — "Use custom" → pick `image/output/*.img.gz`.
2. **balenaEtcher** — open the `.img.gz` directly.
3. **dd** (Linux/macOS):
   ```bash
   gunzip -k image/output/*.img.gz
   sudo dd if=image/output/*.img of=/dev/sdX bs=4M status=progress conv=fsync
   ```

Insert into the Pi, connect Ethernet, power on. After first boot (rootfs expand
+ provisioning) the dashboard is reachable at `https://droplet-ai.local`.

## File layout

```
image/
├── README.md                               # This file
├── config                                  # pi-gen config (arm64 Lite, gz, no baked pw)
├── .gitignore                              # ignores .pi-gen/, output/, *.img.gz, ...
├── stage-droplet/                          # custom pi-gen stage
│   ├── 00-packages                         # apt packages installed in the stage
│   ├── 01-run.sh                           # chroot build-time: Docker, clone, warm images
│   ├── EXPORT_IMAGE                        # pi-gen export marker (produces the artifact)
│   └── files/
│       └── droplet-firstboot.service       # baked oneshot unit (runs setup.sh once)
├── .pi-gen/                                # cloned pi-gen toolchain (gitignored)
└── output/                                 # built *.img.gz + *.sha256 (gitignored)
```

## Verification limits

The **actual arm64 image build CANNOT be verified on a non-Linux box.** pi-gen
needs Linux + `qemu-user-static` + `binfmt_misc` + `debootstrap` + Docker. On
Windows/macOS only the **static contract checks** in
[`tests/build-image.test.sh`](../tests/build-image.test.sh) run (set -euo
pipefail, non-Linux fast-fail, no baked password, no baked `.env`, first-boot
unit guards). The full build, SD flash, boot-on-Pi, first-boot `setup.sh`,
model pull, and in-container FIPS self-test must be validated on a Linux
build host + a Raspberry Pi.
