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
| file-indexer / brain pgvector | docker volume under `/data/docker` |
| Docker image/layer store | classic store under `/data/docker`. **WARP-2102:** Docker ≥ 28's *containerd image store* roots at `/var/lib/containerd` and **ignores `data-root`**, so `daemon.json` pins `"features": {"containerd-snapshotter": false}`; `/var/lib/containerd` then holds runtime metadata only, never image content. Verified live by `rest.docker.store-root` (`droplet-verify-encryption.sh`) |
| Brain chunk text (chat attachments) | **column-level** AES-256-GCM under per-document DEKs (WARP-242, below) — on top of the LUKS layer |
| `.env` (carries `DEVICE_SECRET_KEY`) | `/data/droplet/env/.env` (symlinked) |
| `data/secrets` (audit signing key, doc-KEK keyfile) | `/data/droplet/secrets` (symlinked) |
| Hot-plugged USB drives | per-drive LUKS2 under `/mnt/droplet/<usb>` |
| Off-box backups | restic repo, per-customer key = HKDF(`DEVICE_SECRET_KEY`) (WARP-254) |

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
window is governed by backup retention, same as the file itself. Brain
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
2. Unlock once with the OFFLINE recovery key (printed once at provision time):
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
`droplet-luks-provision.sh` never moves the store unattended: an existing
`daemon.json` keeps its `data-root` (the `--migrate-data` runbook below is the
operator path). Since WARP-2102 a provision re-run **does** merge
`"features": {"containerd-snapshotter": false}` into an existing `daemon.json`
(backing the file up first, validating the JSON after, and respecting an
explicit operator value) — Docker ≥ 28's containerd image store roots at
`/var/lib/containerd` and ignores `data-root` entirely, so without the pin
every image lands back on the plain root LV no matter what `data-root` says.

**Store-switch consequence (WARP-2102).** The classic and containerd image
stores share nothing. A box that already ran Docker ≥ 28 with the containerd
store has its images in `/var/lib/containerd`; after the pin lands and dockerd
restarts, those images become *invisible* (not deleted) — `docker image ls`
comes up empty until you re-pull, or `docker save` them before the restart and
`docker load` after. Named volumes and container definitions live under
`data-root` in both modes and are unaffected.

**`--migrate-data` runbook:** stop the stack → `rsync -aHAX /var/lib/docker/
/data/docker/` → write `daemon.json` (`"data-root": "/data/docker"` **plus**
the `containerd-snapshotter: false` pin — both surfaces, or the image store
escapes the LUKS boundary again) → start docker → re-pull any image the store
switch left behind → once the stack is healthy, reclaim the plain-root copies
(`/var/lib/docker`, and `/var/lib/containerd`'s content/snapshot stores) and
confirm with `droplet-verify-encryption.sh --checks rest.docker.store-root`.

## Cross-references

- `scripts/host/droplet-luks-provision.sh` — data-LV create + LUKS2 + TPM enroll.
- `scripts/host/droplet-usb-enroll.sh` — USB encrypt-and-format + derivation.
- `scripts/host/droplet-tpm-lib.sh` — the shared PCR set (0+2+4+7) both tickets seal to.
- `docs/security/crypto-shred.md` — decommissioning / destroy-the-key runbook.
- `docs/security/device-identity.md` — the device-key TPM sealing this parallels.
