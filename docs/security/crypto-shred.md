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
| 4 | `scripts/factory-reset.sh` | The app-level purge (docker volumes, `data/secrets` dir). |

Because the restic repository password is `HKDF(DEVICE_SECRET_KEY)` (WARP-254),
shredding `.env` in step 3 orphans the off-box backups at the same instant it
orphans the on-disk keys — there is no window where the backup outlives the box.

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
