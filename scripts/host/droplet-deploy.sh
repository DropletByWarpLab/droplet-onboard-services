#!/usr/bin/env bash
# =============================================================================
# WARP-3841 — droplet-deploy: the in-repo, root-run deploy (epic WARP-3834)
# =============================================================================
#
# Deploys used to be hand-written scripts in /home/support that Romain ran with
# sudo: setup.sh refuses root (scripts/lib/preflight.sh), the `droplet` user has
# no password and root is locked, so no agent could deploy. This is the repo-
# tracked replacement, installed as /usr/local/sbin/droplet-deploy and run ONLY
# by droplet-deploy.service (Type=oneshot, User=root, no argv). The `droplet`
# user may START that unit through polkit (scripts/host/50-droplet-deploy.rules).
#
# Flow (any failure exits 1; there is NO automatic rollback):
#   1. preflight  — resolve the checkout, refuse if dirty or .data/.setup.lock held
#   2. backup     — db dump + one 0600 tar of .env, data/secrets, docker/secrets,
#                   docker/certs, docker/mosquitto.*; keep the last 3 (D2)
#   3. grant      — temporary NOPASSWD sudoers for `droplet` (setup.sh sudo's),
#                   removed by trap here AND by ExecStopPost=+ in the unit
#   4. setup      — runuser -u droplet -- setup.sh --skip-docker --skip-drivers
#   5. host hook  — systemctl start droplet-host-units.service
#   6. gate       — `droplet-host-units audit` == 0, required units active;
#                   failed droplet-* units are a WARN only
#   7. on failure — print the backup path and the three-line restore
#
# Test seams (env): DROPLET_HOST_INTEGRATION_REPO_ROOT (checkout, honoured by
# resolve_checkout), DROPLET_DEPLOY_BACKUP_DIR, DROPLET_DEPLOY_SUDOERS,
# DROPLET_DEPLOY_REAPPLY_LIB, DROPLET_DEPLOY_TS, DROPLET_DEPLOY_REQUIRED_UNITS,
# DROPLET_HOST_UNITS_BIN. Secret contents are never printed.
# =============================================================================
set -uo pipefail

BACKUP_DIR="${DROPLET_DEPLOY_BACKUP_DIR:-/var/lib/droplet/deploy-backups}"
SUDOERS="${DROPLET_DEPLOY_SUDOERS:-/etc/sudoers.d/droplet-deploy}"
REAPPLY_LIB="${DROPLET_DEPLOY_REAPPLY_LIB:-/usr/local/sbin/droplet-reapply-host-integration}"
KEEP=3
# Units that must be active after a deploy. Explicit (not derived from MANIFEST
# `unit` rows: those carry no Type, and oneshots/path units are legitimately
# inactive). droplet.service is the RemainAfterExit compose unit.
REQUIRED_UNITS="${DROPLET_DEPLOY_REQUIRED_UNITS:-droplet.service droplet-device-bridge.service droplet-watchdog.timer}"


# One resolver, shared with the heal wrapper (sourcing does not run its main).
# shellcheck source=/dev/null
. "$REAPPLY_LIB" || { echo "[droplet-deploy] cannot source $REAPPLY_LIB (run droplet-reapply-host-integration once to install it)" >&2; exit 1; }
log()  { printf '[droplet-deploy] %s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }
HU="${HU_BIN:-/usr/local/sbin/droplet-host-units}"

REPO="" ; BK=""

cleanup() { rm -f "$SUDOERS" "${SUDOERS}.new"; }
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

die() {
  log "FAILED: $*"
  if [ -n "$BK" ]; then
    local q; q="$(printf %q "$REPO")"
    log "Backup (db dump + secrets tar): $BK"
    log "Restore: 1) cat $BK/secrets.tar | runuser -u droplet -- tar -xpf - -C $q   (as droplet, never root; chown any root-owned path by hand. db: gunzip -c $BK/db.sql.gz | docker compose -f $q/docker/docker-compose.yml exec -T db psql ...)"
    log "         2) runuser -u droplet -- bash -lc 'cd $q && ./scripts/setup.sh --sync-secrets'"
    log "         3) docker compose -f $q/docker/docker-compose.yml up -d --force-recreate"
  fi
  exit 1
}

# Every git call runs AS droplet with NO safe.directory override: the repo is
# droplet-writable, so root running git there would execute a planted
# core.fsmonitor (or similar) from .git/config.
git_repo() { runuser -u droplet -- git -C "$REPO" "$@"; }

# --- 0. trust assumption (WARP-2888) -----------------------------------------
# The polkit start grant and the temporary NOPASSWD window are privilege-neutral
# ONLY while `droplet` is already root-equivalent via the docker group
# (ADR-020 §D6: the trust boundary is "who can become droplet"). Fail safe.
id -nG droplet 2>/dev/null | tr ' ' '\n' | grep -qx docker \
  || die "user droplet is not in the docker group. WARP-2888 deferred removing that membership; once droplet leaves the docker group the temporary NOPASSWD grant becomes a real privilege escalation, and this unit must be redesigned before it may run"

# --- 1. preflight ------------------------------------------------------------
REPO="$(resolve_checkout)" && [ -n "$REPO" ] || die "could not locate the checkout (set DROPLET_HOST_INTEGRATION_REPO_ROOT)"
[ -z "$(git_repo status --porcelain 2>&1)" ] || die "checkout $REPO is dirty (git status --porcelain not empty)"
lock="$REPO/.data/.setup.lock"
if [ -f "$lock" ]; then
  pid="$(cat "$lock" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then die "setup.sh is already running (pid $pid, $lock)"; fi
fi
log "deploying $REPO at $(git_repo rev-parse HEAD)"

# --- 2. backup (D2) ----------------------------------------------------------
umask 077
mkdir -p "$BACKUP_DIR" && chmod 0700 "$BACKUP_DIR"
BK="$BACKUP_DIR/${DROPLET_DEPLOY_TS:-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -m 0700 "$BK" || die "cannot create $BK"

# The exact pg_dump line of scripts/host/device-backup.sh (empty overrides ->
# the container's own POSTGRES_USER / POSTGRES_DB). Runs AS droplet (docker
# group) so root never parses the droplet-controlled compose file; the project
# name comes from the compose file's pinned `name:`. Root only owns the output.
runuser -u droplet -- docker compose -f "$REPO/docker/docker-compose.yml" exec -T -e "DROPLET_DUMP_USER=" -e "DROPLET_DUMP_DB=" db \
  sh -c 'pg_dump --username="${DROPLET_DUMP_USER:-$POSTGRES_USER}" --dbname="${DROPLET_DUMP_DB:-$POSTGRES_DB}" --format=plain --no-owner --no-privileges' \
  | gzip --best > "$BK/db.sql.gz"
[ "${PIPESTATUS[0]}" -eq 0 ] && [ -s "$BK/db.sql.gz" ] || die "db dump failed"

# NO -h: symlinks are stored as links and never read. Root dereferencing a
# droplet-planted link (data/secrets/x -> /etc/shadow) would be an arbitrary
# file read. .env alone may legitimately be a link (relocated onto /data), so
# it is resolved and must land inside the checkout; its target is archived too.
paths=()
for p in .env data/secrets docker/secrets docker/certs "$REPO"/docker/mosquitto.*; do
  p="${p#"$REPO"/}"
  [ -e "$REPO/$p" ] && paths+=("$p")
done
# The tar is built AS droplet with -h: .env and data/secrets may be links onto
# the encrypted /data (WARP-232, docker/ota/env-reconcile.sh), so links must be
# followed, but droplet can only read what droplet can already read. A
# droplet-planted link to a root-only file therefore fails with "permission
# denied" instead of leaking. Root only owns the output file (umask 077).
runuser -u droplet -- tar -chf - -C "$REPO" "${paths[@]}" > "$BK/secrets.tar" \
  || die "secrets tar failed: a file under ${paths[*]} is not readable by droplet (e.g. a root-owned dir Docker created under data/secrets); chown it to droplet, setup.sh as droplet would hit it too"
chmod 0600 "$BK/db.sql.gz" "$BK/secrets.tar"
log "backup written to $BK (${#paths[@]} paths + db dump)"

# Keep the newest $KEEP backup dirs (timestamp names sort chronologically).
# shellcheck disable=SC2012
ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | head -n "-$KEEP" | while read -r old; do rm -rf "$old"; done

# --- 3. temporary sudoers grant (as scripts/image/autoinstall/user-data) -----
printf 'droplet ALL=(ALL) NOPASSWD: ALL\n' > "${SUDOERS}.new"
visudo -cf "${SUDOERS}.new" >/dev/null || die "sudoers grant failed visudo -cf"
install -m 0440 "${SUDOERS}.new" "$SUDOERS" && rm -f "${SUDOERS}.new" || die "cannot install the sudoers grant"

# --- 4. setup.sh as droplet (documented field-update path) -------------------
log "running setup.sh --skip-docker --skip-drivers as droplet"
runuser -u droplet -- bash -lc "cd $(printf %q "$REPO") && ./scripts/setup.sh --skip-docker --skip-drivers" \
  || die "setup.sh failed (exit $?)"
cleanup   # grant is no longer needed

# --- 5. host hook ------------------------------------------------------------
systemctl start droplet-host-units.service || die "droplet-host-units.service failed"

# --- 6. gate -----------------------------------------------------------------
bad=0
"$HU" audit >/dev/null 2>&1 || { log "GATE: droplet-host-units audit did not exit 0"; bad=1; }
for u in $REQUIRED_UNITS; do
  systemctl is-active --quiet "$u" || { log "GATE: $u is not active"; bad=1; }
done
failed="$(systemctl --failed --no-legend --plain 'droplet-*' 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
[ -z "${failed// /}" ] || log "WARN: failed units: $failed"
[ "$bad" -eq 0 ] || die "post-deploy gate failed"

log "deploy OK ($REPO at $(git_repo rev-parse --short HEAD), backup $BK)"
