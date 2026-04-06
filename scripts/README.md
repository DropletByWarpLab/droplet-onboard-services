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
| **3. Secrets** | Generates unique-per-device passwords and encryption keys. Writes `.env` (chmod 600) |
| **4. Build** | Pulls 7 base images, builds orchestrator, web-dashboard, and ai-gateway containers |
| **5. Start** | Starts the full Docker Compose stack with health-check waits |
| **6. Verify** | Runs `verify.sh` smoke tests against all services |

### Secrets generated

Each device gets its own random secrets — no two devices share credentials:

| Secret | Used by | Purpose |
|--------|---------|---------|
| `DEVICE_SECRET` | ai-gateway | Fernet encryption key for BYOK API keys |
| `POSTGRES_PASSWORD` | db, orchestrator, nextcloud, file-sync | PostgreSQL authentication |
| `REDIS_PASSWORD` | cache, orchestrator, ai-gateway, nextcloud | Redis authentication |
| `MQTT_PASSWORD` | broker, orchestrator, file-sync | Mosquitto MQTT authentication |
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

# Factory provisioning: full setup + auto-start on boot
./scripts/setup.sh --systemd
```

---

## Standalone verification

```bash
./scripts/verify.sh
```

Checks all services independently of `setup.sh`. Useful for monitoring or post-update validation.

Checks: container status, PostgreSQL, Nextcloud DB, Redis, MQTT, orchestrator API, web dashboard, AI gateway, Nginx proxy routing, `.env` file permissions.

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

- Docker volumes: database, uploaded files, Nextcloud data, AI keys, Home Assistant config
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

## File layout

```
scripts/
├── setup.sh               Main entry point
├── factory-reset.sh       Wipe all data and start fresh
├── verify.sh              Standalone smoke test
├── README.md              This file
└── lib/
    ├── logging.sh         Colored output, log file, spinner
    ├── preflight.sh       OS/arch/disk/memory checks
    ├── docker.sh          Docker install + group handling
    ├── secrets.sh         .env generation with openssl rand
    ├── compose.sh         Image pull, build, start, health wait
    └── systemd.sh         Optional boot service
```
