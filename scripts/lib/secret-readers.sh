#!/usr/bin/env bash
# =============================================================================
# WARP-2548: who reads each mounted secret, and can they?
#
# The broker crash-looped for 6,000+ restarts because a host secret written
# 0600 install-user-owned was bind-mounted straight into an image that drops
# to its own uid (mosquitto, 1883) before opening it. Nothing tied "the mode
# and owner setup writes" to "the uid that actually opens the file", so the
# break was silent until the box stopped doing MQTT.
#
# The rule this file anchors:
#   * Setup writes every secret install-user-owned (keys 0600; certs, CA
#     copies and the redis ACL 0644). relocate_secrets_to_data chown -Rs the
#     tree to the install user, so no other ownership survives anyway.
#   * A container reads its secret mounts either as ROOT (no `user:`, no
#     Dockerfile USER, or a staging wrapper — db/cache/broker `install -o`
#     the bundle as container-root before the entrypoint drops privileges)
#     or as a NON-ROOT uid listed in SECRET_READERS below, and then the file
#     must be readable by that uid under the modes setup writes.
#   * tests/secret-readers.test.sh derives the reader uid of every
#     `../data/secrets` mount in docker/docker-compose.yml independently and
#     fails if SECRET_READERS drifts from it, or if a non-root reader can't
#     read what setup writes. A new direct mount into a privilege-dropping
#     image therefore fails CI instead of crash-looping a box.
#
# SECRET_READERS rows: "<service>|<path under data/secrets>|<uid>|<why>".
# Only NON-ROOT direct readers belong here; a root reader reads anything.
# =============================================================================

SECRET_READERS=(
  "cache|redis/users.acl|999|redis:7-alpine entrypoint setprivs to redis before redis-server opens --aclfile"
  "nextcloud|service-tls/nextcloud/ca.pem|33|mod_php runs as www-data and opens REDIS_TLS_CAFILE"
)

# _secret_stat <path> → "<uid> <octal-mode>" (GNU stat on the box, BSD on macOS dev).
_secret_stat() {
  stat -L -c '%u %a' "$1" 2>/dev/null || stat -L -f '%u %Lp' "$1" 2>/dev/null
}

# secret_readable_by <uid> <owner-uid> <octal-mode> — the kernel's DAC answer
# for a plain read, minus groups (containers don't share the host's groups,
# so a group bit is never counted as access).
secret_readable_by() {
  local uid="$1" owner="$2" mode=$((8#$3))
  [ "$uid" = "0" ] && return 0
  [ "$uid" = "$owner" ] && [ $((mode & 8#400)) -ne 0 ] && return 0
  [ $((mode & 8#004)) -ne 0 ]
}

# secret_tls_perms_repair — idempotent. Normalise every service-tls bundle to
# what internal_ca_issue writes: key.pem 0600, cert.pem/ca.pem 0644, all
# owned by whoever owns the service-tls dir (the install user). Undoes the
# two pre-WARP-2154 leftovers an upgraded box can still carry: a key chowned
# to 1883 by the old issuance chain, and a key left world-readable (0644) by
# its no-sudo fallback. Nothing here changes a box that is already correct.
secret_tls_perms_repair() {
  local root="$REPO_ROOT/data/secrets/service-tls" owner f want st
  [ -d "$root" ] || return 0
  owner="$(_secret_stat "$root")"; owner="${owner%% *}"
  for f in "$root"/*/key.pem "$root"/*/cert.pem "$root"/*/ca.pem; do
    [ -f "$f" ] || continue
    case "$f" in */key.pem) want=600 ;; *) want=644 ;; esac
    st="$(_secret_stat "$f")"
    [ "$st" = "$owner $want" ] && continue
    if [ "${st%% *}" != "$owner" ]; then
      chown "$owner" "$f" 2>/dev/null || sudo -n chown "$owner" "$f" 2>/dev/null || true
    fi
    chmod "$want" "$f" 2>/dev/null || sudo -n chmod "$want" "$f" 2>/dev/null || true
    log_info "secret perms: repaired ${f#"$REPO_ROOT"/} ($st -> $owner $want)"
  done
}

# secret_readers_check — every non-root reader in SECRET_READERS can read its
# file as it sits on disk. Loud failure naming file, owner, mode and uid.
secret_readers_check() {
  local row svc rel uid why f st rc=0
  for row in "${SECRET_READERS[@]}"; do
    IFS='|' read -r svc rel uid why <<<"$row"
    f="$REPO_ROOT/data/secrets/$rel"
    # Not provisioned on this shape (e.g. no .env yet → no users.acl): the
    # generator already warned; a missing file is not a permission bug.
    [ -e "$f" ] || continue
    st="$(_secret_stat "$f")"
    if ! secret_readable_by "$uid" "${st%% *}" "${st##* }"; then
      log_error "secret perms: $svc runs as uid $uid but cannot read data/secrets/$rel (owner uid ${st%% *}, mode ${st##* }) — $why. It would crash-loop (WARP-2548)."
      rc=1
    fi
  done
  return "$rc"
}

# secret_readers_guard — the setup-path entry point: repair, then assert.
# WARP-2995's host-side OTA reconcile should call this too; until it does, an
# OTA-only box gets it on its next setup.sh run (the broker itself does not
# depend on it — its staging wrapper reads the bundle as container root).
secret_readers_guard() {
  secret_tls_perms_repair
  secret_readers_check
}
