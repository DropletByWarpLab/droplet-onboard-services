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
  local pg_password redis_password mqtt_password nc_password device_secret device_secret_key jwt_secret routing_service_token service_token_voice service_token_display service_token_switch service_token_ai_gateway ops_token service_token_mcp service_token_email orchestrator_sampler_token ai_gateway_sampler_token ollama_url openwrt_password
  # WARP-850: orchestrator -> matter-controller sidecar bearer (X-Droplet-Auth).
  local droplet_matter_service_token
  # WARP-882 / WS-4: shared HS256 secret the OnlyOffice Document Server, the
  # Nextcloud `onlyoffice` connector, AND the orchestrator all verify.
  local onlyoffice_jwt_secret
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
  # Shared bearer for orchestrator → switch service HTTP calls (/ports,
  # /vlans, /poe, /provision/*). Same WARP-165 rationale as the display
  # token: the switch container's SERVICE_SECRET previously reused
  # DEVICE_SECRET_KEY (the FIPS-sealed AES-256 master encryption key),
  # putting the master key on the wire — and the orchestrator side was
  # never wired at all, so the moment DEVICE_SECRET_KEY existed the
  # switch service started 403ing every orchestrator call (the dashboard
  # Network page's "Router unavailable"). Both switch.client.ts
  # (orchestrator, outbound) and the switch container's SERVICE_SECRET
  # MUST read the same value; compose wires both ends to
  # ${SERVICE_TOKEN_SWITCH}.
  service_token_switch=$(openssl rand -hex 32)
  # WARP-560: bearer the orchestrator presents on every outbound call to
  # the ai-gateway. The gateway's ServiceAuthMiddleware requires it on all
  # /ai/* routes (except /ai/health) — before this the gateway had NO
  # inbound auth. Both ai-gateway.client.ts (orchestrator, outbound) and the
  # ai-gateway container's SERVICE_TOKEN_AI_GATEWAY MUST read the same value;
  # compose wires both ends to ${SERVICE_TOKEN_AI_GATEWAY}.
  service_token_ai_gateway=$(openssl rand -hex 32)
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
  # WARP-850: shared bearer the orchestrator presents in the
  # X-Droplet-Auth header on every call to the matter-controller
  # host-network sidecar (services/matter-controller, port 8083).
  # Same device-bridge auth pattern as SERVICE_TOKEN_DISPLAY; the
  # sidecar fails CLOSED (401s everything) when this is empty. Both
  # ends read the same .env key via compose — rotate in lockstep and
  # restart orchestrator + matter-controller together.
  droplet_matter_service_token=$(openssl rand -hex 32)
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
  # WARP-882 / WS-4: device-unique HS256 secret for the OnlyOffice in-browser
  # editing / co-authoring handshake. The Document Server, the Nextcloud
  # `onlyoffice` connector, AND the orchestrator's docserver.client.ts all sign +
  # verify document-access JWTs with this ONE value. It MUST be device-unique and
  # unguessable: a shared/default secret (the old `change-me` placeholder) lets
  # anyone forge an HS256 token granting access to any document. 32 random bytes
  # (64 hex chars) clears the orchestrator's JWT-strength floor. The doc-server is
  # default-ON on the 32 GB box (dropped on ≤8 GB), but we generate the secret
  # unconditionally so it is always strong (never a placeholder) on every box,
  # whatever the RAM gate decides about DOCS_ENABLED / the `docs` profile.
  onlyoffice_jwt_secret=$(openssl rand -hex 32)

  # OLLAMA_URL — picks the bundled droplet-ollama container by default
  # (single-box). Override before running setup.sh for a multi-box
  # deployment with a separate inference host on the LAN, e.g.
  # `OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh`.
  # NEVER set this to `inference-engine.local:11434` — mDNS does not
  # resolve from inside Docker containers and you'll get
  # "Temporary failure in name resolution" on every chat.
  ollama_url="${OLLAMA_URL:-http://droplet-ollama:11434}"

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

# --- Document server (WARP-882 / WS-4 — in-browser editing + co-authoring) ---
# ONLYOFFICE_JWT_SECRET: device-unique HS256 secret the OnlyOffice Document
# Server, the Nextcloud \`onlyoffice\` connector, AND the orchestrator's
# docserver.client.ts all sign/verify document-access JWTs with. Generated here
# unconditionally so the secret is always strong (never a forgeable placeholder)
# regardless of whether the box runs the engine. The doc-server is DEFAULT-ON on
# the 32 GB box (DOCS_ENABLED=1 + \`docs\` in COMPOSE_PROFILES, RAM-gated in
# scripts/lib/single-box.sh) and dropped on ≤8 GB boxes — see .env.example.
ONLYOFFICE_JWT_SECRET=$onlyoffice_jwt_secret

# --- AI Gateway ---
AI_GATEWAY_URL=http://ai-gateway:8000
# Default targets the bundled \`droplet-ollama\` container on the compose
# default network — works out of the box on the single-box deployment where
# Ollama runs alongside the rest of the stack. Override BEFORE running
# setup.sh if you're deploying against a separate inference host on the
# LAN (\`OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh\`).
# The old \`inference-engine.local\` mDNS name does NOT resolve from
# inside Docker containers on Linux/macOS, which is why every fresh
# single-box install used to come up with a broken model list and ai-gateway logs
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
# \`sudo systemctl restart droplet-openwrt-attach.service\` (sets the container
# root pw + restarts routing together) — NOT a bare \`docker compose restart
# routing\`, which would present the new pw to a container still on the old one.
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

# --- Switch service bearer (orchestrator → switch service HTTP) ---
# Used by switch.client.ts to authenticate to the switch service's
# /ports, /vlans, /poe, /provision/* endpoints. Replaces the prior
# reuse of DEVICE_SECRET_KEY (the FIPS-sealed AES-256 master encryption
# key) as the switch container's SERVICE_SECRET — same rationale as
# SERVICE_TOKEN_DISPLAY above. Both switch.client.ts and the switch
# container's SERVICE_SECRET MUST read the same value; compose wires
# both ends to \${SERVICE_TOKEN_SWITCH}.
SERVICE_TOKEN_SWITCH=$service_token_switch

# --- AI gateway service bearer (orchestrator → ai-gateway HTTP) ---
# WARP-560. Required by the ai-gateway's ServiceAuthMiddleware on every
# /ai/* route (chat, sessions, BYOK key CRUD) except /ai/health — the
# gateway previously had NO inbound auth at all. Both ai-gateway.client.ts
# and the ai-gateway container's SERVICE_TOKEN_AI_GATEWAY MUST read the
# same value; compose wires both ends to \${SERVICE_TOKEN_AI_GATEWAY}.
SERVICE_TOKEN_AI_GATEWAY=$service_token_ai_gateway

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

# --- Matter controller sidecar bearer (orchestrator → matter-controller) ---
# WARP-850. The matter.js controller runs in the matter-controller
# host-network sidecar (raw HCI for BLE commissioning + native LAN
# mDNS); the orchestrator authenticates to it with this token in the
# X-Droplet-Auth header (device-bridge precedent). The sidecar fails
# closed when the value is empty. Rotate both sides in lockstep —
# change here, restart orchestrator + matter-controller.
DROPLET_MATTER_SERVICE_TOKEN=$droplet_matter_service_token

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

# --- Public-CA per-device TLS (ADR-023) ---
# DROPLET_PUBLIC_FQDN: the opaque per-device subdomain
#   d-HMAC.devices.warp-lab.ai. The box CANNOT compute the HQ-keyed HMAC, so it
#   starts EMPTY and is populated when the tls-issuance cron learns the FQDN
#   from the HQ challenge response and persists it back here. Empty is the
#   correct first-boot value: the bootstrap self-signed cert keeps the box
#   serving TLS, and the FQDN becomes the canonical origin + a bootstrap-SAN
#   entry once known.
DROPLET_PUBLIC_FQDN=
# HQ_ISSUANCE_URL: base URL of the fleet HQ issuance API. PRESERVED from the
#   provisioning environment / manifest (${HQ_ISSUANCE_URL:-}) so a fresh or
#   reflashed box that was handed the HQ URL keeps live issuance. Without this,
#   factory-reset wipes .env and the box permanently loses its droplet-us.com
#   cert + FQDN → remote access dead-ends (WARP-978). Empty disables live
#   issuance (dev / pre-fleet). Plain outbound HTTPS; no WG tunnel required.
HQ_ISSUANCE_URL=${HQ_ISSUANCE_URL:-}
# TUNNEL_TOKEN: Cloudflare Tunnel connector token for the remote-access relay
#   (WARP-974 / ADR-025). PRESERVED from the provisioning environment. Empty =
#   relay OFF — single-box.sh only activates the `relay` compose profile
#   (cloudflared) when this is set, so an un-provisioned box never brings up a
#   tokenless connector.
TUNNEL_TOKEN=${TUNNEL_TOKEN:-}

# --- Compose profiles ---
# Linux defaults to "linux,display,eval":
#   linux   → Frigate (needs /dev/dri/renderD128), voice-io (needs /dev/snd),
#             wyoming-faster-whisper, wyoming-piper
#   display → oled-display (status display — safe default, auto-falls back
#             to a simulated PNG backend when no /dev/ttyACM* is present)
#   eval    → rag-eval (RAGAS retrieval-quality scoring). Standard in ALL
#             environments per WARP-844 follow-up — the judge runs on the
#             appliance's own Ollama, so even macOS dev can score runs
#             (slower, but functional). Pause the schedule with
#             RAG_EVAL_DISABLED=1 rather than dropping the profile — the
#             ad-hoc /api/admin/rag-eval/* surface needs the container up.
#   full    → switch driver, camera-discovery (both require real hardware
#             and operator-supplied credentials; not default-on so a fresh
#             install doesn't scan the LAN or hit a missing switch on boot)
# macOS: linux/display are skipped (GPU/audio device mounts), but eval stays.
# Add "full" by hand if you want the hardware-facing services.
COMPOSE_PROFILES=$([ "$(uname)" = "Linux" ] && printf 'linux,display,eval' || printf 'eval')
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
  log_info "  MATTER_TOKEN      : ${droplet_matter_service_token:0:8}****"
  log_info "  ONLYOFFICE_JWT    : ${onlyoffice_jwt_secret:0:8}****"
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

  # Default ROUTING_MODE to `mock` on macOS (no local OpenWrt), `real` on
  # Linux. Only set when missing — never overwrite a user's choice.
  local routing_mode_default="real"
  [ "$(uname)" = "Darwin" ] && routing_mode_default="mock"

  # COMPOSE_PROFILES on Linux defaults to "linux,display,eval":
  #   linux   → Frigate, voice-io, wyoming-faster-whisper, wyoming-piper
  #             (need /dev/dri or /dev/snd, gated on Linux only)
  #   display → oled-display status display (safe default via sim fallback
  #             when /dev/ttyACM* is absent)
  #   eval    → rag-eval (RAGAS) — standard in every env (WARP-845), so
  #             macOS dev defaults to "eval" alone
  # `full` (switch, camera-discovery) is intentionally not in the default —
  # both need real hardware + credentials. Operator opts in via .env.
  #
  # Only appended when missing — existing installs that pinned a narrower
  # COMPOSE_PROFILES keep their value. To pull in the new default, edit
  # .env manually: COMPOSE_PROFILES=linux,display,eval
  local compose_profiles_default="eval"
  [ "$(uname)" = "Linux" ] && compose_profiles_default="linux,display,eval"

  _migrate_ensure_key ROUTING_SERVICE_TOKEN "$(openssl rand -hex 32)"
  _migrate_ensure_key ROUTING_MODE "$routing_mode_default"
  _migrate_ensure_key COMPOSE_PROFILES "$compose_profiles_default"
  # WARP-978: ensure the HQ issuance URL + relay tunnel token exist on re-run,
  # seeded from the provisioning environment (empty = live issuance / relay off).
  # Pairs with the seed-block `${HQ_ISSUANCE_URL:-}` / `${TUNNEL_TOKEN:-}` above so
  # a reflashed box keeps its droplet-us.com cert + relay when provisioning hands
  # these in, instead of silently regressing to the self-signed bootstrap cert.
  _migrate_ensure_key HQ_ISSUANCE_URL "${HQ_ISSUANCE_URL:-}"
  _migrate_ensure_key TUNNEL_TOKEN "${TUNNEL_TOKEN:-}"
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
  # Switch-bearer backfill: existing installs wired the switch container's
  # SERVICE_SECRET to DEVICE_SECRET_KEY while the orchestrator side sent no
  # bearer at all — so any install with a DEVICE_SECRET_KEY in .env had the
  # switch service 403ing every orchestrator call. Minting this key (and the
  # compose rewire to ${SERVICE_TOKEN_SWITCH} on both ends) restores the
  # orchestrator → switch path and keeps DEVICE_SECRET_KEY off the wire.
  _migrate_ensure_key SERVICE_TOKEN_SWITCH "$(openssl rand -hex 32)"
  # WARP-560 backfill: existing installs predate the ai-gateway inbound-auth
  # token. Minting it (and the compose wire on both ends) closes the gap where
  # /ai/chat, /ai/sessions/*, and /ai/keys/* were reachable with no auth.
  # Until the gateway also reads SERVICE_TOKEN_AI_GATEWAY it stays open, so the
  # orchestrator already sending a bearer is harmless; once both ends have the
  # key the gateway enforces it.
  _migrate_ensure_key SERVICE_TOKEN_AI_GATEWAY "$(openssl rand -hex 32)"
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
  # WARP-850 backfill: existing installs predate the matter-controller
  # sidecar; without this key the sidecar's auth wall fails closed and
  # every orchestrator Matter call 401s (dashboard shows the controller
  # as disconnected).
  _migrate_ensure_key DROPLET_MATTER_SERVICE_TOKEN "$(openssl rand -hex 32)"
  # WARP-882 / WS-4 backfill: already-provisioned boxes predate the OnlyOffice
  # doc-server JWT secret. Without this key the orchestrator + connector would
  # fall back to an empty/default secret on the document-access handshake —
  # forgeable HS256 — so backfill a device-unique 32-byte secret here too. Only
  # appended when missing (idempotent); a box that already opted in keeps its
  # value. The doc-server stays OPT-IN / default-OFF — minting the secret does
  # NOT start the engine (that needs DOCS_ENABLED=1 + \`docs\` in COMPOSE_PROFILES).
  _migrate_ensure_key ONLYOFFICE_JWT_SECRET "$(openssl rand -hex 32)"

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

  # Source .env so MQTT_PASSWORD / OPENWRT_PASSWORD / SWITCH_PASSWORD / MQTT_USER
  # are in scope for the helpers below. Reachable via setup.sh --sync-secrets
  # where nothing else has loaded .env yet.
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
  sync_switch_password_secret
  sync_audit_signing_key
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

# ADR-018 T1 — Write the OPERATOR-SUPPLIED $SWITCH_PASSWORD (from env or .env)
# into docker/secrets/switch_password so Docker Compose can mount it read-only at
# /run/secrets/switch_password in the switch container. Mirrors
# sync_openwrt_password_secret(), with one deliberate difference: the managed
# switch is NOT a device we mint a secret for, so this NEVER generates a value —
# it only materializes what the operator put in .env.
#
# When SWITCH_PASSWORD is unset/empty (a box without a managed switch, the common
# case) we write an EMPTY placeholder rather than a real credential: the
# `secrets:` mount in docker-compose.yml requires the file to exist for
# `docker compose up switch` to start, and drivers._load_switch_password() treats
# an empty file exactly like "no switch configured" — the switch service comes up
# and reports "disconnected" without crashing. So non-switch boxes are unaffected.
sync_switch_password_secret() {
  local secret_dir="$REPO_ROOT/docker/secrets"
  local secret_file="$secret_dir/switch_password"
  local password="${SWITCH_PASSWORD:-}"

  # Fall back to reading .env if the value isn't already in the shell environment.
  # `|| true` keeps a missing SWITCH_PASSWORD line from tripping `set -euo pipefail`
  # (grep exits 1 on no match). An empty password is handled gracefully below.
  if [ -z "$password" ] && [ -f "$REPO_ROOT/.env" ]; then
    password=$(grep -E '^SWITCH_PASSWORD=' "$REPO_ROOT/.env" | head -n 1 | cut -d= -f2- || true)
  fi

  mkdir -p "$secret_dir"
  chmod 700 "$secret_dir"

  if [ -z "$password" ]; then
    # No operator credential supplied — write an empty placeholder so Compose can
    # mount the secret and the switch service still starts (degraded → the switch
    # reports "disconnected"). NEVER generate a switch password here. Boxes
    # without a managed switch hit exactly this path and are unaffected.
    : > "$secret_file"
    chmod 600 "$secret_file"
    log_info "SWITCH_PASSWORD not set in .env — wrote empty $secret_file (no managed switch)"
    log_info "  For a managed switch: set SWITCH_PASSWORD in .env, then re-run ./scripts/setup.sh --sync-secrets"
    return 0
  fi

  # Write atomically: stage to .tmp then rename, so a crashed write never leaves
  # a half-populated secret file that the switch container would then read.
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

# ADR-023 PR-2: detect whether the installed leaf is a PUBLIC-CA cert (an
# LE / ZeroSSL / Google Trust Services fullchain the box-side tls-issuance cron
# installed) rather than our own self-signed bootstrap cert.
#
# Detector: issuer != subject. A self-signed cert has issuer == subject; any
# CA-signed leaf has a distinct issuer DN. `openssl x509` reads only the FIRST
# PEM block in the file, so this correctly inspects just the leaf even when
# cert_file is a fullchain (leaf + intermediate concatenated). NOTE: we do NOT
# use `openssl verify -CAfile <cert> <cert>` — on a fullchain PEM, OpenSSL
# loads all PEM blocks as trusted anchors, the intermediate verifies the leaf,
# and the command exits 0, indistinguishable from self-signed.
#
# Deliberately NOT keyed on the literal string "Let's Encrypt": the HQ Worker
# has CA failover (ZeroSSL primary, Google Trust Services fallback), all
# non-self-signed — matching on a CA name would miss the fallback issuers.
#
# Parse gate: if either DN is unreadable (corrupt/truncated/garbage cert), we
# require both to be non-empty before trusting the issuer!=subject result. An
# unparseable droplet.crt is NOT a preservable public-CA leaf — fall through
# so the normal path regenerates a fresh self-signed cert.
#
# Returns 0 (true) when the cert is a public-CA leaf we must preserve.
_cert_is_public_ca_leaf() {
  local cert_file="$1"
  [ -f "$cert_file" ] || return 1

  # Read only the FIRST PEM block (openssl x509 stops at the first cert in the
  # file), so this correctly reads the leaf even when cert_file is a fullchain
  # (leaf + intermediate). Using openssl verify -CAfile with a fullchain would
  # load ALL PEM blocks as trusted anchors, causing the intermediate to verify
  # the leaf and exit 0 — indistinguishable from a self-signed cert.
  local issuer subject
  issuer="$(openssl x509 -in "$cert_file" -noout -issuer 2>/dev/null)"
  subject="$(openssl x509 -in "$cert_file" -noout -subject 2>/dev/null)"

  # Parse gate: if either DN is unreadable, not a valid public-CA leaf —
  # corrupt/truncated/garbage cert. Fall through to regeneration.
  if [ -z "$issuer" ] || [ -z "$subject" ]; then
    return 1
  fi

  # Issuer != subject → signed by a different CA → preserve as a public-CA leaf.
  # Strip the leading `issuer=` / `subject=` label before comparing.
  if [ "${issuer#issuer=}" = "${subject#subject=}" ]; then
    return 1
  fi
  return 0
}

# ADR-023 PR-2: write the self-signed bootstrap pair to droplet.{crt,key}.bootstrap
# — the exact bytes clients import via trust-droplet-cert. Idempotent: never
# overwrite an existing .bootstrap (the first self-signed cert ever generated is
# the one clients trust; a later regeneration must not move the trust anchor).
_write_tls_bootstrap_copy() {
  local cert_file="$1" key_file="$2"
  local boot_cert="$cert_file.bootstrap" boot_key="$key_file.bootstrap"

  if [ ! -f "$cert_file" ] || [ ! -f "$key_file" ]; then
    return 0
  fi
  # Write each bootstrap file independently — never overwrite an existing one.
  # Writing them separately means a crash between the two copies leaves exactly
  # one file present; the next run writes the missing half without touching the
  # already-written one, rather than skipping both (OR guard) or overwriting the
  # existing one (AND guard with fallthrough).
  if [ ! -f "$boot_cert" ]; then
    cp "$cert_file" "$boot_cert"
    chmod 644 "$boot_cert"
    log_info "  Saved trust-anchor bootstrap cert: $boot_cert"
  fi
  if [ ! -f "$boot_key" ]; then
    cp "$key_file" "$boot_key"
    chmod 600 "$boot_key"
    log_info "  Saved trust-anchor bootstrap key: $boot_key"
  fi
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

    # ADR-023 PR-2 — NEVER CLOBBER A PUBLIC-CA LEAF.
    # The box-side tls-issuance cron installs the HQ-issued publicly-trusted
    # fullchain into these SAME files. A re-run that reaches here (SAN-incomplete
    # OR expired trigger) must NOT regenerate a self-signed cert over a live
    # public-CA leaf — that silently reverts the box to self-signed until the
    # next 04:00 issuance, and a fresh -newkey also breaks every client that
    # imported the original cert. If the installed cert is a public-CA leaf,
    # leave the fullchain in place and return success.
    if _cert_is_public_ca_leaf "$cert_file"; then
      log_success "TLS certificate is a publicly-trusted (public-CA) leaf — preserving it (ADR-023)"
      return 0
    fi

    # ADR-023 PR-2 — EXPIRED + BOOTSTRAP RESTORE.
    # If the installed (self-signed) cert is EXPIRED and a valid bootstrap pair
    # exists, RESTORE the bootstrap pair instead of -newkey'ing a fresh keypair,
    # so trust-store clients that imported the bootstrap cert still connect.
    # Only -newkey below when there is no usable bootstrap.
    local boot_cert="$cert_file.bootstrap" boot_key="$key_file.bootstrap"
    if ! openssl x509 -checkend 86400 -noout -in "$cert_file" >/dev/null 2>&1 \
       && [ -f "$boot_cert" ] && [ -f "$boot_key" ] \
       && openssl x509 -checkend 86400 -noout -in "$boot_cert" >/dev/null 2>&1 \
       && _cert_has_all_required_sans "$boot_cert"; then
      log_warn "TLS certificate expired — restoring the trust-anchor bootstrap pair (ADR-023)"
      cp "$boot_cert" "${cert_file}.new"
      cp "$boot_key"  "${key_file}.new"
      chmod 600 "${key_file}.new"
      chmod 644 "${cert_file}.new"
      mv "${cert_file}.new" "$cert_file"
      mv "${key_file}.new"  "$key_file"
      log_success "Restored TLS certificate from bootstrap copy:"
      log_info "  Cert: $cert_file"
      log_info "  Key:  $key_file"
      if ! declare -F reload_gateway_nginx >/dev/null 2>&1; then
        # shellcheck source=tls-reload.sh
        source "$(dirname "${BASH_SOURCE[0]}")/tls-reload.sh"
      fi
      reload_gateway_nginx || true
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

  # ADR-023 (C2): the opaque per-device FQDN (`d-<hmac>.devices.warp-lab.ai`).
  # The box can't compute the HQ-keyed HMAC, so it learns its FQDN from the HQ
  # challenge response and persists it to .env (DROPLET_PUBLIC_FQDN). When it is
  # known, add it to the bootstrap self-signed SAN so the box serves a
  # name-matching cert for the FQDN even BEFORE the first LE cert is issued
  # (works offline / pre-issuance). The LE cert later overwrites these same
  # files with a publicly-trusted fullchain. Empty on first ever boot — harmless.
  local public_fqdn="${DROPLET_PUBLIC_FQDN:-}"
  if [ -n "$public_fqdn" ]; then
    san="$san,DNS:$public_fqdn"
    log_info "  Including per-device FQDN in SAN: $public_fqdn"
  fi

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

  # ADR-023 PR-2 — BOOTSTRAP SIDE-COPY.
  # Persist this self-signed pair as droplet.{crt,key}.bootstrap — the exact
  # bytes clients import via trust-droplet-cert. Idempotent (never overwrites an
  # existing .bootstrap), so the trust anchor stays pinned to the FIRST
  # self-signed cert across re-runs. The expired-restore path above replays this
  # pair instead of -newkey'ing a keypair the trust store has never seen.
  _write_tls_bootstrap_copy "$cert_file" "$key_file"

  # If the gateway container is already running (setup.sh re-run or
  # --sync-secrets flow), ask nginx to reload so the new cert is served
  # immediately. On a fresh install this is a no-op because gateway isn't
  # up yet — nginx will just pick up the cert on first start.
  #
  # ADR-023 (C2): the reload is now the shared scripts/lib/tls-reload.sh helper,
  # so the SELF-SIGNED bootstrap path here and the LE-RENEW path (orchestrator →
  # device-bridge) use exactly one reload implementation.
  if ! declare -F reload_gateway_nginx >/dev/null 2>&1; then
    # Defensive: secrets.sh is normally sourced after tls-reload.sh by setup.sh,
    # but source it directly if a caller sourced secrets.sh standalone.
    # shellcheck source=tls-reload.sh
    source "$(dirname "${BASH_SOURCE[0]}")/tls-reload.sh"
  fi
  reload_gateway_nginx || true
}
