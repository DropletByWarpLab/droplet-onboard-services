#!/bin/bash
# Nextcloud post-installation hook (runs ONCE after the initial auto-install,
# from /docker-entrypoint-hooks.d/post-installation/). Every step is guarded so
# a re-run — or a manual `occ`-driven re-invoke — is a no-op.
set -euo pipefail

OCC="php /var/www/html/occ"

# ── Skeleton: replace the default Nextcloud skeleton with the Droplet guide. ──
$OCC config:system:set skeletondirectory --value="/skeleton"

# ────────────────────────────────────────────────────────────────────────────
# WARP-883 (ADR-027 WS-5) — shared "Household" space via the groupfolders app.
#
# Every Droplet user already has a PRIVATE space (their own Nextcloud account +
# WebDAV home, provisioned per-user at invite-accept). This adds the SHARED
# household space: a `groupfolders` group folder assigned to a household group.
# The groupfolders app mounts that folder into the home of every member of the
# group, so the dashboard's "Shared" space is just a well-known top-level path
# browsed with the user's OWN token — no separate account or WebDAV root.
#
# The folder NAME comes from DROPLET_SHARED_FOLDER_NAME (default "Household");
# the household GROUP name is the same value lowercased with non-alphanumerics
# collapsed to single dashes — this MUST match orchestrator's
# householdGroupName() (src/routes/auth-groups.ts) so the user-provisioning
# flows add members to the same group this script assigns the folder to.
# ────────────────────────────────────────────────────────────────────────────

SHARED_FOLDER_NAME="${DROPLET_SHARED_FOLDER_NAME:-Household}"
SHARED_FOLDER_QUOTA="${DROPLET_SHARED_FOLDER_QUOTA:-unlimited}"
# Derive the group name exactly as orchestrator's householdGroupName() does.
HOUSEHOLD_GROUP="$(printf '%s' "$SHARED_FOLDER_NAME" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
[ -z "$HOUSEHOLD_GROUP" ] && HOUSEHOLD_GROUP="household"

echo "[droplet] WARP-883: provisioning shared space '${SHARED_FOLDER_NAME}' (group '${HOUSEHOLD_GROUP}')"

# 1. Enable the groupfolders app (idempotent — occ no-ops if already enabled).
$OCC app:enable groupfolders

# 2. Ensure the household group exists (idempotent — group:add is a no-op /
#    harmless error if it already exists, so don't let it abort the script).
if ! $OCC group:list --output=json | grep -q "\"${HOUSEHOLD_GROUP}\""; then
  $OCC group:add "${HOUSEHOLD_GROUP}"
else
  echo "[droplet] group '${HOUSEHOLD_GROUP}' already exists — skipping"
fi

# 3. Create the group folder only if one with this mount name doesn't exist.
#    `groupfolders:list` prints existing folders; we match the mount_point
#    column so a re-run never creates a duplicate "Household (2)".
FOLDER_ID="$($OCC groupfolders:list --output=json 2>/dev/null \
  | php -r '
      $j = json_decode(stream_get_contents(STDIN), true) ?: [];
      $want = $argv[1];
      foreach ($j as $id => $f) {
        $mp = $f["mount_point"] ?? ($f["mountPoint"] ?? null);
        if ($mp === $want) { echo $id; exit; }
      }
    ' "$SHARED_FOLDER_NAME" 2>/dev/null || true)"

if [ -z "$FOLDER_ID" ]; then
  # `groupfolders:create` prints the new folder id (Nextcloud 29).
  FOLDER_ID="$($OCC groupfolders:create "$SHARED_FOLDER_NAME" | tr -dc '0-9')"
  echo "[droplet] created group folder '${SHARED_FOLDER_NAME}' (id ${FOLDER_ID})"
else
  echo "[droplet] group folder '${SHARED_FOLDER_NAME}' already exists (id ${FOLDER_ID}) — skipping create"
fi

# 4. Assign the household group with read/write/share permissions.
#    `groupfolders:group <id> <group>` is idempotent (re-assigning the same
#    group is a no-op). Permission bits: 31 = read+update+create+delete+share.
$OCC groupfolders:group "$FOLDER_ID" "$HOUSEHOLD_GROUP" || true
$OCC groupfolders:permissions "$FOLDER_ID" "$HOUSEHOLD_GROUP" 31 || true

# 5. Set the quota (idempotent — re-applying the same quota is a no-op).
$OCC groupfolders:quota "$FOLDER_ID" "$SHARED_FOLDER_QUOTA" || true

# 6. Add the first owner/admin to the household group so the shared folder
#    mounts for them too. The admin user is created by the Nextcloud installer
#    BEFORE this hook runs and lands in the "admin" group, but not the
#    household group — invite-accept / admin-create add later members, this
#    covers the bootstrap owner. group:adduser is idempotent.
ADMIN_USER="${NEXTCLOUD_ADMIN_USER:-admin}"
$OCC group:adduser "$HOUSEHOLD_GROUP" "$ADMIN_USER" || true

echo "[droplet] WARP-883: shared space provisioning complete"

# ── WARP-882 / WS-4 — OnlyOffice connector (in-browser editing + co-authoring) ──
#
# Enable + configure the Nextcloud `onlyoffice` connector app so it drives the
# Document Server over a WOPI-style handshake. Idempotent: `occ app:install`
# enables the app, and `occ config:app:set` overwrites on re-run, so a reflash
# reconciles cleanly. We only configure when DOCS_ENABLED is on AND a JWT secret
# is present (fail-safe: a small box that dropped the engine — or any box whose
# JWT secret is empty — skips the connector rather than wiring it to a
# non-existent engine OR to a forgeable empty/default JWT secret).
#
# URLs:
#   DocumentServerUrl         — browser-facing engine path, fronted by the
#                               gateway at /docs/ (see docker/nginx.conf).
#   DocumentServerInternalUrl — compose-network address the connector reaches
#                               the engine on directly (no gateway hop).
#   StorageUrl                — how the engine calls BACK into Nextcloud.
# The shared `jwt_secret` is the same value the engine + orchestrator verify.
#
# LICENSE: built/tested against OnlyOffice Document Server Community Edition
# (AGPLv3); an OnlyOffice OEM/commercial license is required before GA. No
# license enforcement here — the engine is config-driven (engine-agnostic WOPI).
#
# DOCS_ENABLED defaults to 1 (default-ON on the 32 GB box; ≤8 GB boxes drop the
# engine and set DOCS_ENABLED=0 — see scripts/lib/single-box.sh). An explicit
# "0"/"false" means the box dropped the engine, so the connector stays unwired.
#
# CONNECTOR-BOOTSTRAP RESILIENCE (reflash bug): `occ app:install onlyoffice`
# reaches the Nextcloud appstore, and on a real first boot the appstore/DNS is
# not yet settled — a single attempt fails. Under `set -euo pipefail` that
# failure, followed by a bare `occ app:enable`, aborted the WHOLE post-install
# hook before any `config:app:set` ran, leaving the connector unconfigured. We
# therefore (1) RETRY the install in a bounded loop so it waits the appstore
# out, (2) NEVER let a final failure abort the hook (the `if` consumes the
# non-zero exit; we log a warning to reconcile on the next boot), and (3) run
# the 5 `config:app:set` lines ONLY after a confirmed-installed connector.
#
# All occ calls in this block run as the www-data user (uid 33) — config.php is
# owned by 33, not root, and the post-installation hook runs in the entrypoint's
# root context, so a root-run occ trips Nextcloud's owner check. `occ_www` wraps
# the existing `$OCC` (php occ) with `su` to www-data; if `su`/www-data is
# somehow unavailable it falls back to the plain runner rather than aborting.
DOCS_ENABLED_NORM="$(printf '%s' "${DOCS_ENABLED:-1}" | tr '[:upper:]' '[:lower:]')"

# Run occ as the www-data user (uid 33), matching config.php's owner. Wrapped so
# the OnlyOffice block never executes occ as root (owner-check abort). Falls back
# to the plain runner when `su` to www-data isn't possible (non-fatal best-effort).
occ_www() {
  if su -p -s /bin/sh www-data -c 'true' 2>/dev/null; then
    su -p -s /bin/sh www-data -c '"$0" "$@"' -- $OCC "$@"
  else
    $OCC "$@"
  fi
}

if { [ "$DOCS_ENABLED_NORM" = "1" ] || [ "$DOCS_ENABLED_NORM" = "true" ]; } \
   && [ -n "${ONLYOFFICE_JWT_SECRET:-}" ]; then
  # Connector wiring must not abort shared-space provisioning above; the whole
  # block is isolated so a missing/incompatible onlyoffice app on a box that
  # enabled the engine doesn't take down the post-install hook (set -e).

  # 1. Resilient, bounded-retry install (waits out appstore/DNS settling on a
  #    real first boot). `app:install` ALSO enables the app, so there is no bare
  #    `app:enable` to abort the hook. The `if` consumes the non-zero exit of the
  #    final attempt so `set -e` never fires; on exhaustion we WARN and skip
  #    config (the connector reconciles on the next boot's idempotent re-run).
  onlyoffice_installed=0
  install_tries="${ONLYOFFICE_INSTALL_TRIES:-10}"
  install_interval="${ONLYOFFICE_INSTALL_INTERVAL:-6}"
  i=0
  while [ "$i" -lt "$install_tries" ]; do
    i=$((i + 1))
    # `app:install` is idempotent: on a box that already has the connector it
    # exits 0 (already installed/enabled), so a reflash short-circuits the loop
    # on the first attempt.
    if occ_www app:install onlyoffice >/dev/null 2>&1; then
      onlyoffice_installed=1
      break
    fi
    # Defence in depth: the app may already be present (install reports an error
    # like "already installed") — treat a present app as installed so we still
    # (re)apply config on a reflash even if `app:install` is unhappy.
    if occ_www app:list 2>/dev/null | grep -q 'onlyoffice'; then
      occ_www app:enable onlyoffice >/dev/null 2>&1 \
        || echo "[droplet] WARP-882: warning — app:enable onlyoffice failed; connector present but may stay disabled until manually enabled" >&2
      onlyoffice_installed=1
      break
    fi
    echo "[droplet] WARP-882: onlyoffice connector install attempt ${i}/${install_tries} failed (appstore not ready?) — retrying in ${install_interval}s" >&2
    sleep "$install_interval"
  done

  # 2. Configure ONLY after a confirmed-installed connector. Each `config:app:set`
  #    is an idempotent overwrite, so a reflash reconciles cleanly; `|| true`
  #    keeps a single transient failure from aborting the block.
  if [ "$onlyoffice_installed" = 1 ]; then
    occ_www config:app:set onlyoffice DocumentServerUrl \
      --value="/docs/" || true
    occ_www config:app:set onlyoffice DocumentServerInternalUrl \
      --value="http://docserver/" || true
    occ_www config:app:set onlyoffice StorageUrl \
      --value="http://nextcloud/" || true
    occ_www config:app:set onlyoffice jwt_secret \
      --value="${ONLYOFFICE_JWT_SECRET}" || true
    occ_www config:app:set onlyoffice jwt_header \
      --value="Authorization" || true
    echo "[droplet] WARP-882: OnlyOffice connector configured (doc-server default-on)"
  else
    echo "nextcloud-init: OnlyOffice connector install did NOT complete after ${install_tries} attempts (appstore unreachable?) — leaving it unconfigured; the next boot's idempotent re-run will reconcile it" >&2
  fi
else
  echo "nextcloud-init: OnlyOffice connector NOT configured (DOCS_ENABLED='${DOCS_ENABLED:-1}', jwt secret $( [ -n "${ONLYOFFICE_JWT_SECRET:-}" ] && echo set || echo empty ))" >&2
fi
