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
# Document Server over a WOPI-style handshake. Idempotent: `occ app:enable` and
# `occ config:app:set` are no-ops / overwrites on re-run, and we only configure
# when DOCS_ENABLED is on AND a JWT secret is present (fail-safe: an unconfigured
# box — the DEFAULT, since the doc-server is opt-in / default-off — skips the
# connector rather than wiring it to a non-existent engine OR to a forgeable
# empty/default JWT secret).
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
# DOCS_ENABLED defaults to 0 (opt-in / default-off — Stefan sign-off): an unset
# value means the operator did NOT opt in, so the connector stays unwired.
DOCS_ENABLED_NORM="$(printf '%s' "${DOCS_ENABLED:-0}" | tr '[:upper:]' '[:lower:]')"
if { [ "$DOCS_ENABLED_NORM" = "1" ] || [ "$DOCS_ENABLED_NORM" = "true" ]; } \
   && [ -n "${ONLYOFFICE_JWT_SECRET:-}" ]; then
  # Connector wiring must not abort shared-space provisioning above; isolate
  # failures with `|| true` so a missing/incompatible onlyoffice app on a box
  # that opted in doesn't take down the whole post-install hook (set -e).
  $OCC app:install onlyoffice 2>/dev/null || true
  $OCC app:enable onlyoffice || true
  $OCC config:app:set onlyoffice DocumentServerUrl \
    --value="/docs/" || true
  $OCC config:app:set onlyoffice DocumentServerInternalUrl \
    --value="http://docserver/" || true
  $OCC config:app:set onlyoffice StorageUrl \
    --value="http://nextcloud/" || true
  $OCC config:app:set onlyoffice jwt_secret \
    --value="${ONLYOFFICE_JWT_SECRET}" || true
  $OCC config:app:set onlyoffice jwt_header \
    --value="Authorization" || true
  echo "[droplet] WARP-882: OnlyOffice connector configured (doc-server opt-in)"
else
  echo "nextcloud-init: OnlyOffice connector NOT configured (DOCS_ENABLED='${DOCS_ENABLED:-0}', jwt secret $( [ -n "${ONLYOFFICE_JWT_SECRET:-}" ] && echo set || echo empty ))" >&2
fi
