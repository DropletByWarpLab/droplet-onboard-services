# Crypto-shred (WARP-232 device-level, WARP-242 per-document)

Two granularities share the destroy-the-key principle:

- **Per-document (WARP-242):** deleting a brain document (chat attachment)
  destroys its per-document DEK alongside its rows and files, making the
  document's chunk ciphertext unrecoverable — including from off-box restic
  snapshots, because the wrapping doc-KEK keyfile
  (`data/secrets/doc-kek.key`) is excluded from the backup set. Full design,
  key hierarchy, and the on-box-restore caveat:
  `docs/security/at-rest-encryption.md` §"Per-document chunk encryption".
- **Device-level (WARP-232):** the whole-appliance decommission below. Note
  step 4 (`factory-reset`) also removes `data/secrets/doc-kek.key`, which
  independently orphans every per-document DEK.

# Crypto-shred decommissioning (WARP-232)

`scripts/host/droplet-crypto-shred.sh` decommissions an appliance by destroying
the **keys**, not the ciphertext. This is fast (seconds, not a multi-pass wipe
of TBs) and mathematically complete: with every unlock key gone, the data LV,
every enrolled USB drive, and every off-box backup are ciphertext forever.

> DESTRUCTIVE AND IRREVERSIBLE. Double-gated: `--yes-destroy-everything` **and**
> a typed `CONFIRM` prompt.

## What it destroys, and why each thing becomes unreadable

The key-destruction chain — each link orphans a class of data:

| Step | Command | Orphans |
|---|---|---|
| 1 | `cryptsetup luksErase` on `/dev/ubuntu-vg/droplet-data` + every enrolled USB drive | The LUKS2 data LV + USB drives: no keyslot (TPM, recovery, or passphrase) can ever unlock them again. |
| 2 | `tpm2_clear` (or `systemd-cryptenroll --wipe-slot=tpm2` + BIOS clear) | The TPM sealing hierarchy: the sealed LUKS/KEK blobs are undecryptable forever. |
| 3 | `shred -u` on `/data/droplet/env/.env` + `/data/droplet/secrets/*` | `DEVICE_SECRET_KEY`: the HKDF input for the restic repo password, the USB per-drive recovery slots, and the doc-KEK recovery path → **every restic snapshot is orphaned** and no recovery slot survives. |
| 4 | `scripts/factory-reset.sh` | The app-level purge (docker volumes, `data/secrets` dir). Since WARP-2629 it also overwrite-then-unlinks the live `/data` secrets itself — see below. |

Because the restic repository password is `HKDF(DEVICE_SECRET_KEY)` (WARP-254),
shredding `.env` in step 3 orphans the off-box backups at the same instant it
orphans the on-disk keys — there is no window where the backup outlives the box.

## What a plain `factory-reset.sh` guarantees on its own (WARP-2629)

A factory reset is **not** a crypto-shred, and the two are used for different
things: a reset re-provisions the same box (or hands a leased rack back), a
crypto-shred retires it. Until WARP-2629 the reset's `/data` coverage was a
hole, not a smaller guarantee — worth stating exactly where the line now falls.

**The hole.** Since the WARP-232 relocation the real `.env` is
`/data/droplet/env/.env` and the audit / doc-KEK keys are
`/data/droplet/secrets/`, with symlinks left at `<repo>/.env` and
`<repo>/data/secrets`. `factory-reset.sh` removed the **symlinks**, and `rm` on
a symlink unlinks the link, never the target. So on every relocated box
`DEVICE_SECRET_KEY`, the audit signing key, `doc-kek.key` and every
`.env.bak.*` / `.env.torn.*` snapshot **survived a factory reset**. Nothing
else covered them: `scripts/lib/storage-wipe.sh` (WARP-1988) only erases bulk
drives adopted under `/mnt/droplet` and never touches the `/data` LUKS mount.
On a 2-year hardware lease that meant a returned or re-provisioned rack was
still carrying the previous tenant's keys.

**What the reset guarantees now.** Phase 4 resolves both symlinks first, then
overwrite-then-unlinks, via `scripts/lib/secrets-wipe.sh`:

| Path | Reset behaviour |
|---|---|
| `/data/droplet/env/.env` (resolved) | overwritten in place, then unlinked |
| `.env.{bak,torn,tmp,migrate,upsert}.*` beside it | same — each is a complete copy of the same secrets |
| every file under `/data/droplet/secrets/` | same (audit signing key, `doc-kek.key`, anything else generated there) |
| `/data/droplet/env/` and `/data/droplet/secrets/` | left present, **empty**, install-user-owned, mode `0750` — the contract `relocate_secrets_to_data` establishes, so the next `setup.sh` regenerates into a tree it can traverse |
| the repo-side link copies (`<repo>/.env.bak.*` …) | overwritten then unlinked too — these sit on the **unencrypted** boot disk |

It needs no Docker, no network and no root on a normally-relocated box, and it
is idempotent: a second reset finds nothing and exits 0.

**What it still does not give you.** `shred`/overwrite reaches the file's own
blocks — `/data` is ext4 on LUKS2, not log-structured, so a single in-place
pass is real — but it cannot reach blocks the filesystem already relocated, a
journal copy, or blocks the SSD FTL has remapped (`/data` is mounted with
`discard`). And a wipe is a **list**, so it only covers what the list names;
lists rot. Bulk drives remain `storage-wipe.sh`'s job (structural, not
forensic — see `scripts/factory-reset.sh`'s header). **For a box that is
leaving the fleet, or changing customer, run the crypto-shred above, not a
factory reset.** Destroying the keyslots is what makes every byte
unrecoverable, including whatever a future writer forgets to add to the list.

**Re-keying `/data` on every reset was considered and not done** (WARP-2629
option 2). It is strictly stronger and closes the list-rot problem, but it
costs a re-format + re-provision of the volume and a TPM re-seal, so a reset
would stop being something that can run unattended and still leave a bootable
box. That is an operator decision; the wipe above closes the leak in the
meantime.

## Run it

```
sudo droplet-crypto-shred.sh --yes-destroy-everything
# type CONFIRM at the prompt
```

## Verify the post-conditions

```
# No usable keyslots on the data LV:
sudo cryptsetup luksDump /dev/ubuntu-vg/droplet-data     # → zero keyslots

# The backup repo can no longer be opened (password unrecoverable):
restic -r /var/lib/droplet/restic-repo snapshots         # → auth failure

# The AC: "disk removed + mounted elsewhere yields no readable data" —
# pull the disk, attach to a lab machine:
sudo mount /dev/ubuntu-vg/droplet-data /mnt              # → fails: crypto_LUKS, no key
sudo cryptsetup open /dev/ubuntu-vg/droplet-data x       # → prompts; no key exists → no data
strings /dev/ubuntu-vg/droplet-data | head              # → ciphertext only
```

If `tpm2_clear` was unavailable, also clear the TPM from BIOS/UEFI setup
("Clear TPM" / "Security Device") to destroy the sealing hierarchy.

## Hardware-gated

The end-to-end drill on real hardware (actually pulling the disk, confirming
`restic snapshots` auth-fails after the shred) is part of the **WARP-966**
hardware pass — see the plan's "Hardware Test (deferred)" section. The script
logic itself is exercised hermetically (`tests/luks2-data-partition.test.sh`,
crypto-shred static gate).
