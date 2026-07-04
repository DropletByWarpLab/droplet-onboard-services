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

## Restic backup + restore drill (WARP-254)

The long-term backup home (device-backup.sh below is the tarball MVP that
predates it): an **encrypted, deduplicated restic repository** keyed by the
device identity, with scheduled incrementals, weekly fulls, and a monthly
automated restore drill.

| Script | Purpose |
|--------|---------|
| `droplet-backup.sh` | restic backup: staged `pg_dump` of the orchestrator Postgres + the `nextcloud-data` volume + `.env` + config dirs. `--full` re-reads every byte (`restic backup --force`, tag `weekly-full`) |
| `droplet-restore.sh` | Restore a snapshot into the live stack (DESTRUCTIVE; confirm-gated, `--force` to skip, `--list` / `--snapshot ID` to pick). `.env`/config are staged for operator review, never applied live |
| `droplet-restore-drill.sh` | Monthly drill: `restic check` (with data re-read) + restore latest into a throwaway sandbox Postgres + smoke query + **explicit** `ok\|failed` status file |
| `droplet-backup-lib.sh` | Shared lib (sourced): HKDF-SHA256 password derivation + restic env plumbing |

**Repository key (derived, never stored):** the restic password is
HKDF-SHA256-derived from `DEVICE_SECRET_KEY` (the per-device master key in
`.env`) — salt `droplet-restic-v1`, info `droplet-restic-repository-password`.
The construction is a **stability contract** pinned by a known-answer test in
`tests/restic-backup.test.sh`: changing it makes every existing repository
unreadable. The derived password is materialized per-run under `/run/droplet`
(root-only tmpfs, mode 0600) and handed to restic via `RESTIC_PASSWORD_FILE`;
it never lands in a tracked file.

**Repository target:** `DROPLET_BACKUP_TARGET`, default
`/var/lib/droplet/restic-repo` (local path on the data disk). Off-device
targets are future work — restic natively speaks sftp/S3/rest-server, so only
this env knob needs to change.

**Camera footage is EXCLUDED by default** (the `nvrdata` volume): 24/7 NVR
recordings routinely run to hundreds of GB, which would dwarf every other
surface and stretch the nightly window from minutes to hours. Opt in with
`DROPLET_BACKUP_INCLUDE_CAMERA=1`.

**Retention** (applied after every backup): `restic forget --prune` with
**7 daily / 4 weekly / 6 monthly** — a month of fine-grained restore points
plus half a year of monthly history, bounded on disk. Override with
`DROPLET_BACKUP_KEEP_{DAILY,WEEKLY,MONTHLY}`. Retention groups `--group-by host`
so the policy stays global across backup path-set changes over the box's
lifetime (restic's default `host,paths` grouping would strand stale groups).

**Integrity:** `restic check` runs before *every* restore (before any
destructive step) and on every drill (with `--read-data-subset`, default 10%).
The staged dump is `gzip -t`-verified at backup AND restore time.

**Scheduling (installed + enabled by `setup.sh` on every Linux shape —
see `scripts/lib/backup.sh`):**

| Unit | Cadence |
|------|---------|
| `droplet-restic-backup.timer` | daily 03:15 (incremental, tag `daily`) |
| `droplet-restic-backup-full.timer` | Sun 04:15 (`--full`, tag `weekly-full`) |
| `droplet-restore-drill.timer` | monthly (1st, 05:00) |

All three are `Persistent=true` (missed runs fire on next boot). The drill
writes `/var/lib/droplet/backup/restore-drill-status.json` with an **explicit
status enum** (`"status": "ok"` or `"failed"` — never inferred from
timestamps), logs `daemon.err` via `logger` on failure, and leaves the unit
failed so operators can alert on either surface.

```bash
# Manual runs (as root; scripts install to /usr/local/sbin)
sudo droplet-backup.sh                # daily incremental
sudo droplet-backup.sh --full         # weekly-style full re-read
sudo droplet-restore.sh --list        # inspect snapshots
sudo droplet-restore.sh               # restore latest (confirm-gated)
sudo droplet-restore-drill.sh         # prove the latest snapshot restores
```

Drill / test: `npm run test:restic-backup` (or `bash
tests/restic-backup.test.sh`) runs the full backup → incremental → full →
mutate → restore → drill round-trip against a disposable compose project,
including the drill's failure path (wrong key ⇒ `status: failed` + non-zero
exit). Static checks + the derivation KAT always run; the live drill SKIPs
cleanly when Docker or restic is unavailable.

## Encryption verification harness (WARP-966)

`droplet-verify-encryption.sh` (+ `droplet-verify-encryption-lib.sh`) probes
data-at-rest (LUKS2) and every in-transit hop (Postgres, Redis, MQTT, internal
service mesh, nginx edge) and emits a **signed, hash-chained evidence bundle**
satisfying the WARP-966 acceptance criteria (epic WARP-957, GA security
cut-line). One command on the box:

```bash
sudo bash scripts/host/droplet-verify-encryption.sh          # full pass
sudo bash scripts/host/droplet-verify-encryption.sh --list   # show the check registry
sudo bash scripts/host/droplet-verify-encryption.sh --verify-bundle <dir>   # re-verify later
```

Every registered check always reports an explicit `PASS | FAIL | SKIP` (same
status contract as the watchdog). A **FAIL is a documented plaintext path and a
release blocker** per the AC — expected today because the encryption tickets
(WARP-232/233/234/235/236) are still in flight, and flips to PASS as each lands.
Bundles land under `/var/lib/droplet/verify/<UTC-ts>/` (`report.json`,
`report.md`, `evidence/`, `manifest.sha256`, `manifest.sig`,
`device-id-cert.pem`); the manifest is signed by the device-identity sidecar
(WARP-230) and degrades to unsigned if that sidecar is absent.

Full runbook: `docs/security/encryption-verification.md`. Bundle convention:
`docs/security/evidence/README.md`. Test: `npm run test:verify-encryption` (or
`bash tests/verify-encryption.test.sh`) — evaluators against committed fixtures
plus the real runner end-to-end against stub binaries (no root / hardware /
Docker daemon).

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
