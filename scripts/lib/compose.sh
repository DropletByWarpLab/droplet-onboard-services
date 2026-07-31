#!/usr/bin/env bash
# compose.sh — Pull images, build containers, start the stack, wait for health.
# Source this file; do not execute directly.

COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
COMPOSE_ENV_FILE="$REPO_ROOT/.env"

# =============================================================================
# Env validation — single source of truth for required secrets
# =============================================================================
# Update this list when adding a new secret to the .env heredoc in secrets.sh.
REQUIRED_ENV_VARS=(
  POSTGRES_PASSWORD
  REDIS_PASSWORD
  # MQTT_PASSWORD retired by WARP-235 — MQTT identity is the per-service
  # client certificate CN (WARP-236 internal CA), not a shared secret.
  NEXTCLOUD_ADMIN_PASSWORD
  DEVICE_SECRET
  DEVICE_SECRET_KEY
  # WARP-834: per-device OpenWrt root / rpcd credential. Without this the
  # routing service silently starts with an empty ubus password and loses
  # the router (the WARP-826 symptom). Fail-closed here so a box that updates
  # code WITHOUT running setup.sh can't start with an empty ubus password.
  OPENWRT_PASSWORD
)

_validate_env() {
  local env_file="$COMPOSE_ENV_FILE"

  if [ ! -f "$env_file" ]; then
    log_error ".env not found at $env_file"
    log_error "Run ./scripts/setup.sh to generate device secrets."
    return 1
  fi

  local missing=()
  local var val

  for var in "${REQUIRED_ENV_VARS[@]}"; do
    # `|| true`: a missing var makes grep exit 1, which under `set -euo
    # pipefail` would abort here instead of recording it in missing[] (the
    # whole point of this loop). Empty val → flagged as missing below.
    val=$(grep -E "^${var}=" "$env_file" 2>/dev/null | head -1 | cut -d= -f2- || true)
    if [ -z "$val" ] || [ "$val" = "change-me" ]; then
      missing+=("$var")
    fi
  done

  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing or placeholder secrets in .env:"
    for var in "${missing[@]}"; do
      log_error "  - $var"
    done
    log_error ""
    log_error "Run: ./scripts/setup.sh --regenerate-env"
    return 1
  fi

  return 0
}

# =============================================================================
# Build-list drift guard
# =============================================================================
# prepare_and_build's build_services list is hardcoded — jq is not a
# guaranteed device dependency, so the honest enumeration (`compose config
# --format json`) can't run on every box. Hardcoded lists drift: mcp-server,
# device-identity-svc and email-indexer all gained build: sections in
# docker/docker-compose.yml without landing in the list, so fresh provisions
# built them lazily at first `up` instead of during setup's build phase.
# This guard re-derives the buildable set wherever jq IS available — dev
# machines and CI (setup-e2e runs setup.sh on every docker-compose.yml /
# scripts change) — and prepare_and_build hard-fails on drift in CI only, so
# the next drift dies in a PR, not on a fleet box mid-provision.
# Sentinel-delimited for unit testing (tests/setup.test.sh Phase 12).
# >>> compute_build_list_drift (build-list drift guard)
# stdin: newline-separated buildable service names from the compose model.
# $1:    comma-separated accounted-for names (build list + documented skips).
# stdout: space-separated names from stdin that are not accounted for — the
# drift. Pure bash (no docker/jq) so the tests exercise the shipping code.
compute_build_list_drift() {
  local accounted="$1" svc drift=""
  while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    case ",${accounted}," in
      *",${svc},"*) ;;
      *) drift="${drift:+${drift} }${svc}" ;;
    esac
  done
  printf '%s' "$drift"
}
# <<< compute_build_list_drift (build-list drift guard)

# =============================================================================
# Build
# =============================================================================
prepare_and_build() {
  # Validate all required secrets before touching Docker
  _validate_env || return 1

  # --- Always start from clean state ---
  # Stop any running containers so builds don't conflict with stale state.
  # Compose file has no :? patterns, so this always works even with partial .env.
  log_info "Stopping any existing containers..."
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    down --remove-orphans 2>/dev/null || true

  # --- Ensure init scripts are executable ---
  chmod +x "$REPO_ROOT/docker/init-nextcloud-db.sh" 2>/dev/null || true

  # --- Make `.env` discoverable to bare `docker compose -f docker/…` calls ---
  # Compose resolves `.env` relative to the compose file's directory, not the
  # repo root. Without this symlink, invocations that don't pass
  # `--env-file .env` (e.g. ad-hoc `docker compose -f docker/docker-compose.yml
  # logs`) silently default secrets to empty strings and break auth services.
  ln -sfn ../.env "$REPO_ROOT/docker/.env"

  # --- Pin the repo's absolute host path for the OTA apply path (WARP-1669) ---
  # The orchestrator runs `docker compose -f "$DROPLET_OTA_COMPOSE_FILE"` from
  # INSIDE its container against the host daemon, so that file has to resolve
  # to the same absolute path in both places. Otherwise the compose file's
  # relative binds (./certs, ../data/secrets/…) resolve against a path that
  # exists only in the container, Docker creates those host paths as empty
  # directories, and the stack comes back up without its certs or secrets.
  #
  # Upserted on every run rather than backfilled-if-missing: it is derived
  # from where the checkout actually is, so moving the repo must update it —
  # a stale value is exactly the failure above. This writes the .env that
  # compose interpolates, through the docker/.env symlink created just above.
  _upsert_env_kv DROPLET_HOST_ROOT "$REPO_ROOT"

  # --- Pull base images (sequential for slow appliance connections) ---
  log_info "Pulling base container images..."
  local images=(
    "postgres:16-alpine"
    "redis:7-alpine"
    "eclipse-mosquitto:2"
    "nginx:alpine"
    "nextcloud:29-apache"
    "node:20-alpine"
    "python:3.12-slim"
  )
  # Frigate is gated to the `linux` compose profile (see docker-compose.yml);
  # skip the ~2GB pull on macOS where it can never run.
  # Use the same pinned tag (and .env override) the compose file resolves to,
  # so the pre-pull lands the exact image Compose runs instead of pulling a
  # floating `:stable` that's then re-pulled as `:0.17.1` on `up`.
  if [ "$(uname)" = "Linux" ]; then
    images+=("${FRIGATE_IMAGE:-ghcr.io/blakeblackshear/frigate:0.17.1}")
  fi

  local failed=0
  for img in "${images[@]}"; do
    local attempts=0
    while [ $attempts -lt 3 ]; do
      attempts=$((attempts + 1))
      if run_with_spinner "Pulling $img" run_docker pull "$img"; then
        break
      fi
      if [ $attempts -lt 3 ]; then
        log_warn "  Retry $attempts/3 for $img..."
        sleep 3
      else
        log_warn "  Failed to pull $img — will retry during build"
        failed=$((failed + 1))
      fi
    done
  done

  if [ $failed -gt 0 ]; then
    log_warn "$failed image(s) failed to pull — build may re-download them"
  fi

  # --- Build application images ---
  # Every service with a `build:` section in docker-compose.yml needs to
  # land here, including profile-gated ones. Previously this listed only
  # orchestrator / web-dashboard / ai-gateway, so a fresh install where
  # the user later did `COMPOSE_PROFILES=full docker compose up -d` hit
  #   "No such image: docker-file-indexer:latest"
  # because file-indexer / switch / camera-discovery / routing were
  # never built. `--profile full` makes profile-gated services visible
  # to compose; routing is default-profile but was also missing.
  #
  # Keep this list in sync with the `build:` sections in
  # docker/docker-compose.yml. If you add a new buildable service,
  # add it here too — the drift guard below (compute_build_list_drift)
  # fails setup-e2e in CI when this list and the compose file disagree.
  # (Frigate ships as a pulled image, not a local build — don't list it.)
  log_info "Building application containers..."
  local build_services=(
    # default profile
    # WARP-1021: the nginx edge gateway is now a local build (Bookworm +
    # dormant validated FIPS provider), no longer a pulled nginx:alpine.
    gateway
    orchestrator
    web-dashboard
    ai-gateway
    routing
    # build-list drift fix: mcp-server (streamable-HTTP MCP surface),
    # device-identity-svc and email-indexer (below) all had build: sections
    # but were never pre-built — fresh provisions built them lazily at the
    # first `up` instead of during this build phase.
    mcp-server
    device-identity-svc
    # WARP-850: Matter controller host-network sidecar (BLE + LAN mDNS)
    matter-controller
    # full profile (hardware-facing services)
    file-indexer
    switch
    camera-discovery
    oled-display
    # full profile (email ingestion — same drift fix as mcp-server above)
    email-indexer
    # linux profile (audio-facing services; the OS-specific gate keeps
    # macOS Docker Desktop from trying to mount /dev/snd which doesn't exist)
    voice-io
  )

  # eval profile: rag-eval (RAGAS scoring) is `["eval"]`-profiled and has a
  # `build:` section, so `up -d` with eval active fails with "No such image:
  # docker-rag-eval" unless it's pre-built. Build it ONLY when the active
  # COMPOSE_PROFILES set (in .env) contains `eval` — single-box enables it by
  # default via scripts/lib/single-box.sh; macOS-dev / multi-box leave it off,
  # so they skip the heavy RAGAS image build. Build-only-when-active idiom.
  # `|| true`: grep exits 1 when the key is absent (fresh /
  # profile-less .env), which would abort build_images() under `set -euo pipefail`.
  local active_profiles
  active_profiles=$(grep -E '^COMPOSE_PROFILES=' "$COMPOSE_ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  case ",${active_profiles}," in
    *,eval,*) build_services+=(rag-eval) ;;
  esac
  case ",${active_profiles}," in
    *,web,*) build_services+=(web-fetch) ;;
  esac

  # --- Build-list drift guard (compute_build_list_drift above) --------------
  # Deliberately NOT in build_services (accounted for here, not built):
  #   rag-eval    — appended above only when the eval profile is active
  #   web-fetch   — appended above only when the web profile is active
  #                 (WARP-1436 screened ambient-data fetcher)
  #   openwrt     — single-box router image; start_stack's `up` builds it on
  #                 the one shape whose profiles activate it
  #   ops-console — operator-workstation `ops` profile, never provisioned
  #   fleet-agent — opt-in `telemetry` profile (fleet portal plane)
  # Removing an exclusion here must be mirrored in tests/setup.test.sh
  # Phase 12 (BUILD_LIST_EXCLUSIONS).
  if command -v jq >/dev/null 2>&1; then
    # Activate every profile the compose file declares so the enumeration
    # sees ALL buildable services regardless of this box's shape. The
    # `${arr[@]+...}` expansion keeps `set -u` happy on bash 3.2 (macOS dev)
    # if the profile listing comes back empty.
    local _drift_profile_flags=() _drift_profile _drift_buildable _drift
    while IFS= read -r _drift_profile; do
      [ -n "$_drift_profile" ] && _drift_profile_flags+=(--profile "$_drift_profile")
    done < <(run_docker_compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" config --profiles 2>/dev/null || true)
    # `|| true` throughout: the guard is best-effort — an enumeration failure
    # must never block a provision; CI's real builds still gate correctness.
    _drift_buildable=$(run_docker_compose ${_drift_profile_flags[@]+"${_drift_profile_flags[@]}"} \
        --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" config --format json 2>/dev/null \
      | jq -r '.services | to_entries[] | select(.value.build) | .key' 2>/dev/null || true)
    _drift=$(compute_build_list_drift \
      "$(IFS=,; printf '%s' "${build_services[*]}"),rag-eval,web-fetch,openwrt,ops-console,fleet-agent" \
      <<<"$_drift_buildable")
    if [ -n "$_drift" ]; then
      if [ -n "${CI:-}" ]; then
        log_error "docker-compose.yml has buildable services this build phase doesn't know: ${_drift}"
        log_error "Add them to build_services in scripts/lib/compose.sh, or document the exclusion beside the drift guard."
        return 1
      fi
      log_warn "build-list drift: ${_drift} missing from build_services — they will build lazily at 'up'; sync scripts/lib/compose.sh"
    fi
  fi

  # All profiles that carry a buildable service in the list above must be active
  # so compose can see every one. Without --profile linux, `build voice-io`
  # errors out because the service is invisible to compose's view of the
  # project; without --profile eval the same is true for rag-eval. (rag-eval is
  # only in build_services when its profile is enabled, so the extra --profile
  # flag is harmless otherwise.) Default-profile services are visible
  # regardless of --profile.
  # CI hook: when DROPLET_COMPOSE_BUILD_EXTRA_FILE is set (setup-e2e.yml),
  # merge that compose file on top of the main one so builds import the GHCR
  # BuildKit layer cache that docker-build.yml refreshes on every push to
  # main. cache_from only — image content is unchanged, and a missing or
  # stale cache ref just means a cold build. Passed as argv (not env) so it
  # survives the env_reset sudo path in the compose wrapper (docker.sh) —
  # naming the wrapper here trips test-security's env-file grep. Unset on
  # devices → argv identical to before, production behavior untouched.
  for svc in "${build_services[@]}"; do
    if ! run_with_spinner "Building $svc" \
      run_docker_compose --profile full --profile linux --profile eval --env-file "$COMPOSE_ENV_FILE" \
        -f "$COMPOSE_FILE" \
        ${DROPLET_COMPOSE_BUILD_EXTRA_FILE:+-f "$DROPLET_COMPOSE_BUILD_EXTRA_FILE"} \
        build "$svc"; then
      log_error "Failed to build $svc"
      _suggest_build_fix
      return 1
    fi
  done

  log_success "All images built"
  log_divider
}

# =============================================================================
# Nextcloud Droplet provisioning reconcile (WARP-990)
# =============================================================================
# docker/nextcloud-init.sh (household group + "Household" group folder +
# OnlyOffice connector — WARP-883/882) is mounted into the nextcloud container
# as the official image's post-installation hook:
#   /docker-entrypoint-hooks.d/post-installation/init-droplet.sh
# The image fires post-installation hooks ONLY on the single boot that performs
# the initial auto-install into an EMPTY nextcloud-data volume. On a reflashed
# box that window is easy to miss entirely (WARP-990, live on .87 2026-07-01):
#   * a volume-preserving reset keeps nextcloud-data, so the entrypoint sees an
#     already-installed Nextcloud and never enters the install path — and
#     therefore never runs the post-installation hooks;
#   * even on a genuinely fresh volume the hook races first-boot bring-up
#     (db/appstore/DNS settling — the #691 fragility) and the image never
#     re-fires a hook that erred.
# Either way the box serves a bare Nextcloud (`occ group:list` → only "admin"):
# no household group, no shared folder, no OnlyOffice connector — which broke
# the setup wizard's account creation with a 500 (WARP-989).
#
# Fix: after EVERY stack bring-up, once `php occ status` reports installed,
# re-exec the SAME mounted hook script inside the running container. The hook
# is fully idempotent (every step no-ops when already applied), so this is a
# reconcile, not a re-install — and docker/nextcloud-init.sh stays the single
# source of truth (nothing here duplicates its logic). Because it runs from
# start_stack, every bring-up path converges: fresh install, re-provision,
# factory-reset --reinstall, and the reflash recipes (all re-run setup.sh).
#
# Both execs run as uid 33 (www-data): occ refuses to run as any user other
# than the config.php owner, and unlike the entrypoint's hook-runner context a
# plain exec has no root wrapper — uid 33 is exactly how the live-box manual
# recovery ran the hook cleanly.
#
# Sentinel-delimited for unit testing (tests/setup.test.sh extracts the
# function bodies and runs them against a stubbed compose runner), mirroring
# wait_for_openwrt_ready in scripts/lib/single-box.sh (WARP-826).
#
# WARP-1064: this occ poll is start_stack's ONLY Nextcloud readiness gate.
# It used to run stacked on top of a curl loop against
# http://localhost:8080/status.php — but Nextcloud stopped publishing host
# port 8080 in 945cf766 ("gateway is the only ingress"; on single-box the
# host-network routing service owns :8080), so that loop could never
# succeed and burned its full 300 s on EVERY provision before this poll
# even started (measured 2026-07-05: ~7m38s of dead wait, 47% of the
# reflash). occ status inside the container is the honest installed
# signal; poll it fast and break immediately.
#
# Tunables (env, 120 s default budget — the single Nextcloud wait):
#   NEXTCLOUD_OCC_READY_TRIES     poll attempts (default 60)
#   NEXTCLOUD_OCC_READY_INTERVAL  seconds between polls (default 2)
# >>> wait_for_nextcloud_installed (WARP-990)
wait_for_nextcloud_installed() {
  local tries="${NEXTCLOUD_OCC_READY_TRIES:-60}"
  local interval="${NEXTCLOUD_OCC_READY_INTERVAL:-2}"
  local i=0 occ_out
  while [ "$i" -lt "$tries" ]; do
    i=$((i + 1))
    # `php occ status --output=json` prints {"installed":true,…} once the
    # auto-install has finished; before that it reports false or occ errors
    # while the container is still warming up. Output is captured and matched
    # with a pipe-free `case`: an `… | grep -q` here can SIGPIPE the writer
    # under `set -o pipefail` and turn a genuine "installed" into a false
    # negative (the WARP-981 lesson). `|| true` keeps a warming-up occ from
    # aborting the poll under `set -e`.
    occ_out=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
      exec -T -u 33 nextcloud php occ status --output=json 2>/dev/null || true)
    case "$occ_out" in
      *'"installed":true'* | *'"installed": true'*) return 0 ;;
    esac
    sleep "$interval"
  done
  return 1
}
# <<< wait_for_nextcloud_installed (WARP-990)

# =============================================================================
# Nextcloud auto-install recovery (WARP-1064)
# =============================================================================
# The official nextcloud image only auto-installs on the ONE boot that finds
# an empty volume AND a complete env (NEXTCLOUD_ADMIN_USER/PASSWORD +
# POSTGRES_HOST/DB/USER/PASSWORD — all six, or it prints "Next step: Access
# your instance to finish the web-based installation!" and serves the manual
# wizard instead). Either fall-through OR an install that exhausted the
# entrypoint's 10 retries leaves version.php in the volume — and the
# entrypoint's install branch is gated on a VERSION mismatch, not on
# installed-ness, so every later boot skips it entirely. The box then reports
# `occ status → installed:false` FOREVER: no wait budget can succeed, setup
# proceeds degraded on every re-run, and the WARP-990 reconcile is skipped
# every time (reproduced locally 2026-07-09 on a fresh volume with a
# deliberately incomplete env; restarting with a complete env did NOT
# recover). This is the provisioning miss the old 7.6-minute double-wait was
# masking.
#
# A second, compounding trap (also reproduced locally): Nextcloud's
# PostgreSQL Setup never installs as the supplied CREATEROLE-capable user —
# it mints a dedicated non-superuser role (oc_admin, then oc_admin2, 3, …
# one per retry) and installs as THAT. So when the `nextcloud` database
# still holds oc_* tables from a previous install (reflash that lost
# nextcloud-data but kept pgdata, or an asymmetric volume wipe — the
# WARP-234 stale-bind-mount `volume rm` failure), every install attempt
# creates a fresh oc_adminN and immediately dies with
#   SQLSTATE[42501] permission denied for table oc_migrations
# (owned by the DEAD oc_admin of the previous install). The entrypoint's 10
# retries just mint 10 more roles and then exit 1. Auto-install can NEVER
# converge into a stale DB.
#
# Recovery: when the wait expires AND occ itself parses (container up, PHP
# fine) but reports installed:false, then (1) if the DB carries stale oc_*
# tables, recreate it — occ status just told us nothing live uses it, and
# its rows are orphaned without the matching nextcloud-data volume — and
# drop the dead oc_adminN roles; (2) run the same `occ maintenance:install`
# the entrypoint would have run, with the container's OWN env (single source
# of truth — .env via env_file), then set trusted_domains exactly like the
# entrypoint does. Idempotent by construction: occ refuses a second install
# on an installed instance, and we only enter on installed:false.
#
# GUARD — never race the image's own first-boot install: with the wait
# budget cut to 120 s (WARP-1064), a slow-but-healthy first boot (rsync of
# the whole Nextcloud tree + the entrypoint's retried maintenance:install +
# appstore hooks — ALL before apache2 starts) can outlive the wait. That is
# real provisioning work, not dead wait — so before judging, hold off
# (bounded) while the entrypoint is still initializing, then read the
# verdict. apache2 running = entrypoint done, the verdict is final;
# container unreachable = dead, nothing to hold for. Tunables (env):
#   NEXTCLOUD_ENTRYPOINT_WAIT_TRIES     probes while initializing (default 20)
#   NEXTCLOUD_ENTRYPOINT_WAIT_INTERVAL  seconds between probes (default 15)
# Sentinel-delimited for unit testing, like its two siblings.
# >>> recover_nextcloud_autoinstall (WARP-1064)
recover_nextcloud_autoinstall() {
  local ep_tries="${NEXTCLOUD_ENTRYPOINT_WAIT_TRIES:-20}"
  local ep_interval="${NEXTCLOUD_ENTRYPOINT_WAIT_INTERVAL:-15}"
  local ep_i=0 ep_probe ep_initializing=0
  while [ "$ep_i" -lt "$ep_tries" ]; do
    # No pgrep in the nextcloud image — scan /proc comms. Prints
    # "initializing" only when the container answers AND apache2 isn't up yet
    # (the entrypoint execs apache2 only after rsync + install + hooks).
    ep_probe=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
      exec -T nextcloud sh -c \
      'if grep -sqx apache2 /proc/[0-9]*/comm; then echo serving; else echo initializing; fi' \
      2>/dev/null || true)
    case "$ep_probe" in
      *initializing*) ep_initializing=1 ;; # entrypoint still working — hold
      *) ep_initializing=0; break ;; # serving (verdict is final) or unreachable (dead)
    esac
    ep_i=$((ep_i + 1))
    if [ "$ep_i" -eq 1 ]; then
      log_info "Nextcloud's entrypoint is still initializing (first-boot rsync/install) — waiting for it instead of racing it (WARP-1064)..."
    fi
    sleep "$ep_interval"
  done
  if [ "$ep_initializing" = 1 ]; then
    # Budget spent and the entrypoint is STILL working. NEVER fall through to
    # a second install here — racing the in-flight one was observed live
    # (2026-07-11): both installers fight over the same DB and the entrypoint
    # burns its whole retry loop against an already-installed instance. Bail;
    # the degraded-path breadcrumb stands and the next bring-up reconciles.
    log_warn "Nextcloud's entrypoint is still initializing after $((ep_tries * ep_interval))s — not racing it with a second install (WARP-1064); re-run setup once it settles."
    return 1
  fi

  local occ_out
  occ_out=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -u 33 nextcloud php occ status --output=json 2>/dev/null || true)
  case "$occ_out" in
    # Converged while we held (the slow-healthy first boot) — nothing to fix.
    *'"installed":true'* | *'"installed": true'*) return 0 ;;
    *'"installed":false'*) ;; # the recoverable state — fall through
    *) return 1 ;;            # container not answering occ — not ours to fix
  esac

  log_warn "Nextcloud is running but NOT installed (first-boot auto-install never completed) — recovering with occ maintenance:install (WARP-1064)..."

  # --- Stale-DB guard (see the block comment above) --------------------------
  # A leftover oc_migrations table means a previous install's schema is in the
  # way (owned by a dead oc_adminN role) and the installer can never converge.
  # The instance is NOT installed (checked above), so those rows are orphaned
  # state — recreate the database and drop the dead roles so install can run.
  # A virgin/empty nextcloud DB skips this entirely.
  local stale_probe
  stale_probe=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" db \
    psql -U "${POSTGRES_USER:-droplet}" -w -d nextcloud -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='oc_migrations'" 2>/dev/null || true)
  if [ "$(printf '%s' "$stale_probe" | tr -d '[:space:]')" = "1" ]; then
    log_warn "Stale Nextcloud schema found in the 'nextcloud' database (dead previous install) — recreating it so the install can converge..."
    if ! run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
      exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" db \
      psql -U "${POSTGRES_USER:-droplet}" -w -d postgres -v ON_ERROR_STOP=1 \
        -c "DROP DATABASE IF EXISTS nextcloud WITH (FORCE)" \
        -c "CREATE DATABASE nextcloud OWNER ${POSTGRES_USER:-droplet}" \
        -c "DO \$\$ DECLARE r text; BEGIN FOR r IN SELECT rolname FROM pg_roles WHERE rolname ~ '^oc_admin[0-9]*\$' LOOP EXECUTE 'DROP ROLE ' || quote_ident(r); END LOOP; END \$\$"; then
      log_error "Could not recreate the stale 'nextcloud' database — aborting the recovery install"
      return 1
    fi
  fi

  # Runs inside the container so the credentials come from ITS env (env_file
  # ../.env), exactly what the image's own auto-install would have used. The
  # guard mirrors the entrypoint's install gate; trusted_domains mirrors its
  # post-install loop (without it the gateway's Host header is rejected).
  # shellcheck disable=SC2016  # single-quoted on purpose: $VARS expand inside the container
  if ! run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -u 33 nextcloud sh -c '
      set -e
      for v in NEXTCLOUD_ADMIN_USER NEXTCLOUD_ADMIN_PASSWORD POSTGRES_HOST POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD; do
        eval "val=\${$v:-}"
        if [ -z "$val" ]; then echo "recovery install: $v is empty in the container env — cannot install" >&2; exit 1; fi
      done
      php /var/www/html/occ maintenance:install -n \
        --admin-user "$NEXTCLOUD_ADMIN_USER" --admin-pass "$NEXTCLOUD_ADMIN_PASSWORD" \
        --database pgsql --database-name "$POSTGRES_DB" --database-user "$POSTGRES_USER" \
        --database-pass "$POSTGRES_PASSWORD" --database-host "$POSTGRES_HOST"
      idx=1
      for d in ${NEXTCLOUD_TRUSTED_DOMAINS:-}; do
        php /var/www/html/occ config:system:set trusted_domains "$idx" --value="$d"
        idx=$((idx + 1))
      done
    '; then
    log_error "Nextcloud recovery install FAILED — see output above"
    return 1
  fi

  log_success "Nextcloud recovered: occ maintenance:install completed"
  return 0
}
# <<< recover_nextcloud_autoinstall (WARP-1064)

# >>> run_nextcloud_post_install_hook (WARP-990)
run_nextcloud_post_install_hook() {
  # The mounted hook — the single source of truth (docker/nextcloud-init.sh,
  # see the nextcloud volumes in docker/docker-compose.yml). Exec THIS path;
  # never reimplement its steps here.
  local hook_path="/docker-entrypoint-hooks.d/post-installation/init-droplet.sh"
  local recover_cmd="docker compose -f docker/docker-compose.yml exec -u 33 nextcloud bash $hook_path"

  log_info "Reconciling Nextcloud Droplet provisioning (household group + shared folder + OnlyOffice connector — WARP-990)..."

  if ! wait_for_nextcloud_installed; then
    # WARP-1064: before declaring the box degraded, try to self-heal the
    # never-auto-installed state (see recover_nextcloud_autoinstall above) —
    # a stuck volume reports installed:false forever, so *waiting longer*
    # can never fix it, but an explicit occ maintenance:install can.
    if ! recover_nextcloud_autoinstall; then
      # LOUD but non-fatal — the rest of setup (verify.sh, local DNS) must
      # still run; a box with a lagging Nextcloud is degraded, not bricked.
      log_error "Nextcloud never reported installed (php occ status) within budget — SKIPPING the Droplet provisioning reconcile (WARP-990)."
      log_error "Without it the household group / shared folder / OnlyOffice connector are missing and the setup wizard's account creation fails (WARP-989)."
      log_error "Recover manually once Nextcloud is up:  $recover_cmd"
      return 0
    fi
  fi

  # WARP-484 capture-and-branch pattern (see the workspace-settings seeder in
  # setup.sh): never pipe the exec through `grep … || true` (which swallows
  # real failures) — capture the transcript and branch on the exit code
  # explicitly, surfacing it either way.
  local hook_out="" hook_rc=0
  hook_out=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -u 33 nextcloud bash "$hook_path" 2>&1) || hook_rc=$?
  # Keep the full hook transcript in the setup log either way.
  printf '%s\n' "$hook_out" >> "$LOG_FILE" 2>/dev/null || true
  if [ "$hook_rc" -eq 0 ]; then
    log_success "Nextcloud Droplet provisioning reconciled (hook exit 0)"
  else
    log_error "Nextcloud Droplet provisioning hook FAILED (exit $hook_rc) — household group / shared folder / OnlyOffice connector may be missing, and the setup wizard's account creation will 500 (WARP-989/990):"
    printf '%s\n' "$hook_out" | tail -20 >&2
    log_error "Setup continues; re-run the hook manually once Nextcloud is healthy:  $recover_cmd"
  fi

  apply_file_indexer_nc_grants
  return 0
}
# <<< run_nextcloud_post_install_hook (WARP-990)

# >>> apply_file_indexer_nc_grants (WARP-1328)
apply_file_indexer_nc_grants() {
  # WARP-1328: the file-indexer resolves Nextcloud file ids by reading
  # oc_storages/oc_filecache directly (watcher.py _resolve_nc_file_id), but
  # no grant was ever provisioned — and none CAN be baked into db-init:
  # Nextcloud mints its own table-owner role at install time (oc_admin,
  # oc_admin2, … — see the stale-DB guard above), so the tables only exist,
  # with a nondeterministic owner, AFTER install. Apply the read grants here,
  # on every setup run, as the bootstrap superuser — idempotent by nature.
  # The grantee is the app role the indexer's derived NEXTCLOUD_DATABASE_URL
  # connects as (WARP-1327); an operator overriding that env var must grant
  # the override role equivalently (docs/ENVIRONMENT.md).
  local app_role="${POSTGRES_USER:-droplet}"
  log_info "Granting file-indexer read access to Nextcloud's oc_* lookup tables (WARP-1328)..."
  local grant_out="" grant_rc=0
  grant_out=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" db \
    psql -U "$app_role" -w -d nextcloud -v ON_ERROR_STOP=1 \
      -c "GRANT CONNECT ON DATABASE nextcloud TO ${app_role}" \
      -c "GRANT USAGE ON SCHEMA public TO ${app_role}" \
      -c "GRANT SELECT ON public.oc_storages, public.oc_filecache TO ${app_role}" 2>&1) || grant_rc=$?
  printf '%s\n' "$grant_out" >> "$LOG_FILE" 2>/dev/null || true
  if [ "$grant_rc" -eq 0 ]; then
    log_success "file-indexer oc_* read grants in place (role: ${app_role})"
  else
    # LOUD but non-fatal, same posture as the provisioning hook: without the
    # grants every upload lands `failed / nc_file_id_unresolved` (WARP-1327).
    log_error "Could not apply file-indexer oc_* grants (exit $grant_rc) — semantic indexing will fail with nc_file_id_unresolved until they are applied:"
    printf '%s\n' "$grant_out" | tail -5 >&2
  fi
  return 0
}
# <<< apply_file_indexer_nc_grants (WARP-1328)

# =============================================================================
# Start
# =============================================================================
start_stack() {
  log_info "Starting the Droplet stack..."

  # Validate all required secrets before starting
  _validate_env || return 1

  # --- Source .env for variable substitution ---
  if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
  fi

  # --- Start infrastructure first ---
  run_with_spinner "Starting database, cache, and broker" \
    run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" up -d db cache broker

  # --- Wait for Postgres to be healthy ---
  log_info "Waiting for PostgreSQL to be ready..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" exec -T db pg_isready -U "${POSTGRES_USER:-droplet}" >/dev/null 2>&1; then
      log_success "PostgreSQL is ready"
      break
    fi
    retries=$((retries - 1))
    sleep 2
  done
  if [ $retries -eq 0 ]; then
    log_error "PostgreSQL did not become ready within 60 seconds"
    log_error "Check logs: docker compose -f docker/docker-compose.yml logs db"
    return 1
  fi

  # --- Ensure Nextcloud database exists (init script only runs on fresh volumes) ---
  log_info "Ensuring Nextcloud database exists..."
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" db \
    psql -U "${POSTGRES_USER:-droplet}" -w -tc \
    "SELECT 1 FROM pg_database WHERE datname = 'nextcloud'" 2>/dev/null | grep -q 1 || \
  run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" \
    exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" db \
    psql -U "${POSTGRES_USER:-droplet}" -w -c \
    "CREATE DATABASE nextcloud OWNER ${POSTGRES_USER:-droplet}" 2>/dev/null
  log_success "Nextcloud database ready"

  # --- Start all remaining services (Nextcloud needs to be up for install check) ---
  run_with_spinner "Starting all services" \
    run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" up -d

  # --- Wait for services to stabilize ---
  log_info "Waiting for services to start..."
  local wait_retries=60
  while [ $wait_retries -gt 0 ]; do
    local running
    running=$(run_docker_compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" ps --status running --format json 2>/dev/null | wc -l || echo 0)
    # Expect at least 7 services: db, cache, broker, gateway, orchestrator, web-dashboard, ai-gateway
    if [ "$running" -ge 7 ] 2>/dev/null; then
      break
    fi
    wait_retries=$((wait_retries - 1))
    sleep 5
  done
  if [ $wait_retries -eq 0 ]; then
    log_warn "Some services may still be starting — continuing with verification"
  fi

  # --- Wait for Nextcloud + reconcile Droplet's provisioning (WARP-990) ---
  # Nextcloud auto-installs on first boot (empty nextcloud-data volume); the
  # OCS API and setup wizard won't work until that finishes. The hook below
  # gates on wait_for_nextcloud_installed (php occ status inside the
  # container — the honest installed signal; see the WARP-1064 note on the
  # function), which replaced the old localhost:8080 status.php curl loop
  # that could never succeed after the port publish was removed (945cf766).
  #
  # The post-installation hook (docker/nextcloud-init.sh) only fires on the
  # single boot that auto-installs into an EMPTY nextcloud-data volume — a
  # volume-preserving reset/reflash never re-enters that window, and a raced
  # first-boot hook is never re-fired. Re-exec the same mounted hook
  # (idempotent) on every bring-up so the household group + shared folder +
  # OnlyOffice connector always converge. Non-fatal on failure, loud in the log.
  run_nextcloud_post_install_hook

  # --- Wait for orchestrator health (via Nginx on port 80) ---
  log_info "Waiting for services to be healthy..."
  local health_retries=30
  while [ $health_retries -gt 0 ]; do
    # TLS listener, not :80 — nginx 301s :80 to https and `curl -sf` exits 0 on
    # the redirect, reporting healthy against a dead orchestrator.
    if curl -skf https://localhost/api/health >/dev/null 2>&1; then
      log_success "Stack is healthy (Nginx → Orchestrator responding)"
      break
    fi
    health_retries=$((health_retries - 1))
    sleep 2
  done
  if [ $health_retries -eq 0 ]; then
    log_warn "Health check timed out — services may still be starting"
    log_info "Check logs: docker compose -f docker/docker-compose.yml logs"
  fi

  log_success "Stack is running"
  log_divider
}

_suggest_build_fix() {
  log_info ""
  log_info "Build troubleshooting:"
  log_info "  - Low memory: try closing other apps or increasing swap"
  log_info "  - Disk full:  run 'docker system prune -a' to reclaim space"
  log_info "  - Re-run:     ./scripts/setup.sh --skip-docker"
}
