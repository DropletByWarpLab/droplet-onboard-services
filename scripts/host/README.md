# Host scripts

Scripts and units that run **on the device host** (not inside a container).

## Self-heal watchdog (WARP-1002)

`droplet-watchdog.sh` is the unified on-box self-heal supervisor: one
timer-driven pass over pluggable checks, each of which encodes a wedge state
we have a **proven manual heal** for (all diagnosed live on shipping boxes).
Installed by `setup.sh` (via `scripts/lib/single-box.sh`) to
`/usr/local/sbin/droplet-watchdog`, scheduled by
`etc-systemd-system/droplet-watchdog.timer` every ~3 minutes.

| Check | Detects | Heals |
|-------|---------|-------|
| `wifi` | Wi-Fi PCI function silently dead (driver bound, phy/netdev gone — WARP-869) | Delegates detect **and** heal (PCI remove + rescan, the only network-touching heal allowed) to `usr-local-sbin/droplet-wifi-watchdog` and classifies its outcome |
| `voice_dsp` | ReSpeaker XVF3800 DSP wedge ("listening but never detecting"; xhci overrun spam in the kernel log) | `xvf_host REBOOT 1` over USB (`DROPLET_WATCHDOG_XVF_HOST`); `not_applicable` when the XMOS USB device is absent |
| `docker_dns` | DNS broken inside containers — `getent hosts` probe via an **already-running** container (no heavy spawns) | Detect-and-report only: the durable fix (daemon.json `"dns": ["1.1.1.1", "8.8.8.8"]` pin) needs a dockerd restart that would take the stack down, so it is documented in the status message, never auto-applied |
| `container_crashloop` | `docker inspect` RestartCount deltas between runs (persisted); any service restarting more than the threshold per window | Detect-and-report only (docker's restart policy already retries); captures a `docker logs --tail 200` snapshot to `diagnostics/` once per episode |

**Status contract:** every known check ALWAYS appears in
`/var/lib/droplet/watchdog/status.json` with an explicit enum —
`ok | healed | heal_failed | escalated | not_applicable` — never inferred
from absence. Detect-only checks report failures as `heal_failed` with a
message stating no automatic heal exists. `overall` carries the worst status.

**Escalation:** after 2 consecutive heal failures on the same check
(`DROPLET_WATCHDOG_ESCALATE_AFTER`) the check goes `escalated` — CRITICAL log
line on the transition, heals suspended, re-tried only every 5th run
(`DROPLET_WATCHDOG_ESCALATED_RETRY_EVERY`) so a persistent failure never
retry-storms. A passing re-try resets it. Every heal action is logged with a
UTC timestamp to the journal and `/var/lib/droplet/watchdog/heal.log`.

**Per-shape gating:** `DROPLET_WATCHDOG_CHECKS` in
`/etc/default/droplet-watchdog` (installed once from
`etc-default/droplet-watchdog`, operator edits never clobbered) selects the
checks; everything else reports `not_applicable`. Checks also self-gate on
hardware/tooling presence, so the default (all checks) is safe on any shape.

**WARP-869 migration:** `droplet-wifi-watchdog.timer` is superseded — the
unified timer owns the schedule (two independent schedulers could race a PCI
remove/rescan). Both `setup.sh` and `install-device-bridge.sh` disable and
remove the old units on their next run; the helper script itself stays.

```bash
# Force a run + inspect
sudo systemctl start droplet-watchdog.service
cat /var/lib/droplet/watchdog/status.json
sudo journalctl -u droplet-watchdog --no-pager -n 50

# Tests (no root/hardware/docker needed)
bash tests/droplet-watchdog.test.sh
```

## Backup & restore (WARP-570)

| Script | Purpose |
|--------|---------|
| `device-backup.sh` | Full-device backup: `pg_dump` of the orchestrator Postgres (`db`) plus tar snapshots of every data volume → one timestamped `*.tar.gz` |
| `device-restore.sh` | Restore a `device-backup-*.tar.gz` into the live stack (DESTRUCTIVE; confirm-gated, `--force` to skip) |

```bash
# Back up everything (default /var/lib/droplet/backups, archive chmod 600)
./scripts/host/device-backup.sh [OUTPUT_DIR]

# Keep N rotations (default 7)
BACKUP_KEEP=14 ./scripts/host/device-backup.sh

# Restore
./scripts/host/device-restore.sh [--force] <device-backup-*.tar.gz>
```

**Captured surfaces:** orchestrator Postgres (`db`) and the `nextcloud-data`,
`aikeys`, `matter-data`, `brain-memory-data`, `nvrdata` (NVR recordings), and
`ops-audit` (WARP-337 audit trail) volumes. These are the real top-level
volumes in `docker/docker-compose.yml`; the backup script's `DATA_VOLUMES` list
is kept in lock-step with `factory-reset.sh`'s wipe list, and a static test
asserts every captured name is a genuine compose volume (a wrong name would
otherwise auto-create an empty volume and silently back up nothing).

**Not captured (rebuilt on reinstall):** the Postgres data volume itself
(`pgdata` — captured transactionally via `pg_dump` instead), plus pure caches /
rebuildable state: `frigate-config`, `rag-eval-data`, the whisper/piper/ollama
model caches, and `openwrt-config`/`openwrt-overlay`. The backup manifest's
`excluded` array is the machine-readable record, and `factory-reset.sh` prints
the same list before it wipes.

**Integrity:** every dump is verified with `gzip -t` at backup time and a
sha256 of each artifact is recorded in `manifest.json`. `device-restore.sh`
re-verifies those checksums **before** the first `DROP DATABASE`, so a
truncated/corrupt artifact aborts the restore instead of leaving an empty DB
with the good copy already gone.

**Secrets safety:** the archive holds DB dumps + the `aikeys` volume, so it is
`chmod 600` and its directory `chmod 700`. The repo `.env` is never copied into
the tarball.

### Scheduling (systemd)

`systemd/droplet-backup.service` + `droplet-backup.timer` run a daily backup.

```bash
sudo cp systemd/droplet-backup.{service,timer} /etc/systemd/system/
# edit WorkingDirectory + ExecStart in the .service to your checkout path
sudo systemctl daemon-reload
sudo systemctl enable --now droplet-backup.timer
```

Rotation (`BACKUP_KEEP`, default 7) is handled by `device-backup.sh` itself.
The orchestrator's in-container cron-runtime is deliberately NOT used for this
host-level dump — it can't reach the sibling DB containers or the host disk.

### factory-reset safeguard

`scripts/factory-reset.sh` runs `device-backup.sh` before it wipes anything.
A failed safety backup aborts the reset; pass `--no-backup` to opt out.

### Drill / test

`npm run test:backup` (or `bash tests/device-backup.test.sh`) runs the full
backup→mutate→restore round-trip against a disposable docker compose project,
asserting a restorable artifact per volume + both DBs, mode 600, and rotation.
It SKIPs the live drill (keeping the static checks) when Docker is unavailable.
