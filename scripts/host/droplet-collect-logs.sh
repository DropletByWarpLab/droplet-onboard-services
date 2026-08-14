#!/usr/bin/env bash
# =============================================================================
# WARP-823 — Droplet diagnostics log collector (host executor)
# =============================================================================
#
# The ONLY place the box's service logs are gathered for the Settings →
# "Download diagnostics" bundle. Repo-tracked (architecture-guard rule 20) and
# installed to /usr/local/sbin/droplet-collect-logs.sh by setup.sh via
# scripts/install-device-bridge.sh — never hand-placed on a box.
#
# Invoked ONLY by the device-bridge's auth-gated GET /logs/bundle, which the
# orchestrator reaches ONLY after an owner/admin session. The AI can never
# reach this.
#
# What it does:
#   - For each Droplet service, capture a BOUNDED slice of its logs:
#       * container services  -> `docker logs --since <window> --tail <cap>`
#       * host units (fallback)-> `journalctl -u <unit> --since <window> -n <cap>`
#   - REDACT secrets from every captured line (defense in depth — the
#     orchestrator redacts again before zipping). Redaction here means a leaked
#     bundle from a future code path that skipped the orchestrator gate still
#     can't expose a token / password / key.
#   - Emit a single JSON object on stdout:
#       { collected_at, window_hours, truncated, services: [ {name, source,
#         lines, note?} ] }
#
# Usage:
#   droplet-collect-logs.sh <window_hours> [<service>]
#     window_hours : look-back window, clamped to [1, 168]. Non-numeric -> 24.
#     service      : optional single-service filter; "" / omitted = all.
#
# SECRET HANDLING (architecture-guard rule 19): NEVER print a captured line
# without passing it through redact(). The redaction shapes mirror the
# orchestrator's apps/orchestrator/src/lib/log-redaction.ts so the two gates
# agree.
#
# Test hook (so the collector is unit-testable without Docker/journald):
#   DROPLET_LOGS_FIXTURE_DIR=<dir>  read each service's raw log from
#                                   <dir>/<service>.log instead of docker/journald.
#   DROPLET_LOGS_SERVICES="a b c"   override the service list (default below).
#
# Output: a single JSON object on stdout. Best-effort per service — a service
# that can't be read yields an empty `lines` + a `note`, never a hard failure,
# so one missing container doesn't sink the whole bundle.
# =============================================================================
set -euo pipefail

WINDOW_RAW="${1:-24}"
SERVICE_FILTER="${2:-}"

# Per-service capture cap (lines). Keeps a single service from dominating the
# bundle and bounds memory/time. The orchestrator surfaces `truncated` when any
# service hits this.
LINE_CAP="${DROPLET_LOGS_LINE_CAP:-2000}"

MIN_HOURS=1
MAX_HOURS=168
DEFAULT_HOURS=24

# Canonical Droplet service set. Names double as the docker container name
# suffix (the compose project prefix is resolved at run time) and, where a
# service is a host systemd unit, the unit base name.
# WARP-1748: `ollama-manager` -> `inference-manager`. BOTH are listed, and both
# must stay listed through the deprecation window. `capture_one` resolves these
# against `docker ps --format '{{.Names}}'`, i.e. against CONTAINER NAMES — the
# compose network alias that keeps `ollama-manager` resolvable over DNS does
# NOT help here. A box still running the pre-rename image has a container named
# `…-ollama-manager-1`; a box on the new image has `…-inference-manager-1`.
# Listing only one silently drops the model-lifecycle manager's logs from the
# diagnostic bundle, with a bland "no source" note — the exact soft failure this
# rename went out of its way to avoid everywhere else. A miss costs nothing:
# `capture_one` already tolerates a service that is not running.
DEFAULT_SERVICES="orchestrator ai-gateway routing camera-discovery file-indexer mqtt nextcloud inference-manager ollama-manager web-dashboard"
SERVICES="${DROPLET_LOGS_SERVICES:-$DEFAULT_SERVICES}"

FIXTURE_DIR="${DROPLET_LOGS_FIXTURE_DIR:-}"

# --- window clamp ------------------------------------------------------------
if [[ "$WINDOW_RAW" =~ ^[0-9]+$ ]]; then
  WINDOW_HOURS="$WINDOW_RAW"
else
  WINDOW_HOURS="$DEFAULT_HOURS"
fi
if [ "$WINDOW_HOURS" -lt "$MIN_HOURS" ]; then WINDOW_HOURS="$MIN_HOURS"; fi
if [ "$WINDOW_HOURS" -gt "$MAX_HOURS" ]; then WINDOW_HOURS="$MAX_HOURS"; fi

# =============================================================================
# redact — scrub secret SHAPES from stdin, mirroring log-redaction.ts.
# =============================================================================
# Order matters: the multi-line PEM block is collapsed first (a sed range), then
# the single-line shapes run via a sed script. The placeholder is the same
# literal `[REDACTED]` the orchestrator + UI use.
REDACT_PLACEHOLDER="[REDACTED]"

redact() {
  # 1) Collapse PEM private-key blocks (BEGIN..END inclusive) to one placeholder
  #    line so no base64 key body survives. The range match spans lines.
  # 2) Single-line shapes: Bearer tokens, auth headers, sensitive KEY=value /
  #    KEY: value (PASSWORD|PASSWD|SECRET|TOKEN|KEY|PSK|CREDENTIAL|AUTH, with a
  #    PUBLIC_KEY / KEY_ID carve-out), URI userinfo credentials, and the
  #    richdocuments direct-editing token.
  #
  # WARP-1688 — that last one lives in a URL PATH SEGMENT, which none of the
  # other shapes can see. `/…/apps/richdocuments/direct/<token>` renders the
  # editor with NO cookie and NO Authorization header, so the URL IS the
  # credential while it lives (docs/THREAT_MODEL.md T1.8 / R6 — "must never be
  # logged"). It arrives here unwritten-by-anyone: the gateway has no
  # `access_log` directive so nginx logs `$request` verbatim, and
  # `nextcloud:29-apache` symlinks its Apache access log to stdout while
  # `nextcloud` is in DEFAULT_SERVICES above. The ROUTE is kept and only the
  # token replaced, so the line still says what was requested.
  # Mirrors the `richdocuments-direct-token` rule in log-redaction.ts — keep
  # the two in sync.
  sed -E \
    -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/c\'"$REDACT_PLACEHOLDER (private key)" \
    -e 's@((/index\.php)?/apps/richdocuments/direct/)[^[:space:]"'"'"'?#]+@\1'"$REDACT_PLACEHOLDER"'@gI' \
    -e 's/(\bBearer[[:space:]]+)[A-Za-z0-9._+/=-]{8,}/\1'"$REDACT_PLACEHOLDER"'/g' \
    -e 's/((X-Droplet-Auth|Authorization|X-Api-Key|X-Auth-Token|Proxy-Authorization)[[:space:]]*[:=][[:space:]]*)[^[:space:]",;]{6,}/\1'"$REDACT_PLACEHOLDER"'/gI' \
    -e 's/(([A-Za-z][A-Za-z0-9+.-]*):\/\/[^[:space:]:\/@]*:)[^[:space:]@\/]+(@)/\1'"$REDACT_PLACEHOLDER"'\3/g' \
    -e 's/(\b[A-Za-z0-9_.-]*(PASSWORD|PASSWD|SECRET|TOKEN|KEY|PSK|CREDENTIAL|AUTH)[A-Za-z0-9_.-]*[[:space:]]*[:=][[:space:]]*)("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]",;]+)/\1'"$REDACT_PLACEHOLDER"'/gI'
}

# =============================================================================
# capture_one — print the raw (un-redacted) log text for one service.
# =============================================================================
# Resolution order:
#   1. fixture file (tests)            -> cat <dir>/<service>.log
#   2. a running container             -> docker logs --since/--tail
#   3. a host systemd unit             -> journalctl -u <service> --since/-n
# Prints nothing + returns 1 when no source is available (caller adds a note).
capture_one() {
  local svc="$1"
  if [ -n "$FIXTURE_DIR" ]; then
    if [ -f "$FIXTURE_DIR/$svc.log" ]; then
      tail -n "$LINE_CAP" "$FIXTURE_DIR/$svc.log"
      return 0
    fi
    return 1
  fi
  # Find a running container whose name contains the service token (the compose
  # project prefix varies: droplet-pi-platform-<svc>-1, droplet-<svc>-1, …).
  local cname
  if command -v docker >/dev/null 2>&1; then
    cname="$(docker ps --format '{{.Names}}' 2>/dev/null \
             | grep -E "(^|[-_])${svc}([-_]|$)" | head -1 || true)"
    if [ -n "$cname" ]; then
      docker logs --since "${WINDOW_HOURS}h" --tail "$LINE_CAP" "$cname" 2>&1 \
        | tail -n "$LINE_CAP"
      return 0
    fi
  fi
  # Host systemd unit fallback.
  if command -v journalctl >/dev/null 2>&1; then
    if journalctl -u "$svc" -n 1 >/dev/null 2>&1; then
      journalctl -u "$svc" --since "${WINDOW_HOURS} hours ago" \
        -n "$LINE_CAP" --no-pager 2>&1 | tail -n "$LINE_CAP"
      return 0
    fi
  fi
  return 1
}

# =============================================================================
# JSON string encoder (no jq dependency on the box).
# =============================================================================
json_escape() {
  # Read all of stdin, escape per JSON string rules. python3 is present on every
  # Droplet host (the bridge + many services need it); it is the most robust
  # encoder and avoids hand-rolled escaping bugs.
  python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read()))'
}

# =============================================================================
# Build the bundle.
# =============================================================================
COLLECTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TRUNCATED="false"

printf '{'
printf '"collected_at":%s,' "$(printf '%s' "$COLLECTED_AT" | json_escape)"
printf '"window_hours":%s,' "$WINDOW_HOURS"
printf '"services":['

FIRST=1
for svc in $SERVICES; do
  # Apply the single-service filter, if any.
  if [ -n "$SERVICE_FILTER" ] && [ "$svc" != "$SERVICE_FILTER" ]; then
    continue
  fi

  raw="$(capture_one "$svc" 2>/dev/null || true)"
  note=""
  source="docker"
  if [ -z "$raw" ]; then
    note="no logs available for this service"
    source="none"
  fi
  # Mark truncation if we hit the cap exactly.
  if [ "$(printf '%s\n' "$raw" | wc -l)" -ge "$LINE_CAP" ]; then
    TRUNCATED="true"
  fi

  # REDACT before the bytes leave this function (rule 19). Empty stays empty.
  if [ -n "$raw" ]; then
    redacted="$(printf '%s\n' "$raw" | redact)"
  else
    redacted=""
  fi

  if [ "$FIRST" -eq 0 ]; then printf ','; fi
  FIRST=0
  printf '{'
  printf '"name":%s,' "$(printf '%s' "$svc" | json_escape)"
  printf '"source":%s,' "$(printf '%s' "$source" | json_escape)"
  if [ -n "$note" ]; then
    printf '"note":%s,' "$(printf '%s' "$note" | json_escape)"
  fi
  printf '"lines":%s' "$(printf '%s' "$redacted" | json_escape)"
  printf '}'
done

printf '],'
printf '"truncated":%s' "$TRUNCATED"
printf '}\n'
