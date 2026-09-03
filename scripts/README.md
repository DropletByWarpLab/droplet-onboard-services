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

This single command provisions a fresh device (router host, inference host, or Linux dev machine) with everything needed to run the Droplet stack.

---

## What `setup.sh` does

The script runs six phases, each idempotent (safe to re-run):

| Phase | What happens |
|-------|-------------|
| **1. Preflight** | Checks OS (Debian/Raspbian/Ubuntu), architecture (ARM64 or x86_64), disk (≥ 8 GB), memory (≥ 2 GB), internet |
| **2. Docker** | Installs Docker Engine 25+ and Compose v2 if not present. Adds user to `docker` group |
| **3. Camera Drivers** | Installs UVC/V4L2 kernel modules, v4l-utils, ffmpeg, udev rules for USB cameras. Also preps host Bluetooth for Matter BLE commissioning (WARP-850): bluez + rfkill installed, `bluetooth.service` enabled, radio rfkill-unblocked, adapter powered — bluetoothd stays RUNNING (noble's raw-channel HCI socket coexists with it; see `lib/bluetooth.sh`) |
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
| `NEXTCLOUD_ADMIN_PASSWORD` | nextcloud | Nextcloud bootstrap admin |
| `DROPLET_MATTER_SERVICE_TOKEN` | orchestrator, matter-controller | X-Droplet-Auth bearer for the Matter host-network sidecar (WARP-850) |

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
# Full setup on a fresh appliance host
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

## Re-running setup.sh on a deployed device (the field-update path)

Until the OTA update system ships (WARP-534 covers signed app-update
manifests — see the key ceremony below — and WARP-179 the full image-based
update path), **re-running `./scripts/setup.sh` is the way a deployed box
picks up new code**: pull the new checkout, re-run setup, and every phase
converges the box to the new version. This section is the contract for what
that re-run does, what it guarantees, and what happens when a run is
interrupted (power loss, SSH drop, ctrl-C) — WARP-595.

### What a re-run does on an existing device

| Phase | On an existing install |
|-------|------------------------|
| **1. Preflight** | Read-only checks; re-run has no side effects |
| **2. Docker** | No-op when Docker ≥ 25 is present; group membership checked, not re-added |
| **3. Drivers / Bluetooth** | apt installs skip when present; kernel modules re-loaded (idempotent); guarded files only written when absent |
| **4. Secrets** | `.env` is **preserved** — never regenerated without `--regenerate-env`. `migrate_env` appends only *missing* keys (never rewrites a value); artifacts (mosquitto conf/ACL, Docker secret files, audit key, internal-CA service bundles) are re-materialized deterministically; the TLS cert is kept unless invalid (a public-CA leaf is *never* clobbered — ADR-023) |
| **5. Build** | `docker compose down` then rebuild — this is where new code lands |
| **6. Start** | `up -d` recreates changed containers; Nextcloud DB creation is existence-guarded; the Nextcloud provisioning hook and workspace-settings seeder are insert-or-skip |
| **7. Verify / DNS** | Read-only checks + idempotent registrations |

DB schema migrations run **inside the orchestrator container on boot** via
the guarded entrypoint (`apps/orchestrator/scripts/migrate-and-start.sh`,
WARP-573: advisory lock + pre-migrate snapshot + loud failure), not from
setup.sh itself.

### Interruption + re-run convergence (what's guaranteed)

Setup takes a lock (`.data/.setup.lock`); a lock left behind by a killed run
is reclaimed automatically when its PID is dead (no 1-hour wait, no manual
`rm`). Per phase, an interruption converges as follows on the next run:

- **Phase 4 (secrets).** All `.env` writes are staged to a temp file and
  atomically renamed into place — `.env` is always either the previous
  complete file or the new complete file, never a prefix. A *torn* `.env`
  left by an older setup version is detected on re-run (generated header
  present but core keys missing / truncated last line) and recovered:
  restored from the newest complete `.env.bak.*` when one exists, otherwise
  regenerated fresh with a loud warning. The mid-run `.env` copies exist
  ONLY for this convergence: a setup run that completes successfully removes
  its `.env.bak.*` / `.env.torn.*` / staging strays on the way out, so a
  green provision leaves nothing stale on the box (exception: a
  `--regenerate-env` run keeps its `.env.bak.*` — that backup is the
  documented recovery path below). Docker secret files and the audit
  signing key were already staged+renamed; the TLS cert/key pair is now also
  verified to *match* — a torn self-signed pair is restored from the
  `.bootstrap` trust anchor (or regenerated) instead of being kept forever.
  One carve-out: a torn **public-CA** pair is *preserved with a loud
  warning* (setup cannot mint public-CA material) — it heals via
  re-issuance, which the operator should trigger rather than waiting for
  the renew window.
- **Phase 3 / single-box host files.** Files behind "write only if missing"
  guards (`/etc/default/droplet-openwrt-attach`, `droplet-cameras.conf`,
  udev rules) are staged+renamed, so the guard can never latch onto a
  half-written file.
- **Phases 5–6 (build/start).** Interruptions leave a partially built/started
  stack; the next run's `down → build → up -d` converges it. No state is
  keyed on a completion marker that an interruption could strand.

### What is NOT guaranteed (know before you run)

- **`--regenerate-env` rotates data-store passwords** (`POSTGRES_PASSWORD`,
  `REDIS_PASSWORD`, …) but existing Docker **volumes keep the old
  credentials** — a stack with data will fail auth after regeneration.
  Recover by restoring the automatic `.env.bak.*`, or factory-reset if the
  data is disposable. Use `--sync-secrets` (not `--regenerate-env`) after
  hand-editing `.env`. Hand edits must also keep the six core keys
  (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
  `NEXTCLOUD_ADMIN_PASSWORD`, `DEVICE_SECRET`, `DEVICE_SECRET_KEY`)
  non-empty and the file's trailing newline intact — otherwise the next
  re-run classifies the file as torn and restores/regenerates it (the
  hand-edited version is kept as `.env.torn.*`).
- **No automatic pre-update backup yet.** A setup.sh re-run does not snapshot
  the box first. The building blocks exist — scheduled restic backups
  (WARP-254, `scripts/lib/backup.sh`) and the opt-in pre-reset full-device
  backup in `factory-reset.sh` (`--backup`, WARP-570) — but wiring an automatic pre-update snapshot
  into the re-run path is deliberately deferred to the OTA work (WARP-534/179),
  which owns the update transaction (snapshot → apply → verify → rollback).
  Until then: `sudo /usr/local/sbin/droplet-backup.sh` before a risky update
  is the manual equivalent.
- **Concurrent runs** are excluded by the lockfile, but the check is
  best-effort (not `flock`-based); don't deliberately race two setups.

---

## Standalone verification

```bash
./scripts/verify.sh
```

Checks all services independently of `setup.sh`. Useful for monitoring or post-update validation.

Checks: container status, PostgreSQL, Nextcloud DB, Redis, MQTT, orchestrator API, web dashboard, AI gateway, Nginx proxy routing, `.env` file permissions.

---

## Rebuilding the RAG corpus (`rag-re-embed.sh`)

```bash
./scripts/rag-re-embed.sh --dry-run   # report only, deletes nothing
./scripts/rag-re-embed.sh             # interactive: type REBUILD to confirm
./scripts/rag-re-embed.sh -y          # unattended
```

Deletes `FileContentChunk` + `FileIndexStatus` in one transaction so the
file-indexer rebuilds every vector with the currently-configured
`EMBEDDING_MODEL`. Needed whenever the embedding model changes — vectors from
two different models are not comparable even at equal width, and pgvector will
compare them anyway without erroring.

Deliberately **not** a Prisma migration: the rebuild is CPU-bound and can run
for hours, so an operator picks the window rather than `migrate deploy` picking
it at the next reboot. Skipping it is safe, not silent — the file-indexer's
startup guard (`services/file-indexer/corpus_state.py`) refuses to write new
chunks into a corpus a different model built, keeps serving reads, and logs the
recovery command.

The script does **not** restart the file-indexer and does **not** replay brain
uploads; both are printed as next steps. Safe to re-run.

Full procedure, verification and rollback: `docs/RAG_RE_EMBED_RUNBOOK.md`.

---

## Local validation (ship-check)

```bash
./scripts/test/ship-check.sh           # seven static checks (~2 min)
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
| `stale-repo-names` | Walk curated user-facing surfaces (README, service READMEs/TESTING.md, top-level `scripts/*.sh`, `apps/orchestrator/src/**/*.ts`, `services/ai-gateway/**/*.py`, `services/voice-io/**/*.py`, `docker/docker-compose.yml`) and FAIL on any reference to the legacy inference-repo names that predate the canonical `droplet-local-LLM` (the exact blocked strings live in `scripts/test/ship-check.sh`). Allowlists the mDNS hostname `inference-engine.local` and the compose project-name + container-label call sites tied to it | WARP-494 — stale repo-name refs accumulating in user-facing surfaces after the canonical DropletByWarpLab remote rename; new refs reach for the old name out of habit |
| `docker-build-smoke` (`--full` only) | `setup.sh --skip-docker --skip-build --skip-start --skip-drivers` inside a fresh `ubuntu:24.04` container | PR #263 set-u/RETURN-trap class + bash-version drift between macOS and the production target host |

Each subcommand can be invoked individually (`./scripts/test/ship-check.sh shellcheck`) for fast iteration on a single failure. `--help` lists everything.

**Regression test suite** for ship-check itself (every check has a synthetic mutation that proves the check would have FAILED the bug it exists to catch):

```bash
./scripts/test/ship-check.test.sh
```

A case whose prerequisite is absent (no `node_modules`, no `shellcheck`, no
reachable docker daemon) reports **SKIP**, and a SKIP is **not** a pass — the
suite exits non-zero unless the caller names the cases allowed to skip:

```bash
SHIPCHECK_ALLOW_SKIP='tsc-full catches WARP-329 fixture regression' ./scripts/test/ship-check.test.sh
SHIPCHECK_ALLOW_SKIP=all ./scripts/test/ship-check.test.sh   # tolerate any skip on this host
```

WARP-2637: before this, every SKIP returned 0 and was counted in `N/N passed`,
so CI's `shipcheck` job — which does no `npm ci` — reported green while both
`tsc-full` cases had never run, and the WARP-329 fixture guard sat vacuous for
weeks. The two cases CI cannot run are named in `.github/workflows/ci.yml`; the
skipped names are also written to the GitHub job summary.

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

On memory-constrained ARM64 hosts (2 GB RAM), builds may run out of memory:

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
- The Docker **build cache** — reclaimed on **every** reset. It's the largest rebuildable disk consumer (`docker compose down --rmi all` leaves it behind; it has grown past 57 GB on a long-lived box, enough to fill the OS NVMe) and is never user data. This is why the next `setup.sh` after a reset is a cold (slower) rebuild — an intentional trade so the OS drive doesn't silently fill over time.
- Device secrets (`.env`)
- TLS certificates and internal-CA service bundles (incl. broker mTLS identities)
- Setup logs

### Options

```
  --yes            Skip interactive confirmation
  --reinstall      After wiping, auto-run setup.sh to re-provision
  --purge-images   Also remove built Docker images + dangling images/networks
                   (a scoped reclaim — not a daemon-wide system prune, so
                   sibling project images such as Ollama are left intact)
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

## OTA release signing — key ceremony (WARP-535)

OTA release manifests (`release.json`, published by
`.github/workflows/publish-release.yml`) are signed with
[cosign](https://github.com/sigstore/cosign) and verified on-device by the
orchestrator's update agent against the public key baked into the image at
`apps/orchestrator/src/services/update-agent/cosign.pub`, and by the
fleet-agent's update-poll (WARP-1025) against its byte-identical copy at
`services/fleet-agent/cosign.pub` — the ceremony stamps BOTH copies.

> **The committed `cosign.pub` is a PLACEHOLDER.** The update agent's verify
> path detects the `DROPLET-OTA-PLACEHOLDER` marker and **fails closed** —
> no OTA release verifies (and the publish workflow's sign step fails for
> want of secrets) until a human runs the ceremony below. This is
> deliberate: the real keypair must never be minted by CI or an agent.

Run the ceremony on a trusted workstation (not a CI runner):

```bash
# 1. Mint the keypair. cosign prompts for a password that encrypts the
#    private key (ECDSA P-256 — consistent with the FIPS-allowed set used
#    by the ADR-020 image-signing keys in scripts/image/keys/).
cosign generate-key-pair          # writes cosign.key + cosign.pub

# 2. Store the PRIVATE side in GitHub Actions secrets — never in the repo.
gh secret set COSIGN_PRIVATE_KEY < cosign.key
gh secret set COSIGN_PASSWORD     # paste the password from step 1

# 3. Commit the PUBLIC side over BOTH placeholders (orchestrator update
#    agent + fleet-agent update-poll, WARP-1025).
cp cosign.pub apps/orchestrator/src/services/update-agent/cosign.pub
cp cosign.pub services/fleet-agent/cosign.pub
git add apps/orchestrator/src/services/update-agent/cosign.pub \
        services/fleet-agent/cosign.pub
git commit -m "chore: install real OTA cosign public key (key ceremony)"

# 4. Destroy the local private key (it now lives only in GH secrets +
#    whatever escrow the org key-custody policy requires).
shred -u cosign.key 2>/dev/null || rm cosign.key
```

Custody and rotation follow the same rules as the ADR-020 appliance-image
release keys — see `scripts/image/keys/README.md` (escrow the private key
per org policy; rotation is a superset-trust transition so in-field boxes
keep verifying through the overlap window). The two trust domains are
**separate on purpose**: `scripts/image/keys/droplet-release.pub` signs the
full appliance ISO manifest (OpenSSL ECDSA, ADR-020), while `cosign.pub`
signs OTA app-update release manifests (WARP-534). Do not reuse one key
for the other.

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
    ├── camera-drivers.sh  Camera driver library (sourced by setup.sh)
    ├── bluetooth.sh       Host Bluetooth prep for Matter BLE (WARP-850)
    └── backup.sh          Restic backup host integration (WARP-254):
                           installs droplet-{backup,restore,restore-drill}.sh
                           + daily/weekly/monthly timers; repo key derived
                           from device identity — see scripts/host/README.md
```
