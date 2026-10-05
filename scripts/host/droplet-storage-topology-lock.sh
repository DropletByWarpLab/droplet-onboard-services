#!/usr/bin/env bash
# Shared exclusive lock for operations that can change the recordings device
# topology. systemd-tmpfiles provisions a root-owned 0750 directory and a
# root-owned, single-link 0660 file in it. The bridge has only group access to
# the file; no untrusted caller may choose a weaker lock through the test-path
# override.
# Return 0 when acquired, 1 when another operation holds it, and 2 when the
# lock cannot be trusted or acquired. Callers fail closed on either error.
storage_topology_lock() {
  local lock_file="${DROPLET_STORAGE_TOPOLOGY_LOCK_FILE:-/run/droplet-storage-ops/recordings-topology.lock}"
  local lock_dir lock_name parent_path parent_fd_stat file_path file_fd_stat current_dir current_stat
  local parent_type parent_uid parent_gid parent_mode parent_nlink parent_dev parent_ino
  local parent_fd_type parent_fd_uid parent_fd_gid parent_fd_mode parent_fd_nlink parent_fd_dev parent_fd_ino
  local current_type current_uid current_gid current_mode current_nlink current_dev current_ino current_perm
  local file_type file_uid file_gid file_mode file_nlink file_dev file_ino
  local file_fd_type file_fd_uid file_fd_gid file_fd_mode file_fd_nlink file_fd_dev file_fd_ino
  local lock_rc

  case "$lock_file" in
    /*) ;;
    *) return 2 ;;
  esac
  case "$lock_file" in
    *//*|*/./*|*/../*|*/.|*/..) return 2 ;;
  esac
  lock_dir="$(dirname -- "$lock_file")" || return 2
  lock_name="$(basename -- "$lock_file")" || return 2
  [ -n "$lock_name" ] && [ "$lock_name" != "." ] && [ "$lock_name" != ".." ] || return 2
  [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] || return 2
  [ -f "$lock_file" ] && [ ! -L "$lock_file" ] || return 2
  command -v flock >/dev/null 2>&1 && command -v stat >/dev/null 2>&1 || return 2

  # Pin the parent before opening the file. It must be root-owned, exactly
  # 0750, and unchanged at its path after opening; this prevents an untrusted
  # directory from swapping a checked lock path before the shell opens it.
  { exec 7<"$lock_dir"; } 2>/dev/null || return 2
  parent_path="$(LC_ALL=C stat -c '%F|%u|%g|%a|%h|%d|%i' -- "$lock_dir" 2>/dev/null)" || { exec 7<&-; return 2; }
  parent_fd_stat="$(LC_ALL=C stat -Lc '%F|%u|%g|%a|%h|%d|%i' -- "/proc/$$/fd/7" 2>/dev/null)" || { exec 7<&-; return 2; }
  IFS='|' read -r parent_type parent_uid parent_gid parent_mode parent_nlink parent_dev parent_ino <<< "$parent_path"
  IFS='|' read -r parent_fd_type parent_fd_uid parent_fd_gid parent_fd_mode parent_fd_nlink parent_fd_dev parent_fd_ino <<< "$parent_fd_stat"
  if [ "$parent_type" != directory ] || [ "$parent_uid" != 0 ] || [ "$parent_mode" != 750 ] \
     || [ "$parent_fd_type" != directory ] || [ "$parent_fd_uid" != 0 ] \
     || [ "$parent_fd_mode" != 750 ] || [ "$parent_dev:$parent_ino" != "$parent_fd_dev:$parent_fd_ino" ]; then
    exec 7<&-
    return 2
  fi

  # Every ancestor must also be root-owned and protected from group/world
  # rename. A root-owned sticky directory such as /tmp is safe: its sticky bit
  # prevents another uid from renaming the root-owned child lock directory.
  current_dir="$lock_dir"
  while :; do
    [ -d "$current_dir" ] && [ ! -L "$current_dir" ] || { exec 7<&-; return 2; }
    if [ "$current_dir" = "$lock_dir" ]; then
      current_stat="$parent_path"
    else
      current_stat="$(LC_ALL=C stat -c '%F|%u|%g|%a|%h|%d|%i' -- "$current_dir" 2>/dev/null)" || { exec 7<&-; return 2; }
    fi
    IFS='|' read -r current_type current_uid current_gid current_mode current_nlink current_dev current_ino <<< "$current_stat"
    case "$current_mode" in
      ''|*[!0-7]*) exec 7<&-; return 2 ;;
    esac
    current_perm=$((8#$current_mode))
    if [ "$current_type" != directory ] || [ "$current_uid" != 0 ] \
       || { (( current_perm & 0022 )) && ! (( current_perm & 01000 )); }; then
      exec 7<&-
      return 2
    fi
    [ "$current_dir" = / ] && break
    current_dir="${current_dir%/*}"
    [ -n "$current_dir" ] || current_dir=/
  done

  # Opening with a pinned, protected parent plus fstat/path-inode comparison
  # closes the check/open race. Require the provisioned owner/group/mode shape,
  # a regular inode, and exactly one link before taking the lock.
  { exec 8<>"$lock_file"; } 2>/dev/null || { exec 7<&-; return 2; }
  file_path="$(LC_ALL=C stat -c '%F|%u|%g|%a|%h|%d|%i' -- "$lock_file" 2>/dev/null)" || { exec 8>&- 7<&-; return 2; }
  file_fd_stat="$(LC_ALL=C stat -Lc '%F|%u|%g|%a|%h|%d|%i' -- "/proc/$$/fd/8" 2>/dev/null)" || { exec 8>&- 7<&-; return 2; }
  IFS='|' read -r file_type file_uid file_gid file_mode file_nlink file_dev file_ino <<< "$file_path"
  IFS='|' read -r file_fd_type file_fd_uid file_fd_gid file_fd_mode file_fd_nlink file_fd_dev file_fd_ino <<< "$file_fd_stat"
  if { [ "$file_type" != "regular file" ] && [ "$file_type" != "regular empty file" ]; } || [ "$file_uid" != 0 ] \
     || [ "$file_gid" != "$parent_gid" ] || [ "$file_mode" != 660 ] || [ "$file_nlink" != 1 ] \
     || { [ "$file_fd_type" != "regular file" ] && [ "$file_fd_type" != "regular empty file" ]; } || [ "$file_fd_uid" != 0 ] \
     || [ "$file_fd_gid" != "$parent_gid" ] || [ "$file_fd_mode" != 660 ] || [ "$file_fd_nlink" != 1 ] \
     || [ "$file_dev:$file_ino" != "$file_fd_dev:$file_fd_ino" ]; then
    exec 8>&- 7<&-
    return 2
  fi

  flock -n -E 75 -x 8
  lock_rc=$?
  if [ "$lock_rc" -eq 0 ]; then
    return 0
  fi
  exec 8>&- 7<&-
  [ "$lock_rc" -eq 75 ] && return 1
  return 2
}
