#!/usr/bin/env bash
# secrets.sh — Generate device-unique secrets and write .env file.
# Source this file; do not execute directly.

# WARP-236 — internal CA + per-service TLS bundle issuance. Sourced here (not
# only from setup.sh) so materialize_artifacts() can call internal_ca_* even
# when a caller sources secrets.sh standalone (tests, --sync-secrets).
# shellcheck source=internal-ca.sh
. "$(dirname "${BASH_SOURCE[0]}")/internal-ca.sh"

# Generate a random alphanumeric password of given length.
_gen_password() {
  local length="${1:-24}"
  openssl rand -base64 48 | tr -d '=/+\n' | head -c "$length"
}

# Generate a Fernet-compatible base64 key.
_gen_fernet_key() {
  openssl rand -base64 32
}

# WARP-318 / WARP-595: idempotent atomic upsert of a single KEY=VALUE into .env.
# Shared primitive (the single-box.sh `upsert_env` body promoted here so both
# callers share one implementation): strip any existing copy of the key, append
# the new value, stage under umask 077, chmod 600, and rename(2) into place.
# rename is atomic on the same filesystem, so an interruption leaves either the
# previous .env or the fully-updated one — never a torn file. A previous
# interrupted run's stage sibling is swept before writing.
#
# Targets $ENV_FILE if set (tests point this at a sandbox), else $REPO_ROOT/.env.
_upsert_env_kv() {
  local key="$1" val="$2"
  local env_file="${ENV_FILE:-$REPO_ROOT/.env}"
  # WARP-232 (finding 2): once relocate_secrets_to_data has run, $env_file is a
  # SYMLINK onto the encrypted /data. Staging beside the symlink and `mv`-ing
  # over it would REPLACE the link with a plain file on the unencrypted root —
  # moving DEVICE_SECRET_KEY back outside the LUKS boundary AND breaking the
  # compose `../.env` env_file for the docker-group user. Resolve the link and
  # write THROUGH it (stage next to the real target, rename onto the target),
  # so the symlink and the encrypted destination both survive.
  local target="$env_file"
  if [ -L "$env_file" ]; then
    target="$(readlink -f "$env_file" 2>/dev/null || readlink "$env_file")"
    [ -n "$target" ] || target="$env_file"
  fi
  local stage="${target}.upsert.$$"
  rm -f "${target}".upsert.* 2>/dev/null || true
  # Normalize a missing trailing newline first — appending to a file whose last
  # line was cut mid-write would glue the new key onto it (mirrors the guards in
  # generate_env / migrate_env / configure_single_box_env). Read/write the
  # target (via the symlink) so this works whether or not $env_file is a link.
  if [ -s "$target" ] && [ -n "$(tail -c 1 "$target")" ]; then
    printf '\n' >> "$target"
  fi
  ( umask 077; { grep -vE "^${key}=" "$target" 2>/dev/null || true; \
                 printf '%s=%s\n' "$key" "$val"; } > "$stage" )
  chmod 600 "$stage"
  mv "$stage" "$target"
}

# Remove a key from .env entirely (same atomicity/symlink discipline as
# _upsert_env_kv). WARP-1063 needs this for OPENSSL_MODULES: an env var that
# is PRESENT BUT EMPTY is not harmless there — OpenSSL treats an empty
# OPENSSL_MODULES as a real (empty) search path, so provider resolution
# becomes "/fips.so" and activation fails. Absent is the only safe "off".
_remove_env_kv() {
  local key="$1"
  local env_file="${ENV_FILE:-$REPO_ROOT/.env}"
  local target="$env_file"
  if [ -L "$env_file" ]; then
    target="$(readlink -f "$env_file" 2>/dev/null || readlink "$env_file")"
    [ -n "$target" ] || target="$env_file"
  fi
  [ -f "$target" ] || return 0
  local stage="${target}.upsert.$$"
  rm -f "${target}".upsert.* 2>/dev/null || true
  ( umask 077; { grep -vE "^${key}=" "$target" 2>/dev/null || true; } > "$stage" )
  chmod 600 "$stage"
  mv "$stage" "$target"
}

# WARP-318: translate the single DROPLET_FIPS_MODE customer knob into the
# per-service FIPS activation env vars. Explicit boolean arg — never derived
# from ambient state (mirrors the DOCS_ENABLED / SINGLE_BOX_MODE convention).
# Every image already ships the NIST-validated OpenSSL FIPS provider (CMVP
# #4282, WARP-967) dormant; this only changes which env compose passes in, so
# flipping needs NO rebuild. FIPS RESTRICTS algorithms for certification; it
# does not add strength. `off` restores byte-identical-to-default runtime
# posture (empty OPENSSL_CONF → compose per-service `:-/etc/ssl/openssl.cnf`).
#
# Node vs Python activation asymmetry (see the Dockerfiles): Python uses the
# system libcrypto, so OPENSSL_CONF alone activates FIPS; Node's bundled
# OpenSSL additionally needs NODE_OPTIONS=--openssl-shared-config (to honor
# the shared `openssl_conf` key). Both are written here; the OFF path clears
# them.
#
# OPENSSL_MODULES is deliberately NOT set — and is actively REMOVED from any
# older .env (WARP-1063). The validated fips.so cannot be initialized by two
# libcrypto instances in one process (upstream limitation, openssl#25553:
# second activation fails with `common libcrypto routines::init fail`), and
# several of our processes carry two: Node's bundled OpenSSL + Prisma's
# system libssl (orchestrator/mcp-server), pyca cryptography's static
# OpenSSL + the system libssl (ai-gateway/file-indexer). A process-wide
# OPENSSL_MODULES forces every instance onto the SAME fips.so file — the
# second loser then boots with zero usable algorithms and TLS dies with
# LIBRARY_HAS_NO_CIPHERS (Prisma P1011). Instead each image installs a
# dedicated COPY of fips.so into every bundled runtime's own baked
# MODULESDIR (docker/fips/install-fips-provider.sh), so each libcrypto
# resolves its own module and all of them activate.
#
# WARP-233 ⇄ WARP-318 reconciliation (P1011, decision A — pending Romain's
# ratification): under the FIPS openssl config Prisma/libpq cannot open ANY
# TLS connection to `db` ("library has no ciphers"), so FIPS-on scopes the
# intra-compose DB hop to plaintext+SCRAM on the private container bridge:
#   PG_SSLMODE=disable          → file-indexer's inline DATABASE_URL param
#   PG_HBA=pg_hba.fips.conf     → db serves docker/postgres/pg_hba.fips.conf
#                                 (hostssl first; RFC1918+loopback host lines
#                                 still SCRAM-authed; terminal reject intact)
#   DATABASE_URL sslmode        → rewritten in-place (orchestrator/mcp-server/
#                                 email-indexer consume .env's DATABASE_URL)
# FIPS-off restores the WARP-233 default posture (TLS 1.3-only, sslmode=
# require). Both directions are idempotent and driven by this ONE knob.
apply_fips_mode() {
  local mode="${1:-}"
  case "$mode" in
    on)
      _upsert_env_kv DROPLET_FIPS_MODE      1
      _upsert_env_kv OPENSSL_CONF           /etc/ssl/openssl-fips.cnf
      _upsert_env_kv DROPLET_FIPS_REQUIRED  true
      _remove_env_kv OPENSSL_MODULES
      _upsert_env_kv NODE_OPTIONS           --openssl-shared-config
      _upsert_env_kv PG_SSLMODE             disable
      _upsert_env_kv PG_HBA                 pg_hba.fips.conf
      _rewrite_database_url_sslmode         disable
      ;;
    off)
      _upsert_env_kv DROPLET_FIPS_MODE      0
      _upsert_env_kv OPENSSL_CONF           ""
      _upsert_env_kv DROPLET_FIPS_REQUIRED  false
      _remove_env_kv OPENSSL_MODULES
      _upsert_env_kv NODE_OPTIONS           ""
      _upsert_env_kv PG_SSLMODE             require
      _upsert_env_kv PG_HBA                 pg_hba.conf
      _rewrite_database_url_sslmode         require
      ;;
    *)
      log_error "apply_fips_mode: expected 'on' or 'off', got '${mode:-<none>}'"
      return 1
      ;;
  esac
}

# WARP-233/318: flip the sslmode param of the .env DATABASE_URL in place.
# Only rewrites an EXISTING sslmode=<value> param — a param-less URL is
# migrate_env's job (it backfills ?sslmode=require), and custom operator
# params are never restructured. Same staged-rename atomicity as
# _upsert_env_kv.
_rewrite_database_url_sslmode() {
  local target="$1"
  local env_file="${ENV_FILE:-$REPO_ROOT/.env}"
  local stage="${env_file}.upsert.$$"
  [ -f "$env_file" ] || return 0
  grep -qE '^DATABASE_URL=.*sslmode=' "$env_file" || return 0
  rm -f "${env_file}".upsert.* 2>/dev/null || true
  ( umask 077; sed -E "s|^(DATABASE_URL=.*[?\&]sslmode=)[A-Za-z-]+|\1${target}|" \
      "$env_file" > "$stage" )
  chmod 600 "$stage"
  mv "$stage" "$env_file"
}

# WARP-595: core keys that EVERY .env our heredoc has ever written contains
# with a non-empty value (verified across the full git history of this file —
# all six landed together with the heredoc in the first "generated by setup.sh"
# version and were never removed). A generated .env missing any of them is a
# TORN file from an interrupted write, not an old-version file. Deliberately
# excludes later additions (JWT_SECRET, OPENWRT_PASSWORD, SERVICE_TOKEN_*…):
# a healthy pre-WARP-834 install legitimately lacks those until migrate_env
# backfills them, and flagging it torn would rotate a live box's secrets.
#
# WARP-235 removed MQTT_PASSWORD from the heredoc (MQTT identity is the client
# cert CN now), so it can no longer serve as a torn-file marker — a fresh .env
# legitimately lacks it. Truncation detection is unaffected: the heredoc is
# prefix-preserving, so any cut that would have lost MQTT_PASSWORD also loses
# NEXTCLOUD_ADMIN_PASSWORD and the DEVICE_SECRET* keys below it.
_ENV_CORE_KEYS=(
  POSTGRES_PASSWORD
  REDIS_PASSWORD
  NEXTCLOUD_ADMIN_PASSWORD
  DEVICE_SECRET
  DEVICE_SECRET_KEY
)

# WARP-595: is this .env a torn (half-written) file from an interrupted run?
# Only files our own heredoc wrote are ever flagged — an operator-authored
# .env has no "generated by setup.sh" header and is never touched. Torn means:
#   * the last line was cut mid-write (no trailing newline), or
#   * any always-generated core key is missing (truncation is prefix-
#     preserving, so a cut heredoc loses the tail keys).
#
# Known residual window (legacy writers only): a .env cut INSIDE the first
# header line — i.e. the write died within the first ~100 bytes — fails the
# header gate above and goes undetected (it just looks operator-authored, so
# generation is skipped). Only the pre-atomic-write setup versions could
# produce such a file; the staged+renamed write below can't. Accepted: closing
# it would require loosening the header match, which risks false positives on
# genuinely operator-authored files — a worse trade than a sub-100-byte legacy
# window whose stack was never functional anyway (_validate_env catches it and
# points at --regenerate-env).
_env_file_is_torn() {
  local f="$1"
  [ -f "$f" ] || return 1
  head -n 1 "$f" | grep -q 'generated by setup.sh' || return 1
  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then
    return 0
  fi
  local key
  for key in "${_ENV_CORE_KEYS[@]}"; do
    grep -qE "^${key}=." "$f" || return 0
  done
  return 1
}

# ─── Default serving model, per runtime (WARP-1870) ─────────────────────────
#
# File scope, not function scope, so scripts/lib/single-box.sh can read the
# same constant instead of carrying a second copy that silently drifts.
#
# The DMR value MUST be the EXACT registry-qualified id the store reports —
# verified live against `GET /api/tags`, which returns
# "docker.io/ai/gpt-oss:20B-F16" byte-for-byte. This is not cosmetic: the
# orchestrator's first-boot readiness compares raw strings, so any other
# spelling of the same model reads as "absent" and kicks a background pull of
# a 13.79 GB artifact on EVERY orchestrator boot, forever. That is the single
# most expensive way to get this wrong.
#
# The Ollama value is the historic short tag, unchanged.
: "${DROPLET_DEFAULT_DMR_MODEL:=docker.io/ai/gpt-oss:20B-F16}"
: "${DROPLET_DEFAULT_OLLAMA_MODEL:=gpt-oss:20b}"

generate_env() {
  local env_file="$REPO_ROOT/.env"
  local force_regen=false

  # --- WARP-595: recover a torn .env from an interrupted previous run ---
  # Interruption scenario closed: a power cut / SSH drop mid-heredoc left a
  # truncated .env; the old behaviour saw ".env already exists", skipped
  # generation, and started the stack with missing core secrets (compose
  # interpolates them as empty strings). Convergence rule:
  #   * a complete .env.bak.* exists (the --regenerate-env path backs up
  #     before writing) → RESTORE it, so a live stack keeps the passwords its
  #     data volumes were initialized with;
  #   * no usable backup (first-install interruption — the stack never ran
  #     with these secrets) → regenerate fresh.
  if [ -f "$env_file" ] && [ "${REGENERATE_ENV:-false}" != "true" ] && _env_file_is_torn "$env_file"; then
    log_warn ".env is incomplete — torn write from an interrupted setup run detected"
    local newest_backup
    newest_backup="$(ls -1t "$env_file".bak.* 2>/dev/null | head -n 1 || true)"
    if [ -n "$newest_backup" ] && ! _env_file_is_torn "$newest_backup"; then
      local torn_copy
      torn_copy="$env_file.torn.$(date +%s)"
      cp "$env_file" "$torn_copy"
      # A legacy torn file sits at umask-default 644 (the pre-atomic writer
      # died BEFORE its chmod) and `cp` preserves that mode — force 600 so the
      # kept copy's leading secrets block is never world-readable.
      chmod 600 "$torn_copy"
      local restore_tmp="$env_file.tmp.$$"
      rm -f "$restore_tmp"
      cp "$newest_backup" "$restore_tmp"
      chmod 600 "$restore_tmp"
      mv "$restore_tmp" "$env_file"
      log_success "Restored .env from $newest_backup (torn copy quarantined at $torn_copy until this run completes)"
      log_info "  migrate_env will backfill any keys added since that backup"
      log_divider
      return 0
    fi
    log_warn "No complete .env backup found — regenerating fresh secrets"
    log_warn "  (the torn file is backed up next to .env; if this box had a running"
    log_warn "   stack, data-store passwords rotate — see scripts/README.md)"
    force_regen=true
  fi

  # --- Check for existing .env ---
  if [ -f "$env_file" ] && [ "${REGENERATE_ENV:-false}" != "true" ] && [ "$force_regen" != "true" ]; then
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
    # On the torn-no-backup regen path the source is a legacy 644 torn file
    # (see the torn_copy chmod above) — force the backup to 600 regardless.
    chmod 600 "$backup"
    log_info "Backed up existing .env to $backup"
  fi

  log_info "Generating device-unique secrets..."

  # --- Generate all secrets ---
  local pg_password redis_password nc_password device_secret device_secret_key jwt_secret routing_service_token service_token_voice service_token_display service_token_switch service_token_ai_gateway ops_token service_token_mcp service_token_email service_token_rag_eval orchestrator_sampler_token ai_gateway_sampler_token service_token_egress_audit ollama_url openwrt_password
  # WARP-850: orchestrator -> matter-controller sidecar bearer (X-Droplet-Auth).
  local droplet_matter_service_token
  # WARP-882 / WS-4: shared HS256 secret the OnlyOffice Document Server, the
  # Nextcloud `onlyoffice` connector, AND the orchestrator all verify.
  local onlyoffice_jwt_secret
  pg_password=$(_gen_password 24)
  redis_password=$(_gen_password 24)
  # WARP-234: per-service Redis ACL identities (least privilege; the shared
  # REDIS_PASSWORD becomes the ping-only `default` user for health probes).
  local redis_orchestrator_password redis_ai_gateway_password redis_mcp_password
  redis_orchestrator_password=$(_gen_password 24)
  redis_ai_gateway_password=$(_gen_password 24)
  redis_mcp_password=$(_gen_password 24)
  nc_password=$(_gen_password 24)
  # WARP-834: per-device OpenWrt rpcd/root password. _gen_password keeps it
  # alphanumeric ([A-Za-z0-9]) so it's safe for `passwd`, the docker secret
  # file, and the ubus `… login` JSON string (no shell/JSON-hostile chars).
  openwrt_password=$(_gen_password 24)
  # SMB network-drive credential (compose `samba` service, account `droplet`).
  # Alphanumeric via _gen_password: the value rides through compose env
  # interpolation, smbpasswd, AND gets typed by hand into Windows/macOS
  # connect dialogs — 20 chars is the typing-friendly compromise.
  local smb_password
  smb_password=$(_gen_password 20)
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
  # Bearer ragas_runner.py presents on the orchestrator's
  # /api/admin/retrieval-eval/search calls (WARP-449 role gate). Same
  # SERVICE_TOKEN_EMAIL shape: the orchestrator's SERVICE_PRINCIPALS
  # (middleware/auth.ts) matches it; compose wires the rag-eval
  # container's ORCHESTRATOR_SERVICE_TOKEN to ${SERVICE_TOKEN_RAG_EVAL}.
  # Without it every scheduled + ad-hoc RAGAS run 401s at the first query.
  service_token_rag_eval=$(openssl rand -hex 32)
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
  # WARP-268: host-side egress-audit collector → orchestrator anomaly POST.
  # The collector reads this from .env via /etc/default/droplet-egress-audit.
  service_token_egress_audit=$(openssl rand -hex 32)
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
  # `INFERENCE_RUNTIME=ollama OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh`
  # (the runtime is REQUIRED alongside an OLLAMA_URL override — setup refuses
  # to guess which engine a remote host runs; see the guard in generate_env).
  # NEVER set this to `inference-engine.local:11434` — mDNS does not
  # resolve from inside Docker containers and you'll get
  # "Temporary failure in name resolution" on every chat.
  # INFERENCE_RUNTIME — which engine a FRESH box provisions to (WARP-1870).
  #
  # This key used to be absent from generate_env entirely, and that absence was
  # the whole reason a new appliance came up on Ollama no matter what: both
  # runtime guards in single-box.sh read the key, found an empty string, and
  # took their ollama branches. WARP-1865's guard could only PRESERVE a flip
  # someone had already performed by hand — its own comment says "Never ADDS
  # dmr on a box that isn't flipped" — so nothing on the provision path could
  # ever select DMR.
  #
  # Writing it explicitly also removes a silent-degradation class: ai-gateway
  # reads INFERENCE_RUNTIME at module import and defaults to "ollama", so an
  # absent key on a DMR box means every model reports tools=false with no
  # error anywhere (WARP-1839's shape). An explicit value cannot be lost by
  # an interpolation that resolves against the wrong env file.
  #
  # Overridable for an Ollama box: `INFERENCE_RUNTIME=ollama ./scripts/setup.sh`.
  # Refuse to GUESS when the operator points us at a remote inference host but
  # says nothing about which engine runs there.
  #
  # The remote host decides the model-id vocabulary, and nothing downstream can
  # repair a wrong guess on this path: `configure_single_box_env` — the only
  # code that would clobber OLLAMA_URL back to a coherent value — is skipped
  # entirely, because detect_single_box_mode() probes that very host, finds it
  # reachable, and classifies the box as multi-box. So the (dmr runtime,
  # remote-Ollama URL, docker.io/... model id) triple lands in .env unmodified
  # and the orchestrator re-pulls ~13.79 GB on every boot forever.
  #
  # Refusing beats sniffing the port: a `*:12434 -> dmr` heuristic is still a
  # guess, and an operator proxying DMR on 11434 gets the same silent mismatch.
  if [ -n "${OLLAMA_URL:-}" ] && [ -z "${INFERENCE_RUNTIME:-}" ]; then
    log_error "OLLAMA_URL is overridden (${OLLAMA_URL}) but INFERENCE_RUNTIME is unset."
    log_error "The remote inference host decides the model-id vocabulary; guessing wrong re-pulls ~13.79 GB on every orchestrator boot."
    log_error "Re-run with the runtime stated explicitly, e.g.:"
    log_error "  INFERENCE_RUNTIME=ollama OLLAMA_URL=${OLLAMA_URL} ./scripts/setup.sh"
    exit 1
  fi

  inference_runtime="${INFERENCE_RUNTIME:-dmr}"

  # OLLAMA_URL — the CHAT endpoint, whichever engine serves it. The name is
  # historical and deliberately kept: it is how DMR is consumed too (compose
  # wires it, ai-gateway reads it), so renaming it would be a breaking change
  # for zero benefit. Default tracks the runtime above.
  #
  # Override before running setup.sh for a multi-box deployment with a separate
  # inference host on the LAN, e.g.
  # `INFERENCE_RUNTIME=ollama OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh`
  # (the runtime is REQUIRED alongside an OLLAMA_URL override — setup refuses
  # to guess which engine a remote host runs; see the guard in generate_env).
  # NEVER set this to `inference-engine.local:11434` — mDNS does not
  # resolve from inside Docker containers and you'll get
  # "Temporary failure in name resolution" on every chat.
  if [ "$inference_runtime" = "dmr" ]; then
    ollama_url="${OLLAMA_URL:-http://dmr:12434}"
    llm_model="${LLM_MODEL:-$DROPLET_DEFAULT_DMR_MODEL}"
  else
    ollama_url="${OLLAMA_URL:-http://droplet-ollama:11434}"
    llm_model="${LLM_MODEL:-$DROPLET_DEFAULT_OLLAMA_MODEL}"
  fi

  # --- Write .env directly (single source of truth — no template, no sed) ---
  # WARP-595: stage to a temp file and rename into place. rename(2) is atomic
  # on the same filesystem, so an interruption (power cut, SSH drop, ctrl-C)
  # can never leave a half-written .env that the next run's exists-check would
  # mistake for a complete one — .env is either the previous complete file or
  # the new complete file, never a prefix. The temp file is created empty and
  # chmod'd 600 BEFORE any secret is written into it.
  #
  # WARP-232 (finding 2): on a --regenerate-env re-run AFTER secrets have been
  # relocated onto the encrypted /data, $env_file is a SYMLINK. Stage beside and
  # rename onto the link's REAL target so the regenerated secrets stay inside the
  # LUKS boundary and the symlink survives — never replace the link with a plain
  # file on the unencrypted root.
  local env_write_target="$env_file"
  if [ -L "$env_file" ]; then
    env_write_target="$(readlink -f "$env_file" 2>/dev/null || readlink "$env_file")"
    [ -n "$env_write_target" ] || env_write_target="$env_file"
  fi
  local env_tmp="$env_write_target.tmp.$$"
  rm -f "$env_write_target".tmp.* 2>/dev/null || true
  : > "$env_tmp"
  chmod 600 "$env_tmp"
  cat >> "$env_tmp" << EOF
# Droplet Edge Platform — generated by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# WARNING: Contains device-unique secrets. Do NOT commit this file.

# --- PostgreSQL ---
POSTGRES_USER=droplet
POSTGRES_PASSWORD=$pg_password
POSTGRES_DB=droplet
DATABASE_URL=postgresql://droplet:${pg_password}@db:5432/droplet?sslmode=require

# --- Redis ---
# WARP-234: REDIS_PASSWORD is the ping-only `default` ACL user (health
# probes / the WARP-966 harness). Real clients authenticate as their own
# ACL user via the per-service rediss:// URLs in docker-compose.yml.
REDIS_PASSWORD=$redis_password
REDIS_URL=rediss://:${redis_password}@cache:6380
REDIS_PASSWORD_ORCHESTRATOR=$redis_orchestrator_password
REDIS_PASSWORD_AI_GATEWAY=$redis_ai_gateway_password
REDIS_PASSWORD_MCP=$redis_mcp_password
# Nextcloud expects this name for the Redis password (ACL user `nextcloud`)
REDIS_HOST_PASSWORD=$redis_password

# --- MQTT (WARP-235: mTLS, no shared password — identity = client cert CN) ---
MQTT_BROKER=mqtts://broker:8883
# Host-network services (camera-discovery) connect via the loopback publish
MQTT_BROKER_LOCAL=mqtts://localhost:8883

# --- Nextcloud ---
NEXTCLOUD_ADMIN_USER=admin
NEXTCLOUD_ADMIN_PASSWORD=$nc_password
NEXTCLOUD_URL=http://nextcloud:80

# --- Network drive (SMB — the "Droplet" folder in Explorer/Finder) ---
# Device-wide credential for the \`samba\` compose service's "Droplet" share
# (username is fixed to \`droplet\`). Surfaced to owner/admin accounts by the
# dashboard's "Connect network drive" dialog via GET /api/storage/network-drive.
SMB_PASSWORD=$smb_password
# EXPLICIT master switch for the network-drive surface (never derived from
# SMB_PASSWORD emptiness). Mirrors the \`linux\` compose profile that actually
# starts smbd: 1 on Linux, 0 on macOS dev hosts (host networking + :445).
SMB_ENABLED=$([ "$(uname)" = "Linux" ] && printf 1 || printf 0)

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
# LAN (\`INFERENCE_RUNTIME=ollama OLLAMA_URL=http://192.168.50.197:11434 ./scripts/setup.sh\`).
# The old \`inference-engine.local\` mDNS name does NOT resolve from
# inside Docker containers on Linux/macOS, which is why every fresh
# single-box install used to come up with a broken model list and ai-gateway logs
# full of "Temporary failure in name resolution". See CLAUDE.md
# "Ollama call path" for the full rationale.
OLLAMA_URL=${ollama_url}

# --- Inference runtime (WARP-1870) ---
# Which engine serves chat: \`dmr\` (Docker Model Runner, the default) or
# \`ollama\`. Read by ai-gateway at module IMPORT — a \`docker restart\` does
# not re-read it, only \`--force-recreate\` does — and by single-box.sh, which
# derives the compose profile and the chat/judge URLs from it. Written
# explicitly rather than left to a default so it can never be lost by an
# interpolation resolving against the wrong env file.
INFERENCE_RUNTIME=${inference_runtime}

# LLM_MODEL — the one serving model (One-Model Rule). Under DMR this MUST be
# the exact registry-qualified id \`GET /api/tags\` reports; the readiness
# check compares raw strings, so any other spelling of the same model reads as
# absent and re-pulls ~13.79 GB on every orchestrator boot. Written here so a
# fresh box is never provisioned without a model to acquire.
LLM_MODEL=${llm_model}

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

# --- RAG eval service bearer (rag-eval → orchestrator REST) ---
# Bearer ragas_runner.py presents on /api/admin/retrieval-eval/search
# (WARP-449 role gate). The orchestrator's SERVICE_PRINCIPALS matches it;
# compose wires the rag-eval container's ORCHESTRATOR_SERVICE_TOKEN to
# this value. Rotate both sides in lockstep — change here, recreate
# orchestrator + rag-eval together.
SERVICE_TOKEN_RAG_EVAL=$service_token_rag_eval

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

# WARP-268: the host-side egress-audit collector
# (droplet-egress-audit.service — a systemd unit, NOT a compose service)
# presents this token on POST /api/security/egress-anomaly. The launcher
# /usr/local/sbin/droplet-egress-audit greps it out of this .env;
# authMiddleware sets req.user = _service:egress-audit.
SERVICE_TOKEN_EGRESS_AUDIT=$service_token_egress_audit

# --- Internal service-to-service mTLS (WARP-236 plumbing, WARP-1061 wiring) ---
# 0 (default) = every internal HTTP/gRPC hop speaks plaintext exactly as
# before; 1 = first-party listeners (orchestrator :3000, the FastAPI/uvicorn
# services, ai-gateway gRPC :50051, matter-controller :8083, nginx→upstream
# legs) serve TLS and REQUIRE a CA-signed client cert, and every first-party
# client presents its /data/service-tls bundle. Flip with care and only after
# this setup run has issued the bundles (materialize_artifacts does), then
# recreate the stack: docker compose up -d --force-recreate.
# MQTT stays scheme-gated (mqtts://) independent of this knob (WARP-235).
DROPLET_INTERNAL_TLS=0

# --- Application ---
STORAGE_BACKEND=nextcloud
AUTH_ENABLED=true
FILES_ROOT=/data/files
MAX_UPLOAD_SIZE_MB=100

# --- WARP-230 device identity ---
# Selects the device-identity-svc backend.
#   mock = pure-Python in-memory mock (dev / CI / hosts without a TPM).
#   real = /dev/tpm0 via tpm2-pytss — currently an UNFINISHED scaffold
#          (IDX-002): its crypto returns placeholder bytes, so the sidecar
#          FAILS CLOSED on it unless DROPLET_TPM_ALLOW_SCAFFOLD is also set.
# Default to 'mock' even on TPM-equipped hosts until the tss2 path lands —
# auto-selecting 'real' would crash-loop device-identity-svc. An operator
# knowingly running the scaffold sets DROPLET_TPM_BACKEND=real +
# DROPLET_TPM_ALLOW_SCAFFOLD=1 by hand.
DROPLET_TPM_BACKEND=mock
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
# HQ_ISSUANCE_URL: base URL of the fleet HQ issuance API. Defaults to the PUBLIC
#   (non-secret) fleet-HQ Cloudflare Worker so a plain reflash / --single-box
#   self-provisions its trusted droplet-us.com cert zero-touch — no SSH-in to
#   hand-set this. Still overridable from the provisioning environment / manifest
#   (${HQ_ISSUANCE_URL:-<default>}). Without a value, factory-reset wiped .env and
#   the box permanently lost its droplet-us.com cert + FQDN → remote access
#   dead-ends (WARP-978), which is exactly the reflash-self-signed regression the
#   baked default fixes. Plain outbound HTTPS; no WG tunnel required.
#   The default MUST be a hostname that exists: the intended vanity name
#   fleet-hq.droplet-us.com was never bound in DNS (NXDOMAIN as of 2026-07-16),
#   so every box that inherited it dead-ended issuance at DNS resolution and
#   silently stayed on the self-signed bootstrap cert. Until the HQ production
#   cutover binds the vanity name (droplet-fleet-hq HQ-CUTOVER-RUNBOOK), the
#   default is the live HQ Worker URL; flip it back in the SAME commit that
#   creates the DNS record.
HQ_ISSUANCE_URL=${HQ_ISSUANCE_URL:-https://droplet-fleet-hq.rjouffret.workers.dev}
# OVERLAY_CONNECT_ENABLED: the box half of customer remote access (WARP-1767 /
#   ADR-031) — outbound long-poll to HQ signaling, STUN mapping discovery, and
#   the wg0 peer install that lands a hole-punched session. ON by default: this
#   is the shipped remote-access path, and a box written without it cannot be
#   reached from outside at all. Overridable from the provisioning environment
#   for a box that must ship LAN-only. Requires HQ_ISSUANCE_URL (above) and
#   router supervision; index.ts gates on all three.
OVERLAY_CONNECT_ENABLED=${OVERLAY_CONNECT_ENABLED:-true}
OVERLAY_CONNECT_POLL_SECONDS=${OVERLAY_CONNECT_POLL_SECONDS:-15}
OVERLAY_PEER_IDLE_EXPIRY_HOURS=${OVERLAY_PEER_IDLE_EXPIRY_HOURS:-720}
# TUNNEL_TOKEN: Cloudflare Tunnel connector token for the remote-access relay
#   (WARP-974 / ADR-025). PRESERVED from the provisioning environment. Empty =
#   relay OFF — single-box.sh only activates the `relay` compose profile
#   (cloudflared) when this is set, so an un-provisioned box never brings up a
#   tokenless connector.
TUNNEL_TOKEN=${TUNNEL_TOKEN:-}
# DROPLET_PROVISION_TOKEN: one-time HQ-minted provisioning token (WARP-983).
#   PRESERVED from the provisioning environment / manifest so a fresh or
#   FACTORY-RESET box can re-enroll itself into the HQ registry. Factory-reset
#   sends the ADR-023 signed deregister, which DELETES the device from the HQ
#   registry — on the next boot tls-issuance is then rejected with 404
#   `device_id not in registry` and the box would stay on the self-signed
#   bootstrap cert forever. When this token is set, the orchestrator self-provisions
#   (POST /api/issuance/provision with a TPM proof-of-possession over the token)
#   on that 404, then retries issuance and installs its droplet-us.com cert.
#   Empty disables self-provision (dev / pre-fleet / provisioned by another path).
DROPLET_PROVISION_TOKEN=${DROPLET_PROVISION_TOKEN:-}

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

  mv "$env_tmp" "$env_write_target"
  chmod 600 "$env_file"

  log_success "Generated unique secrets:"
  log_info "  POSTGRES_PASSWORD : ${pg_password:0:4}****"
  log_info "  REDIS_PASSWORD    : ${redis_password:0:4}****"
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

  # WARP-595: stage every append in a private copy and rename into place once
  # at the end. Appending straight to the live .env meant an interruption
  # mid-migration could cut a KEY=value line in half — the truncated line then
  # matched the `^KEY=` existence check on the next run and the mangled value
  # was kept forever. With the stage + rename, the live .env is either the
  # pre-migration file or the fully-migrated file, never something in between.
  local stage="$env_file.migrate.$$"
  rm -f "$env_file".migrate.* 2>/dev/null || true
  cp "$env_file" "$stage"
  chmod 600 "$stage"

  # A previous interrupted writer (or a hand edit) can leave .env without a
  # trailing newline; appending to it would glue the first backfilled key onto
  # the last existing line, corrupting BOTH keys. Normalize before appending.
  local normalized=false
  if [ -s "$stage" ] && [ -n "$(tail -c 1 "$stage")" ]; then
    printf '\n' >> "$stage"
    normalized=true
  fi

  _migrate_ensure_key() {
    local key="$1" value="$2"
    if ! grep -qE "^${key}=" "$stage" 2>/dev/null; then
      if [ "$backed_up" = "false" ]; then
        # shellcheck disable=SC2155  # Same rationale as line 29: `date +%s` cannot meaningfully fail.
        local backup="$env_file.bak.$(date +%s)"
        cp "$env_file" "$backup"
        log_info "Backed up existing .env to $backup before migration"
        backed_up=true
      fi
      printf '%s=%s\n' "$key" "$value" >> "$stage"
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
  # Network-drive backfill: existing installs predate the `samba` compose
  # service. Without SMB_PASSWORD, compose interpolates ACCOUNT_droplet to
  # empty and smbd's `null passwords = no` default refuses every logon —
  # fails closed, but the share is unusable until this backfill runs.
  # SMB_ENABLED mirrors the platform rule generate_env writes (the `linux`
  # profile is what actually starts smbd); only set when missing, so an
  # operator's explicit 0 survives upgrades.
  local smb_enabled_default=0
  [ "$(uname)" = "Linux" ] && smb_enabled_default=1
  _migrate_ensure_key SMB_PASSWORD "$(_gen_password 20)"
  _migrate_ensure_key SMB_ENABLED "$smb_enabled_default"
  # INFERENCE_RUNTIME on an EXISTING box backfills to `ollama`, NOT to the
  # fresh-install default of `dmr` (WARP-1870).
  #
  # This asymmetry is the point. `_migrate_ensure_key` only writes when the key
  # is absent, which partitions every box into exactly three cases:
  #   - already flipped  → the key exists (dmr), untouched. No un-flip.
  #   - legacy, un-flipped → key absent; it has been serving Ollama all along,
  #     so `ollama` is the TRUTHFUL value. Backfilling `dmr` here would flip a
  #     working box on its next setup run and take inference down — an
  #     accidental flip is as bad as the accidental un-flip WARP-1865 fixed.
  #   - fresh install    → never reaches migrate_env; generate_env writes dmr.
  # Writing it explicitly also immunises legacy boxes against ai-gateway's
  # import-time "ollama" default being mistaken for a deliberate choice.
  _migrate_ensure_key INFERENCE_RUNTIME "ollama"
  # WARP-978: ensure the HQ issuance URL + relay tunnel token exist on re-run.
  # HQ_ISSUANCE_URL is seeded from the provisioning environment or the baked
  # PUBLIC fleet-HQ Worker default (non-secret) so a reflashed box self-provisions
  # its droplet-us.com cert zero-touch; TUNNEL_TOKEN stays a secret (empty = relay
  # off). Pairs with the seed-block defaults above. `_migrate_ensure_key` only
  # appends when the key is ABSENT, so an existing (even intentionally-empty)
  # value is never clobbered on re-run.
  _migrate_ensure_key HQ_ISSUANCE_URL "${HQ_ISSUANCE_URL:-https://droplet-fleet-hq.rjouffret.workers.dev}"
  _migrate_ensure_key TUNNEL_TOKEN "${TUNNEL_TOKEN:-}"
  # WARP-1767: backfill the overlay connect agent onto boxes already in the field.
  # These installs predate the key entirely, so the orchestrator fell back to the
  # zod default (false) and the connect tick + idle-expiry sweep never registered
  # — every one of them is unreachable from outside. `_migrate_ensure_key` only
  # appends when the key is ABSENT, so a box deliberately opted out (explicit
  # `false`) keeps that value across the re-run.
  _migrate_ensure_key OVERLAY_CONNECT_ENABLED "${OVERLAY_CONNECT_ENABLED:-true}"
  _migrate_ensure_key OVERLAY_CONNECT_POLL_SECONDS "${OVERLAY_CONNECT_POLL_SECONDS:-15}"
  _migrate_ensure_key OVERLAY_PEER_IDLE_EXPIRY_HOURS "${OVERLAY_PEER_IDLE_EXPIRY_HOURS:-720}"
  # WARP-983: ensure the one-time HQ provisioning token exists on re-run, seeded
  # from the provisioning environment (empty = self-provision disabled). Pairs
  # with the seed-block `${DROPLET_PROVISION_TOKEN:-}` above so a fresh or
  # factory-reset box that was handed a token can re-enroll into the HQ registry
  # and re-issue its droplet-us.com cert, instead of dead-ending on the 404
  # `device_id not in registry` and staying on the self-signed bootstrap cert.
  _migrate_ensure_key DROPLET_PROVISION_TOKEN "${DROPLET_PROVISION_TOKEN:-}"
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

  # INFRA-003: these four service tokens + JWT_SECRET are ALWAYS written by
  # generate_env's heredoc but were missing from migrate_env — so a pre-existing
  # .env (predating WARP-465/468/268) interpolated them to empty. Consequences on
  # an upgraded box: email-indexer ingest 401s and every delivered email is
  # PERMANENTLY lost (no retry queue), ai-gateway 451s every cloud-LLM call, the
  # routing egress/throughput samplers 401 (WARP-268 egress-anomaly feed dies),
  # and an empty JWT_SECRET bricks the orchestrator at boot. Backfill on upgrade.
  _migrate_ensure_key SERVICE_TOKEN_EMAIL "$(openssl rand -hex 32)"
  _migrate_ensure_key ORCHESTRATOR_SAMPLER_TOKEN "$(openssl rand -hex 32)"
  _migrate_ensure_key AI_GATEWAY_SAMPLER_TOKEN "$(openssl rand -hex 32)"
  _migrate_ensure_key SERVICE_TOKEN_EGRESS_AUDIT "$(openssl rand -hex 32)"
  _migrate_ensure_key JWT_SECRET "$(openssl rand -hex 64)"
  # RAG-eval auth backfill: existing installs predate the rag-eval service
  # token; without this key ragas_runner.py's /api/admin/retrieval-eval/search
  # calls 401 and every RAGAS run dies at the first query. Same consumer pair
  # as the fresh-install heredoc: orchestrator SERVICE_PRINCIPALS ↔ rag-eval
  # container ORCHESTRATOR_SERVICE_TOKEN (compose wires it to this value).
  _migrate_ensure_key SERVICE_TOKEN_RAG_EVAL "$(openssl rand -hex 32)"
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

  # WARP-230 device-identity backend. The 'real' (tpm2-pytss) backend is an
  # UNFINISHED scaffold (IDX-002) — device-identity-svc fails closed on it
  # unless DROPLET_TPM_ALLOW_SCAFFOLD is set, so auto-selecting it on a TPM
  # host would crash-loop the sidecar. Backfill 'mock' when the key is absent;
  # operators knowingly running the scaffold set real + the opt-in by hand.
  _migrate_ensure_key DROPLET_TPM_BACKEND "mock"
  # Reconcile pre-existing installs whose .env auto-selected 'real' (older
  # setup, before the fail-closed guard) but never opted into the scaffold:
  # left as-is they crash-loop the sidecar on upgrade. Flip them back to
  # 'mock'. A deliberate opt-in (DROPLET_TPM_BACKEND=real together with a
  # truthy DROPLET_TPM_ALLOW_SCAFFOLD) is preserved untouched.
  if grep -qE '^DROPLET_TPM_BACKEND=real[[:space:]]*$' "$stage" \
     && ! grep -qiE '^DROPLET_TPM_ALLOW_SCAFFOLD=(1|true|yes|on)[[:space:]]*$' "$stage"; then
    sed -i.bak -E 's|^DROPLET_TPM_BACKEND=real[[:space:]]*$|DROPLET_TPM_BACKEND=mock|' "$stage" && rm -f "$stage.bak"
    normalized=true
    log_info "Migrated .env: DROPLET_TPM_BACKEND real→mock (IDX-002 scaffold fails closed; no DROPLET_TPM_ALLOW_SCAFFOLD opt-in)"
  fi
  _migrate_ensure_key DROPLET_DEVICE_ID "$(hostname 2>/dev/null || echo droplet)"

  # WARP-234: per-service Redis ACL identities for pre-existing installs.
  _migrate_ensure_key REDIS_PASSWORD_ORCHESTRATOR "$(_gen_password 24)"
  _migrate_ensure_key REDIS_PASSWORD_AI_GATEWAY "$(_gen_password 24)"
  _migrate_ensure_key REDIS_PASSWORD_MCP "$(_gen_password 24)"
  # Upgrade the exact legacy plaintext REDIS_URL shape to the TLS listener.
  # Only the default-user URL is rewritten (operators with custom URLs keep
  # theirs); real clients get per-service URLs from docker-compose.yml.
  if grep -qE '^REDIS_URL=redis://:[^@]*@cache:6379$' "$stage"; then
    sed -i.bak -E 's|^REDIS_URL=redis://(:[^@]*@cache):6379$|REDIS_URL=rediss://\1:6380|' "$stage" && rm -f "$stage.bak"
    normalized=true
    log_info "Migrated .env: REDIS_URL now points at the TLS listener (WARP-234)"
  fi

  # WARP-318: backfill the single FIPS knob (default OFF) so a pre-318 .env
  # gains it on the next setup re-run. Only the knob is migrated — the derived
  # activation vars (OPENSSL_CONF / DROPLET_FIPS_REQUIRED / OPENSSL_MODULES /
  # NODE_OPTIONS) are setup.sh-managed and (re)written by apply_fips_mode only
  # when --fips/--no-fips is passed; leaving them alone here keeps a re-run
  # without the flag a no-op on FIPS (never a silent enable/disable).
  _migrate_ensure_key DROPLET_FIPS_MODE 0

  # WARP-1061: backfill the internal-mTLS knob (default OFF = plaintext,
  # byte-identical posture to before). Append-if-missing only, so a box whose
  # operator flipped it to 1 keeps that choice across setup re-runs.
  _migrate_ensure_key DROPLET_INTERNAL_TLS 0

  # WARP-235: move existing installs from the shared-password plaintext broker
  # to the mTLS endpoint (single listener :8883; identity = client cert CN).
  # Rewrite-in-place rather than append: compose interpolates these URLs
  # directly, so a stale mqtt:// value would dial a listener that no longer
  # exists. Stale MQTT_PASSWORD / MQTT_USER / FRIGATE_MQTT_* keys are left in
  # the file — harmless, nothing reads them anymore.
  local mqtt_migrated=false
  if grep -qE '^MQTT_BROKER(_LOCAL)?=mqtt://' "$stage" 2>/dev/null; then
    if [ "$backed_up" = "false" ]; then
      # shellcheck disable=SC2155  # Same rationale as above: `date +%s` cannot meaningfully fail.
      local backup="$env_file.bak.$(date +%s)"
      cp "$env_file" "$backup"
      log_info "Backed up existing .env to $backup before migration"
      backed_up=true
    fi
    # BSD/GNU-portable: stage a rewritten copy and rename over the stage file.
    sed -e 's|^MQTT_BROKER=mqtt://.*$|MQTT_BROKER=mqtts://broker:8883|' \
        -e 's|^MQTT_BROKER_LOCAL=mqtt://.*$|MQTT_BROKER_LOCAL=mqtts://localhost:8883|' \
        "$stage" > "$stage.mqtt"
    chmod 600 "$stage.mqtt"
    mv "$stage.mqtt" "$stage"
    mqtt_migrated=true
  fi

  # WARP-233: upgrade an existing DATABASE_URL to sslmode=require (idempotent —
  # only rewrites the exact legacy no-param shape; operators with custom params
  # keep their value). Runs inside the staged-file+mv atomic write.
  if grep -qE '^DATABASE_URL=postgresql://[^?]*$' "$stage"; then
    sed -i.bak -E 's|^(DATABASE_URL=postgresql://[^?]*)$|\1?sslmode=require|' "$stage" && rm -f "$stage.bak"
    normalized=true
    log_info "Migrated .env: DATABASE_URL now pins sslmode=require (WARP-233)"
  fi

  if [ "$appended_count" -gt 0 ] || [ "$normalized" = "true" ] || [ "$mqtt_migrated" = "true" ]; then
    mv "$stage" "$env_file"
  else
    rm -f "$stage"
  fi
  if [ "$appended_count" -gt 0 ]; then
    log_success "Migrated .env: appended$appended_keys"
  fi
  if [ "$mqtt_migrated" = "true" ]; then
    log_success "Migrated .env MQTT_BROKER(_LOCAL) to mqtts:// (WARP-235 — shared password retired)"
  fi
}

# Materialize all setup-time artifact files that Docker Compose bind-mounts
# (Docker secret file, mosquitto conf + ACL, TLS cert). Each underlying
# generator is individually idempotent, so this is safe to run on every
# setup invocation.
#
# This intentionally lives outside generate_env() so it runs even when .env
# already exists — the common upgrade-an-existing-install path.
materialize_artifacts() {
  log_info "Materializing setup artifacts (idempotent)..."

  # Source .env so OPENWRT_PASSWORD / SWITCH_PASSWORD are in scope for the
  # helpers below. Reachable via setup.sh --sync-secrets where nothing else
  # has loaded .env yet.
  if [ -f "$REPO_ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
  fi

  _write_mosquitto_conf
  _generate_redis_acl
  _write_mosquitto_acl
  # WARP-236 — mint the internal CA and issue a per-service TLS bundle for
  # every first-party identity. Idempotent (renews only within 30d of expiry).
  # DROPLET_BRIDGE_GATEWAY_IP is exported by single-box.sh for the single-box
  # shape; empty elsewhere (host.docker.internal covers dev/multi-box).
  internal_ca_ensure
  internal_ca_issue_all "${DROPLET_BRIDGE_GATEWAY_IP:-}"
  _generate_tls_cert
  sync_openwrt_password_secret
  sync_switch_password_secret
  sync_ap_password_secret
  sync_audit_signing_key
  sync_doc_kek_key
  sync_email_fernet_key
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

  # WARP-235 decision-4: compose bind-mounts this key as a single FILE. A bare
  # `docker compose up` run before any setup.sh leaves a Docker-created
  # DIRECTORY at the mount source, which would then block the tmp+mv write
  # below forever — clear it so setup self-heals.
  [ -d "$key_file" ] && rm -rf "$key_file"

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

# WARP-242 — generate data/secrets/doc-kek.key on first setup.
#
# The doc-KEK master key: orchestrator, mcp-server, and file-indexer derive
# the KEK that wraps per-document chunk-encryption DEKs from these 32 raw
# bytes (HKDF, info="doc-kek"). Deliberately a keyfile and NOT an .env
# value — .env ships inside every restic snapshot, so a KEK carried there
# would make snapshots self-decrypting and crypto-shredding a DEK would not
# hold against backups. droplet-backup.sh excludes this file from the backup
# set; the flip side (documented in docs/security/at-rest-encryption.md) is
# that a restore onto NEW hardware cannot decrypt brain chunks.
#
# Same mechanics as sync_audit_signing_key above: raw 32 bytes, mode 0600,
# single-file compose bind (dir self-heal), idempotent — the existing key is
# preserved on every re-run or every wrapped DEK on the box goes unreadable.
# TPM-sealing this key is WARP-1033.
sync_doc_kek_key() {
  local secret_dir="$REPO_ROOT/data/secrets"
  local key_file="$secret_dir/doc-kek.key"

  mkdir -p "$secret_dir"
  chmod 700 "$secret_dir"

  # A bare `docker compose up` before setup.sh leaves a Docker-created
  # DIRECTORY at the single-file mount source — clear it so setup self-heals
  # (WARP-235 decision-4 pattern).
  [ -d "$key_file" ] && rm -rf "$key_file"

  if [ -f "$key_file" ] && [ -s "$key_file" ]; then
    log_success "doc-KEK master key already present at $key_file — skipping"
    return 0
  fi

  local tmp="$key_file.tmp"
  openssl rand 32 > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$key_file"
  log_success "Generated doc-KEK master key at $key_file (chmod 600)"
}

# WARP-465 / WARP-235 decision-4 — generate data/secrets/email.key on first
# setup. The email-indexer's creds.py decrypts EmailAccount.passwordEnc with
# this per-device Fernet key (EMAIL_KEY_PATH, mode 0600) and exits non-zero
# when it's missing. creds.py has ALWAYS documented the key as
# "generated once by setup.sh", but no generator existed until now — and the
# WARP-235 mount-narrowing makes it load-bearing: compose bind-mounts the key
# as a single FILE, so the source must exist before `docker compose up` or
# Docker manufactures a directory in its place.
#
# Idempotent: an existing key is preserved on every re-run — rotating it would
# orphan every already-encrypted EmailAccount row. A fresh key is only minted
# when no file exists (no accounts can predate the key: without it the
# service never booted).
sync_email_fernet_key() {
  local secret_dir="$REPO_ROOT/data/secrets"
  local key_file="$secret_dir/email.key"

  mkdir -p "$secret_dir"
  chmod 700 "$secret_dir"

  # Same single-file bind-mount self-heal as sync_audit_signing_key: a bare
  # compose-up before setup leaves a Docker-created directory here.
  [ -d "$key_file" ] && rm -rf "$key_file"

  if [ -f "$key_file" ] && [ -s "$key_file" ]; then
    log_success "Email Fernet key already present at $key_file — skipping"
    return 0
  fi

  # Fernet key = url-safe base64 of 32 random bytes (44 chars incl. padding).
  # Stage + rename so a crashed run never leaves a truncated key the
  # email-indexer would then fail to parse.
  local tmp="$key_file.tmp"
  openssl rand -base64 32 | tr '+/' '-_' > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$key_file"
  log_success "Generated email Fernet key at $key_file (chmod 600)"
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

# WARP-1675/WARP-1676 — Write the OPERATOR-SUPPLIED $AP_OPENWRT_PASSWORD (from
# env or .env) into docker/secrets/ap_openwrt_password so Compose can mount it
# read-only at /run/secrets/ap_openwrt_password in the routing container.
# Exactly the switch_password contract: the external OpenWrt AP mints its own
# per-unit droplet-ai password at first boot (droplet-edge-router ap/), so this
# NEVER generates a value — the operator copies the AP's
# /etc/droplet/droplet-ai-password here (manual until the pairing handshake in
# ADR-033 lands). Empty/missing → empty placeholder; routing's
# _load_ap_password() treats that as "no external AP" and keeps the historical
# router-side-only approval behaviour, so every existing box is unaffected.
sync_ap_password_secret() {
  local secret_dir="$REPO_ROOT/docker/secrets"
  local secret_file="$secret_dir/ap_openwrt_password"
  local password="${AP_OPENWRT_PASSWORD:-}"

  if [ -z "$password" ] && [ -f "$REPO_ROOT/.env" ]; then
    password=$(grep -E '^AP_OPENWRT_PASSWORD=' "$REPO_ROOT/.env" | head -n 1 | cut -d= -f2- || true)
  fi

  mkdir -p "$secret_dir"
  chmod 700 "$secret_dir"

  if [ -z "$password" ]; then
    : > "$secret_file"
    chmod 600 "$secret_file"
    log_info "AP_OPENWRT_PASSWORD not set in .env — wrote empty $secret_file (no external AP)"
    log_info "  For an external OpenWrt AP: copy its /etc/droplet/droplet-ai-password into AP_OPENWRT_PASSWORD in .env, then re-run ./scripts/setup.sh --sync-secrets"
    return 0
  fi

  local tmp="$secret_file.tmp"
  printf '%s' "$password" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$secret_file"
  log_success "Wrote $secret_file (chmod 600)"
}

# WARP-234 — materialize the per-service Redis ACL file the `cache` service
# serves via --aclfile. Passwords land as sha256 hashes (never plaintext), so
# the file is 0644-safe (redis runs as uid 999 in redis:7-alpine; same
# rationale as the hashed mosquitto passwd). Idempotent: content is fully
# derived from the .env passwords, staged + rename(2)d into place.
#
# ACL map (from ACTUAL usage, not aspiration):
#   default       — +ping only. Health probes + the WARP-966 harness
#                   authenticate with the legacy REDIS_PASSWORD; no data.
#   orchestrator  — get/set/del/expire/smembers/srem/scan/eval across its
#                   many prefixes (sessions, ratelimit:login:*, SWR cache) →
#                   ~* but -@dangerous (KEYS/FLUSH*/CONFIG/... stay denied);
#                   +info for the ioredis ready check.
#   ai-gateway    — chat sessions (session:*, sessions:index) + rate-limit
#                   Lua (ratelimit:*) → exactly those patterns, +@scripting.
#   mcp-server    — rerank result cache → ~rerank:* with +get +setex only.
#   nextcloud     — php memcache/locking (instanceid-derived prefixes) → ~*,
#                   +keys carve-out (phpredis clear()), -@dangerous.
_generate_redis_acl() {
  local acl_dir="$REPO_ROOT/data/secrets/redis"
  local acl_file="$acl_dir/users.acl"

  if [ -z "${REDIS_PASSWORD:-}" ]; then
    log_warn "REDIS_PASSWORD not set — skipping Redis ACL generation (rerun setup once .env exists)"
    return 0
  fi
  # Pre-WARP-234 .env (fresh generate_env always sets these; migrate_env
  # backfills on upgrade). Nextcloud reuses REDIS_HOST_PASSWORD.
  local orch_pw="${REDIS_PASSWORD_ORCHESTRATOR:-}"
  local aigw_pw="${REDIS_PASSWORD_AI_GATEWAY:-}"
  local mcp_pw="${REDIS_PASSWORD_MCP:-}"
  local nc_pw="${REDIS_HOST_PASSWORD:-$REDIS_PASSWORD}"
  if [ -z "$orch_pw" ] || [ -z "$aigw_pw" ] || [ -z "$mcp_pw" ]; then
    log_warn "Per-service Redis passwords missing from .env — skipping ACL generation (run setup.sh to migrate .env first)"
    return 0
  fi

  _redis_sha() { printf '%s' "$1" | openssl dgst -sha256 -hex | sed 's/^.*= //'; }

  mkdir -p "$acl_dir"
  chmod 700 "$REPO_ROOT/data/secrets" "$acl_dir" 2>/dev/null || true
  local stage="$acl_file.tmp.$$"
  rm -f "$acl_file".tmp.* 2>/dev/null || true
  # NOTE: redis --aclfile REJECTS comment lines ("should start with user
  # keyword") — the file must contain user lines ONLY. Provenance lives here:
  # generated by _generate_redis_acl (WARP-234); regenerated on every setup
  # run from .env; DO NOT hand-edit.
  cat > "$stage" <<EOF
user default on #$(_redis_sha "$REDIS_PASSWORD") resetchannels -@all +ping
user orchestrator on #$(_redis_sha "$orch_pw") ~* resetchannels -@all +@connection +@read +@write +@keyspace +@transaction +@scripting -@dangerous +info +client|setinfo
user ai-gateway on #$(_redis_sha "$aigw_pw") ~session:* ~sessions:index ~ratelimit:* resetchannels -@all +@connection +@read +@write +@keyspace +@scripting -@dangerous +client|setinfo
user mcp-server on #$(_redis_sha "$mcp_pw") ~rerank:* resetchannels -@all +@connection +get +setex +info +client|setinfo
user nextcloud on #$(_redis_sha "$nc_pw") ~* resetchannels -@all +@connection +@read +@write +@keyspace +@string +@scripting -@dangerous +keys +client|setinfo
EOF
  chmod 644 "$stage"
  if [ -f "$acl_file" ] && cmp -s "$stage" "$acl_file"; then
    rm -f "$stage"
    return 0
  fi
  mv "$stage" "$acl_file"
  log_success "Redis ACL file generated at $acl_file (5 users, hashed)"
}

# WARP-235: the shared-password machinery (the passwd-file generator + its
# compose mount) is retired. The broker runs a single mTLS
# listener on :8883; client identity is the certificate CN issued by the
# WARP-236 internal CA (internal_ca_issue broker/orchestrator/file-indexer/…),
# and per-CN topic grants live in docker/mosquitto.acl. Both files below are
# TRACKED IN GIT and regenerated byte-identically here so an on-box
# `--sync-secrets` run never dirties the checkout (the parity is pinned by
# tests/mosquitto-conf.test.sh).
#
# WARP-185 lineage: the runtime mosquitto uid is 1883, so the broker's TLS
# private key gets the same readability treatment the old passwd file needed —
# internal_ca_issue (scripts/lib/internal-ca.sh) chowns key.pem to 1883 or
# falls back to 0644 inside the 0700 data/secrets tree.
_write_mosquitto_conf() {
  local conf_file="$REPO_ROOT/docker/mosquitto.conf"

  # Clean up stale file or directory from a previous failed run. Docker creates
  # a directory if the bind-mount target doesn't exist as a file yet, so we
  # need rm -rf to handle both cases.
  rm -rf "$conf_file" 2>/dev/null || true

  cat > "$conf_file" << 'MQTTCONF'
listener 8883
cafile /mosquitto/config/tls/ca.pem
certfile /mosquitto/config/tls/cert.pem
keyfile /mosquitto/config/tls/key.pem
require_certificate true
use_identity_as_username true
acl_file /mosquitto/config/droplet.acl
allow_anonymous false
persistence false
MQTTCONF

  log_success "Mosquitto configured for mTLS (client identity = cert CN)"
}

# WARP-235: per-CN topic ACLs. The heredoc MUST stay byte-identical to the
# tracked docker/mosquitto.acl (tests/mosquitto-conf.test.sh enforces parity).
# Adding a new MQTT client: add its CN to INTERNAL_CA_SERVICES
# (scripts/lib/internal-ca.sh), grant its topics HERE and in
# docker/mosquitto.acl, mount its bundle in docker-compose.yml, then run
# `./scripts/setup.sh --sync-secrets` — see docs/security/internal-mtls.md.
_write_mosquitto_acl() {
  local acl_file="$REPO_ROOT/docker/mosquitto.acl"

  rm -rf "$acl_file" 2>/dev/null || true

  cat > "$acl_file" << 'MQTTACL'
# WARP-235 — per-service topic ACLs. Usernames ARE certificate CNs
# (use_identity_as_username true); there are no password accounts.
# Deny-by-default: any topic not granted here is rejected for that CN.

user orchestrator
topic readwrite droplet/#
topic read frigate/#
topic read email/#

user file-indexer
topic write droplet/index/+/indexed
topic write droplet/index/+/deleted
topic write droplet/files/+/brain/indexed
topic write droplet/context-stats/invalidate
topic read droplet/files/brain/uploaded
topic read droplet/transcription/run-one

user email-indexer
topic write email/+/new

user camera-discovery
topic write droplet/cameras/discovered

user frigate
topic readwrite frigate/#
MQTTACL

  log_success "Mosquitto per-CN topic ACLs written"
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

# WARP-2132: the ONE source of truth for "which IPv4 addresses must this box's
# cert cover" — used by BOTH the SAN builder in _generate_tls_cert and the
# coverage check _cert_covers_current_ips, so the two can never drift apart.
# Deliberately the exact expression the SAN builder always used: every
# non-loopback global-scope IPv4, docker0/br-*/wg* addresses included (they are
# global-scope, have always landed in the SAN, and excluding them here while
# the builder emits them would make a freshly-minted cert read as stale).
# Test hook: DROPLET_TLS_CURRENT_IPS (space-separated) overrides the harvest so
# IP-coverage behaviour is deterministic off-box.
_current_global_ipv4s() {
  if [ -n "${DROPLET_TLS_CURRENT_IPS:-}" ]; then
    local _ip
    for _ip in ${DROPLET_TLS_CURRENT_IPS}; do
      printf '%s\n' "$_ip"
    done
    return 0
  fi
  ip -4 addr show scope global 2>/dev/null \
    | grep -oP 'inet \K[\d.]+' 2>/dev/null || \
    ifconfig 2>/dev/null \
    | grep -oE 'inet (addr:)?[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
    | grep -v '^127\.'
  return 0
}

# WARP-2132: every IP SAN of the given cert, one per line (mirrors the DNS
# extraction in _cert_has_all_required_sans; `openssl x509 -ext subjectAltName`
# prints these as `IP Address:192.168.50.197`).
_cert_ip_sans() {
  openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null \
    | grep -oE 'IP Address:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
    | sed 's/^IP Address://'
  return 0
}

# WARP-2132: does the installed cert's SAN cover every CURRENT global IPv4 on
# the box? The install-time cert freezes the secrets-time harvest into its IP
# SANs; a box that changes networks then serves IP SANs for addresses it no
# longer holds and every browser warns forever — and the skip-guard (expiry +
# DNS SANs + pair match only) passed that stale cert on every re-run. Current
# addresses come from _current_global_ipv4s — the SAME harvest the SAN builder
# uses. Returns 0 when every current IP is present as an IP SAN (vacuously
# true when the harvest is empty — a box with no addresses must not churn).
_cert_covers_current_ips() {
  local cert_file="$1"
  local ip_list
  ip_list="$(_cert_ip_sans "$cert_file")"
  local ip
  for ip in $(_current_global_ipv4s); do
    if ! printf '%s\n' "$ip_list" | grep -qxF "$ip"; then
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

# WARP-595: does the private key actually belong to the certificate? A torn
# write from an interrupted run (or a crash between the two renames of a
# cert+key pair) can leave a VALID cert next to a key from a DIFFERENT keypair.
# The skip-guard in _generate_tls_cert used to validate only the cert, so that
# broken pair passed "already exists, is valid" on every re-run forever while
# nginx failed to load it — the one non-convergent TLS state. Compare the
# SubjectPublicKeyInfo from both sides; `openssl pkey` handles RSA and EC.
# Returns 0 when the pair matches, 1 on mismatch or an unparseable input.
_tls_pair_matches() {
  local cert_file="$1" key_file="$2"
  local cert_pub key_pub
  cert_pub="$(openssl x509 -in "$cert_file" -noout -pubkey 2>/dev/null)" || return 1
  key_pub="$(openssl pkey -in "$key_file" -pubout 2>/dev/null)" || return 1
  [ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ]
}

# ADR-023 PR-2: write the self-signed bootstrap pair to droplet.{crt,key}.bootstrap
# — the exact bytes clients import via trust-droplet-cert. Idempotent: never
# overwrite an existing .bootstrap (the first self-signed cert ever generated is
# the one clients trust; a later regeneration must not move the trust anchor).
#
# WARP-2132 exception: an explicit `--refresh` third argument overwrites the
# side-copy. ONLY the IP-stale re-issue path passes it — that path reuses the
# SAME keypair (the trust anchor's public key does not move) and only widens
# the SAN, and the expired-restore path above must replay the WIDEST cert ever
# issued, not resurrect one pinned to a network the box has left. The default
# never-overwrite behaviour is unchanged for every other caller.
_write_tls_bootstrap_copy() {
  local cert_file="$1" key_file="$2" mode="${3:-}"
  local boot_cert="$cert_file.bootstrap" boot_key="$key_file.bootstrap"

  if [ ! -f "$cert_file" ] || [ ! -f "$key_file" ]; then
    return 0
  fi
  # Write each bootstrap file independently — never overwrite an existing one.
  # Writing them separately means a crash between the two copies leaves exactly
  # one file present; the next run writes the missing half without touching the
  # already-written one, rather than skipping both (OR guard) or overwriting the
  # existing one (AND guard with fallthrough).
  if [ ! -f "$boot_cert" ] || [ "$mode" = "--refresh" ]; then
    cp "$cert_file" "$boot_cert"
    chmod 644 "$boot_cert"
    log_info "  Saved trust-anchor bootstrap cert: $boot_cert"
  fi
  if [ ! -f "$boot_key" ] || [ "$mode" = "--refresh" ]; then
    cp "$key_file" "$boot_key"
    chmod 600 "$boot_key"
    log_info "  Saved trust-anchor bootstrap key: $boot_key"
  fi
}

# WARP-2132: re-issue the SELF-SIGNED cert when the box's interface IPs have
# moved out from under it. The install-time cert freezes the secrets-time IP
# harvest into its SANs; a box that changes networks then serves IP SANs for
# addresses it no longer holds and browsers warn forever — with no regen
# trigger anywhere. Three deliberate properties:
#   * KEY REUSE — `openssl req -x509 -key`, never -newkey: pairings,
#     key-pinned clients, and every client that imported the bootstrap cert
#     (same subject, same public key) survive the re-issue.
#   * SAN SUPERSET — every SAN the outgoing cert vouched for is RETAINED and
#     the current generation set (required DNS names, hostname, public FQDN,
#     current IPs) is ADDED, so a client still dialing an old address keeps a
#     name-matching cert. Duplicates are harmless to openssl; an exact-match
#     dedup keeps the logged SAN line readable.
#   * BOOTSTRAP REFRESH — the .bootstrap side-copy is deliberately refreshed
#     on THIS path only (same keypair, wider SAN — the trust anchor's key does
#     not move); see _write_tls_bootstrap_copy's --refresh note.
# Public-CA leaves NEVER reach this function — the caller gates on
# _cert_is_public_ca_leaf first (ADR-023: setup never reshapes an HQ-issued
# fullchain; LE leaves carry no IP SANs and the per-device FQDN is their
# access path).
_regen_tls_cert_for_current_ips() {
  local cert_file="$1" key_file="$2"

  log_warn "TLS certificate does not cover the box's current interface IPs — re-issuing with the SAME key (WARP-2132)"

  # Union: the outgoing cert's SANs first (typed tokens, IP Address → IP so
  # they are valid subjectAltName syntax again), then the current set.
  local entries
  entries="$(openssl x509 -in "$cert_file" -noout -ext subjectAltName 2>/dev/null \
             | grep -oE '(DNS:[^,[:space:]]+|IP Address:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)' \
             | sed 's/^IP Address:/IP:/')"
  local dns
  for dns in "${_REQUIRED_DNS_SANS[@]}"; do
    entries="$entries
DNS:$dns"
  done
  local hn
  hn=$(hostname 2>/dev/null || echo "droplet")
  entries="$entries
DNS:$hn
DNS:${hn}.local"
  local public_fqdn="${DROPLET_PUBLIC_FQDN:-}"
  if [ -n "$public_fqdn" ]; then
    entries="$entries
DNS:$public_fqdn"
  fi
  local ip
  for ip in $(_current_global_ipv4s); do
    entries="$entries
IP:$ip"
  done
  entries="$entries
IP:127.0.0.1"

  # Order-preserving exact dedup.
  local san="" entry
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case ",$san," in *",$entry,"*) continue ;; esac
    san="${san:+$san,}$entry"
  done <<< "$entries"

  # Same atomic-write discipline as the -newkey path (WARP-595): temp file +
  # rename. Only the CERT moves — the key is untouched by design, so there is
  # no two-rename window: a crash here leaves either the old or the new cert,
  # both matching the existing key.
  if ! openssl req -x509 -new -nodes -key "$key_file" \
    -days 3650 \
    -out "$cert_file.tmp" \
    -subj "/CN=Droplet Edge Device" \
    -addext "subjectAltName=$san" \
    2>/dev/null; then
    rm -f "$cert_file.tmp"
    log_warn "could not re-issue the TLS certificate with the existing key — keeping the current cert"
    return 1
  fi
  chmod 644 "$cert_file.tmp"
  mv "$cert_file.tmp" "$cert_file"

  log_success "TLS certificate re-issued for the current IPs (key unchanged):"
  log_info "  Cert: $cert_file"
  log_info "  SANs: $san"

  # Deliberate refresh — same keypair, superset SAN (see header).
  _write_tls_bootstrap_copy "$cert_file" "$key_file" --refresh

  # Same shared reload helper as every other cert-writing path (ADR-023 C2).
  if ! declare -F reload_gateway_nginx >/dev/null 2>&1; then
    # shellcheck source=tls-reload.sh
    source "$(dirname "${BASH_SOURCE[0]}")/tls-reload.sh"
  fi
  reload_gateway_nginx || true
  return 0
}

_generate_tls_cert() {
  local cert_dir="$REPO_ROOT/docker/certs"
  local cert_file="$cert_dir/droplet.crt"
  local key_file="$cert_dir/droplet.key"

  # Skip only if the cert is still valid AND covers every required DNS name
  # AND (self-signed only) covers every current interface IP. The SAN-complete
  # check was added after the local-DNS feature landed; without it, installs
  # upgrading from an older setup still served a cert without
  # droplet-ai.lan / droplet.local etc. in the SAN, forcing a
  # hostname-mismatch error even after the user trusted the cert.
  if [ -f "$cert_file" ] && [ -f "$key_file" ]; then
    # WARP-595: the skip-guard must also verify the KEY belongs to the cert —
    # a torn pair (valid cert + unrelated/truncated key) previously passed
    # this check on every re-run and never converged.
    if openssl x509 -checkend 86400 -noout -in "$cert_file" >/dev/null 2>&1 \
       && _cert_has_all_required_sans "$cert_file" \
       && _tls_pair_matches "$cert_file" "$key_file"; then
      # WARP-2132: expiry + DNS SANs + pair match is NOT enough for a
      # SELF-SIGNED cert — its IP SANs freeze the install-time harvest, so a
      # box that changed networks kept skipping here and served stale IP SANs
      # forever (no other regen trigger existed). Public-CA leaves are exempt:
      # setup never reshapes an HQ-issued fullchain (ADR-023), and LE leaves
      # carry no IP SANs — the per-device FQDN is their access path.
      if _cert_is_public_ca_leaf "$cert_file" || _cert_covers_current_ips "$cert_file"; then
        log_success "TLS certificate already exists, is valid, and covers all required SANs — skipping"
        return 0
      fi
      # Valid, DNS-complete, matched — but self-signed and missing at least
      # one CURRENT interface IP: re-issue with the same key + SAN superset.
      _regen_tls_cert_for_current_ips "$cert_file" "$key_file"
      return $?
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
      if _tls_pair_matches "$cert_file" "$key_file"; then
        log_success "TLS certificate is a publicly-trusted (public-CA) leaf — preserving it (ADR-023)"
      else
        # WARP-595: preserving is still correct — setup cannot mint public-CA
        # material, and clobbering with self-signed would break the trust
        # story — but this must NEVER read as a clean success. The 04:00
        # tls-issuance cron does NOT heal a torn pair outside the ≤30-day
        # renew window (its decision is DB-state-driven; it never checks the
        # on-disk key), so a broken public-CA pair can sit unloadable for
        # weeks while nginx fails to load it. Tell the operator to trigger
        # re-issuance instead of waiting for the renew window.
        log_warn "TLS certificate is a public-CA leaf but the private key does NOT match it (torn issuance write)"
        log_warn "  Preserving the fullchain (setup cannot mint public-CA material) — but nginx may fail to"
        log_warn "  load this pair. Trigger re-issuance manually rather than waiting for the ≤30-day renew"
        log_warn "  window (the issuance cron never checks the on-disk key)."
      fi
      return 0
    fi

    # ADR-023 PR-2 — EXPIRED (or WARP-595 TORN-PAIR) + BOOTSTRAP RESTORE.
    # If the installed (self-signed) cert is EXPIRED — or the installed pair is
    # MISMATCHED (torn write from an interrupted run) — and a valid bootstrap
    # pair exists, RESTORE the bootstrap pair instead of -newkey'ing a fresh
    # keypair, so trust-store clients that imported the bootstrap cert still
    # connect. Only -newkey below when there is no usable bootstrap. The
    # bootstrap pair itself must also match (it could be torn too).
    local pair_broken=false
    _tls_pair_matches "$cert_file" "$key_file" || pair_broken=true
    local boot_cert="$cert_file.bootstrap" boot_key="$key_file.bootstrap"
    if { ! openssl x509 -checkend 86400 -noout -in "$cert_file" >/dev/null 2>&1 \
         || [ "$pair_broken" = "true" ]; } \
       && [ -f "$boot_cert" ] && [ -f "$boot_key" ] \
       && openssl x509 -checkend 86400 -noout -in "$boot_cert" >/dev/null 2>&1 \
       && _cert_has_all_required_sans "$boot_cert" \
       && _tls_pair_matches "$boot_cert" "$boot_key"; then
      log_warn "TLS certificate expired or pair mismatched — restoring the trust-anchor bootstrap pair (ADR-023)"
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
    elif [ "$pair_broken" = "true" ]; then
      log_warn "TLS certificate and key do not match (torn write from an interrupted run) — regenerating"
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

  # Add all non-loopback IPv4 addresses. ONE shared harvest
  # (_current_global_ipv4s) feeds both this SAN builder and the WARP-2132
  # coverage check _cert_covers_current_ips, so the two can never drift.
  local ip
  for ip in $(_current_global_ipv4s); do
    san="$san,IP:$ip"
  done
  # Always include loopback
  san="$san,IP:127.0.0.1"

  # WARP-595: generate into temp files and rename into place so an interrupted
  # run never leaves a half-written cert or key at the live paths. A crash
  # between the two renames leaves a MISMATCHED pair — which the pair-match
  # guard above now detects and heals on the next run.
  openssl req -x509 -nodes -newkey rsa:2048 \
    -days 3650 \
    -keyout "$key_file.tmp" \
    -out "$cert_file.tmp" \
    -subj "/CN=Droplet Edge Device" \
    -addext "subjectAltName=$san" \
    2>/dev/null

  chmod 600 "$key_file.tmp"
  chmod 644 "$cert_file.tmp"
  mv "$key_file.tmp" "$key_file"
  mv "$cert_file.tmp" "$cert_file"

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
