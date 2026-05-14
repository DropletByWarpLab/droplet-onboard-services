#!/usr/bin/env bash
# scripts/lib/storage.sh — auto-detect + mount unformatted block devices.
#
# Layout convention (matches what was applied manually on the photo-studio POC
# box and works for the customer install):
#
#   The first detected non-OS data drive becomes the "NVR drive":
#     - sda1 = 20% (e.g., 400 GiB of a 2 TB drive)   label=nvr   /mnt/nvr
#     - sda2 = 80% remaining                          label=data  /mnt/data
#
#   Subsequent drives become single-partition data drives:
#     - sdb1 = 100%   label=data2   /mnt/data2
#     - sdc1 = 100%   label=data3   /mnt/data3
#     - ...
#
# Idempotent: drives that already have a partition table OR are already in
# /etc/fstab are skipped. Safe to re-run.
#
# Sourced by scripts/setup.sh during phase 4 (Secrets) — runs BEFORE the build
# phase so .env can be populated with NVR_MEDIA_SOURCE.

set -euo pipefail

# Globals populated by detect_and_mount_drives() — read by setup.sh after the
# call to write NVR_MEDIA_SOURCE into .env.
STORAGE_NVR_PATH=""
STORAGE_DATA_PATHS=()

# Returns 0 if $1 is the root disk (the one whose tree contains /), 1 otherwise.
# Handles LVM, dm-crypt, partitions via lsblk's full subtree.
_is_root_disk() {
  local dev="$1"
  local root_src
  root_src=$(findmnt -no SOURCE / 2>/dev/null || echo "")
  [ -z "$root_src" ] && return 1
  # lsblk -lpno NAME walks the full block-device tree from $dev down
  # in LIST mode (no ├─/└─ tree drawing — important for exact-match grep).
  # If the root mount source appears anywhere in that tree, $dev is the root disk.
  lsblk -lpno NAME "$dev" 2>/dev/null | grep -qFx "$root_src"
}

# Returns 0 if $1 already has a partition table, 1 if raw.
_has_partition_table() {
  local dev="$1"
  # parted exits 0 when there's a label, 1 when "unrecognised disk label"
  sudo parted -s "$dev" print 2>/dev/null | grep -q '^Partition Table: \(gpt\|msdos\)'
}

# Returns 0 if $1 (a partition or whole device) is already in /etc/fstab.
_in_fstab() {
  local dev="$1"
  local uuid
  uuid=$(sudo blkid -s UUID -o value "$dev" 2>/dev/null || echo "")
  [ -n "$uuid" ] && grep -q "UUID=$uuid" /etc/fstab 2>/dev/null
}

# Mount $1 (block device, e.g. /dev/sda1) at $2 with label $3.
# Idempotent on fstab — adds the entry only if the UUID isn't already there.
_mount_and_persist() {
  local dev="$1" mp="$2" label="$3"
  sudo mkdir -p "$mp"
  local uuid
  uuid=$(sudo blkid -s UUID -o value "$dev")
  if ! grep -q "UUID=$uuid" /etc/fstab; then
    echo "UUID=$uuid $mp ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab >/dev/null
  fi
  # Mount if not already
  if ! mountpoint -q "$mp"; then
    sudo mount "$mp"
  fi
  sudo chown -R droplet:droplet "$mp" 2>/dev/null || true
  echo "  $dev (label=$label, uuid=$uuid) → $mp"
}

# Partition + format a raw disk into the NVR-split layout (20% + 80%).
# Returns 2 partition device paths via stdout: "/dev/sdX1 /dev/sdX2".
_layout_nvr_split() {
  local dev="$1"
  sudo parted -s "$dev" mklabel gpt
  sudo parted -s "$dev" mkpart nvr  ext4 1MiB 20%
  sudo parted -s "$dev" mkpart data ext4 20%  100%
  sudo parted "$dev" align-check optimal 1 >/dev/null
  sudo parted "$dev" align-check optimal 2 >/dev/null
  sudo partprobe "$dev"; sleep 1
  sudo mkfs.ext4 -F -L nvr  -m 1 -E lazy_itable_init=1,lazy_journal_init=1 "${dev}1" >/dev/null
  sudo mkfs.ext4 -F -L data -m 1 -E lazy_itable_init=1,lazy_journal_init=1 "${dev}2" >/dev/null
  echo "${dev}1 ${dev}2"
}

# Partition + format a raw disk as single ext4 with $2 as the label.
_layout_single() {
  local dev="$1" label="$2"
  sudo parted -s "$dev" mklabel gpt
  sudo parted -s "$dev" mkpart "$label" ext4 1MiB 100%
  sudo parted "$dev" align-check optimal 1 >/dev/null
  sudo partprobe "$dev"; sleep 1
  sudo mkfs.ext4 -F -L "$label" -m 1 -E lazy_itable_init=1,lazy_journal_init=1 "${dev}1" >/dev/null
  echo "${dev}1"
}

# Re-discover whether an already-partitioned drive matches our convention
# (label=nvr + label=data on one disk) and if so, just mount+persist them.
# Returns 0 if it claimed the disk for the NVR layout, 1 otherwise.
_adopt_existing_nvr_layout() {
  local dev="$1"
  local p1="${dev}1" p2="${dev}2"
  [ -b "$p1" ] && [ -b "$p2" ] || return 1
  local l1 l2
  l1=$(sudo blkid -s LABEL -o value "$p1" 2>/dev/null || echo "")
  l2=$(sudo blkid -s LABEL -o value "$p2" 2>/dev/null || echo "")
  if [ "$l1" = "nvr" ] && [ "$l2" = "data" ]; then
    _mount_and_persist "$p1" /mnt/nvr  nvr
    _mount_and_persist "$p2" /mnt/data data
    STORAGE_NVR_PATH=/mnt/nvr
    STORAGE_DATA_PATHS+=("/mnt/data")
    return 0
  fi
  return 1
}

# Same for single-partition data drives.
_adopt_existing_single() {
  local dev="$1" want_label="$2"
  local p1="${dev}1"
  [ -b "$p1" ] || return 1
  local l1
  l1=$(sudo blkid -s LABEL -o value "$p1" 2>/dev/null || echo "")
  if [ "$l1" = "$want_label" ]; then
    _mount_and_persist "$p1" "/mnt/$want_label" "$want_label"
    STORAGE_DATA_PATHS+=("/mnt/$want_label")
    return 0
  fi
  return 1
}

# Main entry point. setup.sh calls this; reads STORAGE_NVR_PATH afterward.
detect_and_mount_drives() {
  log_info "Storage: scanning for data drives..."

  # Enumerate candidate whole-disk devices.
  # Filter: type=disk, exclude OS root, exclude < 50 GiB (USB sticks, SD).
  # -b for bytes (avoids 1.8T vs 238.5G suffix parsing).
  local candidates=()
  while IFS= read -r line; do
    local name size_bytes type
    name=$(echo "$line"   | awk '{print $1}')
    size_bytes=$(echo "$line" | awk '{print $2}')
    type=$(echo "$line"   | awk '{print $3}')
    [ "$type" = "disk" ] || continue
    local dev="/dev/$name"
    _is_root_disk "$dev" && continue
    # 50 GiB threshold = 50 * 1024^3 bytes
    [ "$size_bytes" -lt 53687091200 ] && continue
    candidates+=("$dev")
  done < <(lsblk -dnbo NAME,SIZE,TYPE | sort)

  if [ "${#candidates[@]}" -eq 0 ]; then
    log_warn "  No data drives detected (≥50 GiB, non-root). Skipping auto-mount."
    return 0
  fi

  log_info "  Found ${#candidates[@]} data drive(s): ${candidates[*]}"

  local first=true
  local next_label_idx=2
  for dev in "${candidates[@]}"; do
    if $first; then
      first=false
      # First drive: NVR-split layout
      if _has_partition_table "$dev"; then
        if _adopt_existing_nvr_layout "$dev"; then
          log_success "  $dev: existing nvr/data layout adopted"
        else
          log_warn "  $dev: has a partition table that isn't our nvr/data layout. Leaving alone."
        fi
      else
        log_info "  $dev: raw — partitioning 20% NVR + 80% data..."
        local parts; parts=$(_layout_nvr_split "$dev")
        local p1 p2; read -r p1 p2 <<< "$parts"
        _mount_and_persist "$p1" /mnt/nvr  nvr
        _mount_and_persist "$p2" /mnt/data data
        STORAGE_NVR_PATH=/mnt/nvr
        STORAGE_DATA_PATHS+=("/mnt/data")
      fi
    else
      # Subsequent drives: single ext4 with label data2, data3, ...
      local want_label="data${next_label_idx}"
      next_label_idx=$((next_label_idx+1))
      if _has_partition_table "$dev"; then
        if _adopt_existing_single "$dev" "$want_label"; then
          log_success "  $dev: existing $want_label layout adopted"
        else
          log_warn "  $dev: has a partition table that isn't our $want_label layout. Leaving alone."
        fi
      else
        log_info "  $dev: raw — partitioning single $want_label..."
        local part; part=$(_layout_single "$dev" "$want_label")
        _mount_and_persist "$part" "/mnt/$want_label" "$want_label"
        STORAGE_DATA_PATHS+=("/mnt/$want_label")
      fi
    fi
  done

  if [ -n "$STORAGE_NVR_PATH" ]; then
    log_success "Storage: NVR storage at $STORAGE_NVR_PATH"
  else
    log_warn "Storage: no NVR partition claimed (no raw first drive and no pre-existing layout). NVR will fall back to docker volume nvrdata."
  fi
  if [ "${#STORAGE_DATA_PATHS[@]}" -gt 0 ]; then
    log_info "  Data paths: ${STORAGE_DATA_PATHS[*]}"
  fi
}
