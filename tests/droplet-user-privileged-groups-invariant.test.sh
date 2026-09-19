#!/usr/bin/env bash
# =============================================================================
# WARP-2888 SECURITY REGRESSION GUARD — the `droplet` account must not silently
# (re)gain a root-equivalent supplementary group other than the one it needs.
# =============================================================================
#
# THE INVARIANT (load-bearing):
#   `docker` group membership is root-equivalent — a member runs
#       docker run --rm --privileged --pid=host alpine \
#           nsenter -t 1 -m -u -i -n -p -- sh
#   to get a host-root shell with NO password. `lxd` (and `lxc`) are equally
#   root-equivalent (launch a privileged container that bind-mounts host /).
#
#   On a shipped box `droplet` has a LOCKED sudo password (ADR-020 §D6), so its
#   root-equivalent group membership — NOT sudo — is the real local-privilege
#   surface. The ONLY such group Droplet may hold is `docker`, and only because
#   it is load-bearing: droplet.service boots the whole stack as
#   `User=droplet, Group=docker`, and the device-bridge's ADR-023 host wrappers
#   (droplet-tls-reload.sh, droplet-factory-reset.sh -> scripts/lib/tls-reload.sh)
#   run `docker compose` as `droplet` with no sudo. Stripping `docker` is a
#   staged posture change (WARP-2888), NOT a piecemeal edit on a boot path.
#
#   Therefore, in the shipped provisioning code:
#     1. No Droplet script may ADD `droplet`/$USER to a root-equivalent group
#        other than `docker` — in particular never `lxd`/`lxc`/`disk`/`kvm`.
#     2. The `droplet-firstboot` teardown MUST drop the base-image `lxd`
#        membership (`gpasswd -d droplet lxd`) — the gratuitous half this ADR
#        fixes now.
#     3. The ONLY shipped systemd unit granted the `docker` group is
#        droplet.service. A new unit gaining `Group=docker` /
#        `SupplementaryGroups=docker` is a new always-on host-root surface and
#        must be a conscious decision (update this guard + ADR-020 §D6).
#
# No root, no systemd, no docker. Sections 1-3 are static greps; 2b runs the
# ExecStartPost command string hermetically (stubbed sudo/id/gpasswd, paths
# rerooted under mktemp). Runtime: < 1s.
# ci: runs at PR time via .github/workflows/setup-tests.yml (scripts/** trigger).
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root $REPO_ROOT" >&2; exit 2; }

USER_DATA="scripts/image/autoinstall/user-data"

TESTS=0
FAILURES=0
pass() { TESTS=$((TESTS + 1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { TESTS=$((TESTS + 1)); FAILURES=$((FAILURES + 1)); printf "  \033[31m✗\033[0m %s\n" "$1"; }

echo "WARP-2888: droplet privileged-group invariant"

# --- 1a. No group-ADD of droplet to a forbidden root-equivalent group --------
# Matches the add-to-group primitives only (usermod -aG / -a -G, gpasswd -a,
# adduser <u> <g>); a `gpasswd -d ... lxd` REMOVAL uses -d and never matches.
FORBIDDEN='lxd|lxc|disk|kvm|root'
bad_add="$(grep -rInE \
  "(usermod[^;&|]*-a[^;&|]*G|gpasswd[[:space:]]+-a[[:space:]]|adduser[[:space:]])[^;&|]*\b(${FORBIDDEN})\b" \
  scripts 2>/dev/null | grep -vE '/tests?/' || true)"
if [ -z "$bad_add" ]; then
  pass "no Droplet script adds droplet to a forbidden root-equivalent group (${FORBIDDEN})"
else
  fail "Droplet code adds droplet to a forbidden root-equivalent group:"
  printf '      %s\n' "$bad_add"
fi

# --- 1b. The only add-to-group in scripts/lib/docker.sh targets `docker` ------
nondocker_add="$(grep -nE 'usermod[[:space:]]+-aG|gpasswd[[:space:]]+-a[[:space:]]' \
  scripts/lib/docker.sh 2>/dev/null \
  | grep -vE 'usermod[[:space:]]+-aG[[:space:]]+docker\b' || true)"
if [ -z "$nondocker_add" ]; then
  pass "scripts/lib/docker.sh only ever adds the 'docker' group"
else
  fail "scripts/lib/docker.sh adds a non-docker group:"
  printf '      %s\n' "$nondocker_add"
fi

# --- 2. Firstboot teardown removes droplet from the unused lxd group ----------
if grep -qE 'gpasswd[[:space:]]+-d[[:space:]]+droplet[[:space:]]+lxd' "$USER_DATA"; then
  pass "firstboot ExecStartPost drops droplet from the unused lxd group"
else
  fail "$USER_DATA no longer removes droplet from lxd (gpasswd -d droplet lxd)"
fi

# --- 2b. RUNTIME: the sudoers teardown must not depend on the lxd-drop -------
# Section 2 is a grep; this runs the real ExecStartPost command string. The
# `gpasswd -d droplet lxd` step sits between the .firstboot-done stamp and the
# `rm -f /etc/sudoers.d/droplet-firstboot`. If it is `&&`-chained, a gpasswd
# failure (group-file lock, transient EROFS, ...) aborts the chain BEFORE the
# rm and strands the NOPASSWD: ALL drop-in past first boot — the exact outcome
# ADR-020 §D6 forbids. Simulate: droplet IS in lxd, gpasswd FAILS, sudo is a
# pass-through, and every absolute path is rerooted under a temp dir.
post_cmd="$(grep -E '^[[:space:]]*ExecStartPost=' "$USER_DATA" \
  | sed -E 's|^[[:space:]]*ExecStartPost=/bin/bash -lc "||; s|"[[:space:]]*$||')"
if [ -z "$post_cmd" ]; then
  fail "could not extract the ExecStartPost command string from $USER_DATA"
else
  fb_tmp="$(mktemp -d)"
  trap 'rm -rf "$fb_tmp"' EXIT
  mkdir -p "$fb_tmp/etc/sudoers.d"
  : > "$fb_tmp/etc/sudoers.d/droplet-firstboot"
  rerooted="${post_cmd//\/var\/lib\/droplet/$fb_tmp/var/lib/droplet}"
  rerooted="${rerooted//\/etc\/sudoers.d/$fb_tmp/etc/sudoers.d}"
  sudo() { "$@"; }
  id() { echo "droplet lxd docker"; }
  gpasswd() { echo "gpasswd: stub failure" >&2; return 1; }
  export -f sudo id gpasswd
  # bash -c, not -lc: a login shell would source profiles over the stubs.
  fb_err="$(bash -c "$rerooted" 2>&1 >/dev/null || true)"
  unset -f sudo id gpasswd
  if [ ! -e "$fb_tmp/etc/sudoers.d/droplet-firstboot" ] \
     && [ -f "$fb_tmp/var/lib/droplet/.firstboot-done" ]; then
    pass "firstboot sudoers drop-in is removed even when the lxd-drop fails"
  else
    fail "a failing gpasswd -d droplet lxd left /etc/sudoers.d/droplet-firstboot in place (ADR-020 §D6)"
    printf '      sudoers drop-in present: %s | marker present: %s\n' \
      "$([ -e "$fb_tmp/etc/sudoers.d/droplet-firstboot" ] && echo yes || echo no)" \
      "$([ -f "$fb_tmp/var/lib/droplet/.firstboot-done" ] && echo yes || echo no)"
  fi
  case "$fb_err" in
    *"gpasswd: stub failure"*)
      pass "a failing lxd-drop still surfaces on stderr (visible in the firstboot journal)" ;;
    *)
      fail "the lxd-drop's failure was swallowed — gpasswd stderr must reach the journal" ;;
  esac
fi

# --- 3. droplet.service is the ONLY shipped unit granted the docker group -----
docker_units="$(grep -rIlE \
  '^[[:space:]]*Group=docker[[:space:]]*$|^[[:space:]]*SupplementaryGroups=.*\bdocker\b' \
  scripts/host/etc-systemd-system services --include='*.service' 2>/dev/null || true)"
got="$(printf '%s\n' "$docker_units" | sed '/^[[:space:]]*$/d' \
  | xargs -r -n1 basename 2>/dev/null | sort -u | paste -sd, - )"
want="droplet.service"
if [ "$got" = "$want" ]; then
  pass "only droplet.service is granted the docker group"
else
  fail "units granted the docker group changed — got [$got], want [$want]."
  fail "  A new docker-group unit is a new always-on host-root surface: justify it, then update this guard + ADR-020 §D6."
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  printf "\033[32mPASS\033[0m %d checks\n" "$TESTS"
  exit 0
else
  printf "\033[31mFAIL\033[0m %d/%d checks failed\n" "$FAILURES" "$TESTS"
  exit 1
fi
