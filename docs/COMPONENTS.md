# Component Reference (agent-usable)

> **Audience:** AI agents and engineers who need to know *what each component is,
> where its code lives, what it talks to, and what will bite you* — without
> reading the whole codebase first.
>
> **Scope:** Every component in this repo (`droplet-onboard-services`, GitHub
> `DropletByWarpLab/droplet-onboard-services`) — the **intelligence layer** of the
> Droplet edge AI appliance. Inference (Ollama + `ollama-manager`) lives in the
> sibling repo [`droplet-local-LLM`](../../droplet-local-LLM); the physical
> appliance lives in `pcb-claude-tool`. See [`agentic-workflows.md`](agentic-workflows.md)
> for the cross-repo picture and [`ADR-009-canonical-system-architecture.md`](ADR-009-canonical-system-architecture.md)
> for the canonical system shape (do not violate it without a superseding ADR).
>
> **Maintenance:** This is a hand-curated map, last fully audited **2026-05-30**
> against `main`. The machine-generated counterpart is
> `scripts/generate-audit.sh` → `technical-audit.md` (synced into the shared
> brain). When you add/rename/remove a component, update this file in the same PR.

---

## How to read this doc

Each component has a uniform fact sheet:

- **Purpose** — one or two sentences.
- **Stack / entry point** — language, framework, the file that boots it, port.
- **Surface** — HTTP/gRPC/MCP/CLI it exposes.
- **Talks to** — outbound dependencies (other components, containers).
- **Key files** — the handful you'd open first.
- **Gotchas** — the non-obvious constraints an agent editing it must respect.

If you only read one thing: the [System map](#system-map) and
[Ports & transports](#ports--transports) tables below.

---

## System map

The appliance is a **single Docker Compose stack** (`docker/docker-compose.yml`,
25 services) fronted by one nginx `gateway`. The **orchestrator** is the brain —
every client request and every internal coordination path goes through it. There
is deliberately **no separate API gateway service** in front of the orchestrator
(ADR-009): the nginx `gateway` is only a TLS terminator + path router.

```
                          ┌──────────── nginx gateway (:80/:443) ────────────┐
   clients (web / iOS /   │  /          → web-dashboard                       │
   android / desktop) ───►│  /api/      → orchestrator   /ai/  → ai-gateway   │
   (on-LAN direct,        │  /nextcloud/→ nextcloud                           │
    off-LAN via WireGuard)│  /api/ws/   → orchestrator (WebSocket)            │
                          └───────────────────────┬──────────────────────────┘
                                                   │
          ┌────────────────────────────────────── orchestrator (Node/Express/Prisma)
          │  agent loop ── stdio ──► mcp-server ──► @droplet/tools-core (≈78 tools)
          │  inference  ── gRPC ───► ai-gateway ──► Ollama (sibling repo) / cloud LLMs
          │  files      ── HTTP ───► nextcloud ;  index ◄─ MQTT ─ file-indexer
          │  network    ── HTTP ───► routing ──► OpenWrt router (ubus)
          │  switch     ── HTTP ───► switch service ──► managed switch
          │  cameras    ── HTTP ───► camera-discovery + frigate (NVR)
          │  display    ── HTTP ───► oled-display ;  voice ── HTTP ── voice-io
          │  PM         ── native ─► orchestrator /api/pm/* routes + Pm* Prisma models (db)
          │  identity   ── gRPC ───► device-identity-svc (TPM 2.0, unix socket)
          │  state      ── PostgreSQL (db) + Redis (cache) + MQTT (broker)
          └───────────────────────────────────────────────────────────────────────
```

### Component inventory

| Component | Path | Stack | Role |
|---|---|---|---|
| **orchestrator** | `apps/orchestrator/` | Node + Express + Prisma | Central control plane / agent loop |
| **web-dashboard** | `apps/web-dashboard/` | Next.js 14 + React | Admin UI |
| **tools-core** | `packages/tools-core/` | TypeScript | Canonical LLM tool registry (≈78 tools) |
| **shared-types** | `packages/shared-types/` | TypeScript + Zod | Cross-package `Anchor` types |
| **fips-selftest** | `packages/fips-selftest/` | TypeScript | FIPS 140-3 boot self-test (Node services) |
| **mcp-server** | `services/mcp-server/` | TypeScript + MCP SDK | Tool dispatch (stdio + HTTP) |
| **ai-gateway** | `services/ai-gateway/` | Python + FastAPI | Inference router + gRPC embed/rerank |
| **routing** | `services/routing/` | Python + FastAPI | OpenWrt control via ubus |
| **switch** | `services/switch/` | Python + FastAPI | Managed-switch driver |
| **file-indexer** | `services/file-indexer/` | Python + watchdog | Filesystem indexer + embedder (RAG) |
| **email-indexer** | `services/email-indexer/` | Python + FastAPI | IMAP IDLE ingest + SMTP send |
| **camera-discovery** | `services/camera-discovery/` | Python + FastAPI | ONVIF/RTSP discovery → Frigate |
| **erp-sql-bridge** | `services/erp-sql-bridge/` | Python + FastAPI + pyodbc | Direct-SQL ERP bridge (SAP SQL Anywhere) |
| **voice-io** | `services/voice-io/` | Python + FastAPI | Wake → STT → agent → TTS |
| **oled-display** | `services/oled-display/` | Python + FastAPI | Front-panel TFT screen |
| **ops-console** | `services/ops-console/` | Python + FastAPI | Support "what's running" console |
| **rag-eval** | `services/rag-eval/` | Python + RAGAS | Offline retrieval-quality harness |
| **device-identity-svc** | `services/device-identity-svc/` | Python + gRPC | TPM 2.0 identity sidecar |
| **automount** | `services/automount/` | Bash + udev | USB/NVMe auto-mount → Nextcloud |
| **_shared** | `services/_shared/` | Python | FIPS self-test helper (Python services) |
| **openwrt** | `openwrt/` | Shell + OpenWrt ImageBuilder | Router firmware image + overlay |
| **docker** | `docker/` | Compose + nginx | Stack definition + reverse proxy |
| **scripts** | `scripts/` | Shell | Provisioning, reset, security/test gates |
| **proto / schemas** | `proto/`, `schemas/` | protobuf + JSON Schema | gRPC + anchor contracts |
| **clients/desktop** | `clients/desktop/` | — | Placeholder (Tauri planned, not started) |

---

## Ports & transports

Most services have **no host port** — they're reached internally over the Compose
network. Host-published ports and host-network services are called out.

| Component | Port | Transport | Exposure |
|---|---|---|---|
| gateway (nginx) | 80, 443 | HTTP/HTTPS | **host** — single entry point |
| orchestrator | 3000 | HTTP + WebSocket | internal (proxied at `/api/`) |
| web-dashboard | 3001 | HTTP | internal (proxied at `/`) |
| ai-gateway | 8000 | HTTP (REST/SSE) | internal (proxied at `/ai/`) |
| ai-gateway | 50051 | gRPC | internal — `EmbedText` / `Rerank` / `Chat` |
| mcp-server | 9090 (`MCP_PORT`) | streamable-HTTP | internal (+ stdio child of orchestrator) |
| routing | 8080 | HTTP | **host network mode** (direct router access) |
| switch | 8081 | HTTP | host (profile `full`) |
| oled-display | 8082 | HTTP | host network (display profile) |
| camera-discovery | 8085 | HTTP | internal (profile `full`) |
| erp-sql-bridge | 9095 | HTTP | internal only (profile `erp`) — holds the practice's DB credentials |
| voice-io | 8086 | HTTP | host (audio, profile `linux`) |
| ops-console | 8089→127.0.0.1:8087 | HTTP | loopback only (profile `ops`) |
| file-indexer | 8090 | HTTP (admin reindex) | internal |
| rag-eval | 8090 | HTTP (trigger) | internal (profile `eval`) |
| device-identity-svc | `unix:///var/run/droplet/device-identity.sock` | gRPC | unix socket |
| frigate | 5000 | HTTP/RTSP | NVR (profile `linux`/`full`) |
| db / cache / broker | 5432 / 6379 / 1883 | Postgres / Redis / MQTT | internal |

> Port numbers for the Python services come from their READMEs / compose env;
> if you change one, update both the service and this table.

---

# Apps

## apps/orchestrator

- **Purpose:** Central Node/Express/Prisma control plane. Exposes the `/api/*`
  REST surface for all clients, runs the LLM **agent loop** (dispatching tool
  calls through the MCP server), and coordinates every internal service
  (networking, cameras, Matter smart-home, VPN, files, email, reminders, PM).
- **Stack / entry point:** TypeScript 5.4, Express 4.19, Prisma 5.14. Boots from
  `src/index.ts` → `main()`: FIPS self-test → Prisma connect → init services
  (Redis, MQTT, Matter, OpenWrt, Frigate, MCP stdio child) → start cron-runtime
  → Express + WebSocket bridge → listen on `PORT` (3000). Build `tsc`; dev `tsx watch`.
- **Surface:** **51 route modules** under `src/routes/`, all mounted under `/api/*`
  (exception: `/_/fips` mounts **before** auth middleware).
  Highlights: `llm` (chat / agent loop), `auth`, `devices`/`device-clients`
  (pairing), `files`/`files-knowledge` (Nextcloud + RAG), `cameras`, `network*`,
  `switch`, `matter`/`scenes`, `vpn`, `calendar`, `reminders`, `email`, `pm*`
  (native project management — `/api/pm/*`, ADR-026, behind `authMiddleware`/`requireRole`),
  `activity` (signed audit log), `settings*`, `aps` (coverage-extender onboarding),
  `admin-*` (owner/admin-gated dashboards).
- **Data model:** `prisma/schema.prisma` — **55 models, 21 enums**, PostgreSQL
  (`DATABASE_URL`). Notable: `BrainMemoryItemStatus` / `ApDeviceStatus` are
  explicit status enums (the [no-guessing rule](#repo-wide-conventions)),
  `ActivityRow` is an HMAC-SHA256 hash-chained audit log, `DeviceClient` /
  `CalendarSource` hold AES-256-GCM-encrypted secrets.
- **Key internal services** (`src/services/`): `llm-agent.service.ts` (agent loop),
  `mcp-client*` (stdio MCP child lifecycle + registry), `matter.service.ts`
  (HTTP client for the matter-controller host sidecar, ADR-022), `encryption.service.ts` (AES-256-GCM),
  `cron-runtime.service.ts` (Postgres advisory-lock scheduler — **the** sanctioned
  scheduler), `openwrt.client.ts`, `switch.client.ts`, `camera.service.ts`,
  `nextcloud.client.ts`, plus pollers/tickers (device-reconcile,
  AP discovery, schedule, reminders, tool-schedule, screen-QR).
- **Talks to:** ai-gateway (gRPC + REST), mcp-server (stdio child), routing /
  switch / display / camera-discovery / frigate / nextcloud (HTTP), Redis,
  MQTT, device-identity-svc (gRPC unix socket). PM is served natively from the
  orchestrator's own Postgres (ADR-026) — no external PM service.
- **Auth:** Bearer JWT (HS256 access + refresh) with Nextcloud OCS fallback;
  roles `owner | admin | family | guest | service`; per-route RBAC via
  `requireRole` / `requireScope` (see [ADR-004](ADR-004-rbac-per-route-guards.md)).
  `WRITE_TOOLS` in `src/routes/llm.ts` is **derived from `requiresWrite`** in
  tools-core — don't maintain it by hand. Device pairing is QR-code-driven; the
  dashboard uses an HTTP-only `droplet_session` cookie.
- **Tests:** **125** Vitest `*.test.ts` files under `src/` (+ Supertest for HTTP).
- **Gotchas:**
  - **`MATTER_*` env vars are forbidden.** matter.js auto-imports every `MATTER_*`
    var and collisions throw `UnsupportedCastError`. Use `DROPLET_MATTER_*`.
    Only `MATTER_STORAGE_PATH` is allow-listed. (See `src/config.ts` comment.)
  - **All scheduling goes through `cron-runtime.service.ts`** with Postgres
    advisory locks (multi-instance-safe). No `while True`/`setInterval` schedulers.

## apps/web-dashboard

- **Purpose:** Next.js 14 (App Router) admin UI — chat, cameras, devices (Matter),
  files, knowledge/RAG, network, calendar, remote-access (VPN), settings, users,
  setup wizard, admin dashboards.
- **Stack / entry point:** Next.js 14.2, React 18, TypeScript, Tailwind, SWR,
  Framer Motion, Recharts, lucide-react. App Router under `src/app/`; root layout
  wires AuthProvider/Theme/Workspace/Toast. Public routes: `/login`, `/setup`,
  `/invite/[token]`.
- **Surface → backend:** Everything goes through `authFetch()` (`src/lib/auth.tsx`):
  `credentials: same-origin` to carry the `droplet_session` cookie; transparent
  one-shot refresh via `POST /api/auth/refresh` on 401; bounce to `/login` on
  failure. **No JWT in JS-accessible storage** (HTTP-only cookie; XSS-safe). In
  **dev**, `next.config.js` rewrites `/api/*`→orchestrator and `/ai/*`→ai-gateway;
  in **prod**, nginx does the routing.
- **Build/deploy:** Next.js **standalone** output (monorepo-aware
  `outputFileTracingRoot`); multi-stage Docker (`node:20`), served on 3001.
  Requires `@droplet/shared-types` at build — **cannot build standalone**.
- **Tests:** Vitest + React Testing Library (`src/__tests__/`, ~119 files).
- **Gotchas:** admin-page gating is **client-side only** (`useAuth().user.role`) —
  the backend is the real enforcement point. Dev rewrites don't exist in prod;
  prod *needs* the nginx reverse proxy. Tailwind-only styling (lint-enforced via
  `scripts/check-dashboard-classes.sh`).

---

# Packages (`packages/*` — workspace, consumed in-process)

## packages/tools-core (`@droplet/tools-core`)

- **Purpose:** The single canonical LLM tool registry. **≈78 tools** across
  network, files, smart-home (Matter), cameras, calendar, reminders, email,
  memory, and PM (project management) domains. The 9 `pm_*` tools keep their exact
  contract but now dispatch to the orchestrator's native `/api/pm/*` routes (ADR-026).
- **Exports:** `TOOLS: ReadonlyMap<string, Tool>`, `getTool(name)`, the `Tool`
  interface (`name`, `description`, `inputSchema`, `requiresWrite`,
  `requiresConfirmation`, `handler`), `ToolContext`, `ToolResult`, and
  confirmation helpers. Handlers live in `src/handlers/<domain>/` (**81 handler
  files**); the array is assembled in `src/registry.ts`.
- **Consumed by:** orchestrator (agent loop + `WRITE_TOOLS` derivation) and
  mcp-server (wraps each tool as an MCP tool).
- **Add a tool:** new file under `src/handlers/<domain>/`, import + add to
  `allTools` in `registry.ts`, set `requiresWrite`/`requiresConfirmation`, add the
  name to `__tests__/registry.test.ts` (lockstep inventory check), add a unit test.
- **Gotchas:** `requiresWrite` and `requiresConfirmation` are **orthogonal**.
  Schemas must use `additionalProperties: false`. `ToolContext._enhancement`
  (HyDE vectors / soft filters) is **stdio-only** — the HTTP transport drops it so
  an attacker can't smuggle precomputed vectors.

## packages/shared-types (`@droplet/shared-types`)

- **Purpose:** Cross-package `Anchor` types — the positional citation anchors for
  PDFs, media timestamps, email parts, and (recursive) archive members.
- **Gotcha:** `src/anchor.ts` is **generated** from `schemas/anchor.schema.json`
  via `npm run gen:anchor-schema`. Edit the JSON schema, then regenerate — don't
  hand-edit the `.ts`. Uses `z.union` (not `discriminatedUnion`) because some
  variants are refined/lazy.

## packages/fips-selftest

- **Purpose:** FIPS 140-3 boot self-test for Node services. `assertFipsAtBoot(svc)`
  confirms `crypto.getFips() === 1` and negative-confirms that MD5 fails; emits a
  structured JSON log line; fail-closed (`assertFipsAtBootOrExit` calls
  `process.exit(1)`). The Python equivalent is `services/_shared/fips_selftest.py`.

---

# Services (`services/*`)

## services/mcp-server (`@droplet/mcp-server`)

- **Purpose:** MCP server fronting `@droplet/tools-core`. Two transports:
  **stdio** (in-process child of orchestrator — trusted, no auth, all tools) and
  **streamable-HTTP** (external clients on `MCP_PORT` 9090 — JWT HS256 + per-tool
  RBAC).
- **RBAC:** stdio/owner/admin → all tools; family/guest/undefined-role-over-HTTP →
  read-only (`requiresWrite === false`). RBAC is **re-checked on `tools/call`**
  (not just `tools/list`). Matter tool calls **proxy back** to the orchestrator's
  `/api/matter/*` — the Matter fabric lives in the orchestrator.
- **Gotchas:** the `claims === undefined` "trusted" sentinel is **stdio-only** —
  HTTP always requires a valid JWT. gRPC/Redis/Prisma connect lazily so a missing
  dependency at boot doesn't kill the stdio child.

## services/ai-gateway

- **Purpose:** Provider router — **not** a tool dispatcher. FastAPI on 8000 for
  `/ai/chat` (+ models/sessions/health), gRPC on 50051 for `EmbedText` / `Rerank`
  / `Chat`. Cloud providers (OpenAI, Anthropic) go through **LiteLLM**; local
  Ollama goes through **direct httpx** to the OpenAI-compat endpoint.
- **Ollama call path (critical):** chat goes **direct to Ollama `:11434`**, *not*
  through `ollama-manager`'s `:8002/proxy` (whose 120 s read timeout blows up on
  CPU inference / cold loads). `OLLAMA_URL` with a trailing `/proxy` is the smoking
  gun for "manager timed out my agent loop." See the CLAUDE.md "Ollama call path"
  section.
- **gRPC consumers:** file-indexer (`EmbedText`), orchestrator/mcp-server
  (`Rerank`, `ClassifyQuery` for adaptive RAG routing).
- **Gotchas:** does **not** dispatch tools (forwards `tools[]` as-is, returns raw
  `tool_calls` to the orchestrator). Embed/rerank models lazy-load from HF on first
  call (cold start). Sessions are in-memory (lost on restart).

## services/routing

- **Purpose:** FastAPI wrapper over OpenWrt **ubus JSON-RPC** — interfaces,
  wireless, DHCP, firewall, VLANs, WireGuard, DDNS, coverage-extender APs. ~44–49
  endpoints. Runs in **host network mode** for direct router access.
- **`ROUTING_MODE`:** `real` (live OpenWrt, default) / `mock` (fixture `MockRouter`,
  no router needed) / `disabled` (orchestrator skips all router calls). See WARP-44.
- **Auth:** bearer `ROUTING_SERVICE_TOKEN` (constant-time compare) on all non-`/health`
  routes. Password loads from Docker secret file first, env var (deprecated) second.
- **Gotchas:** writes get an `X-Operation-Id` for dashboard rollback polling;
  safe-apply auto-rolls-back on connectivity loss; WireGuard keypairs are generated
  in pure Python because `file.exec` is denied in the rpcd ACL.

## services/switch

- **Purpose:** FastAPI managed-switch control behind an abstract `SwitchDriver`
  (`drivers/base.py`). `OpenWrtSwitchDriver` (Droplet-OpenWrt-imaged Zyxel GS1900, WARP-1674) is real; `ASICDriver`
  (future custom PCB) is a placeholder. `create_driver()` picks by `SWITCH_DRIVER`.
  Endpoints (ports, VLANs, PoE, WAN detect, one-click camera setup) are
  driver-agnostic. Bearer `SERVICE_SECRET`. Profile `full`.

## services/file-indexer

- **Purpose:** Filesystem watcher + embedder for RAG (formerly `file-sync`).
  Watches Nextcloud user-files + brain-memory volumes (watchdog/inotify), routes by
  MIME to extractors (PDF, DOCX, OCR, text/HTML, audio via faster-whisper), chunks
  (token-aware), embeds via **ai-gateway `EmbedText` gRPC**, writes `FileContentChunk`
  rows, and publishes MQTT (`droplet/index/...`) so the orchestrator drops caches.
- **Gotchas:** scheduling via **apscheduler** (the canonical no-`while True`
  example, WARP-218). Status is an explicit enum (`ready`/`failed`/`indexing`),
  never derived from nullability. Anchors are span-aware for PDF/audio/video/email
  (text/docx/image emit `Anchor(kind="none")`); pre-WARP-287 chunks have no anchor.

## services/email-indexer

- **Purpose:** IMAP **IDLE** ingest (one async loop per `EmailAccount`, exponential
  backoff) → posts canonical MIME to the orchestrator; drains the outbound SMTP
  queue (`EmailDraft.status='queued'`). All writes go through orchestrator REST
  (schema stays centralized), not direct DB writes. Account passwords are
  Fernet-encrypted at rest; only this service holds `EMAIL_KEY_PATH`. Real, not a stub.

## services/camera-discovery

- **Purpose:** ONVIF/RTSP camera auto-discovery → Frigate. Pulls DHCP leases from
  routing, sweeps the camera subnet (`CAMERA_SUBNET`, default `192.168.100.0/24`; `auto` resolves it from the edge router at scan time — WARP-1805)
  for RTSP, runs ONVIF WS-Discovery, probes credentials, optionally runs the vendor
  first-run init flow, registers confirmed cameras in Frigate, publishes discovery
  events to MQTT.
- **Gotchas:** fails closed if `DEVICE_SECRET` empty (`/drivers/fix` needs auth);
  subnet sweep is throttled (concurrency cap) to respect the inference host FD limit; RTSP
  URLs validated as RFC-1918 before reaching Frigate; `ONVIF_WS_DISCOVERY_ENABLED`
  defaults off (FD leak on Python 3.12+).

## services/erp-sql-bridge

- **Purpose:** the DB-touching half of the direct-SQL Eaglesoft ERP track —
  unixODBC + pyodbc against a dental practice's SAP SQL Anywhere
  (`PattersonPM`) database. Exists because there is no viable modern Node
  driver for SQL Anywhere, so the TypeScript orchestrator cannot open the
  connection itself.
- **Entry point:** `main.py` (FastAPI). `db.py` owns connection-string
  assembly, the pool, redaction, and row normalization.
- **Port:** 9095, `expose:` only — **never published off-box**. Profile `erp`,
  off by default.
- **Talks to:** the practice's SQL Anywhere server (ODBC, default :2638).
  Called only by the orchestrator, via
  `@droplet/erp-connector`'s `SqlBridgeClient`.
- **Gotchas:**
  - **It never builds SQL.** Statements arrive already built by the canonical
    registries in `@droplet/erp-connector`, with identifiers resolved through
    the introspected schema map and values bound as `?`. Re-deriving them here
    would be a second source of truth for what runs against a practice's
    database.
  - **Credentials never cross the wire.** `droplet_ro` / `droplet_rw` come from
    this container's environment and are picked by ROUTE (`/read/*` vs
    `/write/*`). The request models have no username/password field at all.
  - **The real boundary is the database grant**, not this process —
    `droplet_ro` holds SELECT and nothing else. The route guards are
    belt-and-braces on top.
  - **The SAP client is not in the image.** It is license-gated and
    operator-supplied (`vendor/README.md`); without it the track stays honestly
    blocked (`ERP_NOT_CONNECTED`). SAP ships **no aarch64 Linux client** — on
    ARM, use the `eaglesoft-api` REST track instead.
  - `rowCount: 0` from `/write/*` is the optimistic-concurrency guard missing,
    **not** an error. The caller decides.
- **Tests:** `pytest` for the pure half; `scripts/test-erp-sql-bridge.sh` boots
  a real Postgres (psqlODBC standing in for the license-gated SAP driver) and
  runs the live half plus the TypeScript connector on top.

---

## services/voice-io

- **Purpose:** Always-on voice loop: wake word (openWakeWord ONNX, "hey jarvis") →
  STT (wyoming-faster-whisper over TCP) → orchestrator `/api/llm/chat` → TTS
  (wyoming-piper). Auto-picks ALSA input/output by scoring USB/named devices.
- **Hardware/profile:** needs `/dev/snd` (ALSA), runs under profile `linux`. Mock
  modes (`__mock__`) for STT/TTS/wake let it run on dev boxes.
- **Gotchas:** openWakeWord pulls in scikit-learn unconditionally; blocking
  startup probes are offloaded to a worker thread so `/health` stays responsive.

## services/oled-display

- **Purpose:** Front-panel TFT (Adafruit PyPortal Titano over USB-serial). REST API
  for home/stats/logo/message/custom screens, touch regions, Wi-Fi QR. Renders to a
  PNG **sim backend** when no `/dev/ttyACM*` is present (auto-promotes on hot-plug).
  Profile `display`. Bearer `SERVICE_SECRET` required at boot.
- **Gotcha:** directory keeps the legacy name `oled-display` for orchestrator-client
  compatibility even though the backend is now a PyPortal TFT.

## services/ops-console

- **Purpose:** Support-only "what's running" console (the **Apps Board** of
  ADR-009). FastAPI bound to **loopback** (operator reaches it via SSH tunnel).
  Bearer `OPS_TOKEN`; mounts `/var/run/docker.sock` (scoped by compose project
  label); audit-logs every `/ops/*` call to a named volume. Profile `ops`,
  **not** customer-facing. `/healthz` is the only unauthenticated route.

> **Project management is native (ADR-026).** There is no `services/pm` sidecar
> and no embedded Plane stack. PM is served by the orchestrator's own `/api/pm/*`
> routes against `Pm*` Prisma models in the main Postgres, rendered natively in the
> dashboard `/projects` surface. See [ADR-026](ADR-026-native-pm-supersedes-plane.md).

## services/rag-eval

- **Purpose:** Scheduled RAGAS retrieval-quality harness. Service mode (apscheduler
  cron + HTTP trigger), `run-once`, and `bootstrap --runs N`. Calls the
  orchestrator's `/api/admin/retrieval-eval/search` per query; judges with local
  Ollama or cloud OpenAI; writes results under `/data/rag-eval/runs/`. Profile
  `eval`; orchestrator proxies via `RAG_EVAL_URL` (admin route 503s when inactive).
  No auth on the service itself (gate is on the orchestrator side).

## services/device-identity-svc

- **Purpose:** TPM 2.0 device-identity sidecar. gRPC over a **unix socket**
  (`/var/run/droplet/device-identity.sock`). `Sign` / `GetCert` / `GetStatus` /
  `Reseal`. `RealBackend` (tpm2-pytss + `/dev/tpm0`, appliance prod) vs `MockBackend`
  (pure-Python, dev/CI) — indistinguishable at the gRPC boundary. Reseal requires a
  short-lived nonce the orchestrator issues only after MFA re-auth.

## services/automount

- **Purpose:** udev-triggered bash service: on USB/NVMe insert, mount under
  `/mnt/droplet/...` and (opt-in `NEXTCLOUD_AUTO_REGISTER=1`, set by provisioning
  in the root-owned `/etc/droplet/automount.env` — WARP-1338) register the drive in
  Nextcloud via `occ`. Registration is trust-gated: enrolled/trusted drives and
  md-pool mounts only, never untrusted hot-plugged sticks. A boot-time oneshot
  (`droplet-automount-reconcile.service`) registers already-mounted paths.
  Guards against boot/root/loop/small devices. Hermetic tests live in
  `services/oled-display/tests/test_automount_script.py` +
  `test_automount_env_wiring.py`.

## services/_shared

- **Purpose:** Python FIPS boot self-test helper (`fips_selftest.py`), copied into
  each Python service image at build (no internal PyPI). Imported and called via
  `assert_fips_at_boot_or_exit("<service>")` before any crypto. Gated by
  `DROPLET_FIPS_REQUIRED`.

---

# Infrastructure & tooling

## openwrt/

- **Purpose:** OpenWrt 24.10 — on single-box (the shipping shape) the AP runs in a
  container built from `singlebox-image/Dockerfile` (`droplet/openwrt-singlebox`
  image), which bakes the AP/router packages + the canonical rpcd ACL. The UCI
  config overlay under `files/` documents the network/firewall/camera-VLAN model
  and remains the source of truth for the rpcd ACL. The legacy multi-box bare-metal
  router SD-card image builder (`openwrt/build.sh`) has been retired (ADR-011).
- **Overlay:** `files/etc/config/*` (network/wireless/firewall/dhcp/uhttpd/rpcd/
  system), `files/usr/share/rpcd/acl.d/droplet-ai.json` (ubus ACL, denies
  `file.exec`), `files/etc/uci-defaults/99-droplet-setup` (first-boot secrets +
  board tweaks). Camera VLAN 100 is pre-provisioned. Note: the single-box
  container does NOT consume `files/etc/config/*` — its `/etc/config` is a runtime
  named volume; it only bakes the rpcd ACL + uhttpd limits.
- **Target:** generic hardware-agnostic OpenWrt build (see
  [ADR-011](ADR-011-hardware-agnostic-codebase.md)). On single-box the host's Wi-Fi
  radio is moved into the container's netns and hostapd serves the AP. The legacy
  bare-metal router reference used a MediaTek MT7922 Wi-Fi module + USB NIC.

## docker/

- **Compose:** `docker-compose.yml` (base, 25 services across all profiles) + `docker-compose.dev.yml`
  (local overrides) + `docker-compose.test.override.yml` (exposes orchestrator,
  disables auth, polling watcher for tests).
- **Profiles:** `linux` (Frigate + voice-io + camera/audio), `display` (oled),
  `full` (switch + camera-discovery), `eval` (rag-eval), `ops` (ops-console),
  `single-box` (ollama + openwrt). On Linux, `setup.sh` sets
  `COMPOSE_PROFILES=linux,display`; macOS leaves it empty so GPU/audio mounts
  never trip. (PM is native to the orchestrator — no `pm` profile; ADR-026.)
- **Gateway routing** (`nginx.conf`): `/api/ws/`→orchestrator (WebSocket),
  `/api/`→orchestrator, `/ai/`→ai-gateway, `/nextcloud/`→nextcloud,
  `/`→web-dashboard. Per-request DNS resolution (127.0.0.11) so container IP
  changes don't strand the proxy.
- **Gotcha:** `docker restart` does **not** re-read `env_file`. After editing
  `.env`, recreate: `docker compose -f docker/docker-compose.yml --env-file .env
  up -d --force-recreate <service>`.

## scripts/

- `setup.sh` — idempotent multi-phase provisioning (preflight, Docker, camera
  drivers, **per-device secret generation**, build, start, verify). Flags:
  `--skip-*`, `--systemd`, `--regenerate-env`, `--sync-secrets`.
- `factory-reset.sh` — wipe volumes/secrets/.env; `--reinstall` re-runs setup,
  `--purge-images` also drops built images.
- `verify.sh` — running-state smoke tests.
- `test-security.sh` — static security gate (no secret defaults, env coverage,
  `--env-file` usage, raw camera RTSP passwords, `MATTER_*` allowlist, `.env` 0600).
- `test/ship-check.sh` — PR gate (tsc, compose-config, frigate-env, shellcheck,
  exec-bits, stale-repo-names; `--full` adds an Ubuntu container smoke build).
- `test-rag.sh` / `test-fips.sh` — RAG integration + FIPS validation.
- `generate-grpc.sh` (proto codegen), `generate-audit.sh` (→ `technical-audit.md`),
  `provision-device-identity.sh`, `check-dashboard-classes.sh`.

## tests/

- `tests/docker-compose.test.yml` spins up ephemeral infra (Postgres on tmpfs,
  Redis, MQTT, ai-gateway, orchestrator, integration-tests runner). Run:
  `docker compose -f tests/docker-compose.test.yml up --build --abort-on-container-exit`,
  or `scripts/test-rag.sh` for the layered RAG suite. Covers auth, REST/SSE,
  orchestrator→ai-gateway chat, file ingest + RAG search, migrations, MCP handshake,
  device-identity modes, factory-reset cycle.

## proto/ & schemas/

- `proto/inference.proto` — ai-gateway gRPC: `Chat`/`StreamChat`/`ListModels`/
  `EmbedText`/`Rerank`/`ClassifyQuery`. `proto/device_identity.proto` — TPM sidecar:
  `Sign`/`GetCert`/`GetStatus`/`Reseal`. Codegen via `scripts/generate-grpc.sh`.
- `schemas/anchor.schema.json` — JSON Schema 2020-12 for the `Anchor` union; the
  source of truth for `packages/shared-types/src/anchor.ts` (regenerate, don't
  hand-edit the `.ts`).

## clients/desktop

- **Placeholder only** — no code committed. Per ADR-009 the desktop targets are a
  Tauri Windows `.exe` and macOS via Mac Catalyst on the iOS repo; neither lives
  here yet.

---

## Repo-wide conventions

These cut across every component (full text in [`CLAUDE.md`](../CLAUDE.md)):

1. **No `while True` schedulers.** Python → `apscheduler`; orchestrator →
   `cron-runtime.service.ts`. Event-driven/streaming loops are exempt.
2. **No guessing state.** Persistent status is an explicit enum column
   (`BrainMemoryItemStatus`, `ApDeviceStatus`, `FileContentChunk.status`), never
   derived from `NULL`/absence. Query `WHERE status = 'failed'`, not `indexedAt IS NULL`.
3. **`MATTER_*` env vars are forbidden** (matter.js collision) — use `DROPLET_MATTER_*`.
4. **FIPS 140-3 boot self-test** in every long-lived service (Node:
   `@droplet/fips-selftest`; Python: `services/_shared/fips_selftest.py`), gated by
   `DROPLET_FIPS_REQUIRED`, fail-closed.
5. **Secrets are per-device, generated by `setup.sh`** — never baked into tracked
   files. `test-security.sh` enforces this and `.env` mode `0600`.
6. **`docker restart` ≠ env reload** — recreate services with `--force-recreate`
   after editing `.env`.
7. **Tools are defined once** in `@droplet/tools-core`; RBAC (`WRITE_TOOLS`) is
   derived from `requiresWrite`. Don't fork the tool list.
8. **No public TLS endpoint / no API gateway service** (ADR-009). Off-LAN access is
   WireGuard-only; nginx `gateway` is the only host entry point.

## Related docs

- [ADR-009 — Canonical System Architecture](ADR-009-canonical-system-architecture.md) — the system shape you must not violate.
- [ADR-004 — RBAC per-route guards](ADR-004-rbac-per-route-guards.md), [ADR-010 — PM stack](ADR-010-pm-stack-selection.md), [ADR-011 — hardware-agnostic](ADR-011-hardware-agnostic-codebase.md).
- [agentic-workflows.md](agentic-workflows.md) — cross-repo agent picture.
- [LLM_AGENT.md](LLM_AGENT.md), [RAG_RETRIEVAL.md](RAG_RETRIEVAL.md), [llm-safety-tiers.md](llm-safety-tiers.md).
- [ROADMAP.md](ROADMAP.md) / [STATUS.md](STATUS.md) — milestone + capability status.
- `technical-audit.md` (generated) — quantitative snapshot; re-run `scripts/generate-audit.sh`.
