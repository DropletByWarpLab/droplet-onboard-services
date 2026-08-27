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
| `host_unit_staleness` | A host unit's running process started BEFORE the sources it executes were last modified — a merged fix sitting inert in a live process (WARP-1829). Delegates to `droplet-host-units check` | Detect-and-report only: the heal (`droplet-host-units refresh`) belongs to the deploy path, not a 3-minute timer — `droplet-device-bridge` owns the panel feed and the console handback, and a supervisor able to restart it on its own cadence is the thundering herd, not the fix |

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

## Power-loss auto-restart (WARP-2190)

`usr-local-sbin/droplet-power-restore` makes the box power itself back on after
mains is lost. Without it a box stays dark until somebody presses the button —
measured at ~30 h on a real box, because the board's AC-loss policy was
`always off` and nothing in provisioning ever set it.

Installed by `setup.sh` (via `scripts/lib/single-box.sh`) to
`/usr/local/sbin/droplet-power-restore`, enabled at boot by
`droplet-power-restore.service` and refreshed every 10 min by
`droplet-power-restore.timer`.

| Mechanism | Covers | Recovery |
|-----------|--------|----------|
| AMD FCH `PwrFailShadow` (PM register `0x5B`, bits[1:0]) — the same hardware bit the BIOS *Restore on AC/Power Loss* option drives. Sits in the RTC/always-on power well, so it survives a full G3 | Mains returns after a cut | Immediate |
| RTC wake alarm (`/sys/class/rtc/rtc0/wakealarm`) held 30 min ahead, re-armed by the timer | Board settled in S5 instead of G3; brownout latched the PSU off; someone pressed the button | ≤ the horizon |

The two are deliberately independent — the alarm is armed even when the
register write fails, because that is exactly when a backstop matters.

**Why it re-runs every boot:** firmware rewrites `PM[0x5B]` from its own NVRAM
copy at **every POST**, so a value set once by hand is stomped by the very next
power cycle — the one that matters. The unit is what closes that loop.
`droplet-power-restore.service` therefore has **no** `RemainAfterExit=yes`:
systemd treats a timer trigger on an already-active unit as a no-op, so that
one line would silently kill the refresh while the unit still looked healthy.

⚠ **This does not replace the BIOS setting.** The bit is only re-applied once
Linux is up, so a box that POSTs but fails to boot is unprotected against the
*next* cut. Set `Restore on AC/Power Loss` → `Power On` in BIOS as well;
firmware is the belt, this is the braces.

**Safety.** The script writes a byte to a hardware register via `/dev/mem`, so
it refuses to write at all unless it can first prove the window is mapped where
it thinks: `PM[0x64]` (the spec-fixed ACPI PM-timer block address) must equal
the `PM_TMR_BLK` the firmware published in the FADT — a value the script cannot
influence, and which the kernel echoes as `ACPI: PM-Timer IO Port:`. It
read-modify-writes so firmware-owned bits survive, and verifies bits[1:0]
**only**: on real silicon bits[5:4] mirror bits[1:0], so the byte read back is
legitimately not the byte written (observed: wrote `0x45`, read `0x55`).

⚠ The legacy AMD PMIO index/data pair `0xCD6`/`0xCD7` is **dead on Zen 4** — it
returns `0xFF` for every offset, which decodes as a plausible-looking
`PwrFailShadow=11` ("previous state"). Use the ACPI MMIO window at
`0xFED80300`, as this script does.

`/etc/default/droplet-power-restore` (installed once from
`etc-default/droplet-power-restore`, operator edits never clobbered) tunes
`DROPLET_POWER_RESTORE_RTC_HORIZON_SEC`; set it to `0` to disable the RTC
backstop and rely on the FCH bit alone — e.g. on a box that must stay off when
someone deliberately shuts it down.

```bash
# Read-only: what is the box's current policy?
sudo droplet-power-restore --status

# Force a re-apply + inspect
sudo systemctl start droplet-power-restore.service
sudo journalctl -u droplet-power-restore --no-pager -n 20

# Tests (no root, no hardware — fixture files stand in for /dev/mem)
python3 -m pytest scripts/test/pytest/test_power_restore_script.py -v
```

## Host-unit refresh (WARP-1829)

Host units execute their source **straight out of the git working tree**:

```ini
# droplet-device-bridge.service
ExecStart=/usr/bin/python3 /home/droplet/edge-platform/services/oled-display/device-bridge.py
```

Python reads that file **once**, at process start. The box's refresh pulls
`main` and restarts **containers** — nothing restarted host units — so a host
unit kept running whatever the file said when it launched, across every
subsequent pull, forever.

It is silent by construction: the code on disk is correct, so reading the repo
confirms the fix is present; `systemctl status` says `active (running)`. Only
the running process disagrees. Measured live on 2026-08-09 —
`droplet-device-bridge.service` had run 5d20h (PID 5602, started
`2026-08-03 22:22:39 UTC`) on a file with mtime `2026-08-08 02:37:27 UTC`.
Restarting it (same file, same env, new process) flipped `/openwrt/qr` from
`ok:false` to `ok=true`. Blast radius: **every host-service fix merged since
2026-08-03** — WARP-1800 sat inert for two days and caused a full misdiagnosis,
WARP-1830 was inert the hour it merged.

`droplet-host-units.sh` installs to `/usr/local/sbin/droplet-host-units` (via
`setup.sh` → `scripts/lib/single-box.sh`) and has two subcommands:

```bash
# The detection check. Stands entirely on its own, never touches systemd
# (no restart, no daemon-reload — it does keep its own digest baseline under
# /var/lib/droplet/host-units), and is the ONE-LINE answer next time a merged
# fix "isn't working" on the box.
sudo droplet-host-units check          # exit 1 if any unit runs stale code
sudo droplet-host-units check --json

# The fix. Restarts exactly the stale units.
sudo droplet-host-units refresh
sudo systemctl start droplet-host-units.service   # same thing, journald-logged
```

**Anything that updates the checkout should run `refresh` afterwards.**
`setup.sh` already does (last step of a provision run, where it is normally a
no-op because the installers it just ran restarted those units themselves).

### What counts as a source

mtime of the files the unit **actually executes**, confirmed by a content
digest — not a git diff of the pulled range. The checkout moves by pull, bundle
apply, rsync and the odd hand-edit, so a range is often undefined; and the
question being answered is "is this process older than its own code", which the
standalone check has to answer anyway. Git only rewrites files whose content
changed, so checkout mtime is a faithful "this pull touched this file".

| Included | Why |
|---|---|
| `FragmentPath` + drop-ins | A changed unit definition means the loaded `ExecStart` may differ from disk — these also force a `daemon-reload` before the restart |
| Every `ExecStartPre`/`ExecStart`/`ExecStartPost` argv token that is a real file | Catches both `/usr/bin/python3 <repo>/x.py` and `/usr/local/sbin/foo` |
| Every `*.py` under a `*.py` entry point's directory | An `ExecStart` names ONE file that imports many siblings from the same tree; a change to an imported module is just as stale-making |
| Payload paths under `/usr/local/lib`, `/usr/local/share`, `/opt/droplet` referenced by a shell entry point | `droplet-egress-audit` is a launcher whose real payload is `/usr/local/lib/droplet-egress-audit/collector.py` — invisible from argv alone |

`EnvironmentFile` is deliberately **excluded**: `droplet-device-bridge` writes
its own `/var/lib/droplet-bridge/openwrt-attach.env`, so counting it would have
the unit restart itself on every key rotation. Credential changes have their own
restart path (`droplet-openwrt-attach.path`).

**mtime is the trigger, a content digest is the confirmation.** `setup.sh`
rewrites unit files and `/usr/local/sbin` copies unconditionally (`sed > "$dst"`,
`install -m 0644`), so their mtime moves on every provision whether or not a
byte changed — mtime alone would restart `droplet-host-net` on every single
`setup.sh` run for nothing. A unit is stale only when the bytes it would read
now differ from the bytes it was last known to be running. That digest
(`/var/lib/droplet/host-units/digests/<unit>`) is recorded at exactly the two
moments the process is *provably* at or ahead of its sources: when a sweep
observes `start >= newest source mtime`, and after a restart this script
verified came back. With no digest on file (fresh install) a newer mtime reads
as stale — being conservative on the first run costs one restart; guessing
"probably fine" costs another multi-hour misdiagnosis.

### Which units are in scope

Enumerated from systemd (`droplet-*`), never hardcoded — a host unit added
tomorrow is covered the day it lands. A unit is a **restart candidate** only
with a live main PID, a long-running `Type`, `RemainAfterExit != yes`, at least
one resolved source, and off the deny-list. Everything else is reported
`skipped` **with a reason** (never silently absent).

- `oneshot` units re-execute their source on **every** activation, so they can
  never be stale — `droplet-watchdog`, `droplet-net-selfheal`, the panel units.
- `droplet.service` is a `RemainAfterExit` oneshot whose `ExecStop` is
  `docker compose down`. "Restarting" it would take the whole box down. Excluded
  structurally **and** deny-listed, because the cost of being wrong is the
  appliance.

Today that resolves to exactly three units — `droplet-device-bridge` (tree),
`droplet-host-net` and `droplet-egress-audit` (installed copies). **None touch
the management NIC**: `host-net` owns `br-lan` (192.168.20.0/24) DHCP plus the
`/32` route to the switch, `egress-audit` only reads conntrack. Restarting them
cannot drop SSH. Whoever adds a new long-running host unit must confirm its own
blast radius — one that reconfigures the management interface belongs in
`DROPLET_HOST_UNITS_NEVER_RESTART`.

### Bounds

Sequential with a settle wait, **one attempt per unit per invocation**, ordered
alphabetically except `DROPLET_HOST_UNITS_RESTART_LAST` (default
`droplet-device-bridge.service`) which goes **last** — it owns the rack panel's
data feed and the console-handback path (WARP-1639), so restarting it briefly
blanks panel data; doing it last means the one visible blip happens with every
other unit already verified back up, and `droplet-panel-deadman.timer` is the
safety net if it does not return.

A unit that does not come back is logged `CRITICAL`, recorded in
`/var/lib/droplet/host-units/suspended`, and **not retried** on later runs — a
restarter that keeps retrying a unit that cannot start IS the restart loop. The
suspension lifts by itself as soon as that unit's sources change again (new code
may be the fix) or with `--force`. The whole thing is self-terminating: a
successful restart moves `ExecMainStartTimestamp` past the source mtime, so the
next run has nothing to do.

### Install drift

A unit executing `/usr/local/sbin/<name>` runs a **copy** installed by
`setup.sh`. If the repo pulled but `setup.sh` has not re-run, the copy is behind
the tree — the process matches the copy, so it is not stale, but it is not
running the merged fix either. That is reported as `install_drift` with the repo
path. It deliberately does **not** set a failing exit code and does **not**
trigger a restart: drift is the expected state between a pull and the next
`setup.sh`, only `setup.sh` can fix it, and red-by-default would just teach
people to ignore the check.

```bash
# Tests (no root, no systemd, no box)
bash tests/droplet-host-units.test.sh
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

The pre-reset backup is OPT-IN since 2026-07-16 (a reset means a factory-new
box — by default nothing is saved, and the accumulated tarballs under
`/var/lib/droplet/backups` are removed as part of the wipe). Pass `--backup`
to `scripts/factory-reset.sh` to run `device-backup.sh` before it wipes
anything and keep the backups dir; a failed safety backup then aborts the
reset. `--no-backup` is a deprecated no-op kept for automation back-compat.

### Drill / test

`npm run test:backup` (or `bash tests/device-backup.test.sh`) runs the full
backup→mutate→restore round-trip against a disposable docker compose project,
asserting a restorable artifact per volume + both DBs, mode 600, and rotation.
It SKIPs the live drill (keeping the static checks) when Docker is unavailable.

## Hardware watchdog (WARP-2192)

The floor beneath every other recovery path. If the **kernel** wedges — hard
lock, driver deadlock, storage taking the whole IO path down — nothing in
userspace can help. The *Self-heal watchdog* above is a systemd timer, so a
wedged kernel takes it down too; only the FCH's own timer gets the box back.

Two files, installed by `setup.sh` (via `scripts/lib/single-box.sh`). **Either
one missing makes the whole thing a silent no-op:**

| File | Installed to | Why it is needed |
|---|---|---|
| `etc-modules-load.d/droplet-watchdog-hw.conf` | `/etc/modules-load.d/` | systemd never loads watchdog drivers itself, so without this `/dev/watchdog` does not exist |
| `etc-systemd-system.conf.d/droplet-watchdog.conf` | `/etc/systemd/system.conf.d/` | `RuntimeWatchdogSec` is `off` by default, so PID1 would never open or pet the device |

**`RuntimeWatchdogSec=120` is deliberately conservative.** systemd pets at
**half** the configured value (60s), so a transient stall — heavy IO, a storm of
container restarts — has a full minute of slack before the counter matters. A
spurious reboot of a healthy appliance is worse than two minutes of extra
downtime on a genuine hang.

`nowayout=0` on `sp5100_tco`, so systemd's clean close on a normal shutdown
**disarms** the timer instead of leaving it to fire mid-reboot.
`RebootWatchdogSec` stays at its 10 min default — that covers a hung *shutdown*
sequence, a different failure.

⚠ **`daemon-reload` is not enough.** `system.conf` is read by PID1 at startup,
so applying a change needs `systemctl daemon-reexec`. A reload leaves the
setting inert while the file on disk looks correct.

⚠ **Check `dmesg` on any new board revision.** The known AMD FCH failure is
`Watchdog hardware is disabled` when firmware never programmed the MMIO base —
the module still loads, so "modprobe succeeded" proves nothing. The good path
logs `Using 0x… for watchdog MMIO address`.

```bash
# Is it actually armed?
cat /sys/class/watchdog/watchdog0/state      # want: active
cat /sys/class/watchdog/watchdog0/timeout    # want: 120
systemctl show -p RuntimeWatchdogUSec -p WatchdogDevice
journalctl -b | grep -i watchdog             # "Watchdog running with a timeout of 2min."

# Did the watchdog cause the last reboot? (non-zero = yes)
cat /sys/class/watchdog/watchdog0/bootstatus
```

**Verifying a change here means proving PID1 is *petting* it, not just that it
armed.** An armed-but-unpetted watchdog reboots the box every 2 minutes
forever, and `state=active` looks identical in both cases. Record
`/proc/sys/kernel/random/boot_id`, wait past the full timeout, and re-read it:

```bash
cat /proc/sys/kernel/random/boot_id; sleep 200; cat /proc/sys/kernel/random/boot_id
```
