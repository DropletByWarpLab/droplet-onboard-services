# Host scripts

Scripts and units that run **on the device host** (not inside a container).

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
