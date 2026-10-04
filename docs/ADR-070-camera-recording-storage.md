# ADR-070: Camera recording storage: encrypted bay drives, auto-sized quota slices, recordings off the OS disk

- **Status:** Proposed, 2026-10-03 ([WARP-3512](https://warp-lab.atlassian.net/browse/WARP-3512)). The decisions it records are Stefan's, 2026-10-03, listed in §1 and on the ticket.
- **Supersedes, in part:** [`ADR-019`](ADR-019-storage-pool-management.md) D2 ("Nothing is ever automatic"), for camera recordings only. Nothing else in ADR-019 changes. §3 lists what still holds.
- **Builds on:** [`ADR-019`](ADR-019-storage-pool-management.md) (pools, the D4 safety tiers, D5 "the AI cannot write storage", D6.1 spool plus root apply unit), [`ADR-011`](ADR-011-hardware-agnostic-codebase.md) (role-based vocabulary), [`at-rest-encryption.md`](security/at-rest-encryption.md) (the `/data` scheme, WARP-232), and the camera-storage history in "Context" (WARP-1956, WARP-1963, WARP-2099, WARP-2136).
- **Binding contract:** "WARP-3512 storage contract", shared by the three delivery tickets. §4 to §8 restate it, and this ADR is its record in the repo. Every implementation PR builds from it.
- **Delivered by:** [WARP-3513](https://warp-lab.atlassian.net/browse/WARP-3513) (encrypted bay drives), [WARP-3514](https://warp-lab.atlassian.net/browse/WARP-3514) (recordings allocation backend), [WARP-3515](https://warp-lab.atlassian.net/browse/WARP-3515) (dashboard). See "Delivery".
- **Number:** 070. The WARP-3512 tickets and the shared contract call this ADR-069, but open PR #2593 (WARP-3518, the Work Suite) claimed 069 on 2026-10-03, so this takes the next free number. No ref in this repository adds an ADR-070, and no open PR does. Anything that still says ADR-069 for this decision means this ADR. Re-check before merge.

## Context

On 2026-10-03 the live single-box (Frigate 0.17.1, kernel 6.8.0-142) showed all of this at once:

- **Recordings are on the OS disk.** Frigate writes to the Docker named volume `droplet_nvrdata` (volume `nvrdata` of compose project `droplet`). It sits under Docker's data root on `/data`, the LUKS2 partition of the internal NVMe. The footage is encrypted at rest, but it shares a disk with Postgres, Nextcloud and the models.
- **The bays are empty and plain.** The two storage-bay HDDs (2 TB each) hold nothing. They are plain ext4, mounted `rw,nosuid,nodev,noatime` at `/mnt/droplet/<label>-<uuid8>`, listed in `trusted.list`, and registered in Nextcloud at the drive root for every user (`files_external` with `applicable_users=[]` and `groups=[]`, unscoped on purpose since WARP-1338). "Erase & adopt" and pool format (`drive_adopt`, `drive_reclaim` and `pool_format` in `scripts/host/droplet-storage-pool.sh`) each make a whole-device ext4. Per-drive LUKS exists only for hot-plugged USB drives (WARP-232), and `at-rest-encryption.md` records that there is "no encrypt/trust UI".
- **The redirect seam exists and nothing uses it.** `docker/docker-compose.yml` mounts `${NVR_MEDIA_SOURCE:-nvrdata}:/media/frigate`, and `:-` turns an unset or empty value into the OS-disk volume without an error. WARP-2099 added the only writer, `scripts/host/droplet-set-nvr-media.sh`, and `install-device-bridge.sh` installs it. Nothing calls it: not `setup.sh`, the device-bridge, the orchestrator or the dashboard. A person has to run it over SSH. Its guard compares the target's `st_dev` with `/`, which proves a different filesystem and not a different disk, so a path on `/data` passes. It does not check that the target is mounted, writable or encrypted, and it does not move any footage.
- **Detection exists and nothing acts on it.** WARP-1963 added `recordingsOnBootDisk()` and a warning on the cameras System page. The warning renders only inside the branch that lists cameras, so a box with none shows nothing.
- **Nothing sizes the recordings.** Retention defaults are 3, 30, 14, 14 and 14 days for continuous, motion, alerts, detections and snapshots (`camera-retention-defaults.ts`, agreed 2026-08-13). Frigate has no per-camera quota, and the nightly controller from WARP-1851 aims at a budget but cannot enforce one.

How we got here, oldest first:

- **WARP-232 (2026-07-06, #835).** `/data` got LUKS2 with Argon2id and a TPM-sealed unlock, and USB drives got a per-drive LUKS2 path. This is the scheme the bays now follow.
- **WARP-1851 (2026-08-10).** An allocation in gigabytes per camera (#1499) was reverted the same day (#1500). It predicted bytes from bitrate, and writing its result switched 24/7 recording on. The rebuild (#1501) measures instead of predicting, and it is a target, not a cap.
- **WARP-1956 (2026-08-13, the camera epic).** Stefan reported that "allocation of space is still super unclear" and asked for "a very clear nvr partition on the drives". The decision recorded on the epic: "name it and guard it, browse recordings as files, and give each camera an explicit slice of the drive. Not a physical repartition." Decision 6 below carries this forward.
- **WARP-1963 (2026-08-13, #1574).** It named the recordings drive and added the boot-disk detector. Its message records the first box where recordings went to the wrong disk: a 2 × 2 TB RAID1 sat empty for a month while `/` climbed to 94%, because three `/etc/fstab` entries pointed at UUIDs that no longer existed and each one carried `nofail`.
- **WARP-2136 (2026-08-22).** Backup and factory reset now follow `NVR_MEDIA_SOURCE` when it points at a host path, so a redirected box still backs up its footage and a reset still removes it.
- **WARP-2099 (2026-08-26, #1785).** `.env` always states `NVR_MEDIA_SOURCE`, and the writer above exists. It chose not to adopt a detected pool automatically: "moving footage is an explicit act".

On 2026-10-03 Stefan settled the direction: recordings leave the OS disk for the bays, the bays are always encrypted, and Droplet sizes and places the recordings itself. That reverses ADR-019 D2 and the WARP-2099 note for recordings, and it needs a hard limit, which nothing provides today.

## Decision

### 1. Owner decisions (Stefan, 2026-10-03)

These are fixed inputs. Every later section follows from them.

1. **Every data drive is encrypted at rest, always.** LUKS2 with TPM2 auto-unlock and a recovery key, the same scheme as `/data`: header tokens `systemd-tpm2` and `systemd-recovery`, and a crypttab entry with `tpm2-device=auto,luks,discard,nofail,headless=true`. A plain drive is `needs_preparing`. It is never used for an allocation and never wiped automatically.
2. **No RAID on this install.** Drives are used independently. Pools stay available, and they must be LUKS too, with the encryption layer on top of the md device.
3. **Camera recordings are never on the OS disk.**
4. **Retention defaults to 7 days** for continuous, motion, alerts, detections and snapshots. Today's defaults are 3, 30, 14, 14 and 14.
5. **Droplet measures, calculates and allocates on its own.** The default is an auto-sized slice with a size cap, and "whole drive" is always available. ADR-019 D2 is superseded for camera recordings only (§3). Destructive actions still need explicit owner confirmation: erasing or preparing a drive, and deleting old footage.
6. **The slice is an ext4 project quota, not a repartition**, consistent with the 2026-08-13 decision on WARP-1956.

Decision 3 is the target state, and the contract's states describe the way there. Until a drive is prepared, a box has no eligible drive and its recordings stay where they are today. The status `no_eligible_drive` and the `on_system_disk` warning say so (§6.2, §7). Once an allocation exists, the boot guard (§7) stops Frigate from writing to the OS disk, even when the drive is missing.

### 2. The slice is an ext4 project quota on `nvr/`

```
mkfs.ext4 -O quota,project …                                     # at Prepare (WARP-3513)
mount -o prjquota …                                              # at mount (WARP-3513)
chattr +P -p <DROPLET_NVR_PROJID> <mount>/nvr                    # WARP-3514
setquota -P <DROPLET_NVR_PROJID> 0 <limit in KiB> 0 0 <mount>    # WARP-3514
```

The project id is `DROPLET_NVR_PROJID`, 4096 by default. The soft limit is 0, so only the hard limit applies, and there is no inode limit. `nvr/` is bind-mounted into Frigate as `/media/frigate`, and the project covers nothing else.

The mechanism was spiked on the live box on 2026-10-03 (kernel 6.8.0-142, Frigate 0.17.1):

| Question | Result |
|---|---|
| Does Frigate see the slice as its disk? | Yes. `shutil.disk_usage()` through a bind mount of `nvr` reports the quota as the total (a 50 MiB cap read "50.0 MiB total"), so Frigate's own cleanup works inside the slice. |
| Do new subdirectories join it? | Yes. Subdirectories inherit the project id. |
| Can it be resized while recording? | Yes. Raising the limit with `setquota` takes effect live, with no remount and no Frigate restart. |
| Does the rest of the drive stay usable? | Yes. `<mount>/files`, outside the project, sees the whole filesystem. |
| Does the limit bind Frigate? | Yes. The container is unprivileged (CapEff `0xa80425fb`, no CAP_SYS_RESOURCE), so the kernel enforces the hard limit against it. |
| Does it bind root? | No. A writer with CAP_SYS_RESOURCE bypasses the limit, and the spike's root writer did. The migration `rsync` runs privileged, so it checks free space first (§6.3). |

The host has `chattr`. It does not have `setquota` or the `quota` tools. WARP-3514 adds the `quota` package to the host dependencies that `setup.sh` installs, or calls `quotactl` from Python. Either way it is repo-tracked and never installed by hand.

### 3. ADR-019 D2 is superseded for camera recordings only

ADR-019 D2 reads "Pools are owner-driven and OPTIONAL. Nothing is ever automatic." The tickets shorten it to "nothing auto-assigns storage". Decision 5 overrides it for one purpose, camera recordings.

**What changes.** The box chooses the recordings drive, creates and sizes the slice, grows it, and moves existing footage onto it, without an owner action per step. The owner is notified when it happens, can change the mode or the drive, and can always choose the whole drive. WARP-2099's "moving footage is an explicit act" is set aside on the same grounds.

**What does not change.**

- Nothing creates or formats a pool or a disk on its own. Only a drive the owner has already prepared (encrypted) is eligible. A plain drive is `needs_preparing`, and the allocator never touches it.
- Erasing or preparing a drive, and deleting old footage, are owner-confirmed (§8.5).
- The box still works with no pool and no eligible drive. The setup wizard's storage step stays skippable and creates nothing.
- `GET /api/storage/pools` still returns `[]` when no array exists.
- D1 (`mdadm`), D3 (explicit enums), D4 (the safety tiers, where Tier 2 is now used for the first time), D5 (the AI cannot write storage) and D6 and D6.1 (privileged work runs from a repo-tracked host script behind the spool and root apply unit) stand.

### 4. Interfaces

#### 4.1 Host layout

```
/mnt/droplet/<label>-<uuid8>/        # LUKS2 mapper → ext4 -O quota,project, mounted prjquota (WARP-3513)
├── files/                           # the ONLY path registered in Nextcloud (WARP-3513)
└── nvr/                             # 0700 root, chattr +P, project id DROPLET_NVR_PROJID (WARP-3514)
```

- The crypttab name is `droplet-bay-<luks-uuid8>`. Mount naming does not change: `<label>-<fs-uuid8>`.
- `nvr/` reaches Frigate through `NVR_MEDIA_SOURCE`. The container path stays `/media/frigate`, so Frigate's recordings database stays valid when footage moves (§6.3).
- Compose bind-mounts all of `/mnt/droplet` into the Nextcloud container as `/host`. `nvr/` stays out of its reach because it is not registered and because it is `0700 root` (§8.3).

#### 4.2 Drives and Prepare (WARP-3513)

Drive objects returned by `GET /api/storage/drives` gain four fields:

| Field | Values |
|---|---|
| `encryption` | `"luks2"`, `"none"` or `"unknown"` |
| `preparation` | `"prepared"` or `"needs_preparing"`. It is an explicit enum, and `needs_preparing` means a data drive without LUKS2. |
| `usage` | `{ role, reservedBytes }`, where `role` is `"recordings"`, `"files"` or `null`, and `reservedBytes` is a number or `null`. WARP-3514 fills `role: "recordings"`. |
| `isSystemDisk` | boolean |

Prepare is the existing "Erase & adopt" (`drive_adopt`) and pool format, which now always encrypt:

1. Wipe the device and create LUKS2 with the same cipher and PBKDF policy as `/data` (Argon2id today). For an md pool the LUKS layer sits on top of the md device.
2. Enroll a recovery key and a TPM2 keyslot, with the same PCR policy as `/data`. `/data` enrolls the recovery key first, so that an aborted enrollment never strands a container (WARP-2101), and the bay scheme is the same.
3. Add the crypttab entry `droplet-bay-<luks-uuid8>` with `tpm2-device=auto,luks,discard,nofail,headless=true` and a bounded device timeout.
4. Create ext4 with `-O quota,project` and mount it with `prjquota` at the usual `/mnt/droplet/<label>-<fs-uuid8>`. Add the filesystem UUID to `trusted.list`.
5. Create `files/` and register only that path in Nextcloud, replacing the drive-root registration (§8.3).

A plain drive that is already adopted is shown as `needs_preparing`. It is not wiped, and it is not eligible for an allocation.

Prepare requires a TPM2, as `/data` provisioning does: on a box without one it is refused with `409 tpm_required` and nothing is wiped.

A still-plain adopted drive keeps its existing drive-root Nextcloud registration until it is prepared, so nothing it holds is hidden; Prepare wipes it and replaces the registration with `files/` only.

The recovery key leaves the box once, through `POST /api/storage/drives/:id/recovery-key/reveal` (a `POST`, so it uses the existing confirmation handshake). It is owner only and sits behind a Tier-2 confirmation. The first call returns `200 { recoveryKey }` and every later call returns `410`. §8.2 has the custody rules.

#### 4.3 Bridge endpoints (WARP-3514)

The device-bridge gains the six routes below, next to `/host/box-name` and `/host/public-fqdn`, and they copy that pattern:

- Each request is authenticated with `X-Droplet-Auth`. The orchestrator reads `BRIDGE_AUTH_TOKEN` at each call.
- The request body is validated before anything runs.
- The work is done by a repo-tracked host script that `install-device-bridge.sh` installs and `factory-reset.sh` removes.
- Failures are reported honestly (401 without the token, 400 for a malformed request, 502 when the host script refuses) and never swallowed.

Two things differ from `box-name`. The timeout is at least 120 s, where `box-name` allows 30 s. And creating `nvr/`, setting the project id and quota, and migrating all need root, so they follow the pattern of ADR-019 D6.1: the bridge spools the request and starts a root oneshot that polkit lets the `droplet` user start, because the bridge itself is `User=droplet` under `ProtectSystem=strict` and `NoNewPrivileges`. These endpoints are not `STORAGE_OPS` and do not go through `/pools/command`. The tier gating is in the orchestrator routes (§4.4).

| Endpoint | Request | Effect |
|---|---|---|
| `GET /host/nvr-storage` | none | `{ source, kind, fsUuid, mountPath, physicalDisk, isSystemDisk, encrypted, mounted, rw, projectId, limitBytes, usedBytes, fsSizeBytes, fsFreeBytes }`. `source` is the effective `NVR_MEDIA_SOURCE`, and `kind` is `"volume"` or `"path"`. |
| `POST /host/nvr-storage` | `{ fsUuid, mode, limitBytes }`, where `mode` is `"reserved"` or `"full"` | Validates the target: not the OS disk, mounted, read-write, LUKS-backed. Creates `nvr/`, sets its quota and the `files/` reservation quota (§5), and records the target as pending. It does **not** write `NVR_MEDIA_SOURCE` and does not migrate: only the migration's flip step writes it (§6.3), so Frigate can never be recreated on an empty slice. |
| `POST /host/nvr-storage/resize` | `{ limitBytes }` | Changes the quota only. Frigate is not restarted. |
| `POST /host/nvr-storage/migrate` | `{ fsUuid }` | Starts the root oneshot described in §6.3. |
| `GET /host/nvr-storage/migrate` | none | `{ state, progressPct, bytesCopied, bytesTotal, startedAt, error? }`, where `state` is `"idle"`, `"running"`, `"done"` or `"failed"`. |
| `POST /host/nvr-storage/old/delete` | none | Deletes the previous source after a migration. The orchestrator gates it behind Tier 3. |

Notes:

- The OS disk is refused by resolving the target's physical-disk ancestry, not by comparing `st_dev` with `/`. That is the gap in `droplet-set-nvr-media.sh` today.
- The bridge says `reserved` where the orchestrator API and Prisma say `auto_reserved` and `AUTO_RESERVED`, so the orchestrator maps between them. In `full` mode the limit is the filesystem size.
- `.env` is written only through `_upsert_env_kv` in `scripts/lib/secrets.sh`. On this box `.env` is a regular file. On boxes where secrets were relocated to `/data` it is a symlink, and `_upsert_env_kv` handles both (WARP-2522).

#### 4.4 Orchestrator API and data model (WARP-3514, consumed by WARP-3515)

`GET /api/storage/recordings` returns:

```json
{
  "status": "active|pending|migrating|degraded|missing|no_eligible_drive|on_system_disk",
  "mode": "auto_reserved|full|null",
  "drive": { "fsUuid": "", "label": "", "model": "", "sizeBytes": 0, "encrypted": true, "mountPath": "" },
  "reservedBytes": 0, "usedBytes": 0, "freeBytes": 0, "needBytes": 0, "retentionDays": 7,
  "daysStored": 0,
  "cameras": [{ "name": "", "displayName": "", "mbPerHour": 0, "gbPerDay": 0, "needBytes": 0, "usedBytes": 0 }],
  "migration": { "state": "idle|running|done|failed", "progressPct": 0, "bytesCopied": 0, "bytesTotal": 0,
                 "startedAt": null, "error": null },
  "oldFootage": { "present": false, "bytes": 0, "location": "system_disk" },
  "warnings": [{ "code": "drive_missing|read_only|near_full|cannot_grow|on_system_disk|smart_failed|not_encrypted",
                 "message": "" }],
  "eligibleDrives": [{ "fsUuid": "", "label": "", "sizeBytes": 0, "freeBytes": 0, "encrypted": true }]
}
```

`needBytes` is the sizing total from §5, and each camera's `needBytes` is its share of it. `eligibleDrives` lists the drives that meet the eligibility rule in §5. §6.2 defines `status`, and §7 defines the warning codes.

| Route | Who | Behaviour |
|---|---|---|
| `GET /api/storage/recordings` | Owner and admin get the full payload. A family account gets a read-only subset or a 403, per the existing storage gating. | The payload above. |
| `PUT /api/storage/recordings` with `{ mode?, fsUuid? }`, where `mode` is `"auto_reserved"` or `"full"` | Owner and admin, with a Tier-2 confirmation | Changes the mode, the drive, or both. Answers `202`. |
| `POST /api/storage/recordings/old-footage/delete` | Owner, with a Tier-3 confirmation | Deletes the previous source through the bridge. Answers `202`. |

All three routes are role-gated and audited from the first commit.

Prisma, in the explicit-enum style of ADR-019 D3:

| Model or enum | Definition |
|---|---|
| `StorageAllocation` | `id`, `fsUuid` (unique), `role` (`StorageRole`), `mode` (`AllocationMode`), `reservedBytes` (BigInt), `status` (`AllocationStatus`), `createdAt`, `updatedAt` |
| `StorageRole` | `RECORDINGS` |
| `AllocationMode` | `AUTO_RESERVED`, `FULL` |
| `AllocationStatus` | `PENDING`, `MIGRATING`, `ACTIVE`, `DEGRADED`, `MISSING` |
| `CameraBitrateSample` | `camera`, `sampledAt`, `mbPerHour`. One row per camera per hour, kept for 14 days. |

The migration directory sorts after `20261003000000_warp_3474_remove_security_doors_modules`, and `check-schema-drift` passes.

### 5. Sizing and allocation

**Samples.** An hourly job records a `CameraBitrateSample` for each camera from Frigate's `/api/recordings/storage` `bandwidth` field, and keeps 14 days. Frigate reports that field in mebibytes per hour, so `mbPerHour` is in that unit, and byte sizes are derived from it once at the boundary, as `camera-storage.service.ts` does today.

**Formula.**

```
need(camera) = max( p95(mbPerHour over the last 72 h), latest mbPerHour ) × 24 × retentionDays × 1.25
               (+2% for snapshots and clips)
needTotal    = sum of need(camera), with a floor of 20 GiB
```

A camera with no history yet uses its first measurement × 1.5 as the rate.

Worked example, from the live camera at about 1,000 MB/h: 24,000 MB a day, 168,000 MB over 7 days, 210,000 MB with the 1.25 headroom, and about 214,000 MB with the 2%. That is roughly 210 GB, matching the estimate on the ticket.

**Why the 7-day windows matter here.** The rate term assumes the camera records around the clock, and the formula covers `retentionDays` of that. Frigate keeps a segment while any retention window still covers it, so a longer motion or alert window would outlive the estimate, and today's 30-day motion window would. With all five windows at 7 days, the formula stays an upper bound.

**Allocator.** An hourly job, scheduled with `scheduleCron` and never a `while True` loop, runs the allocator. It also runs after any drive is prepared.

1. If no allocation is `ACTIVE` and an eligible drive exists, create an `AUTO_RESERVED` allocation with `reservedBytes = needTotal`. Eligible means prepared and encrypted, healthy, not the OS disk. If several qualify, take the one with the most free space. Then call the bridge `POST /host/nvr-storage`, start the migration automatically, and notify the owner.
2. If `needTotal` is more than 85% of `reservedBytes`, grow the limit to `needTotal × 1.1`, bounded by the filesystem's free space. If the filesystem cannot cover it, set `DEGRADED` and notify.
3. Never set the limit below `used × 1.1`.
4. In `FULL` mode the limit is the filesystem size.

A new camera or a bitrate rise therefore grows the slice through step 2, and the rest of the drive stays free for files.

### 6. State machines

#### 6.1 `AllocationStatus`

| Status | Meaning |
|---|---|
| `PENDING` | The row exists and the allocation is decided, but Frigate is not yet writing to the slice. |
| `MIGRATING` | The migration oneshot is running. |
| `ACTIVE` | Frigate writes to `<mount>/nvr` and the quota is in force. |
| `DEGRADED` | The allocation exists on a present drive but cannot be kept at its needed size, because the filesystem has no room to grow it. |
| `MISSING` | The drive is absent, not mounted or locked. |

| From | To | Trigger | Basis |
|---|---|---|---|
| none | `PENDING` | The allocator or a `PUT` creates the row. | Contract |
| `PENDING` | `MIGRATING` | The bridge accepted `POST /host/nvr-storage` and the migration started. | Contract |
| `MIGRATING` | `ACTIVE` | The migration reports `done`. The source is flipped and Frigate runs on the slice. | Contract |
| `ACTIVE` | `ACTIVE` | Growth or a resize inside the bounds of §5. No status change. | Contract |
| `ACTIVE` | `DEGRADED` | Growth is needed (§5 step 2) and the filesystem cannot cover it. | Contract |
| `PENDING`, `MIGRATING`, `ACTIVE`, `DEGRADED` | `MISSING` | The recordings-health pass finds the drive absent, not mounted or locked. | Contract |
| `MIGRATING` | `PENDING` | The migration reports `failed`. The old source is still live and `migration.error` says why. | Implied |
| `DEGRADED` | `ACTIVE` | A later pass can grow the slice. | Implied |
| `MISSING` | `ACTIVE` or `DEGRADED` | The drive is back and mounted read-write, and the next pass re-evaluates it. | Implied |

"Contract" rows follow from the contract's states, mechanism and warnings. "Implied" rows are the return edges that the same states need. WARP-3514 owns the exact edges and may not add a state.

#### 6.2 API `status`

| Value | When |
|---|---|
| `active`, `pending`, `migrating`, `degraded`, `missing` | The allocation's `AllocationStatus`, lower-cased. |
| `no_eligible_drive` | There is no allocation and no drive meets the eligibility rule. |
| `on_system_disk` | Recordings are being written to the OS disk. |

The last two exist only in the API, because there is no allocation row to carry them. More than one value can hold at once, for example a `PENDING` allocation while footage is still on the OS disk. The contract does not rank them. WARP-3514 does, and the `warnings` list reports every condition either way.

#### 6.3 Migration

The migration is a root oneshot. `GET /host/nvr-storage/migrate` reports its state:

| State | Meaning |
|---|---|
| `idle` | No run has started. |
| `running` | The steps below are in progress. `progressPct`, `bytesCopied` and `bytesTotal` update. |
| `done` | The last run finished. The source is flipped and Frigate runs on the slice. |
| `failed` | The last run stopped. `error` says why, and the old source is untouched. |

A new `POST /host/nvr-storage/migrate` starts another run.

Steps:

1. **Preflight.** The target has room for the existing footage: space ≥ the old source's used bytes × 1.1. The privileged `rsync` ignores the quota, so this check is the only guard during the copy.
2. **Live copy.** `rsync` the old source into `nvr/`, path-preserving, while Frigate keeps recording.
3. **Stop Frigate.**
4. **Delta.** A second `rsync` for what was written during the live copy.
5. **Verify.**
6. **Flip** `NVR_MEDIA_SOURCE` to `<mount>/nvr`.
7. **Start Frigate** on the new source.

The copy is path-preserving, and the container path stays `/media/frigate`, so the rows in Frigate's recordings database stay valid. Frigate is down between steps 3 and 7, which is the only recording gap. The old source is kept after the flip. It is deleted only when the owner confirms, through `POST /api/storage/recordings/old-footage/delete`, and until then `oldFootage` reports `present: true` with `location: "system_disk"`. A failed run leaves the old source as the live source: if it fails after Frigate was stopped, the oneshot restarts Frigate on the old source before reporting `failed`. The orchestrator retries a failed migration automatically up to three times with backoff (1 h, 6 h, 24 h), then leaves the allocation `PENDING`, raises a warning and notifies the owner. The flip is the only writer of `NVR_MEDIA_SOURCE`; a box with no footage yet still goes through the same (trivial) migration, so there is one path.

### 7. Guards and alerts

**Guards (WARP-3514).**

- **Active drive.** Eject, adopt, reclaim and reformat of the drive that holds the active recordings allocation answer `409` with the reason. The check is in both the bridge and `routes/storage.ts`.
- **Target validation.** `POST /host/nvr-storage` refuses a target on the OS disk, or one that is not mounted, not read-write or not LUKS-backed (§4.3).
- **Boot guard.** Frigate must not start writing to the OS disk because a bay mounted late. The automount units are `After=docker.service`, so Docker and Frigate (`restart: always`) can come up before the bay does, and a short-syntax bind with a missing source makes Docker create that directory on the OS disk. WARP-3514 chooses one of two mechanisms from its scope: a compose bind with `create_host_path: false`, or an immutable unmounted mountpoint plus an automount hook that restarts Frigate once the bay is mounted. It proves the choice with a reboot test.

**Alerts.** An hourly recordings-health pass, scheduled with `scheduleCron`, raises one owner and admin notification per outage. It follows `backup-health.service.ts`: it records one `NotificationLog` row per outage, and the next outage after a recovery is announced again. The conditions that notify are: drive missing, read-only, recordings on the OS disk (even with zero cameras), near full, cannot grow, and SMART failed.

**Warning codes** in the `warnings` list:

| Code | Raised when |
|---|---|
| `drive_missing` | The allocation's drive is absent, not mounted or locked. |
| `read_only` | The drive is mounted read-only. |
| `near_full` | The slice is nearly full. The existing 0.85 ratio (`NEAR_FULL_RATIO`) now measures the slice, because the quota is the volume total Frigate reports. |
| `cannot_grow` | The slice needs to grow and the filesystem cannot cover it. |
| `on_system_disk` | Recordings are on the OS disk, even when no camera exists. |
| `smart_failed` | The drive reports a failed SMART health check. |
| `not_encrypted` | The recordings target is not LUKS-backed. |

### 8. Security

#### 8.1 At rest

Every data drive uses the `/data` scheme (decision 1 in §1): LUKS2, a TPM2 keyslot with a `systemd-tpm2` token bound to the shared PCR set, and a recovery keyslot with a `systemd-recovery` token. A bay that is missing or locked never blocks boot (`nofail`, `headless=true` and a bounded device timeout) and never queues a passphrase prompt on a box with no console (WARP-2100). The allocation shows `MISSING` instead. No key sits in a tracked file or in `.env`.

#### 8.2 Recovery key custody

- The key is retrieved once: owner only, behind a Tier-2 confirmation, `200 { recoveryKey }` the first time and `410` after that.
- The key never appears in a tracked file, `.env`, a log line or a database row. Tests and fixtures use made-up values, never real key material.
- The principle is the one `/data` uses: the key is shown once and the owner keeps it offline. For `/data` it is printed once on the provisioning console and never written to disk.
- Between Prepare and the owner's single reveal, the root Prepare oneshot holds the key in a root-only file (`0600`, directory `0700`) on `/data` — the TPM-sealed LUKS volume, never the unencrypted root filesystem. The reveal is served through the root spool pattern and shreds the file; an unrevealed key is shredded after 7 days. If the owner missed it, "Regenerate recovery key" (owner, Tier 3) enrolls a new recovery keyslot and wipes the old one, then holds the new key the same way.
- Prepare is refused without a TPM2 (`409 tpm_required`).

#### 8.3 Nextcloud scope

Only `<mount>/files` is registered, so it is the only part of a bay drive a Nextcloud user can browse. Existing registrations at the drive root are replaced (WARP-3513). `nvr/` is registered nowhere. It is also `0700 root`, which matters because the Nextcloud container sees all of `/mnt/droplet` as `/host`: it can see the directory, but its `www-data` user (uid 33) cannot read it. The contract changes the registered path, not the registration's user scope.

#### 8.4 The AI

ADR-019 D5 stands. The AI gets read access only: the existing read-only tool `get_camera_storage` (`requiresWrite: false`, `requiresConfirmation: false`) is extended with the allocation facts. No recordings or storage write operation becomes a tool. WARP-3514 adds the new operation names to the forbidden list in `packages/tools-core/__tests__/storage-pool-tools.test.ts`, and `evaluateStorageCommand` keeps refusing `source: "ai"`.

#### 8.5 Confirmations

Storage today has only Tier 3: `classifyStorageCommand` returns Tier 3 for every operation, known or not. ADR-019 D4 reserved a Tier-2 row ("owner-confirmed write") and this ADR is the first to use it. WARP-3513 and WARP-3514 extend `storage-safety-rules.ts` with the Tier-2 operations. An operation the code does not recognise stays Tier 3. The confirmation flow in `storage-safety.service.ts` is a single-use token that expires in 60 seconds and is bound to the operation and the resource, and both tiers use it.

| Action | Who | Gate |
|---|---|---|
| Prepare (erase and encrypt) a drive | The existing adopt and pool-format gate | Tier 3, naming the drive, plus the host pre-flight of ADR-019 D4.3 |
| Change the recordings mode or drive (`PUT`) | Owner and admin | Tier 2 |
| Retrieve a recovery key | Owner | Tier 2 |
| Delete old footage | Owner | Tier 3 |
| Automatic allocation, growth and migration | The orchestrator itself | No per-step confirmation. The owner is notified. |

#### 8.6 Privilege

Frigate stays unprivileged, and so does the bridge. Creating `nvr/`, setting the project id and quota, and migrating run as root from repo-tracked host scripts, following the pattern of ADR-019 D6.1 (§4.3). Nothing on a box is hand-placed, and no box script bypasses `setup.sh`.

## Consequences

**Easier**

- Recordings leave the OS disk. A full recordings slice cannot fill the disk the appliance runs on.
- The slice is a hard limit, so the rest of the drive stays free for files.
- A stolen or removed bay drive is unreadable without the box's TPM or the recovery key.
- Frigate's own cleanup keeps working. It sees the slice as its disk, and the sizing in §5 keeps it from running out of room.
- The owner does not choose sizes. Droplet measures, sizes and resizes live.

**Harder, and the risks**

- **Privileged writers bypass the quota.** Root with CAP_SYS_RESOURCE ignores the limit. Frigate is unprivileged, so it is bound. The migration `rsync` is privileged, so the preflight size check (§6.3) is what protects the slice.
- **Boot-order race.** The automount units run after Docker. Without the boot guard (§7), a late bay would send Frigate's writes to the OS disk, the exact failure WARP-1963 recorded. The guard has to be proven with a reboot test.
- **Migration downtime.** Frigate is stopped for the delta, verify and flip (§6.3). Cameras record nothing in that window. The old footage stays on the OS disk until the owner confirms its deletion, so the OS disk does not get its space back automatically.
- **A missing drive means no recording.** While the drive is missing, nothing records and the allocation shows `MISSING`. That is the price of decision 3, and the alerts (§7) are the mitigation.
- **No RAID, so a failing bay loses its footage.** Decision 2 means nothing mirrors the drive. SMART is the only early warning (`smart_failed`), and the footage on a dead drive is gone.
- **A slice is a cap, not a reservation — so `files/` gets one too.** A project quota alone limits `nvr/` without setting blocks aside. To make the slice a real reservation, `files/` carries its own project quota (id 4097) of filesystem size − recordings slice − 2 % slack, updated whenever the slice changes. In FULL mode the drive is dedicated to recordings: it is allowed only when `files/` is empty, and `files/` is then deregistered from Nextcloud. The bridge still reports `fsFreeBytes` as a backstop.
- **Hitting the cap shortens retention.** Frigate evicts oldest-first when under an hour of headroom remains (`camera-storage.service.ts` documents this), so a full slice means less retention, not a crash. Growth runs hourly, and the 1.25 headroom and the 85% trigger are the buffer between passes.
- **Locks follow the TPM.** A firmware or Secure Boot change that breaks the TPM seal locks the bays the way it locks `/data`. Recovery is the owner's recovery key, one per drive.
- **One more host dependency.** Setting limits needs the `quota` tools or `quotactl`, which the host does not have today (§2).
- **Backup and factory reset.** They already follow a host-path `NVR_MEDIA_SOURCE` (WARP-2136), so they follow the move to a bay. WARP-3513 makes factory reset remove the crypttab entries and keys it adds.

## Delivery

All three branches start from `origin/stage` and their PRs target `stage`. Each is built tests first, runs `./scripts/test/ship-check.sh` green before it is handed off, and keeps real key material out of code, tests, fixtures and commits.

| Ticket | Ships |
|---|---|
| [WARP-3513](https://warp-lab.atlassian.net/browse/WARP-3513), encryption | Prepare and pool format always encrypt (§4.2): LUKS2, TPM2, recovery key, crypttab, quota-capable ext4, `files/` as the only Nextcloud registration. The `encryption`, `preparation`, `usage` and `isSystemDisk` fields. The `needs_preparing` state. Boot and hot-plug unlock through crypttab and the existing automount path, with reconcile handling a late unlock. One-time recovery-key retrieval. Documents the bay scheme in `at-rest-encryption.md`. |
| [WARP-3514](https://warp-lab.atlassian.net/browse/WARP-3514), allocation backend | The hardened host writer and the bridge routes (§4.3). `StorageAllocation` and `CameraBitrateSample`. Sizing, the hourly allocator and the migration (§5, §6). `GET` and `PUT /api/storage/recordings` and the old-footage delete (§4.4). The guards and alerts (§7). The 7-day defaults. The `quota` tooling. The read-only extension of `get_camera_storage`. |
| [WARP-3515](https://warp-lab.atlassian.net/browse/WARP-3515), dashboard | The Storage panel states (encryption, usage badge, Prepare, one-time key display, blocked actions on the recordings drive). A "Recording storage" card on `/cameras/system` with the mode switch, usage bar, per-camera table and every status. The recording drive and per-camera need on camera settings. The boot-disk banner lifted out of the cameras-present branch. An optional wizard suggestion that is never applied silently. Documents the endpoints in `docs/mobile-api-contract.md`. |

Order: WARP-3513 merges first, because it produces the encrypted, quota-capable filesystems that WARP-3514 allocates on. WARP-3515 is built against mocks of both contracts, as its ticket says, and merges after them.

## Where today's code differs from this ADR

Verified 2026-10-03 on `stage` at `7209ae868`.

| Today | This ADR |
|---|---|
| Frigate records to `droplet_nvrdata` under `/data` on the OS NVMe. | Recordings go to `<mount>/nvr` on an encrypted bay drive. |
| Adopt, reclaim and pool format make plain ext4. | LUKS2 first, then ext4 `-O quota,project` mounted `prjquota`. A plain drive is `needs_preparing`. |
| Nextcloud registers the drive root, household-wide. | Only `<mount>/files` is registered. |
| `droplet-set-nvr-media.sh` compares `st_dev` with `/`, has no callers, checks nothing about mount, write access or encryption, and moves nothing. | The bridge endpoints validate by physical-disk ancestry, mount, write access and LUKS, and a root oneshot migrates. |
| `classifyStorageCommand` returns Tier 3 for every storage operation, and the code says "there is no Tier-1 or Tier-2 storage write". | The first Tier-2 operations arrive (`PUT` recordings and the recovery key). An unknown operation is still Tier 3. |
| The `/data` recovery key is printed once at provisioning, with no API. | A bay recovery key is retrieved once through the API. |
| Retention defaults are 3, 30, 14, 14 and 14 days. | 7 days for all five. |
| The automount units run `After=docker.service`. | A boot guard keeps Frigate off the OS disk when a bay mounts late. |
| `recordingsOnBootDisk()` infers "on the OS disk" from equal total and free bytes on two mounts, and its warning needs cameras. | The bridge reports `physicalDisk` and `isSystemDisk`, and `on_system_disk` is raised with zero cameras. |
| The volume total Frigate reports is the filesystem. | It is the quota, so the existing near-full ratio measures the slice. |
| Drive objects carry no encryption or usage state. | `encryption`, `preparation`, `usage` and `isSystemDisk`. |

## Decided after review (2026-10-04)

These were open in the first draft; they are now part of the decision.

- **Recovery key holding place:** root-only `0600` file on `/data` (encrypted), consumed by the single reveal, shredded after 7 days if unrevealed; "Regenerate recovery key" (owner, Tier 3) re-enrolls (§8.2). The reveal is `POST /api/storage/drives/:id/recovery-key/reveal` so it uses the existing `evalAndRespond` → `POST /api/storage/command/confirm` handshake (§4.2).
- **No TPM:** Prepare is refused with `409 tpm_required`, as `/data` provisioning is.
- **`NVR_MEDIA_SOURCE` order:** `POST /host/nvr-storage` prepares the target only; the migration's flip (after delta + verify, Frigate stopped) is the only writer (§4.3, §6.3).
- **API status precedence** when several hold: `missing` > `migrating` > `degraded` > `on_system_disk` > `pending` > `active` > `no_eligible_drive`. `read_only` and `smart_failed` map to `DEGRADED` with the matching warning; Droplet does not move recordings off a failing drive by itself — the owner is notified and can `PUT` another drive.
- **Failed migration:** rollback to the old source, automatic retries at 1 h / 6 h / 24 h, then `PENDING` + warning + owner notification (§6.3). **Moving to another drive (`PUT`):** a new `StorageAllocation` row is created `PENDING` and migrated; on success the previous row is deleted and its `nvr/` becomes old footage awaiting the owner's Tier-3 deletion.
- **`usage.role`:** `"recordings"` when the drive hosts the `ACTIVE` or `MIGRATING` allocation; otherwise `"files"` when it has a `files/` Nextcloud registration; otherwise `null`.
- **Existing cameras and 7 days:** a one-time, idempotent pass sets continuous / motion / alerts / detections / snapshots to 7 days for every camera whose windows are still the previous defaults (3 / 30 / 14 / 14 / 14) or missing. Cameras an operator customised are left alone and listed in the activity log.
- **Plain drives and Nextcloud:** a still-plain drive keeps its drive-root registration until it is prepared (§4.2).
- **Roles:** `GET /api/storage/recordings` and the recordings writes are owner and admin only; family accounts get `403`, aligned with the storage-route role gating (WARP-3465).
- **Reservation:** `files/` carries a project quota so files cannot consume the recordings slice; FULL mode requires an empty `files/` (risks, Consequences).

## Alternatives considered

| Option | Why not |
|---|---|
| Keep recordings on `/data` on the OS NVMe | Decision 3 forbids it. |
| A physical partition or logical volume for recordings | The 2026-08-13 decision on WARP-1956 says "Not a physical repartition" (decision 6). A quota raise is live (§2), and a partition would have to be resized to follow the cameras. |
| Whole drive only | Decision 5 makes the capped slice the default so the rest of the drive stays free for files. Whole drive stays available as `FULL`. |
| The owner types a size per camera, or a soft per-camera target | WARP-1851 tried gigabytes per camera and reverted it (#1499, #1500), and Frigate has no per-camera quota. The soft controller that replaced it (#1501) cannot cap. |
| Software RAID for recordings | Decision 2: no RAID on this install. |
| Keep ADR-019 D2 as written (manual placement) | Decision 5 overrides it for recordings (§3). |
| Leave the bays plain and encrypt only the recordings | Decision 1 encrypts every data drive, so a stolen bay never exposes files either. |
