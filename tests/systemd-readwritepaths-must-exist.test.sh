#!/usr/bin/env bash
# =============================================================================
# REGRESSION GUARD — a shipped unit may not carve out a ReadWritePaths= path
# that nothing creates.
# =============================================================================
#
# THE INVARIANT (load-bearing):
#   `ReadWritePaths=` is a WHITELIST, not a constructor. systemd never creates
#   these paths — unlike StateDirectory=/LogsDirectory=/CacheDirectory=/
#   RuntimeDirectory=, which it creates before the mount namespace is applied.
#   When a ReadWritePaths= target is absent, namespace setup hard-fails:
#       Failed to set up mount namespacing: <path>: No such file or directory
#       status=226/NAMESPACE
#   With Restart=on-failure that is a permanent crash loop, and the service's
#   own mkdir can never save it because the interpreter never runs.
#
#   This is not hypothetical. It shipped three times:
#     * droplet-egress-audit.service — ReadWritePaths=/var/lib/droplet/egress-audit
#       with no creator anywhere in the installer. Found on a live box at 480
#       restarts, ExecMainStatus=226, having NEVER started successfully. The
#       egress-audit collector is a security control (WARP-268), so it was
#       silently absent for the entire life of the box.
#     * droplet-wifi-rotate.service — ReadWritePaths=/var/log/droplet-wifi-rotate.log,
#       a file nothing created and factory-reset.sh actively deleted. Latent only
#       because the timer ships disabled; the first start would have 226'd.
#     * droplet-device-bridge.service — same shape, but survives by an ordering
#       accident: StandardOutput=append: opens the file with O_CREAT in
#       exec_child, BEFORE the namespace is applied. Safe today, one edit from
#       breaking, so it is asserted here rather than left to luck.
#
#   Therefore: every non-optional ReadWritePaths= entry in a shipped unit must be
#   GUARANTEED to exist, via one of:
#     (a) a `-` prefix, which makes systemd ignore it when missing;
#     (b) a systemd-created directory in the same unit (StateDirectory=,
#         LogsDirectory=, CacheDirectory=, RuntimeDirectory=);
#     (c) StandardOutput=/StandardError=append:<same path>, which O_CREATs it;
#     (d) @REPO_ROOT@, which exists by construction when the unit is installed.
#
# This guard is static: no root, no systemd, no docker. It ends with a MUTATION
# CONTROL that feeds the checker the real pre-fix unit bodies and requires it to
# reject them — a guard that cannot fail is worse than no guard.
#
# Runtime: < 1s.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }

# Paths a unit is allowed to carve out even though this repo does not create
# them, with the reason. Keep this list SHORT and justified.
is_allowlisted() {
  case "$1" in
    # Provisioned by the OS/installer well before any unit starts.
    /etc/default) return 0 ;;
  esac
  return 1
}

# Emit every path the unit itself guarantees will exist.
guaranteed_paths() {
  local unit="$1"
  sed -nE 's/^StateDirectory=(.*)$/\1/p'   "$unit" | tr ' ' '\n' | sed -E 's#^#/var/lib/#'
  sed -nE 's/^LogsDirectory=(.*)$/\1/p'    "$unit" | tr ' ' '\n' | sed -E 's#^#/var/log/#'
  sed -nE 's/^CacheDirectory=(.*)$/\1/p'   "$unit" | tr ' ' '\n' | sed -E 's#^#/var/cache/#'
  sed -nE 's/^RuntimeDirectory=(.*)$/\1/p' "$unit" | tr ' ' '\n' | sed -E 's#^#/run/#'
  # StandardOutput=append:/path and StandardError=append:/path open with O_CREAT
  # during exec_child, which runs before apply_mount_namespace().
  sed -nE 's/^Standard(Output|Error)=append:(.*)$/\2/p' "$unit"
}

# Returns 0 when the unit is safe, 1 when it carves out an uncreated path.
# Offending entries are printed on stdout.
audit_unit() {
  local unit="$1" bad_entries="" guaranteed entry stripped g covered
  guaranteed="$(guaranteed_paths "$unit" | sed '/^$/d')"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    for entry in $line; do
      # (a) `-` prefix => ignored when missing => always safe.
      case "$entry" in -*) continue ;; esac
      # (d) templated repo root exists by construction.
      case "$entry" in *@REPO_ROOT@*) continue ;; esac
      is_allowlisted "$entry" && continue
      covered=0
      while IFS= read -r g; do
        [ -n "$g" ] || continue
        # Exact match, or the entry lives under a systemd-created directory.
        if [ "$entry" = "$g" ] || case "$entry" in "$g"/*) true ;; *) false ;; esac; then
          covered=1; break
        fi
      done <<< "$guaranteed"
      [ "$covered" -eq 1 ] || bad_entries="${bad_entries}${entry} "
    done
  done < <(sed -nE 's/^ReadWritePaths=(.*)$/\1/p' "$unit")

  if [ -n "$bad_entries" ]; then printf '%s\n' "$bad_entries"; return 1; fi
  return 0
}

echo "== shipped units: every ReadWritePaths= target must be guaranteed to exist =="
UNITS="$(find "$REPO_ROOT/scripts/host/etc-systemd-system" "$REPO_ROOT/services" \
           -name '*.service' -type f 2>/dev/null | sort)"
[ -n "$UNITS" ] || { echo "  no units found — the guard would pass vacuously"; exit 1; }

echo "  (scanning $(printf '%s\n' "$UNITS" | wc -l | tr -d ' ') units)"
while IFS= read -r u; do
  [ -n "$u" ] || continue
  grep -qE '^ReadWritePaths=' "$u" || continue
  rel="${u#"$REPO_ROOT"/}"
  if offenders="$(audit_unit "$u")"; then
    ok "$rel"
  else
    bad "$rel carves out uncreated path(s): $offenders"
    echo "        fix: use StateDirectory=/LogsDirectory=, or prefix the path with '-'"
  fi
done <<< "$UNITS"

# -----------------------------------------------------------------------------
# MUTATION CONTROL — the checker must REJECT the real pre-fix unit bodies.
# Without this, a checker that silently matched nothing would report all-green.
# -----------------------------------------------------------------------------
echo "== mutation control: the checker must reject the historical regressions =="
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# The egress-audit unit exactly as it shipped before the fix.
cat > "$TMP/pre-fix-egress.service" <<'EOF'
[Service]
Type=exec
ExecStart=/usr/local/sbin/droplet-egress-audit
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/droplet/egress-audit
EOF
if audit_unit "$TMP/pre-fix-egress.service" >/dev/null; then
  bad "checker ACCEPTED the pre-fix egress-audit unit — the guard cannot fail"
else
  ok "checker rejects the pre-fix egress-audit unit (uncreated /var/lib/droplet/egress-audit)"
fi

# The wifi-rotate unit exactly as it shipped before the fix.
cat > "$TMP/pre-fix-wifi.service" <<'EOF'
[Service]
Type=oneshot
ProtectSystem=strict
ReadWritePaths=/var/log/droplet-wifi-rotate.log
EOF
if audit_unit "$TMP/pre-fix-wifi.service" >/dev/null; then
  bad "checker ACCEPTED the pre-fix wifi-rotate unit — the guard cannot fail"
else
  ok "checker rejects the pre-fix wifi-rotate unit (uncreated log file)"
fi

# And it must ACCEPT each sanctioned escape hatch, or it is uselessly strict.
cat > "$TMP/ok-statedir.service" <<'EOF'
[Service]
StateDirectory=droplet/egress-audit
ReadWritePaths=/var/lib/droplet/egress-audit
EOF
audit_unit "$TMP/ok-statedir.service" >/dev/null \
  && ok "checker accepts StateDirectory= covering the carve-out" \
  || bad "checker rejected a StateDirectory-covered path"

cat > "$TMP/ok-append.service" <<'EOF'
[Service]
StandardOutput=append:/var/log/droplet-device-bridge.log
ReadWritePaths=/var/log/droplet-device-bridge.log
EOF
audit_unit "$TMP/ok-append.service" >/dev/null \
  && ok "checker accepts append:-created log file" \
  || bad "checker rejected an append:-created log file"

cat > "$TMP/ok-optional.service" <<'EOF'
[Service]
ReadWritePaths=-/some/optional/path
EOF
audit_unit "$TMP/ok-optional.service" >/dev/null \
  && ok "checker accepts '-' optional prefix" \
  || bad "checker rejected a '-'-prefixed optional path"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
