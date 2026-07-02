# Host scripts

Scripts and units that run **on the device host** (not inside a container).

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
`DROPLET_BACKUP_KEEP_{DAILY,WEEKLY,MONTHLY}`.

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
