# Environment variables — reference

The variables you'll most often need, with defaults and gotchas. The
**exhaustive, always-current list is [`.env.example`](../.env.example)**
— if a variable isn't in this table, look there. The safety-critical
rules (the `MATTER_*` ban, CORS exact-match semantics, rate-limit proxy
trust, PM secrets) are summarized in [`CLAUDE.md`](../CLAUDE.md).

> ⚠ **Never add new `MATTER_*` env vars.** matter.js scans `process.env` at startup and auto-imports every `MATTER_*` variable into its internal `VariableService`, dot-namespacing each one. Collisions with root-node behavior ids throw `UnsupportedCastError: Property "X" is unsupported` and break controller init. Use a `DROPLET_MATTER_*` prefix for our own env vars instead. `MATTER_STORAGE_PATH` is the only surviving `MATTER_*` name and is allow-listed by `scripts/test-security.sh`. Full rationale: [`apps/orchestrator/src/config.ts`](../apps/orchestrator/src/config.ts) — the block comment above the `Matter` schema section.

| Variable             | Description                                          |
|----------------------|------------------------------------------------------|
| `DATABASE_URL`       | PostgreSQL connection string                         |
| `POSTGRES_PASSWORD`  | Main Postgres (`db` service) password                |
| `REDIS_URL`          | Redis connection string                              |
| `MQTT_BROKER`        | MQTT broker address                                  |
| `MQTT_USER` / `MQTT_PASSWORD` | MQTT broker credentials                     |
| `NEXTCLOUD_ADMIN_USER` / `NEXTCLOUD_ADMIN_PASSWORD` | Nextcloud admin account bootstrap |
| `JWT_SECRET`         | Orchestrator JWT signing secret (per-device; `change-me` placeholder in `.env.example`) |
| `COMPOSE_PROFILES`   | Which optional service groups start (`linux`, `display`, `full`, `single-box`, `pm`, `eval`, `ops`, `docs`). Written by `setup.sh` — semantics per shape in the `docker-stack` skill. `docs` (OnlyOffice editing, WARP-882) is default-ON on the 32 GB box; a ≤8 GB box drops it |
| `AI_GATEWAY_URL`     | AI gateway endpoint                                  |
| `OLLAMA_URL`         | Chat-path Ollama endpoint (default `http://host.docker.internal:11434` locally). Points **direct at Ollama**, not the manager's `/proxy` — see the `debug-ollama-call-path` skill |
| `OLLAMA_MANAGER_URL` | Optional ollama-manager root for lifecycle/limits, decoupled from the chat `OLLAMA_URL` (XR-05). If `OLLAMA_URL` itself ends in `/proxy`, the manager root is derived from it |
| `OLLAMA_CONTEXT_LENGTH` | Context window for the bundled single-box Ollama (default `16384`). Ollama's own default is 4096, which the owner-role tool schemas alone overflow — symptom: instant empty chat answers (WARP-854) |
| `DROPLET_SSO_{GOOGLE,ENTRA,OKTA}_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}` | Optional OIDC SSO provider config (commented out by default in `.env.example`) |
| `FILES_ROOT`         | `.data/files` (local) / `/data/files` (Docker)       |
| `STORAGE_BACKEND`    | `legacy` or `nextcloud`                              |
| `NEXTCLOUD_URL`      | Nextcloud instance URL                               |
| `DOCS_ENABLED`       | EXPLICIT master switch for in-browser editing / co-authoring (WARP-882). `1`/`true` enable; default-ON for the 32 GB box. NOT derived from `DOCS_INTERNAL_URL` emptiness. A ≤8 GB box sets `0` AND drops `docs` from `COMPOSE_PROFILES` |
| `DOCS_INTERNAL_URL`  | Compose-network base URL the orchestrator probes for the OnlyOffice Document Server engine (default `http://docserver`). Empty → engine treated as unavailable |
| `DOCS_EDITOR_PUBLIC_PATH` | Public path the gateway fronts the engine on (nginx `location /docs/`); default `/docs/` |
| `DOCS_ACCESS_TOKEN_TTL_SECONDS` | Per-session editor access-token TTL in seconds (default `1800` = 30 min); the dashboard refreshes before expiry |
| `DOCS_MEM_LIMIT` / `DOCS_CPUS` / `DOCS_PIDS_LIMIT` | `docserver` container resource ceilings (ADR-021; defaults `2g` / `2.0` / `1024`). ~2 GB additive |
| `ONLYOFFICE_JWT_SECRET` | Shared HS256 secret the Document Server, the Nextcloud `onlyoffice` connector, AND the orchestrator all verify. Per-device; `change-me` placeholder in `.env.example`. Empty → connector + engine reject unsigned requests. **License note:** OnlyOffice CE (AGPLv3) is what we build/test; an OnlyOffice OEM/commercial license is required before GA |
| `ONLYOFFICE_JWT_ENABLED` | Whether the engine enforces the JWT (default `true`; matched by the connector) |
| `FILES_API_URL` | Files-API target for the MCP file tools (default `http://orchestrator:3000/api/files`). Despite the client's historical "nextcloud" name, raw Nextcloud can't serve these tools (WARP-861) |
| `AUTH_ENABLED`       | Enable/disable auth                                  |
| `PORT`               | Server listen port                                   |
| `DEVICE_SECRET`      | Device authentication secret                         |
| `MAX_UPLOAD_SIZE_MB` | Upload size limit in MB                              |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowlist of browser Origins permitted to make credentialed cross-origin requests against the orchestrator (WARP-562). Exact-match — entries are compared byte-for-byte against the request `Origin` with no normalization, so a trailing slash (`https://x.example/`) or differing case will silently never match; supply each origin as scheme+host(+port) only, e.g. `https://droplet-ai.local`. `credentials: true` is always on so the orchestrator never reflects an arbitrary Origin. Default when unset: `https://droplet-ai.local` (covered by the TLS cert SANs) plus `http://localhost:3001` (the Next.js dashboard dev server; `:3000` is the orchestrator's own port) outside production. A `*` value is **rejected at startup** (mirrors `services/ai-gateway/main.py`). |
| `RATE_LIMIT_TRUSTED_PROXIES` | (ai-gateway, GW-14) Comma-separated socket-peer IPs/CIDRs whose forwarded client-IP headers (`X-Real-IP`/`X-Forwarded-For`) the gateway's rate limiter trusts for per-client bucketing. ai-gateway has no app-level auth and is reachable by any peer on the compose network, so a forged `X-Real-IP` could mint a private bucket and bypass the limit. Default empty → trust nothing → always key on the real socket peer (safe). Set to your nginx edge's address/subnet (e.g. `172.18.0.0/16`) to restore header-based client identification through the proxy. |
| `ROUTING_SERVICE_URL`| Routing service endpoint (default `http://host.docker.internal:8080` — routing uses `network_mode: host`, so orchestrator reaches it via the host gateway) |
| `OPENWRT_HOST`       | OpenWrt router IP (default `192.168.50.1`)           |
| `OPENWRT_USERNAME`   | OpenWrt rpcd user (default `droplet-ai`)             |
| `OPENWRT_PASSWORD`   | OpenWrt rpcd password                                |
| `FRIGATE_URL`        | Frigate NVR API endpoint (default `http://frigate:5000`) |
| `CAMERA_SCAN_INTERVAL` | Camera discovery scan interval in seconds (default `30`) |
| `CAMERA_SUBNET`      | Camera isolation subnet CIDR (default `192.168.100.0/24`) |
| `CAMERA_DEFAULT_USERNAME` | Operator-supplied admin user for IP cameras; tried before factory defaults |
| `CAMERA_DEFAULT_PASSWORD` | Operator-supplied admin password (paired with `CAMERA_DEFAULT_USERNAME`) |
| `CAMERA_CREDENTIALS_JSON` | JSON array of `[user, pw]` pairs probed before factory defaults |
| `ONVIF_WS_DISCOVERY_ENABLED` | `1` to enable WS-Discovery multicast scan (default `0`; `python-ws-discovery` leaks FDs on Python 3.12+) |
| `CAMERA_AUTO_INITIALIZE` | `1` to auto-run the vendor first-run admin-password flow (Hanwha `/init-cgi/pw_init.cgi`) using `CAMERA_DEFAULT_PASSWORD` when an uninitialized camera is seen (default `0`) |
| `FRIGATE_IMAGE`      | Frigate container image (default `stable` CPU; set `stable-tensorrt-jp6` on an NVIDIA-GPU inference host) |
| `FRIGATE_RUNTIME`    | Docker runtime for the Frigate container (`runc` default; set `nvidia` on inference hosts with an NVIDIA GPU) |
| `YOLO_MODELS`        | JP6-image model preparator trigger; leave empty until the s6 prepare script stops expecting legacy `.cfg` inputs |
| `SWITCH_HOST`        | Managed switch IP (default `192.168.1.77`)             |
| `SWITCH_PORT`        | Managed switch HTTPS port (default `443`)              |
| `SWITCH_USERNAME`    | Switch admin username (default `admin`)                |
| `SWITCH_PASSWORD`    | Switch admin password                                  |
| `SWITCH_DRIVER`      | Switch driver: `lantronix` (default) or `asic` (future) |
| `SWITCH_SERVICE_URL` | Switch service endpoint (default `http://host.docker.internal:8081` — same host-mode rationale as `ROUTING_SERVICE_URL`) |
| `DISPLAY_SERVICE_URL`| OLED/TFT display service endpoint (default `http://host.docker.internal:8082` — display runs host-mode on the inference host) |
| `DROPLET_PM_API_URL` | Plane backend API URL on the compose network (default `http://pm-api:8000`) — embedded PM stack per ADR-010 |
| `DROPLET_PM_WEB_URL` | LAN-facing URL Plane bakes into emails / share links (default `https://droplet-ai.local/pm`) — covered by the existing TLS cert SANs |
| `DROPLET_PM_ADMIN_TOKEN` | Orchestrator-only token for provisioning Plane users via admin API. **NEVER** exposed to the dashboard or LLM agent. Empty default makes the SSO bridge 503 until `setup.sh` populates `.env` |
| `DROPLET_PM_WEBHOOK_SECRET` | HMAC signing key for Plane → orchestrator webhooks (WARP-511). Empty default → webhook receiver fail-CLOSED per the engineering-handbook `04-coding-standards/security-rules.md` §1 |
| `DROPLET_PM_DB_NAME` / `_USER` / `_PASSWORD` / `_HOST` / `_PORT` | Dedicated `postgres-pm` connection (OQ1 — separate from the orchestrator's main Postgres) |
| `DROPLET_PM_REDIS_HOST` / `_PORT` | Dedicated `redis-pm` connection (OQ1) |
| `DROPLET_PM_SECRET_KEY` | Plane Django `SECRET_KEY` (session signing, etc.) — generated by `setup.sh` |
| `DROPLET_PM_DEFAULT_WORKSPACE` | First workspace name seeded by the setup wizard (WARP-507). Falls back to "My Workspace" if empty |
| `ROUTING_MODE`       | `real` (default) / `mock` (fixture-driven, no OpenWrt needed) / `disabled` (orchestrator skips router calls). See WARP-44. |
| `CONTAINER_PIDS_LIMIT` | Global PID limit applied to all services (default `512`). Raise for services with many worker threads. |
| `GATEWAY_MEM_LIMIT` | nginx mem ceiling (default `128m`) |
| `WEB_DASHBOARD_MEM_LIMIT` | Next.js mem ceiling (default `384m`) |
| `ORCHESTRATOR_MEM_LIMIT` | Orchestrator mem ceiling (default `768m`) |
| `ORCHESTRATOR_MEM_RESERVATION` | Orchestrator mem reservation — protected from OOM eviction (default `512m`) |
| `ORCHESTRATOR_CPUS` | Orchestrator CPU ceiling (default `2.0`) |
| `DB_MEM_LIMIT` | Postgres mem ceiling (default `1g`) |
| `DB_MEM_RESERVATION` | Postgres mem reservation — most protected core service (default `512m`) |
| `DB_CPUS` | Postgres CPU ceiling (default `2.0`) |
| `CACHE_MEM_LIMIT` | Redis mem ceiling (default `256m`) |
| `CACHE_MEM_RESERVATION` | Redis mem reservation (default `128m`) |
| `AI_GATEWAY_MEM_LIMIT` | AI gateway mem ceiling (default `512m`) |
| `FRIGATE_MEM_LIMIT` | Frigate NVR mem ceiling (default `1g`) — raise for higher-resolution streams |
| `OLLAMA_MEM_LIMIT` | Ollama LLM inference mem ceiling (default `4g`) — raise for larger models |
| `OLLAMA_CPUS` | Ollama CPU ceiling (default `4.0`) |
| `WHISPER_MEM_LIMIT` | Wyoming Whisper STT mem ceiling (default `1g`) — small.en model is ~470 MB |
| (other `*_MEM_LIMIT` / `*_CPUS`) | Per-service overrides for every container. See [`ADR-021-container-resource-limits.md`](ADR-021-container-resource-limits.md) for the full list and RAM budget. |
