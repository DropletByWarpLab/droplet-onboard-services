#!/usr/bin/env bash
# tls-reload.sh — shared "reload the gateway nginx so a freshly-written cert is
# served immediately" helper (ADR-023 C2).
#
# Factored out of scripts/lib/secrets.sh::_generate_tls_cert so the SAME reload
# path is used by:
#   1. secrets.sh (self-signed bootstrap cert + --sync-secrets re-runs), and
#   2. the box LE-renew path — the orchestrator's tls-issuance cron writes the
#      new fullchain into docker/certs/droplet.crt and then triggers this helper
#      on the HOST via the device-bridge (the orchestrator deliberately does NOT
#      mount the docker socket — ADR-023).
#
# Idempotent + safe to call when the gateway isn't running (fresh install): on a
# stopped gateway it is a no-op (nginx picks the cert up on first start). Never
# exits non-zero just because the gateway is down — only a genuine reload
# FAILURE on a running gateway is surfaced as a non-zero return.
#
# Requires: REPO_ROOT in the environment (set by setup.sh / factory-reset.sh /
# the device-bridge wrapper). Logging helpers (log_info/log_warn) are optional —
# they're used when sourced inside setup.sh; standalone callers get plain echo.

# Define no-op logging shims if the caller hasn't sourced logging.sh. This lets
# the device-bridge host wrapper source us without dragging in the full setup
# logging stack.
if ! declare -F log_info >/dev/null 2>&1; then
  log_info()    { printf '%s\n' "$*"; }
  log_warn()    { printf 'WARN: %s\n' "$*" >&2; }
  log_success() { printf '%s\n' "$*"; }
fi

# reload_gateway_nginx — ask the running gateway container to `nginx -s reload`.
#
# Returns 0 when:
#   - the reload succeeded, OR
#   - docker isn't installed / the gateway isn't running (nothing to reload yet).
# Returns non-zero ONLY when the gateway IS running but the reload command
# failed — the one case a caller should surface to the operator.
reload_gateway_nginx() {
  local repo_root="${REPO_ROOT:-}"
  if [ -z "$repo_root" ]; then
    log_warn "reload_gateway_nginx: REPO_ROOT not set — cannot locate docker-compose.yml"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    # No docker on PATH (dev laptop) — nothing to reload.
    return 0
  fi

  local compose_file="$repo_root/docker/docker-compose.yml"
  if [ ! -f "$compose_file" ]; then
    log_warn "reload_gateway_nginx: $compose_file not found — skipping reload"
    return 0
  fi

  # Only reload if the gateway is actually running. On a fresh install it isn't
  # up yet and nginx will pick the cert up on first start.
  if ! docker compose -f "$compose_file" ps --services --filter status=running 2>/dev/null \
       | grep -qx gateway; then
    log_info "reload_gateway_nginx: gateway not running — cert will be served on next start"
    return 0
  fi

  # Warning-free droplet.local: re-render the canonical-host include from the
  # freshly-written cert BEFORE reloading, so one reload picks up both the new
  # cert and the matching redirect posture. Best-effort: a render failure
  # (e.g. an older gateway image without the script) must never block serving
  # the new cert — the entrypoint re-renders on the next container start.
  if ! docker compose -f "$compose_file" exec -T gateway \
       /usr/local/bin/render-canonical-host.sh >/dev/null 2>&1; then
    log_warn "reload_gateway_nginx: canonical-host render failed — redirect posture unchanged (cert reload continues)"
  fi

  if docker compose -f "$compose_file" exec -T gateway nginx -s reload 2>/dev/null; then
    log_info "reload_gateway_nginx: hot-reloaded gateway nginx with the new cert"
    return 0
  fi

  log_warn "reload_gateway_nginx: could not nginx -s reload the gateway container — restart it manually:"
  log_warn "    docker compose -f docker/docker-compose.yml restart gateway"
  return 1
}
