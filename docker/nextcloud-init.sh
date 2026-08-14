#!/bin/bash
# Nextcloud first-boot + reconcile hook. Mounted at
# /docker-entrypoint-hooks.d/before-starting/, which the stock entrypoint runs
# on EVERY container start (after any install/upgrade) — so this converges the
# box's Nextcloud state on each boot rather than only on the run that installed
# it (WARP-1694; it lived in post-installation before, where it fired exactly
# once in a box's lifetime). Every step is guarded so a re-run — or a manual
# `occ`-driven re-invoke — is a no-op, which is what makes the "reconciles on
# the next boot" fallbacks below true rather than aspirational.
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

# ── WARP-1688 — reconcile trusted_domains from the container env, every boot ──
#
# Nextcloud answers HTTP 400 "Access through untrusted domain" for any request
# whose Host is absent from its STORED `trusted_domains`. docker-compose.yml
# already renders the correct list into NEXTCLOUD_TRUSTED_DOMAINS — including
# ADR-023's publicly-trusted per-device FQDN (${DROPLET_PUBLIC_FQDN}) — but the
# stock `nextcloud:29-apache` image consumes that env var ONLY inside its
# install branch. A box that learns its FQDN AFTER install (every box does — HQ
# issues the name later) therefore freezes its stored list at install time and
# never trusts its own public name.
#
# Measured on the box: the container env carried the FQDN, `occ
# config:system:get trusted_domains` stopped at droplet.lan, and the gateway's
# /nextcloud/ leg answered 400 for `Host: <fqdn>`. Because the friendly
# .local/.lan names 307 to that same FQDN, there was NO hostname at which a
# browser-facing Nextcloud page could render — the dashboard's embedded editor
# included. Same "set once, never reconciled" class as WARP-1694, and the same
# fix shape: converge it here, in the every-boot before-starting hook.
#
# ADD-ONLY, deliberately. Entries are never removed: a stale name after a
# rename no longer resolves to the box (inert), whereas a reconcile that
# deletes could take a live box off the air over a transient env glitch.
# Add-only is also what makes a converged boot write nothing at all.
#
# Sits BEFORE the connector block below because that block's appstore retries
# can burn a minute per app, and trusted_domains is what makes the box
# browsable at all — it must not queue behind them.
# >>> reconcile_trusted_domains (WARP-1688)
# Read the stored trusted_domains as one domain per line.
#
# The `|| true` INSIDE the substitution is load-bearing, not style (the
# WARP-1694 lesson, restated): `occ config:system:get` EXITS NON-ZERO for an
# unset key, and a failing command substitution carries that status into the
# assignment — so under `set -euo pipefail` a box with no stored list would
# abort the whole hook right here.
#
# occ prints an array value one element per line, prefixed with "  - " in its
# plain output format. The sed tolerates BOTH that and a bare value, so a
# future format change degrades to "re-add" rather than to "mis-parse and stack
# duplicates".
_td_read() {
  { occ_www config:system:get trusted_domains 2>/dev/null || true; } \
    | sed -e 's/\r$//' \
          -e 's/^[[:space:]]*-[[:space:]]*//' \
          -e 's/^[[:space:]]*//' \
          -e 's/[[:space:]]*$//' \
    | grep -v '^$' || true
}

# Advance $1 to the first index at which trusted_domains has NO element, and
# echo it.
#
# Why not just use the element COUNT? Because an array with a HOLE (an index
# deleted by hand at some point) makes the count collide with a live index, and
# writing there would silently REPLACE a domain the box currently answers on —
# the exact data loss the add-only posture exists to avoid. `occ
# config:system:get <name> <index>` exits non-zero when that index is unset,
# which is precisely the probe needed.
#
# On the overwhelmingly common contiguous array this probes exactly once and
# finds the slot free.
#
# EVERY index this echoes has been probed and found free — the bound is a
# give-up, never a guess. Returning `start + bound` unprobed (which an
# increment-after-probe loop does) would hand the caller a possibly-OCCUPIED
# index and reintroduce the very overwrite this function exists to prevent. On
# exhaustion it prints nothing and returns non-zero; the caller refuses the
# write and says so, and the read-back below reports the domain as missing.
_td_next_free_index() {
  _td_idx="$1"
  _td_probe=0
  while [ "$_td_probe" -lt 64 ]; do
    if ! occ_www config:system:get trusted_domains "$_td_idx" >/dev/null 2>&1; then
      printf '%s' "$_td_idx"
      return 0
    fi
    _td_idx=$((_td_idx + 1))
    _td_probe=$((_td_probe + 1))
  done
  return 1
}

reconcile_trusted_domains() {
  td_want_raw="${NEXTCLOUD_TRUSTED_DOMAINS:-}"

  # Pathname expansion is ON in this script. The unquoted word-split below IS
  # how the space-separated env list is meant to be read, but a token carrying
  # a glob metacharacter would otherwise expand against the CWD — so split with
  # globbing off. `set --` touches only this function's positional parameters,
  # and empty tokens (the trailing blank when DROPLET_PUBLIC_FQDN is unset) are
  # dropped by the split itself, so no empty domain can reach a write.
  set -f
  # shellcheck disable=SC2086
  set -- $td_want_raw
  set +f
  if [ "$#" -eq 0 ]; then
    echo "[droplet] WARP-1688: NEXTCLOUD_TRUSTED_DOMAINS is empty — leaving the stored trusted_domains untouched" >&2
    return 0
  fi

  td_have="$(_td_read)"
  td_next="$(printf '%s\n' "$td_have" | grep -c '.' || true)"
  td_flat=" $(printf '%s' "$td_have" | tr '\n' ' ') "

  td_added=0
  # Domains we WANTED to add and could not. Tracked separately from td_added so
  # a run that refused every write cannot fall into the "already converged"
  # early return below and report "nothing to do" over a box that still answers
  # 400 on its own FQDN.
  td_refused=0
  for td_want in "$@"; do
    # Belt-and-braces: never write something that is not a hostname. A malformed
    # token in the env would otherwise land in the trust list verbatim.
    case "$td_want" in
      ""|*[!a-zA-Z0-9._:-]*)
        echo "[droplet] WARP-1688: skipping malformed trusted-domain token '${td_want}'" >&2
        continue
        ;;
    esac
    # Already trusted → no write. This is the whole idempotence story: a
    # converged box issues zero writes, so repeat boots cannot stack duplicates.
    case "$td_flat" in
      *" $td_want "*) continue ;;
    esac
    # No free slot within the probe bound → REFUSE. Writing at an index we
    # never verified as free could replace a domain the box currently answers
    # on; leaving this one unadded is recoverable (the next boot retries),
    # clobbering a live domain is not.
    if ! td_slot="$(_td_next_free_index "$td_next")"; then
      echo "[droplet] WARP-1688: could not find a FREE trusted_domains index within 64 probes from ${td_next} — REFUSING to add '${td_want}' rather than risk overwriting a domain this box currently answers on. Inspect 'occ config:system:get trusted_domains'; the next boot retries." >&2
      td_refused=$((td_refused + 1))
      continue
    fi
    td_next="$td_slot"
    if occ_www config:system:set trusted_domains "$td_next" --value="$td_want"; then
      echo "[droplet] WARP-1688: trusted_domains += '${td_want}' (index ${td_next})"
      td_flat="${td_flat}${td_want} "
      td_next=$((td_next + 1))
      td_added=$((td_added + 1))
    else
      echo "[droplet] WARP-1688: FAILED to add trusted domain '${td_want}' — Nextcloud will answer 400 'untrusted domain' for that host" >&2
      td_refused=$((td_refused + 1))
    fi
  done

  # "Nothing to do" is only true when nothing was NEEDED. A run that wanted to
  # add something and could not must fall through to the read-back, which names
  # the still-missing domain — otherwise the loudest line in the log is a
  # reassuring one.
  if [ "$td_added" -eq 0 ] && [ "$td_refused" -eq 0 ]; then
    echo "[droplet] WARP-1688: trusted_domains already converged (${td_next} entries) — nothing to do"
    return 0
  fi

  # Read back and ASSERT, exactly like the WARP-1686 URL-trio check below. The
  # failure this catches is silent by nature: the writes above are best-effort,
  # the hook exits 0 regardless, and the only other symptom is a 400 in
  # someone's browser hours later.
  td_after_flat=" $(_td_read | tr '\n' ' ') "
  td_drift=0
  for td_want in "$@"; do
    case "$td_want" in
      ""|*[!a-zA-Z0-9._:-]*) continue ;;
    esac
    case "$td_after_flat" in
      *" $td_want "*) ;;
      *)
        echo "[droplet] WARP-1688: trusted_domains is STILL missing '${td_want}' after the reconcile — Nextcloud will answer HTTP 400 'Access through untrusted domain' on that host, so every browser-facing Nextcloud page (the dashboard's embedded editor included) fails to render there." >&2
        td_drift=1
        ;;
    esac
  done
  if [ "$td_drift" -eq 0 ]; then
    echo "[droplet] WARP-1688: trusted_domains reconciled (+${td_added}); every configured domain verified"
  else
    echo "[droplet] WARP-1688: trusted_domains did NOT verify — see the lines above. Non-fatal; the next boot re-runs this hook." >&2
  fi
}
# <<< reconcile_trusted_domains (WARP-1688)

# >>> reconcile_overwrite_protocol (WARP-1973)
# `overwriteprotocol` is the SECOND key caught by the trap WARP-1688 fixed for
# trusted_domains: docker-compose.yml sets OVERWRITEPROTOCOL=https, but the
# stock image consumes it ONLY inside its install branch, so a box installed
# before that env existed — or any box whose config volume predates it —
# freezes with the key empty forever. Measured on the live box: empty.
#
# What that costs, measured: the gateway terminates TLS and the browser is on
# https, but Nextcloud builds absolute redirects from the REQUEST, so with the
# key empty it emits `Location: http://<host>/…`. A browser blocks that as
# mixed content inside an iframe, and the dashboard's embedded editor shows a
# spinner that never resolves. WARP-1966 removed the particular redirect that
# exposed it, but every other redirect Nextcloud emits still carries the wrong
# scheme until this converges.
#
# DELIBERATELY NOT `overwritehost`. isTrustedDomain() returns TRUE
# UNCONDITIONALLY when overwritehost is non-empty
# (lib/private/Security/TrustedDomainHelper.php), so setting it would silently
# disable the entire trusted-domains allowlist — turning a Host-header
# allowlist into an accept-anything. It is the obvious-looking neighbouring
# knob, which is exactly why it is called out here and guarded by a test.
reconcile_overwrite_protocol() {
  # `:-` on purpose: an UNSET *or EMPTY* env still converges to https. This
  # appliance always terminates TLS at the gateway and 301s plain http, so
  # https is the only correct value here and there is no "leave it unmanaged"
  # state worth honouring — a box whose env lost the variable should still end
  # up right. A non-empty value is honoured verbatim, so an operator who really
  # means http can still say so in compose.
  op_want="${OVERWRITEPROTOCOL:-https}"

  # `|| true` INSIDE the substitution — occ exits non-zero for an unset key and
  # that status would abort the hook under `set -euo pipefail` (WARP-1694).
  op_got="$( { occ_www config:system:get overwriteprotocol 2>/dev/null || true; } | tr -d '\r\n' )"

  if [ "$op_got" = "$op_want" ]; then
    echo "[droplet] WARP-1973: overwriteprotocol already '$op_want' — nothing to do"
  elif occ_www config:system:set overwriteprotocol --value="$op_want" >/dev/null 2>&1; then
    echo "[droplet] WARP-1973: overwriteprotocol '${op_got:-<unset>}' → '$op_want'"
  else
    echo "[droplet] WARP-1973: could not set overwriteprotocol — Nextcloud will emit absolute URLs with the REQUEST's scheme, so an https page can get http redirects (mixed content, blocked in the editor iframe). Non-fatal; the next boot retries." >&2
  fi

  # An overwritehost that got set by hand nullifies the allowlist. Report it
  # LOUDLY rather than clearing it: it may be deliberate on some topology, and
  # silently rewriting another operator's security-relevant config is worse
  # than telling them. Never SET it here.
  oh_got="$( { occ_www config:system:get overwritehost 2>/dev/null || true; } | tr -d '\r\n' )"
  if [ -n "$oh_got" ]; then
    echo "[droplet] WARP-1973: WARNING — overwritehost is set to '$oh_got'. isTrustedDomain() returns true unconditionally while that is non-empty, so the trusted_domains allowlist above is INERT and Nextcloud accepts any Host header. Clear it unless this box genuinely needs it." >&2
  fi
}
# <<< reconcile_overwrite_protocol (WARP-1973)

# >>> disable_hub_apps (WARP-1979)
# Nextcloud is a HEADLESS STORAGE BACKEND here. The user's interface is the
# Droplet dashboard; the only Nextcloud-rendered page a user is ever shown is
# the document editor, embedded in an iframe. But the stock image ships the
# consumer "Hub" apps enabled, and they inject into EVERY page Nextcloud
# renders — including that iframe.
#
# Reported symptom: clicking Edit "brings up Nextcloud Hub". `firstrunwizard`
# is precisely that — its entire job is the "Welcome to Nextcloud Hub" splash
# on a user's first page load, and every new user gets it exactly once, which
# is why it reads as intermittent. Measured on the live box: the rendered
# editor page pulled in firstrunwizard-style.css and updatenotification-init.js
# before this landed, and neither afterwards.
#
# The rest are disabled for two reasons beyond chrome:
#   * `survey_client` and `nextcloud_announcements` PHONE HOME to Nextcloud's
#     servers. On an appliance sold on not doing that, they are a defect
#     regardless of what they render.
#   * `updatenotification` nags about Nextcloud releases this appliance does
#     not apply on its own schedule — the box updates as a unit.
#   * `support` advertises Nextcloud Enterprise; `weather_status` calls an
#     external weather API from the user menu; `recommendations` is noise.
#
# NOT `dashboard` and NOT `activity`, deliberately. `dashboard` is Nextcloud's
# default landing app — disabling it changes what the bare /nextcloud/ route
# serves, which is a different decision from cleaning up the editor iframe, and
# nothing in the editor flow loads it. `activity` backs file-activity data other
# apps read. Neither appears in the editor page's asset list.
#
# Disabled, never removed: an operator who wants one back gets an app:enable,
# with no appstore round-trip on a box that may have no egress. Idempotent and
# non-fatal — this must never take down the boot hook.
disable_hub_apps() {
  hub_disabled=""
  for hub_app in firstrunwizard updatenotification nextcloud_announcements \
                 survey_client support weather_status recommendations; do
    # Match the app NAME in the Enabled block, not anywhere in occ's output:
    # every one of these also appears under "Disabled:" once it is off, and a
    # loose grep would retry the disable on every single boot forever.
    if occ_www app:list 2>/dev/null \
       | sed -n '/Enabled:/,/Disabled:/p' \
       | grep -qE "^[[:space:]]*- ${hub_app}:"; then
      if occ_www app:disable "$hub_app" >/dev/null 2>&1; then
        hub_disabled="$hub_disabled $hub_app"
      else
        echo "[droplet] WARP-1979: could not disable '${hub_app}' — it will keep injecting into the embedded editor page" >&2
      fi
    fi
  done
  if [ -n "$hub_disabled" ]; then
    echo "[droplet] WARP-1979: disabled Nextcloud Hub apps:${hub_disabled}"
  else
    echo "[droplet] WARP-1979: no Hub apps enabled — nothing to do"
  fi
}
# <<< disable_hub_apps (WARP-1979)

reconcile_trusted_domains
reconcile_overwrite_protocol
disable_hub_apps

# >>> disable_other_connector (WARP-1973)
# The engine choice must be EXCLUSIVE. This hook configures the connector for
# the selected DOCS_ENGINE but never disabled the other one, so a box that was
# ever switched — or that picked the app up any other way — ends up running
# both. Measured on the live box: richdocuments 8.4.16 AND onlyoffice 9.8.0
# both enabled, with onlyoffice pointed at http://docserver/ (port 80, where
# nothing listens; Collabora serves 9980).
#
# That is not cosmetic. Both apps register preview providers and file actions
# for the SAME Office MIME types, so which one answers a preview or an open is
# not deterministic, and the loser's provider fails: nextcloud.log carries
# `onlyoffice … getConvertedUri: from docx to jpeg … cURL error 7: Failed to
# connect to docserver port 80` on every attempt.
#
# Disable, never uninstall: a switch back to the other engine then costs an
# app:enable rather than an appstore round-trip on a box that may have no
# egress. Non-fatal throughout — a failure here must not take down the hook.
disable_other_connector() {
  doc_other="$1"
  # WARP-1989 — scope the match to the Enabled block. `occ app:list` prints the
  # same app names under BOTH "Enabled:" and "Disabled:", so an unscoped match
  # still succeeds once the app is off: the hook re-issued app:disable on every
  # boot and logged "disabled the '<app>' connector" forever. A log line
  # claiming a state change that did not happen is worse than silence — it is
  # what an operator reads when working out whether the engine actually flipped.
  #
  # disable_hub_apps below already does this and says why. The fix was
  # understood and simply not applied to the function beside it.
  if occ_www app:list 2>/dev/null \
     | sed -n '/Enabled:/,/Disabled:/p' \
     | grep -qE "^[[:space:]]*- ${doc_other}:"; then
    if occ_www app:disable "$doc_other" >/dev/null 2>&1; then
      echo "[droplet] WARP-1973: disabled the '${doc_other}' connector — DOCS_ENGINE selects exactly one"
    else
      echo "[droplet] WARP-1973: could not disable '${doc_other}'; two connectors remain enabled and may race for the same Office MIME types" >&2
    fi
  fi
}
# <<< disable_other_connector (WARP-1973)

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
          # WARP-1973 — only AFTER this engine is known-configured. Disabling
          # the other one first would leave a box with NO working connector if
          # the wiring above failed.
          disable_other_connector richdocuments
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
        rd_wopi="${RICHDOCUMENTS_WOPI_URL:-http://docserver:9980/docs}"
        rd_public="${RICHDOCUMENTS_PUBLIC_WOPI_URL:-/docs}"
        rd_callback="${RICHDOCUMENTS_CALLBACK_URL:-http://nextcloud/}"

        occ_www config:system:set allow_local_remote_servers --value=true --type=boolean || true

        # WARP-1694 — ORDER IS LOAD-BEARING: activate-config runs BETWEEN the
        # wopi_url write and the other two, and it must not be moved.
        #
        # `richdocuments:activate-config` re-fetches discovery from wopi_url,
        # so wopi_url has to be set before it. But the command does not only
        # read — on richdocuments 8.4.16 it REWRITES the other two values it
        # thinks it owns: it resets wopi_callback_url to "autodetect" (empty)
        # and replaces public_wopi_url with the ABSOLUTE discovery host
        # (`https://docserver:9980`). Both results are wrong here: docserver is
        # a compose-internal name no browser can resolve, and an autodetected
        # callback follows the browser's origin instead of the compose-internal
        # host coolwsd's aliasgroup1 allowlist pins.
        #
        # Setting all three first and then activating — which is what this did
        # before — therefore self-defeats: the editor iframe ends up pointed at
        # https://docserver:9980. Writing the browser-facing pair AFTER
        # activation is what makes the intended values the ones that survive.
        # Discovery stays cached from the activation, so nothing is lost.
        occ_www config:app:set richdocuments wopi_url --value="$rd_wopi" || true
        occ_www richdocuments:activate-config >/dev/null 2>&1 \
          || echo "[droplet] WARP-1686: richdocuments:activate-config failed (engine still starting?) — discovery refreshes on the next reconcile" >&2
        occ_www config:app:set richdocuments public_wopi_url --value="$rd_public" || true
        occ_www config:app:set richdocuments wopi_callback_url --value="$rd_callback" || true

        # WARP-1694 — read the three values back. The failure this catches is
        # silent by nature: the editor only breaks in the browser, long after
        # this script exits 0, and every command above is `|| true`. If a
        # future richdocuments changes which values activate-config claims,
        # this is what says so out loud instead of shipping a dead editor.
        # The `|| true` inside the substitution is load-bearing under
        # `set -euo pipefail`, not style: `occ config:app:get` EXITS NON-ZERO
        # for an unset key, and a failing command substitution carries that
        # status into the assignment — so the first unset value would abort the
        # whole hook mid-way, which is precisely when we most want the report.
        # (Verified: without the guard the script dies before the next line.)
        # if/else rather than `[ … ] && echo` is for the explicit drift message
        # on the failing branch — errexit tolerates either form here, since a
        # false left operand of && is a tested context.
        rd_drift=0
        for rd_pair in "wopi_url=$rd_wopi" "public_wopi_url=$rd_public" "wopi_callback_url=$rd_callback"; do
          rd_key="${rd_pair%%=*}"
          rd_want="${rd_pair#*=}"
          rd_got="$( { occ_www config:app:get richdocuments "$rd_key" 2>/dev/null || true; } | tr -d '\r\n' )"
          if [ "$rd_got" != "$rd_want" ]; then
            echo "[droplet] WARP-1694: richdocuments $rd_key is '$rd_got', expected '$rd_want' — the in-browser editor will not load. Re-run this hook once the engine is up; if it persists, activate-config has changed which keys it rewrites." >&2
            rd_drift=1
          fi
        done
        if [ "$rd_drift" -eq 0 ]; then
          echo "[droplet] WARP-1686: Nextcloud Office connector configured (richdocuments → Collabora CODE); URL trio verified"
          # WARP-1973 — gated on rd_drift, so a box whose trio did NOT verify
          # keeps BOTH connectors rather than being left with one that is
          # known-misconfigured and one that is off.
          disable_other_connector onlyoffice
        else
          echo "[droplet] WARP-1694: document-engine URL trio did NOT verify — see the lines above. Non-fatal; the next boot re-runs this hook." >&2
        fi
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
