#!/usr/bin/env bash
# secrets.sh — Generate device-unique secrets and write .env file.
# Source this file; do not execute directly.

# Generate a random alphanumeric password of given length.
_gen_password() {
  local length="${1:-24}"
  openssl rand -base64 48 | tr -d '=/+\n' | head -c "$length"
}

# Generate a Fernet-compatible base64 key.
_gen_fernet_key() {
  openssl rand -base64 32
}

generate_env() {
  local env_file="$REPO_ROOT/.env"

  # --- Check for existing .env ---
  if [ -f "$env_file" ] && [ "${REGENERATE_ENV:-false}" != "true" ]; then
    log_success ".env already exists — skipping secret generation"
    log_info "  To regenerate: ./scripts/setup.sh --regenerate-env"
    log_divider
    return 0
  fi

  # --- Backup existing .env if regenerating ---
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC2155  # `date +%s` cannot meaningfully fail; the masked return value carries no signal we'd act on.
    local backup="$env_file.bak.$(date +%s)"
    cp "$env_file" "$backup"
    log_info "Backed up existing .env to $backup"
  fi

  log_info "Generating device-unique secrets..."

  # --- Generate all secrets ---
  local pg_password redis_password mqtt_password nc_password device_secret device_secret_key jwt_secret routing_service_token service_token_voice service_token_display ops_token service_token_mcp service_token_email orchestrator_sampler_token ai_gateway_sampler_token ollama_url openwrt_password
  # WARP-503 — embedded Plane PM stack secrets (ADR-010, spec WARP-498).
  local pm_db_password pm_secret_key pm_admin_token pm_webhook_secret pm_web_url
  # Plane v0.24.1 also needs a RabbitMQ broker (celery) + MinIO object storage.
  local pm_mq_password pm_minio_access_key pm_minio_secret_key
  pg_password=$(_gen_password 24)
  redis_password=$(_gen_password 24)
  mqtt_password=$(_gen_password 24)
  nc_password=$(_gen_password 24)
  # WARP-834: per-device OpenWrt rpcd/root password. _gen_password keeps it
  # alphanumeric ([A-Za-z0-9]) so it's safe for `passwd`, the docker secret
  # file, and the ubus `… login` JSON string (no shell/JSON-hostile chars).
  openwrt_password=$(_gen_password 24)
  device_secret=$(_gen_fernet_key)
  device_secret_key=$(openssl rand -base64 32)
  jwt_secret=$(openssl rand -hex 64)
  # Shared bearer for orchestrator and camera-discovery → routing service (WARP-36).
  routing_service_token=$(openssl rand -hex 32)
  # WARP-154: shared bearer the voice-io service presents on the
  # orchestrator's /api/llm/chat — the orchestrator's authMiddleware
  # matches it via timingSafeEqual and sets req.user.role = "service".
  # Both sides MUST read the same value (compose wires voice-io's
  # ORCHESTRATOR_TOKEN to ${SERVICE_TOKEN_VOICE}).
  service_token_voice=$(openssl rand -hex 32)
  # WARP-165: shared bearer for orchestrator → oled-display HTTP calls
  # (health probe, /display/*, /wifi/connect). Previously the path
  # reused DEVICE_SECRET_KEY — the FIPS-sealed AES-256 master encryption
  # key used by encryption.service.ts — which put the master key on the
  # wire on every display call (every 15s via health-monitor). Dedicated
  # token rotates independently and keeps DEVICE_SECRET_KEY off the wire.
  # Both display.client.ts (orchestrator) and oled-display's SERVICE_SECRET
  # + device-bridge.py's BRIDGE_AUTH_TOKEN MUST read the same value;
  # compose wires both ends to ${SERVICE_TOKEN_DISPLAY}.
  service_token_display=$(openssl rand -hex 32)
  # WARP-337: ops-console support-client bearer. Used by Warp Lab
  # support to authenticate against the on-device /ops/* API when
  # troubleshooting a deployed Droplet. The service binds loopback-only
  # (127.0.0.1:8089) and is reached via a reverse SSH/WireGuard tunnel —
  # the bearer is the second layer of defense. Rotates independently of
  # all other secrets so support can hand it off / revoke per-engagement.
  ops_token=$(openssl rand -hex 32)
  # WARP-339: shared bearer the mcp-server presents on outbound calls
  # back to the orchestrator's REST surface (matter, audit-log, etc.).
  # Same authMiddleware path as voice — distinct token so the two
  # service principals can rotate independently and request logs
  # attribute correctly (`_service:mcp` vs `_service:voice`). Compose
  # wires mcp-server's ORCHESTRATOR_TOKEN to ${SERVICE_TOKEN_MCP}.
  service_token_mcp=$(openssl rand -hex 32)
  # WARP-465: bearer the email-indexer service presents on POST to
  # /api/email/_ingest/* and PATCH /api/email/_ingest/drafts/:id. Same
  # authMiddleware path as voice/mcp — distinct token so the principal
  # logs attribute correctly (`_service:email`). Compose wires the
  # email-indexer's ORCHESTRATOR_SERVICE_TOKEN to ${SERVICE_TOKEN_EMAIL}.
  service_token_email=$(openssl rand -hex 32)
  # WARP-468 + WARP-470: bearer the routing service's egress_meter and
  # throughput sampler present on POST /api/network/{off-lan,throughput}-sample-*.
  # Compose wires ORCHESTRATOR_SAMPLER_TOKEN to ${ORCHESTRATOR_SAMPLER_TOKEN}.
  orchestrator_sampler_token=$(openssl rand -hex 32)
  # WARP-468: bearer ai-gateway's off_lan_gating middleware presents on
  # GET /api/network/off-lan + /api/settings/off-lan to read the
  # cloud_model_escape posture. Without this the gate fails closed
  # (every cloud-LLM call 451s). Compose wires it to
  # ${AI_GATEWAY_SAMPLER_TOKEN}.
  ai_gateway_sampler_token=$(openssl rand -hex 32)

  # WARP-503 — Plane secrets (ADR-010, spec WARP-498 OQ1/OQ5).
  #   pm_db_password    — postgres-pm container password
  #   pm_secret_key     — Plane Django SECRET_KEY (session signing etc.)
  #   pm_admin_token    — orchestrator-only token for provisioning users via
  #                       Plane API. NEVER exposed to dashboard or LLM agent.
  #   pm_webhook_secret — HMAC key Plane signs outgoing webhooks with;
  #                       orchestrator validates via /api/pm/webhook (WARP-511).
  #                       Fail-CLOSED on signature mismatch per security-rules.md.
  pm_db_password=$(_gen_password 24)
  pm_secret_key=$(openssl rand -hex 50)
  pm_admin_token=$(openssl rand -hex 32)
  pm_webhook_secret=$(openssl rand -hex 32)
  #   pm_mq_password    — RabbitMQ password for user `plane` (Celery broker).
  #   pm_minio_*        — MinIO root creds (S3-compatible object storage for
  #                       Plane file uploads/attachments). All internal-only.
  pm_mq_password=$(_gen_password 24)
  pm_minio_access_key=$(openssl rand -hex 16)
  pm_minio_secret_key=$(_gen_password 32)
  # pm_web_url — LAN-facing URL Plane bakes into generated emails / share
  # links. Default uses the canonical mDNS hostname covered by the TLS cert
  # SANs; override BEFORE running setup.sh if the customer uses a different
  # LAN name (e.g. `DROPLET_PM_WEB_URL=https://pm.acme.lan ./scripts/setup.sh`).
  # No host-specific IP defaults (rule 14) — DNS name only.
  pm_web_url="${DROPLET_PM_WEB_URL:-https://droplet-ai.local/pm}"

  # OLLAMA_URL — picks the bundled droplet-ollama container by default
  # (single-box PoC). Override before running setup.sh for a multi-box
  # deployment with a separate inference host on the LAN, e.g.
  # `OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh`.
  # The legacy `JETSON_OLLAMA_URL` env var is still read as a fallback
  # for back-compat with operators who have it set in their shell.
  # NEVER set this to `inference-engine.local:11434` — mDNS does not
  # resolve from inside Docker containers and you'll get
  # "Temporary failure in name resolution" on every chat.
  ollama_url="${OLLAMA_URL:-${JETSON_OLLAMA_URL:-http://droplet-ollama:11434}}"

  # --- Write .env directly (single source of truth — no template, no sed) ---
  cat > "$env_file" << EOF
# Droplet Edge Platform — generated by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# WARNING: Contains device-unique secrets. Do NOT commit this file.

# --- PostgreSQL ---
POSTGRES_USER=droplet
POSTGRES_PASSWORD=$pg_password
POSTGRES_DB=droplet
DATABASE_URL=postgresql://droplet:${pg_password}@db:5432/droplet

# --- Redis ---
REDIS_PASSWORD=$redis_password
REDIS_URL=redis://:${redis_password}@cache:6379
# Nextcloud expects this name for the Redis password
REDIS_HOST_PASSWORD=$redis_password

# --- MQTT ---
MQTT_USER=droplet
MQTT_PASSWORD=$mqtt_password
MQTT_BROKER=mqtt://droplet:${mqtt_password}@broker:1883
# Host-mode services (camera-discovery) connect via localhost
MQTT_BROKER_LOCAL=mqtt://droplet:${mqtt_password}@localhost:1883

# --- Nextcloud ---
NEXTCLOUD_ADMIN_USER=admin
NEXTCLOUD_ADMIN_PASSWORD=$nc_password
NEXTCLOUD_URL=http://nextcloud:80

# --- AI Gateway ---
AI_GATEWAY_URL=http://ai-gateway:8000
# Default targets the bundled \`droplet-ollama\` container on the compose
# default network — works out of the box on the single-box PoC where
# Ollama runs alongside the rest of the stack. Override BEFORE running
# setup.sh if you're deploying against a separate inference host on the
# LAN (\`OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh\`).
# The old \`inference-engine.local\` mDNS name does NOT resolve from
# inside Docker containers on Linux/macOS, which is why every fresh PoC
# install used to come up with a broken model list and ai-gateway logs
# full of "Temporary failure in name resolution". See CLAUDE.md
# "Ollama call path" for the full rationale.
OLLAMA_URL=${ollama_url}

# --- Device secrets (unique per device — do not share) ---
DEVICE_SECRET=$device_secret
DEVICE_SECRET_KEY=$device_secret_key

# --- JWT ---
JWT_SECRET=$jwt_secret

# --- Routing service bearer (orchestrator, camera-discovery → routing) ---
ROUTING_SERVICE_TOKEN=$routing_service_token

# --- OpenWrt rpcd/root password (WARP-834) ---
# Per-device password feeding sync_openwrt_password_secret() ->
# docker/secrets/openwrt_password -> /run/secrets/openwrt_password. It serves
# two consumers in lockstep: routing's _load_openwrt_password() (services/
# routing/main.py) uses it for ubus auth, AND droplet-openwrt-attach sets the
# OpenWrt container's root password to match. An empty value previously left
# the router root password unset, so ubus auth never came up. Rotate via
# `sudo systemctl restart droplet-openwrt-attach.service` (sets the container
# root pw + restarts routing together) — NOT a bare `docker compose restart
# routing`, which would present the new pw to a container still on the old one.
OPENWRT_PASSWORD=$openwrt_password

# --- Voice service bearer (voice-io → orchestrator /api/llm/chat) ---
# WARP-154. Read by orchestrator's authMiddleware (matchServiceToken in
# apps/orchestrator/src/middleware/auth.ts) and by voice-io's
# ORCHESTRATOR_TOKEN env (wired via docker-compose.yml). Rotate both
# sides in lockstep — change here, restart both orchestrator + voice-io.
SERVICE_TOKEN_VOICE=$service_token_voice

# --- Display service bearer (orchestrator → oled-display HTTP) ---
# WARP-165. Used by display.client.ts to authenticate to the oled-display
# /health, /display/*, /wifi/* endpoints. Replaces the prior reuse of
# DEVICE_SECRET_KEY (the FIPS-sealed AES-256 master encryption key) on
# this code path, so the master key no longer transits the wire on every
# health probe. Both display.client.ts and oled-display container's
# SERVICE_SECRET + device-bridge's BRIDGE_AUTH_TOKEN MUST read the same
# value; compose wires all three to \${SERVICE_TOKEN_DISPLAY}.
SERVICE_TOKEN_DISPLAY=$service_token_display

# --- ops-console support-client bearer (WARP-337) ---
# Used by Warp Lab support to authenticate to the on-device /ops/*
# API. Loopback-only bind + reverse tunnel is the first line of defense;
# this bearer is the second. Rotate per support engagement if needed.
OPS_TOKEN=$ops_token

# --- MCP service bearer (mcp-server → orchestrator REST) ---
# WARP-339. Same shape as SERVICE_TOKEN_VOICE: the mcp-server presents
# this Bearer on outbound calls to the orchestrator's /api/matter/*,
# /api/audit-log/*, /api/safety-tier/* routes. authMiddleware matches
# via timingSafeEqual and sets req.user = _service:mcp. Distinct token
# so the two service consumers rotate independently. Compose wires
# mcp-server's ORCHESTRATOR_TOKEN to \${SERVICE_TOKEN_MCP}.
SERVICE_TOKEN_MCP=$service_token_mcp

# --- Email indexer service bearer (email-indexer → orchestrator REST) ---
# WARP-465. Bearer the email-indexer presents on ingest POSTs.
# Compose wires email-indexer's ORCHESTRATOR_SERVICE_TOKEN to this value.
SERVICE_TOKEN_EMAIL=$service_token_email

# --- Routing sampler bearers ---
# WARP-468 (egress meter) + WARP-470 (throughput sampler): the routing
# service's apscheduler jobs present this token on POSTs to
# /api/network/{off-lan,throughput}-sample-*. authMiddleware sets
# req.user = _service:sampler.
ORCHESTRATOR_SAMPLER_TOKEN=$orchestrator_sampler_token

# WARP-468: ai-gateway's off_lan_gating middleware presents this token
# on GETs to /api/network/off-lan + /api/settings/off-lan. Without it
# the gate fails closed (every cloud-LLM call 451s).
AI_GATEWAY_SAMPLER_TOKEN=$ai_gateway_sampler_token

# --- WARP-503: embedded Plane PM stack (ADR-010, spec WARP-498) ---
# Customer-facing project-management surface. Wraps upstream Plane (AGPL-3,
# pinned by SHA per spec OQ3) behind Nginx at /pm/.
#
# OQ1 resolution: dedicated postgres-pm + redis-pm. OQ5: workspace-owner
# downgrades surface as manual reconciliation alerts.
#
# All vars are DROPLET_PM_* prefixed (architecture-guard rule 11 — never
# MATTER_*). Required secrets fail-CLOSED via compose ":?MSG" — no host-
# specific defaults (rule 14).
DROPLET_PM_DB_NAME=plane
DROPLET_PM_DB_USER=plane
DROPLET_PM_DB_PASSWORD=$pm_db_password
DROPLET_PM_DB_HOST=postgres-pm
DROPLET_PM_DB_PORT=5432

DROPLET_PM_REDIS_HOST=redis-pm
DROPLET_PM_REDIS_PORT=6379

DROPLET_PM_SECRET_KEY=$pm_secret_key

# Orchestrator-only — used to create/manage Plane users via Plane API.
# NEVER exposed to dashboard or LLM agent. Rotates independently of other
# tokens so a compromise can be contained without re-provisioning every
# user identity.
DROPLET_PM_ADMIN_TOKEN=$pm_admin_token

# Plane signs outgoing webhook payloads with this; orchestrator's
# /api/pm/webhook receiver (WARP-511) validates HMAC + replay window.
# Fail-CLOSED on mismatch per security-rules.md.
DROPLET_PM_WEBHOOK_SECRET=$pm_webhook_secret

# Plane internal API URL — compose-network DNS so a container restart with
# a fresh internal IP doesn't strand callers (same pattern as the gateway's
# nginx resolver).
DROPLET_PM_API_URL=http://pm-api:8000

# LAN-facing URL — Plane bakes into generated emails / share links / OG
# tags. Override BEFORE running setup.sh for non-default LAN hostnames.
DROPLET_PM_WEB_URL=$pm_web_url

# Plane v0.24.1 Celery broker (RabbitMQ) — internal-only, no host port. Plane
# builds CELERY_BROKER_URL from these (plane/settings/common.py). User is
# `plane` (NOT the default `guest`, which RabbitMQ restricts to loopback and
# would refuse cross-container celery connections).
DROPLET_PM_MQ_USER=plane
DROPLET_PM_MQ_PASSWORD=$pm_mq_password
DROPLET_PM_MQ_VHOST=plane

# Plane v0.24.1 object storage (MinIO, S3-compatible) — file uploads/attachments.
# Internal-only. Plane reads AWS_* + USE_MINIO; bucket auto-created on first use.
DROPLET_PM_MINIO_ACCESS_KEY=$pm_minio_access_key
DROPLET_PM_MINIO_SECRET_KEY=$pm_minio_secret_key
DROPLET_PM_MINIO_BUCKET=uploads

# --- Frigate NVR ---
FRIGATE_MQTT_USER=droplet
FRIGATE_MQTT_PASSWORD=$mqtt_password

# --- Application ---
STORAGE_BACKEND=nextcloud
AUTH_ENABLED=true
FILES_ROOT=/data/files
MAX_UPLOAD_SIZE_MB=100

# --- WARP-230 device identity ---
# Selects the device-identity-svc backend.
#   real = use /dev/tpm0 via tpm2-pytss (when a TPM 2.0 chip is present).
#   mock = pure-Python in-memory mock (dev / CI / hosts without a TPM).
DROPLET_TPM_BACKEND=$([ -e /dev/tpm0 ] && printf 'real' || printf 'mock')
DROPLET_DEVICE_ID=$(hostname 2>/dev/null || echo droplet)

# --- Compose profiles ---
# Linux defaults to "linux,display":
#   linux   → Frigate (needs /dev/dri/renderD128), voice-io (needs /dev/snd),
#             wyoming-faster-whisper, wyoming-piper
#   display → oled-display (status display — safe default, auto-falls back
#             to a simulated PNG backend when no /dev/ttyACM* is present)
#   full    → switch driver, camera-discovery (both require real hardware
#             and operator-supplied credentials; not default-on so a fresh
#             install doesn't scan the LAN or hit a missing switch on boot)
# macOS: leave empty — Frigate is skipped, dashboard remains reachable via
# the gateway. Add "full" by hand if you want the hardware-facing services.
COMPOSE_PROFILES=$([ "$(uname)" = "Linux" ] && printf 'linux,display' || printf '')
EOF

  chmod 600 "$env_file"

  log_success "Generated unique secrets:"
  log_info "  POSTGRES_PASSWORD : ${pg_password:0:4}****"
  log_info "  REDIS_PASSWORD    : ${redis_password:0:4}****"
  log_info "  MQTT_PASSWORD     : ${mqtt_password:0:4}****"
  log_info "  NEXTCLOUD_ADMIN   : ${nc_password:0:4}****"
  log_info "  DEVICE_SECRET     : ${device_secret:0:8}****"
  log_info "  DEVICE_SECRET_KEY : ${device_secret_key:0:8}****"
  log_info "  JWT_SECRET        : ${jwt_secret:0:8}****"
  log_info "  ROUTING_TOKEN     : ${routing_service_token:0:8}****"
  log_info "  OPENWRT_PASSWORD  : ${openwrt_password:0:4}****"
  log_info "  VOICE_TOKEN       : ${service_token_voice:0:8}****"
  log_info "  DISPLAY_TOKEN     : ${service_token_display:0:8}****"
  log_info "  OPS_TOKEN         : ${ops_token:0:8}****"
  log_info "  MCP_TOKEN         : ${service_token_mcp:0:8}****"
  log_info "  PM_DB_PASSWORD    : ${pm_db_password:0:4}****"
  log_info "  PM_SECRET_KEY     : ${pm_secret_key:0:8}****"
  log_info "  PM_ADMIN_TOKEN    : ${pm_admin_token:0:8}****"
  log_info "  PM_WEBHOOK_SECRET : ${pm_webhook_secret:0:8}****"
  log_info "  PM_WEB_URL        : $pm_web_url"
  log_info "  PM_MQ_PASSWORD    : ${pm_mq_password:0:4}****"
  log_info "  PM_MINIO_KEY      : ${pm_minio_access_key:0:4}****"
  log_success "Secrets written to $env_file (chmod 600)"

  # NOTE: Artifact materialization (mosquitto password/conf, TLS cert, Docker
  # secret files) and key migration are intentionally NOT called from here.
  # They run unconditionally from setup.sh Phase 4 via materialize_artifacts()
  # and migrate_env() so existing installs whose .env predates a new artifact
  # (e.g. WARP-37 docker/secrets/openwrt_password) self-heal on the next setup.

  log_divider
}

# Backfill missing keys in an existing .env file. Older installs predate
# WARP-36 (ROUTING_SERVICE_TOKEN) and WARP-44 (ROUTING_MODE); without this,
# new keys silently default to empty/insecure values at compose time —
# notably ROUTING_SERVICE_TOKEN="" disables routing-service auth entirely
# (services/routing/main.py:113).
#
# Idempotent: only appends when a key is missing, never rewrites an existing
# value. Backs up .env once on first append.
migrate_env() {
  local env_file="$REPO_ROOT/.env"
  [ -f "$env_file" ] || return 0

  local backed_up=false
  local appended_count=0
  local appended_keys=""

  _migrate_ensure_key() {
    local key="$1" value="$2"
    if ! grep -qE "^${key}=" "$env_file" 2>/dev/null; then
      if [ "$backed_up" = "false" ]; then
        # shellcheck disable=SC2155  # Same rationale as line 29: `date +%s` cannot meaningfully fail.
        local backup="$env_file.bak.$(date +%s)"
        cp "$env_file" "$backup"
        log_info "Backed up existing .env to $backup before migration"
        backed_up=true
      fi
      printf '%s=%s\n' "$key" "$value" >> "$env_file"
      appended_count=$((appended_count + 1))
      appended_keys="$appended_keys $key"
    fi
  }

  # --- One-time rename: JETSON_OLLAMA_URL -> OLLAMA_URL ----------------
  # The env var was originally named with a hardware-specific prefix
  # (Jetson was one of multiple possible inference hosts). The variable
  # is hardware-agnostic — it's just where Ollama is reachable — so we
  # renamed it to OLLAMA_URL. Code still reads JETSON_OLLAMA_URL as a
  # fallback during the transition window, but this migration moves the
  # value to the new name on next setup.sh run so the .env stops
  # carrying the legacy name.
  if grep -qE '^JETSON_OLLAMA_URL=' "$env_file" 2>/dev/null \
     && ! grep -qE '^OLLAMA_URL=' "$env_file" 2>/dev/null; then
    if [ "$backed_up" = "false" ]; then
      # shellcheck disable=SC2155  # Same rationale as lines 29, 352: `date +%s` cannot meaningfully fail; the masked return value carries no signal we'd act on.
      local backup="$env_file.bak.$(date +%s)"
      cp "$env_file" "$backup"
      log_info "Backed up existing .env to $backup before migration"
      backed_up=true
    fi
    # Rename in-place: change the first JETSON_OLLAMA_URL line to OLLAMA_URL.
    # sed -i with a portable backup suffix that we immediately remove,
    # which works on both BSD (Darwin) and GNU sed.
    sed -i.tmp 's/^JETSON_OLLAMA_URL=/OLLAMA_URL=/' "$env_file"
    rm -f "$env_file.tmp"
    log_success "Migrated .env: renamed JETSON_OLLAMA_URL -> OLLAMA_URL (hardware-agnostic)"
  fi

  # Default ROUTING_MODE to `mock` on macOS (no local OpenWrt), `real` on
  # Linux. Only set when missing — never overwrite a user's choice.
  local routing_mode_default="real"
  [ "$(uname)" = "Darwin" ] && routing_mode_default="mock"

  # COMPOSE_PROFILES on Linux defaults to "linux,display":
  #   linux   → Frigate, voice-io, wyoming-faster-whisper, wyoming-piper
  #             (need /dev/dri or /dev/snd, gated on Linux only)
  #   display → oled-display status display (safe default via sim fallback
  #             when /dev/ttyACM* is absent)
  # `full` (switch, camera-discovery) is intentionally not in the default —
  # both need real hardware + credentials. Operator opts in via .env.
  #
  # Only appended when missing — existing installs that pinned a narrower
  # COMPOSE_PROFILES keep their value. To pull in the new default, edit
  # .env manually: COMPOSE_PROFILES=linux,display
  local compose_profiles_default=""
  [ "$(uname)" = "Linux" ] && compose_profiles_default="linux,display"

  _migrate_ensure_key ROUTING_SERVICE_TOKEN "$(openssl rand -hex 32)"
  _migrate_ensure_key ROUTING_MODE "$routing_mode_default"
  _migrate_ensure_key COMPOSE_PROFILES "$compose_profiles_default"
  # WARP-834 backfill: existing installs predate the per-box OpenWrt password.
  # Without it sync_openwrt_password_secret() writes an empty secret file and
  # the OpenWrt container root pw stays unset (ubus auth never comes up).
  _migrate_ensure_key OPENWRT_PASSWORD "$(_gen_password 24)"
  # WARP-154 backfill: existing installs predate the voice service-token
  # path; without this key voice-io will 401 on every /api/llm/chat call.
  _migrate_ensure_key SERVICE_TOKEN_VOICE "$(openssl rand -hex 32)"
  # WARP-165 backfill: existing installs reused DEVICE_SECRET_KEY for the
  # display bearer; without this key the orchestrator → oled-display path
  # falls back to the empty-string bearer and 401s on every health probe.
  _migrate_ensure_key SERVICE_TOKEN_DISPLAY "$(openssl rand -hex 32)"
  # WARP-337 backfill: ops-console support client bearer. Without this
  # key the service falls through to an ephemeral token that regenerates
  # on every container restart, so support's saved credential invalidates
  # silently. The token is operator-only (loopback bind + reverse tunnel
  # is the actual exposure surface — see docs/operator-surfaces.md).
  _migrate_ensure_key OPS_TOKEN "$(openssl rand -hex 32)"
  # WARP-339 backfill: existing installs predate the mcp service-token
  # path; without this key mcp-server's outbound calls to orchestrator
  # /api/matter/* will 401 when AUTH_ENABLED=true.
  _migrate_ensure_key SERVICE_TOKEN_MCP "$(openssl rand -hex 32)"

  # WARP-503 backfill: embedded Plane PM stack (ADR-010). Existing installs
  # predate the PM stack; without these keys docker compose up will refuse
  # to start the pm-api / postgres-pm containers (compose-level :?MSG fail).
  # Each is generated independently so a partial backfill (e.g. operator
  # set DROPLET_PM_WEB_URL manually but no secrets yet) still works.
  _migrate_ensure_key DROPLET_PM_DB_NAME "plane"
  _migrate_ensure_key DROPLET_PM_DB_USER "plane"
  _migrate_ensure_key DROPLET_PM_DB_PASSWORD "$(_gen_password 24)"
  _migrate_ensure_key DROPLET_PM_DB_HOST "postgres-pm"
  _migrate_ensure_key DROPLET_PM_DB_PORT "5432"
  _migrate_ensure_key DROPLET_PM_REDIS_HOST "redis-pm"
  _migrate_ensure_key DROPLET_PM_REDIS_PORT "6379"
  _migrate_ensure_key DROPLET_PM_SECRET_KEY "$(openssl rand -hex 50)"
  _migrate_ensure_key DROPLET_PM_ADMIN_TOKEN "$(openssl rand -hex 32)"
  _migrate_ensure_key DROPLET_PM_WEBHOOK_SECRET "$(openssl rand -hex 32)"
  _migrate_ensure_key DROPLET_PM_API_URL "http://pm-api:8000"
  _migrate_ensure_key DROPLET_PM_WEB_URL "${DROPLET_PM_WEB_URL:-https://droplet-ai.local/pm}"
  # Plane v0.24.1 broker + object storage (completing the #487 integration).
  _migrate_ensure_key DROPLET_PM_MQ_USER "plane"
  _migrate_ensure_key DROPLET_PM_MQ_PASSWORD "$(_gen_password 24)"
  _migrate_ensure_key DROPLET_PM_MQ_VHOST "plane"
  _migrate_ensure_key DROPLET_PM_MINIO_ACCESS_KEY "$(openssl rand -hex 16)"
  _migrate_ensure_key DROPLET_PM_MINIO_SECRET_KEY "$(_gen_password 32)"
  _migrate_ensure_key DROPLET_PM_MINIO_BUCKET "uploads"

  # WARP-230 device-identity. Pick backend based on /dev/tpm0 presence
  # on the host — hosts with a TPM hit 'real', everything else hits
  # 'mock'. Operator can override either by editing .env.
  local di_backend_default="mock"
  [ -e /dev/tpm0 ] && di_backend_default="real"
  _migrate_ensure_key DROPLET_TPM_BACKEND "$di_backend_default"
  _migrate_ensure_key DROPLET_DEVICE_ID "$(hostname 2>/dev/null || echo droplet)"

  if [ "$appended_count" -gt 0 ]; then
    log_success "Migrated .env: appended$appended_keys"
  fi
}

# Materialize all setup-time artifact files that Docker Compose bind-mounts
# (Docker secret file, MQTT password file + conf, TLS cert). Each underlying
# generator is individually idempotent, so this is safe to run on every
# setup invocation.
#
# This intentionally lives outside generate_env() so it runs even when .env
# already exists — the common upgrade-an-existing-install path.
materialize_artifacts() {
  log_info "Materializing setup artifacts (idempotent)..."

  # Source .env so MQTT_PASSWORD / OPENWRT_PASSWORD / MQTT_USER are in scope
  # for the helpers below. Reachable via setup.sh --sync-secrets where nothing
  # else has loaded .env yet.
  if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
  fi

  _generate_mosquitto_passwd "${MQTT_PASSWORD:-}"
  _write_mosquitto_conf
  _generate_tls_cert
  sync_openwrt_password_secret
  sync_audit_signing_key
  sync_pm_oidc_keypair
}

# WARP-505 — Generate the OIDC IdP keypair on first run + backfill .env.
#
# Per spec WARP-498 OQ6: orchestrator runs a minimal OIDC IdP for the
# embedded Plane PM stack. ID tokens are signed RS256 — Plane verifies
# via JWKS (HMAC won't work). RSA-2048 is the OIDC interop floor.
#
# Idempotent — only generates + appends when the key is missing. Existing
# installs with a key already in .env preserve it across re-runs.
#
# Stored as a single \n-escaped line so the .env file stays parseable by
# every consumer (bash source, docker compose env interpolation, Zod
# parser at orchestrator startup — pm-oidc.service.ts decodes back to PEM).
sync_pm_oidc_keypair() {
  local env_file="$REPO_ROOT/.env"
  [ -f "$env_file" ] || return 0

  if grep -qE '^DROPLET_PM_OIDC_PRIVATE_KEY_PEM=.+' "$env_file" 2>/dev/null; then
    log_success "PM OIDC keypair already present — skipping"
    return 0
  fi

  log_info "Generating PM OIDC keypair (RS256, 2048-bit)..."

  local key_tmp escaped_pem kid client_secret
  key_tmp="$(mktemp)"
  if ! openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
       -out "$key_tmp" 2>/dev/null; then
    log_error "openssl genpkey failed — PM OIDC IdP will not work until this is fixed"
    rm -f "$key_tmp"
    return 1
  fi
  # Encode multi-line PEM as \n-separated single line so the .env line
  # stays parseable. orchestrator's pm-oidc.service.ts decodes the
  # literal `\n` back to a real newline before handing to jwt.sign.
  escaped_pem="$(awk 'BEGIN{ORS="\\n"} {print}' "$key_tmp")"
  rm -f "$key_tmp"

  kid="$(openssl rand -hex 16)"
  client_secret="$(openssl rand -hex 32)"

  {
    printf '\n# --- WARP-505 PM OIDC IdP (spec WARP-498 OQ6) ---\n'
    # Single-quote the PEM. The \n-escaped value still contains spaces
    # (-----BEGIN PRIVATE KEY-----), so an UNQUOTED assignment word-splits
    # when .env is `source`d (setup.sh, verify.sh, compose.sh all do), failing
    # with "line N: PRIVATE: command not found" and aborting the stack Start.
    # Safe: the value is base64 + literal \n and never contains a single quote.
    printf "DROPLET_PM_OIDC_PRIVATE_KEY_PEM='%s'\n" "$escaped_pem"
    printf 'DROPLET_PM_OIDC_KID=%s\n' "$kid"
    printf 'DROPLET_PM_OIDC_CLIENT_SECRET=%s\n' "$client_secret"
  } >> "$env_file"
  chmod 600 "$env_file"

  log_success "PM OIDC keypair generated (kid ${kid:0:8}****)"
  log_info "  Configure Plane god-mode /authentication/oidc/ with:"
  log_info "    client_id     = plane (or override DROPLET_PM_OIDC_CLIENT_ID)"
  log_info "    client_secret = ${client_secret:0:8}**** (full value in .env)"
}

# Generate /data/secrets/audit.key on first boot for WARP-456.
#
# The orchestrator's audit-signing.service.ts reads this file at startup
# (or AUDIT_SIGNING_KEY env var in dev/CI) and HMAC-SHA256 signs every
# ActivityRow with it, forming a tamper-evident hash chain across all
# events emitted on the device. Without the key the orchestrator refuses
# to start (no unsigned activity rows ever leave the recorder).
#
# Stored as raw binary at mode 0600 because:
#  - the orchestrator container reads bytes directly (no base64 decode)
#  - any non-orchestrator process on the box must not be able to forge
#    historical events.
#
# Idempotent: the existing key is preserved on every re-run so the chain
# stays verifiable across upgrades. Rotation is a future ticket — when
# it lands it'll write a new file with a versioned suffix and the
# verifier will accept the union of (current, prior) keys.
sync_audit_signing_key() {
  local secret_dir="$REPO_ROOT/data/secrets"
  local key_file="$secret_dir/audit.key"

  mkdir -p "$secret_dir"
  chmod 700 "$secret_dir"

  if [ -f "$key_file" ] && [ -s "$key_file" ]; then
    # Already provisioned — preserve the existing chain. `-s` (size > 0)
    # is the guard against a half-written file from a previous crashed
    # setup run.
    log_success "Audit signing key already present at $key_file — skipping"
    return 0
  fi

  # 32 bytes = HMAC-SHA256 strength floor matched by
  # audit-signing.service.ts:MIN_KEY_BYTES. Write to a `.tmp` first so a
  # crashed install never leaves an empty file that the orchestrator
  # would then treat as a real key.
  local tmp="$key_file.tmp"
  openssl rand 32 > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$key_file"
  log_success "Generated audit signing key at $key_file (chmod 600)"
}

# Write $OPENWRT_PASSWORD (from env or .env) into docker/secrets/openwrt_password
# so Docker Compose can mount it as a read-only secret at /run/secrets/openwrt_password.
# Safe to call independently after editing .env — the file is overwritten atomically.
sync_openwrt_password_secret() {
  local secret_dir="$REPO_ROOT/docker/secrets"
  local secret_file="$secret_dir/openwrt_password"
  local password="${OPENWRT_PASSWORD:-}"

  # Fall back to reading .env if the value isn't already in the shell environment.
  # `|| true` keeps a missing OPENWRT_PASSWORD line from tripping `set -euo pipefail`
  # (grep exits 1 on no match, which with pipefail would kill setup.sh mid-flight).
  # The function already handles an empty password below.
  if [ -z "$password" ] && [ -f "$REPO_ROOT/.env" ]; then
    password=$(grep -E '^OPENWRT_PASSWORD=' "$REPO_ROOT/.env" | head -n 1 | cut -d= -f2- || true)
  fi

  mkdir -p "$secret_dir"
  chmod 700 "$secret_dir"

  if [ -z "$password" ]; then
    # Write an empty placeholder so Docker Compose can still start (routing
    # service degrades to "router not connected" at startup without crashing).
    : > "$secret_file"
    chmod 600 "$secret_file"
    log_warn "OPENWRT_PASSWORD is empty — wrote empty $secret_file"
    log_info "  Set OPENWRT_PASSWORD in .env, then re-run ./scripts/setup.sh --sync-secrets"
    return 0
  fi

  # Write atomically: stage to .tmp then rename, so a crashed write never leaves
  # a half-populated secret file that the routing container would then read.
  local tmp="$secret_file.tmp"
  printf '%s' "$password" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$secret_file"
  log_success "Wrote $secret_file (chmod 600)"
}

_generate_mosquitto_passwd() {
  local mqtt_password="$1"
  local mqtt_user="${MQTT_USER:-droplet}"
  local passwd_dir="$REPO_ROOT/docker/mosquitto_passwd_dir"
  local passwd_file="$passwd_dir/mosquitto_passwd"

  log_info "Generating MQTT password file..."

  # Ensure the target directory exists (this is what docker-compose.yml mounts).
  # The parent directory is owned by the current user, so we can unlink any
  # stale file inside it without sudo even if the file itself is root-owned.
  mkdir -p "$passwd_dir"
  rm -f "$passwd_file" 2>/dev/null || true

  # Write directly to the final mount location. Pass --user so the container
  # runs as the host user and the generated file is already correctly owned —
  # no follow-up `sudo chown` needed. This is required for unattended factory
  # reset on the device, where nothing should prompt for a sudo password.
  if run_docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$passwd_dir:/tmp/mqtt" \
    eclipse-mosquitto:2 \
    sh -c "mosquitto_passwd -b -c /tmp/mqtt/mosquitto_passwd '$mqtt_user' '$mqtt_password'"; then
    # 0644 — the runtime mosquitto container runs as uid 1883, not the host
    # user (1000) that generated the file, so 0600 made the file unreadable
    # and mosquitto crash-looped with "Unable to open pwfile". The bytes on
    # disk are a bcrypt hash, not the plaintext; .env holds the plaintext
    # at 0600 already.
    chmod 644 "$passwd_file"
    log_success "MQTT password file generated"
  else
    # Fallback: create a plaintext file (no Docker needed).
    # IMPORTANT: the bytes here are the PLAINTEXT password, not a bcrypt
    # hash. The 0644 justification on the success branch above applies
    # only to hashed output; leaving a plaintext MQTT credential
    # world-readable on the host would be a real regression. Keep this
    # file at 0600 and try to hand ownership to the mosquitto UID (1883)
    # so the runtime container can still read it. If chown fails (no
    # sudo, not root, non-POSIX fs) we warn loudly — the operator needs
    # to rerun once Docker is available so the hashed path takes over.
    log_warn "Could not generate hashed MQTT password — using plaintext fallback"
    printf "%s:%s\n" "$mqtt_user" "$mqtt_password" > "$passwd_file"
    chmod 600 "$passwd_file"
    if [ "$(id -u)" = "0" ]; then
      chown 1883:1883 "$passwd_file" 2>/dev/null || true
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo chown 1883:1883 "$passwd_file" 2>/dev/null || true
    else
      log_warn "plaintext passwd_file left owned by $(id -un); mosquitto (uid 1883) may not be able to read it — install Docker and rerun to generate the hashed version"
    fi
  fi

  # Clean up stale intermediate file from old code path. The parent directory
  # (docker/) is user-owned, so plain rm can unlink even a root-owned file.
  rm -f "$REPO_ROOT/docker/mosquitto_passwd" 2>/dev/null || true
}

_write_mosquitto_conf() {
  local conf_file="$REPO_ROOT/docker/mosquitto.conf"

  # Clean up stale file or directory from a previous failed run. Docker creates
  # a directory if the bind-mount target doesn't exist as a file yet, so we
  # need rm -rf to handle both cases.
  rm -rf "$conf_file" 2>/dev/null || true

  cat > "$conf_file" << 'MQTTCONF'
listener 1883
password_file /mosquitto/config/passwd_dir/mosquitto_passwd
allow_anonymous false
persistence false
MQTTCONF

  log_success "Mosquitto configured with authentication"
}

# DNS names every Droplet TLS cert must cover. These are the friendly host-
# names the local-DNS layer registers (droplet-ai.local via mDNS,
# droplet-ai.lan via OpenWrt dnsmasq) plus legacy variants users might type
# from muscle memory. A cert missing any of these will cause a browser
# hostname-mismatch warning even after the user installs it as trusted, so
# they're all mandatory — we regenerate the cert if any are absent.
_REQUIRED_DNS_SANS=(
  localhost
  droplet
  droplet.local
  droplet.lan
  droplet-ai
  droplet-ai.local
  droplet-ai.lan
)

_cert_has_all_required_sans() {
  local cert_file="$1"
  local dns_list
  # `openssl x509 -ext subjectAltName` prints e.g.:
  #   X509v3 Subject Alternative Name:
  #       DNS:localhost, DNS:droplet-AI, IP Address:192.168.50.197
  # Extract every DNS: entry and lowercase for case-insensitive comparison
  # (DNS name matching is case-insensitive per RFC 6125).
  dns_list="$(openssl x509 -in "$cert_file" -noout -ext subjectAltName 2>/dev/null \
              | grep -oE 'DNS:[^,[:space:]]+' \
              | sed 's/^DNS://' \
              | tr '[:upper:]' '[:lower:]')"

  local required
  for required in "${_REQUIRED_DNS_SANS[@]}"; do
    # Compare against the lowercased list — if we can't find an exact match,
    # the cert is incomplete and must be regenerated.
    if ! printf '%s\n' "$dns_list" | grep -qxF "$(printf '%s' "$required" | tr '[:upper:]' '[:lower:]')"; then
      return 1
    fi
  done
  return 0
}

_generate_tls_cert() {
  local cert_dir="$REPO_ROOT/docker/certs"
  local cert_file="$cert_dir/droplet.crt"
  local key_file="$cert_dir/droplet.key"

  # Skip only if the cert is both still valid AND covers every required DNS
  # name. A SAN-complete check was added after the local-DNS feature landed;
  # without it, installs upgrading from an older setup still served a cert
  # without droplet-ai.lan / droplet.local etc. in the SAN, forcing a
  # hostname-mismatch error even after the user trusted the cert.
  if [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    if openssl x509 -checkend 86400 -noout -in "$cert_file" >/dev/null 2>&1 \
       && _cert_has_all_required_sans "$cert_file"; then
      log_success "TLS certificate already exists, is valid, and covers all required SANs — skipping"
      return 0
    fi
    if ! openssl x509 -checkend 86400 -noout -in "$cert_file" >/dev/null 2>&1; then
      log_warn "TLS certificate expired or invalid — regenerating"
    else
      log_warn "TLS certificate is missing one or more required DNS SANs — regenerating"
    fi
  fi

  log_info "Generating self-signed TLS certificate (valid 10 years)..."
  mkdir -p "$cert_dir"

  # Start with the fixed list of friendly hostnames the local-DNS layer
  # registers (mDNS + router DNS + legacy variants). This set is stable
  # across devices so every Droplet cert trusts the same names.
  local san=""
  local dns
  for dns in "${_REQUIRED_DNS_SANS[@]}"; do
    san="${san:+$san,}DNS:$dns"
  done

  # Also add the system hostname (and hostname.local) in case it differs
  # from the friendly names above — e.g. Ubuntu's `droplet-AI` hostname.
  # Duplicates are harmless.
  local hn
  hn=$(hostname 2>/dev/null || echo "droplet")
  san="$san,DNS:$hn,DNS:${hn}.local"

  # Add all non-loopback IPv4 addresses
  local ip
  for ip in $(ip -4 addr show scope global 2>/dev/null \
              | grep -oP 'inet \K[\d.]+' 2>/dev/null || \
              ifconfig 2>/dev/null \
              | grep -oE 'inet (addr:)?[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
              | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
              | grep -v '^127\.'); do
    san="$san,IP:$ip"
  done
  # Always include loopback
  san="$san,IP:127.0.0.1"

  openssl req -x509 -nodes -newkey rsa:2048 \
    -days 3650 \
    -keyout "$key_file" \
    -out "$cert_file" \
    -subj "/CN=Droplet Edge Device" \
    -addext "subjectAltName=$san" \
    2>/dev/null

  chmod 600 "$key_file"
  chmod 644 "$cert_file"

  log_success "TLS certificate generated:"
  log_info "  Cert: $cert_file"
  log_info "  Key:  $key_file"
  log_info "  SANs: $san"

  # If the gateway container is already running (setup.sh re-run or
  # --sync-secrets flow), ask nginx to reload so the new cert is served
  # immediately. On a fresh install this is a no-op because gateway isn't
  # up yet — nginx will just pick up the cert on first start.
  if command -v docker >/dev/null 2>&1; then
    local compose_file="$REPO_ROOT/docker/docker-compose.yml"
    if [ -f "$compose_file" ] && \
       docker compose -f "$compose_file" ps --services --filter status=running 2>/dev/null \
         | grep -qx gateway; then
      if docker compose -f "$compose_file" exec -T gateway nginx -s reload 2>/dev/null; then
        log_info "  Hot-reloaded gateway nginx with the new cert"
      else
        log_warn "  Could not nginx -s reload the gateway container — restart it manually:"
        log_warn "    docker compose -f docker/docker-compose.yml restart gateway"
      fi
    fi
  fi
}
