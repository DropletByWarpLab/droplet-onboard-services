<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../.github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../.github/logo.svg">
  <img alt="Droplet" src="../.github/logo.svg" height="36">
</picture>

# Setup Scripts

## Quick start

```bash
cd edge-platform
./scripts/setup.sh
```

This single command provisions a fresh device (Raspberry Pi or Linux dev machine) with everything needed to run the Droplet stack.

---

## What `setup.sh` does

The script runs six phases, each idempotent (safe to re-run):

| Phase | What happens |
|-------|-------------|
| **1. Preflight** | Checks OS (Debian/Raspbian/Ubuntu), architecture (ARM64 or x86_64), disk (≥ 8 GB), memory (≥ 2 GB), internet |
| **2. Docker** | Installs Docker Engine 25+ and Compose v2 if not present. Adds user to `docker` group |
| **3. Camera Drivers** | Installs UVC/V4L2 kernel modules, v4l-utils, ffmpeg, udev rules for USB cameras |
| **4. Secrets** | Generates unique-per-device passwords and encryption keys. Writes `.env` (chmod 600) |
| **5. Build** | Pulls 7 base images, builds every service with a local `Dockerfile` — orchestrator, web-dashboard, ai-gateway, routing, plus the profile-gated file-indexer, switch, and camera-discovery. Previously the `full`-profile images were skipped, so `COMPOSE_PROFILES=full docker compose up -d` on a fresh install would fail with "No such image". |
| **6. Start** | Starts the full Docker Compose stack with health-check waits |
| **7. Verify** | Runs `verify.sh` smoke tests against all services |

### Secrets generated

Each device gets its own random secrets — no two devices share credentials:

| Secret | Used by | Purpose |
|--------|---------|---------|
| `DEVICE_SECRET` | ai-gateway | Fernet encryption key for BYOK API keys |
| `POSTGRES_PASSWORD` | db, orchestrator, nextcloud, file-indexer | PostgreSQL authentication |
| `REDIS_PASSWORD` | cache, orchestrator, ai-gateway, nextcloud | Redis authentication |
| `MQTT_PASSWORD` | broker, orchestrator, file-indexer | Mosquitto MQTT authentication |
| `NEXTCLOUD_ADMIN_PASSWORD` | nextcloud | Nextcloud bootstrap admin |

---

## CLI options

```
./scripts/setup.sh [OPTIONS]

  --skip-docker      Skip Docker installation (assume already installed)
  --skip-build       Skip building container images
  --skip-start       Skip starting the Docker Compose stack
  --systemd          Install systemd service for auto-start on boot
  --regenerate-env   Force-regenerate .env (backs up existing)
  --sync-secrets     Only rewrite Docker secret files from .env, then exit
  --verbose          Show full command output
  --dry-run          Show what would be done without executing
  -h, --help         Show help
```

### Examples

```bash
# Full setup on a fresh Pi
./scripts/setup.sh

# See what would happen without doing anything
./scripts/setup.sh --dry-run

# Re-setup after Docker is already installed
./scripts/setup.sh --skip-docker

# Generate new secrets (backs up old .env)
./scripts/setup.sh --skip-docker --skip-build --skip-start --regenerate-env

# Rewrite Docker secret files after editing .env (e.g. rotate OPENWRT_PASSWORD)
./scripts/setup.sh --sync-secrets

# Factory provisioning: full setup + auto-start on boot
./scripts/setup.sh --systemd
```

### Running without a real router (WARP-44)

Dev laptops don't need OpenWrt hardware. Add `ROUTING_MODE=mock` to `.env` and the routing service serves realistic fixtures instead of calling into OpenWrt. Use `ROUTING_MODE=disabled` to turn off router supervision entirely — the orchestrator short-circuits calls and the dashboard shows a "Router supervision disabled" banner.

---

## Standalone verification

```bash
./scripts/verify.sh
```

Checks all services independently of `setup.sh`. Useful for monitoring or post-update validation.

Checks: container status, PostgreSQL, Nextcloud DB, Redis, MQTT, orchestrator API, web dashboard, AI gateway, Nginx proxy routing, `.env` file permissions.

---

## Local validation (ship-check)

```bash
./scripts/test/ship-check.sh           # six static checks (~2 min)
./scripts/test/ship-check.sh --full    # adds Ubuntu-container smoke (~5-15 min)
./scripts/test/ship-check.sh tsc-full  # iterate on a single failure
```

The canonical local validation gate. Run **before every push** that touches a Dockerfile, compose file, `docker/frigate/*.yml`, `scripts/*.sh`, `scripts/lib/*.sh`, or any orchestrator TypeScript that ships in a container. Run with `--full` **before pushing to a real device** for the bash-layer end-to-end smoke that catches drift between local macOS and Ubuntu LTS.

Each check exists because a specific bug class shipped to droplet-sys during the 2026-05-25 factory-reset (PRs #261, #263) and `npm test` / `npm run dev` didn't catch it:

| Check | One-line | Bug class |
|-------|----------|-----------|
| `tsc-full` | `npx tsc --noEmit` in every workspace with a Dockerfile | WARP-329 — test-fixture type errors that `npm run dev` skips but `RUN npm run build` catches |
| `compose-config` | `docker compose config --quiet` against `.env.example` | YAML breakage, missing env refs, malformed service defs |
| `frigate-env-scan` | Parse `docker/frigate/config.yml` for `{VAR}` substitutions and assert every one resolves | WARP-446 — operator-specific env in committed config raises KeyError at Frigate boot, restart-loops the stack |
| `shellcheck` | shellcheck warning-severity across `setup.sh`, `factory-reset.sh`, `lib/*.sh`, with **no global excludes** — every waiver is a per-line `# shellcheck disable=SCxxxx` directive with rationale (WARP-486) | bash bugs caught by static analysis (parse errors, quoting, declared-outside-function) |
| `matter-env-allowlist` | Delegates to `scripts/test-security.sh` Test 7 | architecture-guard rule 11 — `MATTER_*` env outside the allowlist collides with matter.js's auto-imported `VariableService` and crashes controller init |
| `exec-bits` | `git ls-files --stage` assert mode 100755 for every operator-facing script (setup, factory-reset, camera-drivers, install-device-bridge, ship-check, ship-check.test, openwrt/scripts/upgrade-router) | WARP-487 — index-100644 ships to main, so `./<path>/<name>.sh` invocations documented in the script's own `--help` are silent no-ops on filesystems that honour the index bit (WARP-489 extended the sweep to `openwrt/scripts/`) |
| `docker-build-smoke` (`--full` only) | `setup.sh --skip-docker --skip-build --skip-start --skip-drivers` inside a fresh `ubuntu:24.04` container | PR #263 set-u/RETURN-trap class + bash-version drift between macOS and the production target host |

Each subcommand can be invoked individually (`./scripts/test/ship-check.sh shellcheck`) for fast iteration on a single failure. `--help` lists everything.

**Regression test suite** for ship-check itself (every check has a synthetic mutation that proves the check would have FAILED the bug it exists to catch):

```bash
./scripts/test/ship-check.test.sh
```

---

## Docker group note

After running `setup.sh`, if you were just added to the `docker` group, Docker commands require `sudo` until you re-login:

```bash
# Option 1: Log out and back in
exit
# (re-login)

# Option 2: Reload group in current shell
newgrp docker
```

The setup script handles this automatically during its run by falling back to `sudo docker`.

---

## Troubleshooting

### Build fails with out-of-memory

On Raspberry Pi 4 (2 GB), builds may run out of memory:

```bash
# Free up Docker resources
docker system prune -a

# Re-run build only
./scripts/setup.sh --skip-docker --skip-start
```

### Port 80 already in use

```bash
# Find what's using port 80
sudo lsof -i :80

# Stop it, then re-run
./scripts/setup.sh --skip-docker --skip-build
```

### Services not starting

```bash
# Check container status
docker compose -f docker/docker-compose.yml ps

# View logs
docker compose -f docker/docker-compose.yml logs orchestrator
docker compose -f docker/docker-compose.yml logs db
```

### Need to start fresh

Use the factory reset script to wipe everything and start over:

```bash
./scripts/factory-reset.sh
```

Or reset and re-provision in one step:

```bash
./scripts/factory-reset.sh --reinstall
```

---

## Factory reset

```bash
./scripts/factory-reset.sh
```

Wipes **all** user data, credentials, and configuration — returning the device to a clean out-of-the-box state. Requires typing `RESET` to confirm (or pass `--yes` for automation).

### What gets deleted

- Docker volumes: database, uploaded files, Nextcloud data, AI keys, Matter fabric state
- Device secrets (`.env`)
- TLS certificates and MQTT credentials
- Setup logs

### Options

```
  --yes            Skip interactive confirmation
  --reinstall      After wiping, auto-run setup.sh to re-provision
  --purge-images   Also remove built Docker images (slower rebuild)
  -h, --help       Show help
```

### Examples

```bash
# Interactive reset (prompts for confirmation)
./scripts/factory-reset.sh

# Reset and immediately re-provision
./scripts/factory-reset.sh --reinstall

# Non-interactive for CI/automation
./scripts/factory-reset.sh --yes

# Full clean including Docker images
./scripts/factory-reset.sh --purge-images --reinstall
```

---

## Uninstall

```bash
# Stop the stack and remove volumes
docker compose -f docker/docker-compose.yml down -v

# Remove systemd service (if installed)
sudo systemctl disable droplet
sudo rm /etc/systemd/system/droplet.service
sudo systemctl daemon-reload

# Remove secrets
rm .env

# Remove Docker images (optional)
docker system prune -a
```

---

## Camera driver tool

Standalone tool for managing camera drivers (can be run independently of `setup.sh`):

```bash
./scripts/camera-drivers.sh check    # Show kernel modules, packages, devices
./scripts/camera-drivers.sh install  # Install everything (UVC, V4L2, ffmpeg, udev)
./scripts/camera-drivers.sh scan     # Detect USB + network cameras
./scripts/camera-drivers.sh fix      # Auto-fix permissions, load modules, restart Frigate
```

### What gets installed

| Component | Details |
|-----------|---------|
| **Kernel modules** | uvcvideo, videodev, videobuf2_v4l2, videobuf2_vmalloc |
| **Packages** | v4l-utils, ffmpeg, usbutils |
| **Udev rules** | Auto-permission `/dev/video*`, restart Frigate on USB hotplug |
| **Boot persistence** | Modules auto-load via `/etc/modules-load.d/droplet-cameras.conf` |
| **Permissions** | User added to `video` group |

---

## File layout

```
scripts/
├── setup.sh               Main entry point (7 phases)
├── factory-reset.sh       Wipe all data and start fresh
├── verify.sh              Standalone smoke test
├── camera-drivers.sh      Camera driver check/install/scan/fix tool
├── README.md              This file
└── lib/
    ├── logging.sh         Colored output, log file, spinner
    ├── preflight.sh       OS/arch/disk/memory checks
    ├── docker.sh          Docker install + group handling
    ├── secrets.sh         .env generation with openssl rand
    ├── compose.sh         Image pull, build, start, health wait
    ├── systemd.sh         Optional boot service
    └── camera-drivers.sh  Camera driver library (sourced by setup.sh)
```
