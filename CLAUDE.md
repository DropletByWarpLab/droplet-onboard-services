# droplet-onboard-services

> ## 🪨 The Foundation (read first)
> Droplet's founding thesis: **security and an air-gapped mentality first — without being literally air-gapped — made accessible to real customers.** The local AI **sees and manages** the network but is **never exposed** to it; everything crossing the boundary is **screened both ways** (ingress threat, egress exfiltration), default-deny, audited; the VPN runs on a separate network. The hardware is **two physically separate subsystems** — a trusted **Vault** (dual-socket off-the-shelf CPUs + up to 4 off-the-shelf PCIe GPUs/NPUs + all data + the LAN) and an untrusted **WAN/Edge** little computer (its own less-powerful CPU, storage, containers, WAN network); they share no CPU, drive, container host, or network. **Own the structure, buy the silicon** (off-the-shelf socketed CPUs/DIMMs/GPUs/drives on a custom carrier), leased on a 2-year cycle, in **two SKUs** (Full Rack + Mini Rack). When a design disagrees with the foundation, the design is wrong. Canonical: `shared_brain/FOUNDATION.md` + `droplet-hardware/docs/FOUNDATION.md`.

Behavioral guidelines to reduce common LLM coding mistakes. They bias
toward caution over speed — for trivial tasks, use judgment.

**1. Think before coding** — don't assume, don't hide confusion,
surface tradeoffs. State assumptions explicitly; if uncertain, ask. If
multiple interpretations exist, present them — don't pick silently. If
a simpler approach exists, say so; push back when warranted. If
something is unclear, stop, name what's confusing, and ask.

**2. Simplicity first** — minimum code that solves the problem,
nothing speculative. No features beyond what was asked, no abstractions
for single-use code, no unrequested "flexibility"/"configurability", no
error handling for impossible scenarios. If you write 200 lines and it
could be 50, rewrite. Ask: "Would a senior engineer call this
overcomplicated?"

**3. Surgical changes** — touch only what you must; clean up only your
own mess. Don't "improve" adjacent code, comments, or formatting; don't
refactor what isn't broken; match existing style. Remove
imports/variables/functions YOUR changes made unused; mention (don't
delete) pre-existing dead code. Every changed line traces to the request.

**4. Communication style** — technical, direct, terse. No pleasantries,
no filler, no hedging, no summaries longer than the finding warrants.
Applies to processing (thinking, plans, commit/PR prose) and responses.

**5. Goal-driven execution** — define success criteria, loop until
verified. Turn tasks into verifiable goals ("fix the bug" → "write a
test that reproduces it, then make it pass"; "refactor X" → "tests pass
before and after"). For multi-step tasks, state a brief plan with a
verify check per step — strong criteria let you loop independently.

> **Architecture note:** This repo is the **intelligence layer** (orchestrator, agent loop, MCP server, AI gateway). Inference (Ollama) lives in the sibling repo [`droplet-local-LLM`](../droplet-local-LLM). Both repos deploy side-by-side on the same inference host. See [`docs/agentic-workflows.md`](docs/agentic-workflows.md) for the full picture.

Control-plane monorepo for the Droplet edge AI appliance. This monorepo contains the orchestrator API, web dashboard, AI gateway proxy, file indexer service, and all supporting Docker infrastructure.

> **New to this repo / an agent?** Read [`docs/COMPONENTS.md`](docs/COMPONENTS.md) first — an agent-usable fact sheet for every component (purpose, entry point, ports, what it talks to, and gotchas), plus the system map and repo-wide conventions.

## Monorepo structure

```
apps/orchestrator/      Express + Prisma — central API and device control
apps/web-dashboard/     Next.js 14 — admin UI
packages/tools-core/    @droplet/tools-core — single canonical LLM tool registry (TypeScript)
services/mcp-server/    @droplet/mcp-server — MCP server (stdio + streamable-HTTP)
services/ai-gateway/    FastAPI provider router — LiteLLM for cloud (OpenAI, Anthropic), direct httpx for local Ollama (no tool dispatch)
services/routing/       FastAPI — OpenWrt router control via ubus JSON-RPC
services/file-indexer/  Python watchdog — filesystem indexer + embedder (formerly `file-sync`)
services/camera-discovery/ Python FastAPI — ONVIF/RTSP camera auto-discovery
services/switch/        FastAPI — Managed switch control (pluggable driver: managed-switch / future ASIC)
openwrt/                OpenWrt image builder + config overlay for the router host
docker/                 Nginx, PostgreSQL 16, Redis 7, MQTT, Nextcloud 29, Frigate NVR
```

## Tech stack

- **Orchestrator:** Node.js, Express, Prisma ORM, PostgreSQL
- **Web dashboard:** Next.js 14, React
- **Tools-core:** TypeScript, JSON-Schema; canonical registry consumed by orchestrator + mcp-server
- **MCP server:** TypeScript, `@modelcontextprotocol/sdk`; stdio (in-process child) + streamable-HTTP (external clients)
- **AI gateway:** Python, FastAPI. Multi-provider router with **mixed transports**: LiteLLM (`litellm.acompletion`) for cloud providers — `services/ai-gateway/providers/openai_cloud.py`, `anthropic_cloud.py` — and a custom httpx-based provider for local Ollama (`providers/ollama_local.py`) hitting the OpenAI-compat `/v1/chat/completions` endpoint. Also exposes a gRPC `EmbedText` service on port 50051 (used by `services/file-indexer/`). Provider router only — does NOT dispatch tools (orchestrator owns that via MCP).
- **Routing service:** Python, FastAPI, OpenWrt ubus JSON-RPC SDK
- **File indexer:** Python, watchdog (was `file-sync`; renamed to reflect its indexer+embedder role)
- **Camera discovery:** Python, FastAPI, ONVIF, WS-Discovery
- **Switch service:** Python, FastAPI, abstract driver interface (managed-switch driver / future ASIC)
- **NVR:** Frigate (open-source), TensorRT GPU detection, RTSP
- **Infra:** Docker Compose, Nginx, Redis, MQTT (Mosquitto), Nextcloud, Frigate
- **Smart home:** Native Matter controller in the `matter-controller` host-network sidecar (`services/matter-controller/` — raw HCI for BLE commissioning + LAN mDNS, see ADR-022/WARP-850). The orchestrator fronts it (`matter.service.ts` is the HTTP client) and the dashboard talks to `/api/matter/*` as before.

## Coding standards

- **No `while True` loops for scheduling.** Use a proper scheduler instead:
  - **Python services:** `apscheduler` (`AsyncIOScheduler` for asyncio services,
    `BackgroundScheduler` otherwise). Pinned to `apscheduler` in each service's
    `requirements.txt`. The first canonical usage lands in WARP-218
    (`services/file-indexer`); copy that pattern.
  - **TypeScript orchestrator:** `apps/orchestrator/src/services/cron-runtime.service.ts`
    via `createCronRuntime(...).scheduleCron(...)` or `.scheduleInterval(...)`.
    Already used by reminders-poller, schedule ticker, and the daily 03:00 purge.
  - Existing `while True` violations are tracked in WARP-221 (camera-discovery's
    ONVIF scan, switch driver's keepalive). Add new ones to that ticket if you
    spot more — don't introduce them.
  - Legitimate `while True` patterns DO exist and are NOT covered by this rule:
    event-driven dispatch loops (`await event.wait()`), bounded chunk-streaming
    reads, and microcontroller event loops on different runtimes (CircuitPython).
    The rule is about *scheduling* — fire X every N seconds / at time Y — not
    about every loop in the codebase.
- **No guessing, ever.** Persistent state lives in explicit columns, not
  in the absence of other columns. Declare `status: SomeEnum`; don't
  derive it from `indexedAt IS NULL`-style absence patterns. "All failed
  transcripts" should be `WHERE status = 'failed'` — direct, indexable,
  no compound predicates over nullable fields. Adding a canonical column
  is cheaper than every reader remembering the derivation rule.
  WARP-218's `BrainMemoryItemStatus` enum is the pattern to copy.

## CI cost budget (hard constraint)

GitHub Actions has a **$100/month org spending limit** (~66k runner-min;
practical target: the 50k included minutes). CI was redesigned to fit it
on 2026-07-21 (PR #1204) after burning ~118k min/month — when the limit
is hit, **all Actions runs block org-wide and nothing merges**. Full
rationale, measured costs, and the cost-estimation formula:
[`docs/ci-cost-budget.md`](docs/ci-cost-budget.md). Non-negotiables:

- PR-time test coverage lives in **ci.yml's path-aware legs** (`detect`
  job → dynamic matrices; `ci-summary` is the required check and fails
  closed). A required check must come from an **unfiltered** workflow —
  a path-filtered one is absent on out-of-scope PRs and hangs them on
  "Expected" forever. Inventory + the rule:
  [`docs/ci-required-checks.md`](docs/ci-required-checks.md). Don't re-add `pull_request:` triggers to the per-service
  `*-tests.yml` workflows — they run on push-to-main only, as the
  post-merge canary. New service ⇒ new ci.yml leg (detect filter +
  matrix entry) + a push-only `<name>-tests.yml`.
- No unfiltered `pull_request:` trigger on anything heavier than ~1 min;
  widening `paths:` on docker-build / setup-e2e / test-fips is a spend
  decision — estimate min/month first (formula in the doc) and state it
  in the PR. >2k min/mo needs a callout; >5k needs Romain's sign-off.
- `publish-release.yml` stays `workflow_dispatch`-only. The cosign key
  ceremony has run (2026-07-30), so runs can now succeed — which makes
  the dispatch-only trigger a *cost* control, not a fail-closed one. A
  full publish is ~2 runner-hours; don't automate it back onto every
  merge without redoing the budget math.

## Branching and releases (read before opening a PR)

**One long-lived branch: `main`.** Open every PR against it.

The two-branch `feature -> stage -> main` flow that WARP-1670 built is
retired. `stage` was deleted deliberately (WARP-2187) and the
`branch-flow-guard` workflow that enforced it is gone. If you find a doc,
config or comment still telling you to target `stage`, it is stale --
`stage` cannot be created casually, because a ruleset and the OTA channel
machinery below still reference it.

**What was lost with it:** stage bought a soak -- a subset of real boxes ran
a build before the whole fleet did. Nothing replaces that today, so a merge
to `main` reaches every box on the stable channel once a release is
published. Treat "is this releasable?" as a question you answer at review
time, not one the branch structure answers for you. A real replacement is a
canary-fleet or release-tagging mechanism, not a branch.

`main` publishes the `stable` OTA channel. A box subscribes to exactly one
channel (`update-agent.settings.channel` on the orchestrator,
`DROPLET_UPDATE_CHANNEL` for fleet-agent). Consequences worth knowing before
you touch any of this:

- The channel is **derived from the dispatch ref** in
  `publish-release.yml`, never passed in.
- Stable releases publish with `--latest`. `/releases/latest` skips
  prereleases, and that endpoint is what stable boxes poll.
- A release's tag (`ota-<channel>-...`) is only a discovery *hint*. The
  channel that decides anything is the one inside the cosign-signed
  manifest. Never move a trust decision onto the tag.
- Adding a channel is a four-file change, all of which must agree:
  `ALLOWED_CHANNELS` (`scripts/release/gen-release-manifest.py`),
  `RELEASE_CHANNELS` (`update-agent/settings.ts`), the discovery rule in
  both pollers, and the cosign identity alternation in
  `scripts/lib/apply-update.sh` -- an enumerated `(main|stage)` on purpose.
  Never widen it to a wildcard.
- **`stage` is still enumerated in that alternation and still mapped in
  `publish-release.yml`.** Those paths are now unreachable rather than
  wrong. Whether the stage *channel* retires with the stage *branch* is an
  open decision on WARP-2187 -- until it is made, do not prune them
  piecemeal, and do not point a box at the `stage` channel: it has no
  releases.

History and original rationale: WARP-1670; retirement: WARP-2187;
device-side trust model: `docs/SECURITY.md`.

## LLM tool calling

- All LLM-callable tools live in `@droplet/tools-core` (single canonical
  registry). The orchestrator's `llm-agent.service.ts` runs the agent
  loop and dispatches tool calls via `@droplet/mcp-server` (MCP, stdio
  child process). External MCP clients (inference-engine, Claude
  Desktop, etc.) reach the same server over streamable HTTP with JWT
  auth and per-tool RBAC. `services/ai-gateway/` is a thin provider
  router; it does NOT dispatch tools.
- The dashboard's `/chat` page hits `POST /api/llm/chat`, which drives
  the orchestrator's MCP-backed agent loop. `GET /api/llm/tools` proxies
  `mcp-client.service.ts → listTools()` so the wire shape matches what
  off-host MCP clients see.
- **Adding a new tool:** use the **`add-llm-tool`** skill (handler →
  registry entry with `requiresWrite`/`requiresConfirmation` → unit
  test; MCP server and RBAC pick it up automatically).

## Ollama call path (chat vs lifecycle)

> Heading kept verbatim on purpose: it is a named anchor cited from five
> places, two of them live source comments (`scripts/lib/secrets.sh`,
> `services/voice-io/voice/llm.py`). Renaming it dangles those references.
>
> **Read `INFERENCE_RUNTIME` before anything below applies (WARP-1870).** A box
> provisioned after 2026-08-11 defaults to the **Docker Model Runner** on
> `:12434` — no `ollama-manager`, no `:8002`, no `/proxy`, nothing on `:11434`,
> and the whole proxy-timeout class below simply does not exist. The section
> below describes the Ollama shape, still selectable with
> `INFERENCE_RUNTIME=ollama ./scripts/setup.sh`.
>
> `OLLAMA_URL`, `RAGAS_OLLAMA_URL` and `OLLAMA_CHAT_PATH` are **how DMR is
> consumed too** — the names are historical. Never infer the runtime from a
> variable's name; read its value. A DMR-shaped URL with a non-dmr runtime
> means the variable was lost, every model silently reports `tools=false`, and
> `docker restart` will not fix it — only `--force-recreate` re-reads env.
> Full debugging both ways: the `debug-ollama-call-path` skill.

The inference host runs **Ollama** (`:11434`, inference) and
**ollama-manager** (`:8002`, lifecycle + opt-in observability sidecar).
They are NOT interchangeable:

- **Chat goes direct to Ollama** (`OLLAMA_URL=http://...:11434`) via
  ai-gateway's `OllamaLocalProvider` → OpenAI-compat
  `/v1/chat/completions`. Never route chat through the manager's
  `/proxy` by default: its 120 s read budget times out agent loops on
  CPU inference and cold loads (502 from manager, 500 from orchestrator).
- **ollama-manager owns model lifecycle** (`/models/*`, `/health`,
  `/metrics`) — called directly by setup/observability tooling, NOT
  exposed through ai-gateway. Its `/proxy` chat endpoint is **opt-in
  observability** (tool-call counter, JSON repair, circuit breaker) for
  warm-model production use only.

Debugging "AI not reachable" / chat 502s? Use the
**`debug-ollama-call-path`** skill (smoking-gun checklist).

## Device setup

Run `./scripts/setup.sh` to provision a fresh device. Generates unique per-device secrets, installs Docker, builds and starts the full stack. Idempotent — safe to re-run. See `scripts/README.md` for flags and troubleshooting.

## Commands

```bash
# Full stack via Docker
npm run dev:docker

# Local orchestrator dev
cd apps/orchestrator && npm run dev

# Tests
npm test                    # all tests
npm run test:orchestrator   # orchestrator only
npm run test:ai-gateway     # ai-gateway only

# Factory reset (wipe all data, return to out-of-the-box state)
./scripts/factory-reset.sh

# Factory reset + re-provision in one step
./scripts/factory-reset.sh --reinstall
```

## Docker stack

30 compose services (13 default-on, the rest profile-gated) behind
nginx (dashboard at `/`, orchestrator at `/api/`, ai-gateway at `/ai/`,
Nextcloud at `/nextcloud/`). Full service/port/profile table +
.env-update procedure: the **`docker-stack`** skill. Two
always-relevant gotchas:

- `COMPOSE_PROFILES` is written by `setup.sh`: `linux,display` on Linux
  (Frigate, voice pipeline, oled-display), empty on macOS (GPU/audio
  mounts never trip) — and on the shipping **single-box** shape it
  auto-merges `single-box`, which makes ollama, openwrt, switch, and
  camera-discovery default-on. On other shapes, switch/camera-discovery
  stay opt-in via `full` (real hardware + operator credentials). The
  `docs` profile (`docserver` document engine, in-browser viewing/editing,
  WARP-882/WARP-1686) is **default-on** on the 32 GB box (~2 GB additive);
  a ≤8 GB box drops `docs` AND sets `DOCS_ENABLED=0`. The engine is
  selectable via `DOCS_ENGINE` — Collabora CODE by default (LibreOffice,
  no licensing fee, ADR-034), OnlyOffice retained for an OEM-licensed SKU.
- `docker restart` does **not** re-read the env_file — after editing
  `.env` (including `*_MEM_LIMIT` resource limits, ADR-021), recreate:
  `docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate <service>`.

## Environment variables

Full per-variable reference (defaults, ports, resource limits):
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md). Safety-critical rules:

> ⚠ **Never add new `MATTER_*` env vars.** matter.js scans `process.env` at startup and auto-imports every `MATTER_*` variable into its internal `VariableService`, dot-namespacing each one. Collisions with root-node behavior ids throw `UnsupportedCastError: Property "X" is unsupported` and break controller init. Use a `DROPLET_MATTER_*` prefix for our own env vars instead. `MATTER_STORAGE_PATH` is the only surviving `MATTER_*` name and is allow-listed by `scripts/test-security.sh`. Full rationale: [`apps/orchestrator/src/config.ts`](apps/orchestrator/src/config.ts) — the block comment above the `Matter` schema section.

- `CORS_ALLOWED_ORIGINS` is exact-match (no normalization — a trailing
  slash or case mismatch silently never matches); `*` is rejected at
  startup. Supply scheme+host(+port) only.
- `RATE_LIMIT_TRUSTED_PROXIES` (ai-gateway) defaults empty → trust no
  forwarded client-IP headers (safe). Set to the nginx edge subnet to
  restore per-client rate buckets through the proxy.
- `FILES_API_URL` is the MCP file-tools target (default
  `http://orchestrator:3000/api/files`). Raw Nextcloud cannot serve
  these tools — see WARP-861.
- `DOCS_ENABLED` is an EXPLICIT boolean (never derived from
  `DOCS_INTERNAL_URL` emptiness); `DOCS_ENGINE` selects the engine
  (`collabora` default / `onlyoffice`) and `DOCS_ENGINE_IMAGE` +
  `DOCS_INTERNAL_URL` must track it (single-box.sh writes the trio
  together). `ONLYOFFICE_JWT_SECRET` stays required under BOTH engines —
  the orchestrator signs editor-session tokens with it (per-device, never
  tracked). **License (ADR-034):** default engine Collabora CODE has NO
  licensing fee (MPLv2 core); OnlyOffice CE (AGPLv3) needs an OnlyOffice
  OEM/commercial license before GA and is kept only as the
  `DOCS_ENGINE=onlyoffice` option (WARP-882/WARP-1686). Full row set:
  `docs/ENVIRONMENT.md`.
- `DROPLET_FIPS_MODE` is the SINGLE FIPS 140-3 knob (per-customer,
  default OFF; flipped only via `setup.sh --fips` / `--no-fips`, which
  derives `OPENSSL_CONF` / `DROPLET_FIPS_REQUIRED` / `NODE_OPTIONS` —
  never hand-edit those; `OPENSSL_MODULES` is actively removed, WARP-1063). Only the six provider-carrying
  images (orchestrator, web-dashboard, mcp-server, ai-gateway,
  file-indexer, gateway) enforce; the others are pinned out in compose.
  Operator/auditor guide incl. verification commands and the "library
  has no ciphers" failure mode: [`docs/fips.md`](docs/fips.md).

## GTM alignment

The April 2026 GTM strategy doc (`droplet-gtm-strategy.docx`) assesses
a reference architecture that has drifted from this repo — use
`docs/gtm-mapping.md` to translate its paths (most frequent: GTM's
`services/assistant-api/` = `apps/orchestrator/` +
`services/ai-gateway/`; tool-calling lives in `inference-engine`).
Phase status (PH1–PH5) and milestone breakdowns: the **`gtm-alignment`**
skill, plus `docs/ROADMAP.md` / `docs/STATUS.md`.

When starting new work, read `docs/ROADMAP.md` first — it says whether
the task is already scoped to a milestone and whether cross-repo
dependencies block it. Response streaming landed in-repo (WARP-1442) —
it is NOT a cross-repo dependency. The real siblings are
`droplet-local-LLM` (inference + tool sandboxing) and the native
`droplet-ios` / `droplet-android` clients; the API contract they consume
lives in `packages/shared-types` + `docs/mobile-api-contract.md` (there
is no `shared-api` or `mobile-app` repo).
