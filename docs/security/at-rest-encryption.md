# At-rest encryption (WARP-232)

LUKS2 + Argon2id full-disk encryption for the appliance's data surfaces, with
unlock keys sealed to the TPM2 and bound to the boot-measurement PCRs. This
doc covers the on-disk layout, the boot flow, PCR-mismatch recovery, and the
USB enrollment flow.

> Hardware verification (real Vault TPM/UEFI) is tracked separately as
> **WARP-966** — see the "Hardware Test (deferred)" section of the
> implementation plan. Everything below is software-complete and exercised by
> hermetic, TPM-less tests (`tests/luks2-data-partition.test.sh`,
> `tests/usb-luks-enroll.test.sh`, `services/oled-display/tests/test_automount_script.py`).

## Layout

```
disk (GPT)
├─ ESP (fat32, 1G)                       plain — firmware needs it
├─ /boot (ext4, 2G)                      plain — kernel + initramfs
└─ LVM PV (rest of disk)  →  VG ubuntu-vg
   ├─ ubuntu-lv (ext4, 64G)              root — PLAIN (bounded so the VG keeps
   │                                     free extents; see below)
   └─ droplet-data (LUKS2/Argon2id)      ENCRYPTED data LV, created on FIRST
      └─ /dev/mapper/droplet-data-crypt  BOOT by droplet-luks-provision.sh
         └─ /data (ext4)                 mount point

/data/docker            docker data-root (Postgres, Nextcloud data,
                        file-indexer/brain pgvector — every named volume)
/data/droplet/env/.env  .env (symlinked from <repo>/.env)
/data/droplet/secrets   data/secrets (symlinked from <repo>/data/secrets)

USB drives              per-drive LUKS2/Argon2id, TPM keyslot in each drive's
                        own header token + an HKDF-derived recovery slot
```

**Why a build-time split.** The autoinstall storage layout
(`scripts/image/autoinstall/user-data`) bounds the root LV to 64G so the VG
keeps free extents. An ext4 root cannot shrink online, so a whole-disk root LV
could never be carved at first boot — the bound is what lets
`droplet-luks-provision.sh` create the encrypted data LV during
`setup.sh` Phase 1.5. The data LV is deliberately NOT declared in the
autoinstall config: `setup.sh` owns it (ADR-020 §D1, single provisioning
source of truth).

## Coverage table

| Surface | Encrypted home |
|---|---|
| Postgres data dir | docker volume under `/data/docker` (LUKS data LV) |
| Nextcloud data dir | docker volume under `/data/docker` |
| Redis `cache` AOF (session records, refresh denylist, lockout counters, **Nextcloud app-passwords in plaintext**, WARP-1401) | docker volume `cache-data` under `/data/docker`; wiped by factory reset, never backed up |
| file-indexer / brain pgvector | docker volume under `/data/docker` |
| Brain chunk text (chat attachments) | **column-level** AES-256-GCM under per-document DEKs (WARP-242, below) — on top of the LUKS layer |
| Nextcloud-derived chunk text (`FileContentChunk`, `source='nextcloud'`) | **disk encryption only** (LUKS data LV, restic repo key). No column encryption; see the scope decision below |
| Mailbox content (`EmailMessage.bodyText` / `bodyHtml`, `EmailAttachment.data`, `EmailDraft`) | **disk encryption only** (LUKS data LV, restic repo key). No column encryption and no per-mailbox key, so disconnecting a mailbox deletes the rows but is not a crypto-shred (WARP-3622) |
| Mailbox credentials (`EmailAccount.passwordEnc`) | column-level AES-256-GCM (`encryptSecret`) — on top of the LUKS layer |
| Persisted AI chats, notes, calendar events and reminders | **disk encryption only** (LUKS data LV, restic repo key). Calendar source credentials are stored encrypted |
| `.env` (carries `DEVICE_SECRET_KEY`) | `/data/droplet/env/.env` (symlinked) |
| `data/secrets` (audit signing key, doc-KEK keyfile) | `/data/droplet/secrets` (symlinked) |
| Hot-plugged USB drives | per-drive LUKS2 under `/mnt/droplet/<usb>` |
| Bay drives + storage pools (every drive prepared through the dashboard) | per-drive LUKS2 (over md for pools) under `/mnt/droplet/<label>-<fs-uuid8>`; Nextcloud sees only `files/` (WARP-3513) |
| LUKS recovery keys of bay drives (until the owner retrieves them, at most 7 days) | root-only escrow in `/data/droplet/secrets/bay-recovery/` — encrypted `/data` only; never the unencrypted OS disk, DB, `.env`, or logs |
| Backups | restic repo, per-customer key = HKDF(`DEVICE_SECRET_KEY`) (WARP-254). **Default location is a local path on the same box** (`DROPLET_BACKUP_TARGET`, default `/var/lib/droplet/restic-repo`), so it is a restore point, not off-box protection; off-device targets are planned. Retention is 7 daily, 4 weekly and 6 monthly snapshots. |

Any table not listed above that holds customer content (mail, chats, notes,
file text) is protected by the LUKS layer and the encrypted backup repository
only. Column-level encryption covers brain chunks, credentials and the user
email address. Whether mailbox content should gain a per-mailbox key (shredded
on disconnect, decrypt-on-read in search) is an open decision on WARP-3622.

The `.env` relocation is what makes the AC "disk removed + mounted elsewhere
yields no readable data" hold for the *derivation inputs*: `DEVICE_SECRET_KEY`
derives the restic repo password and the USB per-drive recovery slots, so it
must not sit on the plain root.

The relocation `shred -u`s the plaintext `.env`/`data/secrets` originals on the
unencrypted root before symlinking, so a disk-pull carve of the root filesystem
finds no lingering copy. **Residual-free-space caveat:** `shred` overwrites the
file's *current* blocks but cannot reach blocks the filesystem already freed
from an earlier copy of the same file, and it is a no-op against copy-on-write /
log-structured filesystems (the appliance root is ext4, where it is effective).
For a guaranteed-clean decommission use crypto-shred (destroy the LUKS/TPM keys)
rather than relying on free-space overwrite — see `docs/security/crypto-shred.md`.

## Per-document chunk encryption + crypto-shred (WARP-242)

Brain-memory chunks (chat-attachment content, `FileContentChunk` rows with
`source='brain'`) are additionally encrypted at the **column** level so a
single document can be made unrecoverable without touching the rest of the
corpus — the GDPR right-to-delete / HIPAA-disposal path.

**Key hierarchy.**

```
data/secrets/doc-kek.key   raw 32 bytes, minted by setup.sh, mode 0600,
   │                       EXCLUDED from restic backups (droplet-backup.sh)
   └─ HKDF(info="doc-kek") → doc-KEK
        └─ wraps per-document DEKs (AAD = keyId), one per brain item,
           minted by the file-indexer at first chunk-write and stored in
           DocumentEncryptionKey keyed (keyId, version); keyId = brain:<itemId>
             └─ AES-256-GCM encrypts each chunk's `text` (dcv1 blob,
                AAD = keyId); decrypt-on-read in the orchestrator/mcp-server
                before results reach the LLM context or dashboard
```

**Why the KEK is a dedicated keyfile, not `DEVICE_SECRET_KEY`:** `.env`
travels inside every restic snapshot, so a KEK derived from it would make
each snapshot self-decrypting — deleting a DEK would delete nothing an
attacker (or an operator restore) couldn't recover. With the keyfile excluded
from the backup set, snapshots carry ciphertext chunks + *wrapped* DEKs and
no way to unwrap them off-box.

**Deleting a document** (`DELETE /api/files/brain/:itemId`, and the per-user
purge on user-delete) deletes its chunks, its on-disk originals, **and every
version of its DEK**. After that:

- Live DB: nothing left.
- Off-box / exfiltrated snapshots: ciphertext that can never be decrypted
  (no KEK anywhere in the repo). This is the crypto-shred guarantee.
- **On-box restore window:** a snapshot restored onto the SAME box (KEK still
  on disk) can resurrect documents deleted after that snapshot was taken,
  until retention (`restic forget --prune`) ages the snapshot out. Bounded,
  documented, and the standard GDPR posture for backup media.
- **Restore to NEW hardware:** everything except brain chunks recovers; brain
  chunks are permanently unreadable (the keyfile never left the old box).
  This is the deliberate trade-off for the shred guarantee.

**Scope decision (owner-ratified via the WARP-242 audit):** Nextcloud-sourced
chunks stay plaintext-in-Postgres (inside LUKS). Their source files ship in
the same snapshots via the `nextcloud-data` volume tar, so chunk-level shred
could never deliver right-to-delete for them — deleting a Nextcloud file
already deletes its chunks (`delete_chunks_for_file`), and its recoverability
window is governed by backup retention, same as the file itself: such data
stays in restic snapshots until the last snapshot containing it ages out of
the 7 daily / 4 weekly / 6 monthly retention, up to about six months. Showing
this window in the delete and offboarding flows is planned (WARP-3663). Brain
content is different: its ONLY backup copy is the pg_dump, so per-document
shred is real there. Full lexical (BM25) search is preserved for the
Nextcloud corpus; encrypted brain chunks are vector-search-only (their
generated `text_tsv` is NULL — a plaintext-derived tsvector would leak a
stemmed bag-of-words into every dump).

**Known boundary:** the per-item `extracted.txt` side file (plaintext, on the
LUKS-encrypted brain-memory volume, deleted with the item, never in restic)
is disk-level-protected only. TPM-sealing the doc-KEK keyfile is WARP-1033;
scheduled DEK rotation (version N+1 + background re-encrypt) is a follow-up
slice — the schema is already keyed `(keyId, version)` for it.

## Boot flow

1. systemd's `systemd-cryptsetup@droplet\x2ddata\x2dcrypt` reads
   `/etc/crypttab`: `droplet-data-crypt <dev> none tpm2-device=auto,luks,discard`.
2. The TPM unseals the LUKS key **iff** PCRs 0+2+4+7 match the sealing state
   (firmware, option-ROM code, boot manager, SecureBoot). `/data` mounts.
3. A docker drop-in
   (`/etc/systemd/system/docker.service.d/droplet-data.conf`) declares
   `RequiresMountsFor=/data`. If `/data` is absent (PCR mismatch → unlock
   failed), **docker refuses to start** and every data-bearing container stays
   down — the appliance "falls to recovery" instead of booting with plaintext
   or empty volumes.

## PCR-mismatch recovery (AC: "mismatched PCR fails to unlock, falls to recovery")

A changed boot chain (firmware update, Secure Boot toggle) changes the PCRs, so
the TPM refuses to release the key. The box lands in a degraded state with
`docker.service` inactive.

1. Confirm the cause is an intended boot-chain change:
   ```
   systemctl status systemd-cryptsetup@droplet\x2ddata\x2dcrypt docker
   journalctl -b -u systemd-cryptsetup@droplet\x2ddata\x2dcrypt
   ```
   An **unexplained** mismatch is potential boot-chain tampering — capture the
   journal and investigate before unlocking.
2. Unlock once with the OFFLINE recovery key (delivered to the owner once at
   provision time; see "Recovery key delivery" below):
   ```
   sudo cryptsetup open /dev/ubuntu-vg/droplet-data droplet-data-crypt
   # paste the recovery key when prompted
   sudo mount /dev/mapper/droplet-data-crypt /data
   ```
3. Re-enroll the TPM slot against the *current* PCRs:
   ```
   sudo systemd-cryptenroll --wipe-slot=tpm2 --tpm2-device=auto \
     --tpm2-pcrs=0+2+4+7 /dev/ubuntu-vg/droplet-data
   ```
4. Reboot → clean TPM unlock, docker starts.

## Recovery key delivery and rotation (WARP-3572)

The recovery key is the only way back in after a TPM failure, so it must reach
the owner exactly once, and it must never sit in a log. The root filesystem is
not encrypted, so anything written to the journal, `.data/setup.log` or a
support bundle is readable by someone holding the disk.

- **Interactive console** (a person is running `droplet-luks-provision.sh` on a
  terminal): the key is printed to that terminal and nothing else.
- **Unattended install** (`droplet-firstboot.service`, stdout is not a terminal):
  the key is never printed. It is staged root-only (file `0400`, directory
  `0700`) at `/run/droplet/recovery/recovery-key.pending`, then moved onto the
  encrypted volume at `/data/droplet/recovery/recovery-key.pending` once `/data`
  is mounted, so it survives the post-install reboot. The log line says only
  where it is staged.
- **Retrieval:** on a console or SSH session, `sudo droplet-luks-provision.sh
  show-recovery-key` shows the key and asks the owner to type `stored` after
  recording it offline. Only then is the staged file shredded and
  `/var/lib/droplet/recovery-key-acknowledged` (a timestamp) written. The command
  refuses to run when stdin or stdout is not a terminal.
- **Redaction (defence in depth only; the primary control is that the key never
  reaches an unattended service's output):** a recovery-key line (64 modhex
  characters from `cbdefghijklnrtuv`, as eight dash-separated groups of eight,
  dash-less or upper case also matched) is scrubbed from support bundles by both
  `scripts/host/droplet-collect-logs.sh` and
  `apps/orchestrator/src/lib/log-redaction.ts`.

Limits to know: until the owner runs `show-recovery-key`, the key exists only on
the encrypted volume, so a TPM failure before pickup leaves it unreadable. The
setup wizard and front panel do not yet read the staged file or surface the
acknowledgement (tracked as a product decision on WARP-3572).

### Rotating recovery keys on boxes already in the field

Boxes provisioned before this change may have the old key in the journal of the
provisioning boot. On each such box, as root, with the data volume unlocked:

```
journalctl --rotate && journalctl --vacuum-time=1s        # drop archived provisioning-boot journals
shred -u /home/droplet/edge-platform/.data/setup.log 2>/dev/null || true
umask 077
systemd-cryptenroll --unlock-tpm2-device=auto --wipe-slot=recovery /dev/ubuntu-vg/droplet-data
systemd-cryptenroll --unlock-tpm2-device=auto --recovery-key /dev/ubuntu-vg/droplet-data > /run/droplet/new-key
# record it offline from a terminal, then:
shred -u /run/droplet/new-key
```

`--wipe-slot=recovery` invalidates the old key, so the old journal copy no
longer unlocks anything. Run the enroll from an interactive shell and write the
output to a `0600` file under `/run/droplet`, never to a service's stdout. If
the journal is persistent (`/var/log/journal` exists), also vacuum it as above;
the plain filesystem can still hold deleted journal blocks, so wiping the slot
is the control that matters.

## Bay drives — always encrypted (WARP-3513)

Owner decision (storage contract, ADR-070): **every data/bay drive is encrypted
at rest, always.** Every drive the owner prepares from the dashboard ("Erase &
adopt", reclaiming a pool member) and every storage pool the box formats goes
through `scripts/host/droplet-storage-pool.sh` (root, via
`droplet-storage-pool-apply.service`, ADR-019 D6.1) and comes out like this —
there is no plain option:

```
whole disk (no partition table)   or   md array (a pool)
└─ LUKS2/Argon2id container            tokens: systemd-tpm2 + systemd-recovery
   └─ /dev/mapper/droplet-bay-<luks-uuid8>
      └─ ext4 -O quota,project         mounted rw,nosuid,nodev,noatime,prjquota
         │                             at /mnt/droplet/<label>-<fs-uuid8>
         ├─ files/                     the ONLY folder registered in Nextcloud (project id 4097)
         └─ nvr/                       camera-recordings slice (WARP-3514, project id 4096) — never exposed
```

It is the same scheme as `/data`: the tool seams, the cipher/PBKDF policy
(`--type luks2 --pbkdf argon2id`) and the PCR set (`0+2+4+7`) come from
`droplet-tpm-lib.sh` / `droplet-luks-provision.sh`, so the two cannot drift.
`-O quota,project` + `prjquota` exist because the recordings slice is an ext4
**project quota**, never a repartition: `files/` is created with project id
**4097** (`chattr +P -p 4097`, inherited by everything created inside) so WARP-3514
can give it — and `nvr/`, id 4096 — their own byte limits. Every place that mounts
a bay (Prepare, the hot-plug `droplet-automount.sh`, the boot reconcile, the
crypttab path at reboot) mounts it `prjquota`; the automount path checks the
filesystem's `project` feature first and retries once without `prjquota` (with a
warning) rather than leave a drive unmounted.

**Prepare requires a TPM2 — there is no override.** An encrypted drive that is not
TPM-sealed would not unlock itself at boot, and the owner decided Prepare needs
one. Two machine-readable refusals happen **before anything is erased or changed**
(`409`, with a fixed owner-facing sentence — the script's own words are never
relayed):

| `code` | When | Host exit code |
|---|---|---|
| `tpm_required` | no TPM2 device, or the tss2 userspace `systemd-cryptenroll` needs is unusable (the WARP-2101 class) | 75 |
| `encrypted_data_required` | `/data` is not on an encrypted volume, so a recovery key could not be held safely | 76 |

(The bridge turns the script's **exit code**, never a substring of its message,
into the `code`.)

**Prepare order** (and why):

1. Refuse **before erasing anything** (above).
2. Managed teardown: unmount, close any old `droplet-bay-*` mapper, drop that
   container's stale crypttab line and recovery escrow, deregister the replaced
   drive from Nextcloud, wipe. Closing every mapper happens before the first wipe,
   so a refusal part-way through a pool cannot half-erase it.
3. `luksFormat` with a temporary key that lives only on tmpfs (`/run/droplet`),
   then the **recovery keyslot first**, then the TPM2 keyslot, then the temporary
   keyslot is removed and its file shredded. If any later prepare step fails,
   cleanup closes the mapper, crypto-erases the new LUKS keyslots, and removes
   the LUKS signature; it does not leave a partial container with an inaccessible
   recovery key.
4. `mkfs.ext4 -I 256 -O quota,project` **inside** the container; the recovery key
   is escrowed (below); the crypttab line is written; the filesystem is mounted
   `prjquota` at the same `<label>-<fs-uuid8>` tail `droplet-automount.sh`
   derives on reboot; `files/` is created (uid 33 = Nextcloud, `0770`, project id
   4097 — a failure to set it is fatal, the drive is reported *not prepared*);
   trusted.list is seeded; Nextcloud is registered at `<mount>/files` **only**.

A failure at any step undoes what was done (mapper closed, crypttab line and
escrow removed, key file shredded) — no half-built bay is left behind. The helper
prints exactly one JSON line on stdout (all tool noise goes to stderr), because
the bridge parses it.

**Boot and hot-plug.** The crypttab line is the same shape as `/data`'s:

```
droplet-bay-<luks8> UUID=<luks-uuid> none tpm2-device=auto,luks,discard,nofail,headless=true,x-systemd.device-timeout=30s
```

`systemd-cryptsetup` unlocks bays at boot (before docker). `nofail` +
`headless=true` + the 30 s device timeout mean a PCR mismatch or a missing bay
is simply *absent*: it never blocks boot and never queues an ask-password
prompt on a box with no console operator. `droplet-automount.sh` recognises a
LUKS container with a `droplet-bay-*` crypttab line as a bay: it reuses the
already-unlocked mapper (or does one bounded, non-interactive TPM attach for a
hot-plugged / late bay), mounts it `prjquota`, and never `chown -R`s it. The boot
reconcile retries bays that unlocked late.

**Recovery-key custody.** `/data`'s recovery key is printed once on the
provisioning console and never written to disk. A bay is prepared from the
dashboard, where nobody is at a console, so the key waits in a **root-only
escrow** until the owner retrieves it — the only deliberate deviation from
`/data`:

- generated by `systemd-cryptenroll --recovery-key` (token `systemd-recovery`);
  held in a shell variable, then written `0600` into a `0700` directory:
  `/data/droplet/secrets/bay-recovery/` — **on the LUKS-encrypted `/data` only**,
  so a stolen OS disk reveals no pending key. Prepare refuses
  (`encrypted_data_required`) on a box where `/data` is not encrypted; the key is
  never held on the unencrypted root filesystem. File `<luks-uuid>__<fs-uuid>.key`;
- never on a command line, in a log, in the result of any other operation, in the
  database, in `.env` or in a tracked file; the root executor captures its
  output on tmpfs (`/run`), not the unencrypted `/tmp`;
- retrieved **once**, by the **owner only** (not an admin), through the existing
  destructive-op handshake — a tier-2 confirmation, so a stray, replayed or
  prefetched request can never spend the one retrieval. There is no GET:

  ```
  POST /api/storage/drives/<fs-uuid>/recovery-key/reveal
         -> 202 {status:"confirmation_required", tier:2, confirmationToken, expiresIn:60}
  POST /api/storage/command/confirm {confirmationToken}
         -> 200 {recoveryKey}              first time only, Cache-Control: no-store
         -> 410 recovery_key_already_retrieved
         -> 410 recovery_key_expired       left unrevealed for 7 days (regenerate)
         -> 404 recovery_key_not_found     no escrowed key for that drive
  ```

  Retrieval atomically claims a `.retrieved` tombstone (no secret) before
  shredding the escrowed key, so two racing requests yield the key to exactly
  one. The marker makes every later request `410 Gone`, including after a crash
  between the claim and key removal. The confirm token is single-use, bound to
  the operation, the drive and the user, and valid for 60 seconds. A response
  that is lost in transit has still spent the retrieval — **regenerate** is the
  way back;
- an unretrieved key lives **7 days**: after that it is shredded (a
  `.expired` tombstone remains) by the next reveal request or by
  `droplet-bay-recovery-expiry.timer` (daily, root,
  `droplet-storage-pool.sh recovery_key_expire`; the unit skips cleanly while no
  drive has been prepared). **After the owner has retrieved it — or it has
  expired — the box keeps no copy.** It is also dropped when the drive is
  prepared again, its pool is destroyed, or the box is factory-reset;
- **Regenerate recovery key** — `POST …/recovery-key/regenerate` (owner only,
  tier 3, the same confirm handshake). For an owner who missed, lost or let the
  7-day window pass: the host enrols a **new** recovery keyslot, escrows the new
  key and wipes the old keyslot, so the key the owner holds stops working. The
  reply carries **no** key (`{recoveryKeyPending: true}`); the owner fetches the
  new one through the one-time reveal. Refusals: `404` unknown drive, `409
  drive_not_present` (not plugged in), `409 tpm_required` /
  `encrypted_data_required`, `422` with the host's actionable message (for
  example "… run Regenerate again to retry" when the old keyslot could not be
  wiped). The unlock for this operation is the TPM, so it works only while the
  drive unlocks normally;
- the AI can reach none of these: the operations are not in tools-core, and the
  safety service hard-blocks every storage operation from the AI source.

**PCR-mismatch recovery for a bay** (same story as `/data`, per drive):

```
sudo cryptsetup open /dev/sdX droplet-bay-<luks8>        # paste the recovery key
sudo systemctl restart droplet-automount-reconcile.service   # mounts + registers it
sudo systemd-cryptenroll --wipe-slot=tpm2 --tpm2-device=auto \
  --tpm2-pcrs=0+2+4+7 /dev/sdX                           # re-seal to the current PCRs
```

**Drives adopted before WARP-3513** are plain ext4. They are reported
`encryption: "none"` / `preparation: "needs_preparing"`, are never eligible for
the recordings slice and are **never wiped automatically** — the owner prepares
them (erase + encrypt) deliberately. A still-plain drive **keeps its drive-root
Nextcloud registration until it is prepared**; there is no migration and nothing
is re-pointed. Preparing wipes the drive, deregisters the old registration and
registers `files/` only.

**Factory reset** closes every bay mapper, crypto-erases each LUKS container
(`luksErase` — `wipefs` alone only removes the magic bytes and leaves the
keyslots), removes the `droplet-bay-*` crypttab lines and the escrow, and removes
the expiry timer.

**Dependencies.** The `quota` package (`setquota`/`repquota`, used by WARP-3514)
is provisioned best-effort by `scripts/install-device-bridge.sh`, which also
installs `droplet-tpm-lib.sh` next to the pool script and enables the expiry
timer.


## USB enrollment flow (AC: "USB enrollment flow documented")

1. Plug a drive in. `droplet-automount.sh` classifies it:
   - **droplet-enrolled LUKS2** (has a `systemd-tpm2` header token) → unlocked
     via `systemd-cryptsetup attach` (TPM keyslot) and mounted **rw**.
   - **foreign LUKS** (no token, no derivable slot) → skipped cleanly.
   - **plain filesystem** → mounted **read-only, untrusted** (the dashboard
     shows `untrusted-ro`); it will not accept writes until you encrypt or
     trust it.
2. To encrypt-and-format a plain drive (DESTRUCTIVE):
   ```
   sudo droplet-usb-enroll.sh enroll /dev/sdX1     # or --force to skip the prompt
   ```
   This wipes the drive, formats LUKS2/Argon2id, enrolls a TPM keyslot
   (`--tpm2-pcrs=0+2+4+7`) into the drive's own header, and adds a per-drive
   recovery passphrase derived from `DEVICE_SECRET_KEY`.
3. To keep a plain drive plain but writable:
   ```
   sudo droplet-usb-enroll.sh trust <fs-uuid>      # appends to trusted.list → rw
   ```
4. Enrolled drives auto-unlock on every future plug-in. Recover on-box with:
   ```
   sudo droplet-usb-enroll.sh derive <luks-uuid>   # prints the recovery passphrase
   ```
   A drive enrolled here still opens on ITS OWN box after TPM loss (passphrase
   re-derivable from `.env`); plugged into a foreign box it is unreadable
   LUKS2.

**UI note:** there is no encrypt/trust UI on `main` today. The natural
touchpoint is the device-bridge `/drives` surface (`services/oled-display`,
pool_ops pattern), tracked as a follow-up. The CLI + this runbook are the
enrollment flow WARP-232 ships.

## Recovery passphrase derivation (stability contract)

```
PRK        = HMAC-SHA256(salt = "droplet-usb-luks-v1", IKM = DEVICE_SECRET_KEY)
passphrase = lowercase-hex( HMAC-SHA256(PRK, "droplet-usb-luks-recovery:" || <luks-uuid> || 0x01) )
```

Single-block HKDF-SHA256, the same construction `droplet-backup-lib.sh` pins
for restic — but with a **disjoint versioned salt** (`droplet-usb-luks-v1` vs
restic's `droplet-restic-v1`), each with its own known-answer test. Changing
this derivation bricks every enrolled drive's recovery slot, so it is pinned by
`tests/usb-luks-enroll.test.sh`.

## No-TPM boxes

Provisioning **refuses** without a TPM (`droplet-luks-provision.sh` exits 2):
the data stays plain and `setup.sh` prints a loud warning. The dev-only escape
`DROPLET_LUKS_ALLOW_NO_TPM=1` forces plain-key provisioning for local
development — never use it on an appliance. The current single-box hardware has
no TPM (`DROPLET_TPM_BACKEND=mock`); the Vault hardware is the real target.

## Existing-fleet caveat

Boxes flashed before WARP-232 used the whole-disk `layout: lvm` and have **no
free VG extents** — `droplet-luks-provision.sh` exits 2 there with a clear
message. Encrypted-at-rest for the existing fleet arrives via reflash (new
image) or a manual migration. On boxes with an existing `/var/lib/docker`,
`droplet-luks-provision.sh` leaves the docker data-root alone and prints the
`--migrate-data` runbook (stop stack → `rsync -aHAX /var/lib/docker/
/data/docker/` → `daemon.json` → start) rather than moving data unattended.

## Cross-references

- `scripts/host/droplet-luks-provision.sh` — data-LV create + LUKS2 + TPM enroll + recovery-key delivery (`show-recovery-key`).
- `scripts/host/droplet-usb-enroll.sh` — USB encrypt-and-format + derivation.
- `scripts/host/droplet-tpm-lib.sh` — the shared PCR set (0+2+4+7) both tickets seal to.
- `docs/security/crypto-shred.md` — decommissioning / destroy-the-key runbook.
- `docs/security/device-identity.md` — the device-key TPM sealing this parallels.
