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
#
#    WARP-1064: groupfolders is NOT bundled with nextcloud:29 — `app:enable`
#    fetches it from the Nextcloud appstore, and on a real first boot the
#    appstore/DNS is not yet settled (the exact failure mode the OnlyOffice
#    block below was already hardened against in WARP-990). This used to be
#    a single un-retried attempt under `set -euo pipefail`, so an unsettled
#    appstore aborted the WHOLE hook right here — before the household group
#    was ever created — leaving the bare-Nextcloud state that 500'd the
#    setup wizard (WARP-989). Worse, the entrypoint's run_path treats a hook
#    failure as fatal, so the first-boot container exited and restarted
#    mid-provision. Same treatment as OnlyOffice: bounded retry, never
#    fatal. On exhaustion we still create the household group (independent
#    of the app) and skip only the folder steps; the WARP-990 reconcile
#    re-runs this idempotent hook on the next bring-up and converges them.
groupfolders_ready=0
gf_tries="${GROUPFOLDERS_INSTALL_TRIES:-10}"
gf_interval="${GROUPFOLDERS_INSTALL_INTERVAL:-6}"
gf_i=0
while [ "$gf_i" -lt "$gf_tries" ]; do
  gf_i=$((gf_i + 1))
  if $OCC app:enable groupfolders; then
    groupfolders_ready=1
    break
  fi
  echo "[droplet] WARP-883: groupfolders enable attempt ${gf_i}/${gf_tries} failed (appstore not ready?) — retrying in ${gf_interval}s" >&2
  sleep "$gf_interval"
done
if [ "$groupfolders_ready" != 1 ]; then
  echo "[droplet] WARP-883: groupfolders did NOT enable after ${gf_tries} attempts (appstore unreachable?) — provisioning the household group only; the next boot's idempotent re-run will reconcile the shared folder" >&2
fi

# 1b. WARP-1338 — enable the bundled `files_external` app so drive/pool
#     registrations (`occ files_external:create`, invoked from
#     services/automount/droplet-automount.sh and
#     scripts/host/droplet-storage-pool.sh on the host) have a namespace to
#     land in. Without it every registration fails and the dashboard's drive
#     tiles deep-link into a WebDAV 404. Unlike groupfolders/onlyoffice,
#     files_external SHIPS INSIDE the Nextcloud image (no appstore fetch), so
#     a single retry-free enable is the correct shape — occ no-ops when the
#     app is already enabled. Never fatal under `set -e`: a transient failure
#     logs and reconciles on the next boot's idempotent re-run (same posture
#     as the blocks around it).
if $OCC app:enable files_external; then
  echo "[droplet] WARP-1338: files_external enabled (external-storage drive browsing)"
else
  echo "[droplet] WARP-1338: files_external did NOT enable — drive tiles won't browse until the next boot's idempotent re-run reconciles it" >&2
fi

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
#    Skipped entirely (steps 3–5) when groupfolders never enabled — the occ
#    commands don't exist without the app; the next re-run reconciles.
if [ "$groupfolders_ready" = 1 ]; then
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
fi # groupfolders_ready

# 6. Add the first owner/admin to the household group so the shared folder
#    mounts for them too. The admin user is created by the Nextcloud installer
#    BEFORE this hook runs and lands in the "admin" group, but not the
#    household group — invite-accept / admin-create add later members, this
#    covers the bootstrap owner. group:adduser is idempotent.
ADMIN_USER="${NEXTCLOUD_ADMIN_USER:-admin}"
$OCC group:adduser "$HOUSEHOLD_GROUP" "$ADMIN_USER" || true

echo "[droplet] WARP-883: shared space provisioning complete"

# ── WARP-882 / WARP-1686 — document-engine connector (in-browser viewing/editing) ──
#
# Wire the Nextcloud connector app for the CONFIGURED engine (DOCS_ENGINE):
#   * collabora (default) — `richdocuments` (Nextcloud Office) driving
#     Collabora CODE (LibreOffice technology). NO licensing fee (ADR-034:
#     MPLv2 core, free binaries) — this is why it is the default.
#   * onlyoffice — the original WARP-882 `onlyoffice` connector wiring,
#     preserved verbatim for a future OEM-licensed SKU (AGPLv3 CE otherwise).
# Idempotent: `occ app:install` enables the app and `occ config:*:set`
# overwrites on re-run, so the WARP-990 every-boot reconcile converges an
# EXISTING box onto the configured engine without a reflash.
#
# DOCS_ENABLED defaults to 1 (default-ON on the 32 GB box; ≤8 GB boxes drop the
# engine and set DOCS_ENABLED=0 — see scripts/lib/single-box.sh). An explicit
# "0"/"false" means the box dropped the engine, so no connector gets wired.
#
# CONNECTOR-BOOTSTRAP RESILIENCE (the WARP-990/#691 reflash bug): `occ
# app:install` reaches the Nextcloud appstore, and on a real first boot the
# appstore/DNS is not yet settled — a single attempt fails, and under
# `set -euo pipefail` an unguarded failure aborts the WHOLE post-install hook.
# `nc_app_install` below therefore (1) RETRIES in a bounded loop, (2) NEVER
# lets a final failure abort the hook (callers consume the non-zero exit in an
# `if`; we WARN and reconcile on the next boot), and (3) callers apply config
# ONLY after a confirmed-installed app.
#
# All occ calls in this block run as the www-data user (uid 33) — config.php is
# owned by 33, not root, and the post-installation hook runs in the entrypoint's
# root context, so a root-run occ trips Nextcloud's owner check. `occ_www` wraps
# the existing `$OCC` (php occ) with `su` to www-data; if `su`/www-data is
# somehow unavailable it falls back to the plain runner rather than aborting.
DOCS_ENABLED_NORM="$(printf '%s' "${DOCS_ENABLED:-1}" | tr '[:upper:]' '[:lower:]')"

# Run occ as the www-data user (uid 33), matching config.php's owner. Wrapped so
# this block never executes occ as root (owner-check abort). Falls back to the
# plain runner when `su` to www-data isn't possible (non-fatal best-effort).
occ_www() {
  if su -p -s /bin/sh www-data -c 'true' 2>/dev/null; then
    su -p -s /bin/sh www-data -c '"$0" "$@"' -- $OCC "$@"
  else
    $OCC "$@"
  fi
}

# nc_app_install <app> [tries] [interval] — bounded-retry appstore install
# (the WARP-882/WARP-990 resilience pattern, generalized for every app this
# hook provisions). `app:install` is idempotent (exit 0 when already
# installed), so a reflash short-circuits on the first attempt. Defence in
# depth: an app that is PRESENT but unhappy on `app:install` (e.g. "already
# installed" reported as an error) is enabled and treated as installed so a
# reflash still (re)applies config. Returns non-zero only after exhausting
# the retries — callers MUST consume that in an `if` (set -e).
nc_app_install() {
  local app="$1"
  local tries="${2:-${NC_APP_INSTALL_TRIES:-10}}"
  local interval="${3:-${NC_APP_INSTALL_INTERVAL:-6}}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    i=$((i + 1))
    if occ_www app:install "$app" >/dev/null 2>&1; then
      return 0
    fi
    if occ_www app:list 2>/dev/null | grep -q "$app"; then
      occ_www app:enable "$app" >/dev/null 2>&1 \
        || echo "[droplet] WARP-1686: warning — app:enable $app failed; app present but may stay disabled until manually enabled" >&2
      return 0
    fi
    echo "[droplet] WARP-1686: $app install attempt ${i}/${tries} failed (appstore not ready?) — retrying in ${interval}s" >&2
    sleep "$interval"
  done
  return 1
}

if [ "$DOCS_ENABLED_NORM" = "1" ] || [ "$DOCS_ENABLED_NORM" = "true" ]; then
  # Connector wiring must not abort shared-space provisioning above; every
  # step is isolated (`if` + `|| true`) so a missing/incompatible connector
  # app never takes down the post-install hook (set -e).
  case "${DOCS_ENGINE:-collabora}" in
    onlyoffice)
      # WARP-882 wiring, preserved. Only configured when a JWT secret is
      # present (fail-safe: an empty secret would be a forgeable HS256 key,
      # so the connector stays unwired rather than trusting it).
      #   DocumentServerUrl         — browser-facing engine path (gateway /docs/).
      #   DocumentServerInternalUrl — compose-network address, no gateway hop.
      #   StorageUrl                — how the engine calls BACK into Nextcloud.
      if [ -n "${ONLYOFFICE_JWT_SECRET:-}" ]; then
        if nc_app_install onlyoffice "${ONLYOFFICE_INSTALL_TRIES:-10}" "${ONLYOFFICE_INSTALL_INTERVAL:-6}"; then
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
          echo "[droplet] WARP-882: OnlyOffice connector configured (DOCS_ENGINE=onlyoffice)"
        else
          echo "nextcloud-init: OnlyOffice connector install did NOT complete (appstore unreachable?) — leaving it unconfigured; the next boot's idempotent re-run will reconcile it" >&2
        fi
      else
        echo "nextcloud-init: OnlyOffice connector NOT configured (jwt secret empty — fail-safe)" >&2
      fi
      ;;
    *)
      # collabora (default) — Nextcloud Office (`richdocuments`) → Collabora
      # CODE. URL split (all overridable for non-standard topologies):
      #   wopi_url          — where NEXTCLOUD reaches the engine server-side
      #                       (discovery, convert-to). Compose-internal; the
      #                       :9980/docs suffix matches coolwsd's port +
      #                       net.service_root (docker-compose.yml).
      #   public_wopi_url   — where the BROWSER loads the editor from. A
      #                       RELATIVE "/docs" keeps the editor same-origin
      #                       with whatever hostname the user browsed in on
      #                       (FQDN, droplet-ai.local, .lan) — no cross-origin
      #                       iframe, no cert coupling, works pre-issuance.
      #                       richdocuments consumes the value verbatim
      #                       (rtrim only), so a path-relative base is safe.
      #   wopi_callback_url — where the ENGINE calls back into Nextcloud
      #                       (WOPI CheckFileInfo/GetFile/PutFile). Pinned to
      #                       the compose-internal Nextcloud so the callback
      #                       rides the docker network regardless of browser
      #                       origin — and matches the engine's aliasgroup1
      #                       allowlist exactly (docker-compose.yml).
      # allow_local_remote_servers: Nextcloud's HTTP client refuses
      # private/local hosts by default; the wopi_url discovery fetch needs it
      # on a compose network. Appliance-internal, documented posture.
      # No JWT gate here — Collabora's trust model is the aliasgroup
      # allowlist + WOPI proof keys, not a shared HS256 secret.
      if nc_app_install richdocuments; then
        occ_www config:app:set richdocuments wopi_url \
          --value="${RICHDOCUMENTS_WOPI_URL:-http://docserver:9980/docs}" || true
        occ_www config:app:set richdocuments public_wopi_url \
          --value="${RICHDOCUMENTS_PUBLIC_WOPI_URL:-/docs}" || true
        occ_www config:app:set richdocuments wopi_callback_url \
          --value="${RICHDOCUMENTS_CALLBACK_URL:-http://nextcloud/}" || true
        occ_www config:system:set allow_local_remote_servers --value=true --type=boolean || true
        # Re-fetch discovery so a config change applies now, not on TTL expiry.
        occ_www richdocuments:activate-config >/dev/null 2>&1 \
          || echo "[droplet] WARP-1686: richdocuments:activate-config failed (engine still starting?) — discovery refreshes on the next reconcile" >&2
        echo "[droplet] WARP-1686: Nextcloud Office connector configured (richdocuments → Collabora CODE)"
      else
        echo "nextcloud-init: richdocuments connector install did NOT complete (appstore unreachable?) — leaving it unconfigured; the next boot's idempotent re-run will reconcile it" >&2
      fi
      ;;
  esac
else
  echo "nextcloud-init: document-engine connector NOT configured (DOCS_ENABLED='${DOCS_ENABLED:-1}')" >&2
fi

# ── WARP-1686 — viewer apps: DICOM (X-rays) + 3D models ──
#
# Free, engine-independent Nextcloud apps that widen what Files can open
# in-browser (the "view all document types" half of WARP-1686):
#   * dicomviewer         — OHIF-based DICOM viewer (AGPL-3.0; NC 28–32):
#                           .dcm X-rays/scans, 2D/3D/MPR.
#   * files_3dmodelviewer — 3D model viewer (free; NC 24–34): STL/OBJ/glTF —
#                           the 3D-CAD exchange formats.
# Both are pure PHP/JS apps (no engine, no extra container, no RAM gate), so
# they install unconditionally. Best-effort with the same bounded-retry +
# never-fatal posture as the connector: a miss reconciles on the next boot.
if nc_app_install dicomviewer; then
  echo "[droplet] WARP-1686: DICOM viewer installed (.dcm X-ray/scan viewing)"
else
  echo "nextcloud-init: dicomviewer install did NOT complete — .dcm viewing reconciles on the next boot's idempotent re-run" >&2
fi
if nc_app_install files_3dmodelviewer; then
  echo "[droplet] WARP-1686: 3D model viewer installed (STL/OBJ/glTF viewing)"
else
  echo "nextcloud-init: files_3dmodelviewer install did NOT complete — 3D viewing reconciles on the next boot's idempotent re-run" >&2
fi

# ── WARP-1686 — preview providers: widen image coverage (TIFF/HEIC/SVG) ──
#
# Nextcloud enables a conservative provider set by default; scanned documents
# and X-ray exports are frequently TIFF, and phone photos HEIC. Setting
# `enabledPreviewProviders` REPLACES the built-in default set, so the default
# providers are re-listed first and the three additions follow. The list is an
# ARRAY system value — config:system:set writes one indexed entry per call,
# and re-running overwrites the same indices (idempotent). A provider whose
# imagick delegate is missing simply yields no preview for that type — never
# an error. These previews feed BOTH the Nextcloud UI and the dashboard's
# thumbnail proxy (files.ts → ncFetchThumbnail).
pv_i=0
for pv in PNG JPEG GIF BMP XBitmap MP3 TXT MarkDown OpenDocument Krita TIFF HEIC SVG; do
  occ_www config:system:set enabledPreviewProviders "$pv_i" --value "OC\\Preview\\${pv}" || true
  pv_i=$((pv_i + 1))
done
echo "[droplet] WARP-1686: preview providers set (defaults + TIFF/HEIC/SVG)"
