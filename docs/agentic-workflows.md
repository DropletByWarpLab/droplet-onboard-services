# Agentic Workflows on Droplet — Where Each Component Lives

> **This file is mirrored at `droplet-local-LLM/docs/agentic-workflows.md`.** Keep both copies in sync. Each repo's copy is full content (not a stub) so each repo is readable in isolation.

## TL;DR for future agents and developers

- **`droplet-onboard-services`** (this repo) — runs **intelligence**. The orchestrator's ReAct agent loop, the MCP server with the tool registry, the AI gateway that proxies model requests to Ollama.
- **`droplet-local-LLM`** (sibling repo) — runs **inference**. Ollama + a small Python sidecar that does manifest pulls and exposes `/models/eligible`. **No agent runtime there.**
- The two repos are deployed side-by-side on the same inference host (single device).

If you're looking for "where is Ollama" or "how do I add a new model" — **the answer is the other repo, not this one**. There is intentionally zero inference-server code in `droplet-onboard-services`.

## Architecture

```
              ┌──────────────────── single inference host ──────────────────┐
              │                                                            │
              │   droplet-onboard-services (orchestrator)                       │
              │   ─ apps/orchestrator/      ReAct agent loop, owns chat    │
              │   ─ services/mcp-server/    stdio child, ~50 tools         │
              │   ─ services/ai-gateway/    pure model proxy: routing      │
              │             │                                              │
              │             │  chat: OpenAI-compat, DIRECT to Ollama        │
              │             │  (/v1/chat/completions, /api/chat, etc.)     │
              │             ▼                                              │
              │   http://host.docker.internal:11434   (OLLAMA_URL, chat)   │
              │             ▲                                              │
              │             │                                              │
              │   droplet-local-LLM (this repo — LLM appliance)            │
              │   ─ ollama (Docker container)              :11434         │
              │   ─ ollama-manager (FastAPI sidecar)        :8002         │
              │       /proxy/{path:path}    forwards to Ollama with      │
              │           tool-call observability + JSON repair          │
              │           + circuit breaker; chat-shaped paths get       │
              │           model_loading + circuit_open 503 pre-flights   │
              │       /health   /metrics                                  │
              │       /models/manifest                                    │
              │       /models/available  /models/loaded                   │
              │       /models/eligible    (VRAM-gated)                    │
              │       /models/sync         (idempotent pulls)             │
              │       /models/pull         DELETE /models/{name}          │
              │   ─ ollama-metrics (sidecar)                :9101         │
              └────────────────────────────────────────────────────────────┘
```

For **chat**, the orchestrator's ai-gateway posts **directly to Ollama** at
`OLLAMA_URL` (`http://...:11434`, the OpenAI-compat `/v1/chat/completions`) —
NOT through `ollama-manager`'s `/proxy`, whose 120 s read leg the agent loop
blows past on CPU inference and cold-loads of larger models (surfacing as 502
from the manager, 500 from the orchestrator). `ollama-manager`'s `/proxy` is
**opt-in observability** (tool-call counter, JSON repair, circuit breaker),
used only when prompts fit the 120 s budget — point `OLLAMA_URL` at
`:8002/proxy` deliberately, never by default.
ai-gateway reads `/health.limits` (on `ollama-manager` `:8002`) at provider
init to size its outbound concurrency to match `OLLAMA_NUM_PARALLEL` on the
appliance, and refreshes those limits on a 503.

The `/health` body is **versioned** via a top-level `schema_version` integer
(WARP-284). The orchestrator's `_LimitsCache` carries
`_KNOWN_SCHEMA_VERSION = 1` and logs a structured warning whenever the live
appliance reports an unknown version (newer, older, or absent). The point is
forward compatibility — a planned appliance bump rolls out independently;
the warning log is the canary. The canonical schema-history table lives in
[`droplet-local-LLM/docs/model-management.md`](../../droplet-local-LLM/docs/model-management.md);
bump both sides in lockstep when the contract changes.

## Where things live

| Concern | Location |
|---|---|
| Agent loop (read → tool-call → act → re-prompt) | `droplet-onboard-services/apps/orchestrator/src/services/llm-agent.service.ts` |
| Tool definitions (~50 tools) | `droplet-onboard-services/packages/tools-core/` |
| MCP server (stdio child of orchestrator) | `droplet-onboard-services/services/mcp-server/` |
| Model routing (`llama*` → local, `claude*` → Anthropic, `gpt*` → OpenAI) | `droplet-onboard-services/services/ai-gateway/router.py` |
| HTTP API exposed to the world (`/ai/chat`, `/ai/sessions/*`, `/ai/keys/*`) | `droplet-onboard-services/services/ai-gateway/main.py` |
| BYOK API key storage (Fernet-encrypted) | `droplet-onboard-services/services/ai-gateway/` |
| Model serving (Ollama process) | `droplet-local-LLM/docker/docker-compose.yml` (ollama service) |
| Model lifecycle (pull/sync/list) | `droplet-local-LLM/services/ollama-manager/` |
| Per-device VRAM detection | `droplet-local-LLM/services/ollama-manager/vram.py` |
| Manifest of supported models | `droplet-local-LLM/models/model-manifest.json` |

## How a chat request flows

1. **Web dashboard or API client** → `POST /ai/chat` on the orchestrator (port 3000) or directly on ai-gateway (port 8000).
2. **Orchestrator's agent loop** (`llm-agent.service.ts`) starts: get tools from MCP, send first turn to ai-gateway.
3. **ai-gateway** (`main.py` → `router.py`) inspects the model name. If it starts with `llama*`, `mistral*`, `phi*`, etc., route to `OLLAMA_URL` — **direct to Ollama** at `http://host.docker.internal:11434`'s OpenAI-compat `/v1/chat/completions`. (Model lifecycle — `/models/*`, `/health`, `/metrics` — goes to `ollama-manager` on `:8002`; the chat path does not.)
4. **Ollama on the inference host** (the `ollama` container in `droplet-local-LLM`) generates a response, possibly with `tool_calls`.
5. **Orchestrator** parses `tool_calls`, dispatches each via `mcp.callTool()` (JSON-RPC over stdio), gets results, appends `role="tool"` messages, re-prompts.
6. Loop until model produces final text or hits `MAX_ITERATIONS` (~10).
7. **Response streams back** via SSE through ai-gateway → orchestrator → caller.

The inference host side (`droplet-local-LLM`) is involved only in step 3-4. We see one HTTP call per loop iteration. We do not see tool calls, conversation history, or session state — those live in the orchestrator.

## Adding a new agent capability

**Add a new tool the agent can call:** edit `droplet-onboard-services/packages/tools-core/src/index.ts`. The tool registry is shared between the orchestrator's agent loop and the MCP server, so adding it once exposes it both ways.

**Add a new model the appliance can serve:** edit `droplet-local-LLM/models/model-manifest.json` to add an entry, then run `POST /models/sync` on the appliance. The manifest entry needs a `min_vram_gb` so the appliance knows whether to actually pull it. No code changes in either repo.

**Change the agent's system prompt:** edit the orchestrator-side prompt in `droplet-onboard-services/apps/orchestrator/src/services/llm-agent.service.ts`. There is no system prompt on the inference host side; the appliance is stateless w.r.t. agent identity.

**Change which provider a model name routes to:** edit `droplet-onboard-services/services/ai-gateway/router.py`. The inference host is unaware of which model the orchestrator chose; it just receives a `model` field in the API request and serves it.

## What is NOT in this repo

- ❌ Ollama process (it lives in `droplet-local-LLM`)
- ❌ Model files / weights
- ❌ Model lifecycle endpoints (`/models/sync`, `/models/pull`, `/models/eligible`)
- ❌ VRAM detection
- ❌ The `model-manifest.json`
- ❌ Anything that talks Ollama's native protocol directly (we go through ai-gateway)

If you find yourself wanting to add any of those here, **stop**. They go in `droplet-local-LLM`.

## Historical note

Until April 2026 the agent runtime lived in `droplet-local-LLM`'s OpenClaw container. Two things invalidated that:

1. The OpenClaw upstream broke (the install URL `get.openclaw.ai` went NXDOMAIN, and the config schema diverged from what the project shipped).
2. WARP-104 absorbed the agent loop end-to-end into this repo's orchestrator.

`droplet-local-LLM/docs/ADR-003-llm-appliance-simplification.md` records the decision to retire OpenClaw and consolidate the agentic logic here. This file exists in part so that the next person reading either repo doesn't yak-shave on resurrecting OpenClaw.

## Cross-repo development checklist

When making changes that touch both repos:

1. Branch and PR each repo separately, but link the PRs in their descriptions.
2. Land the inference contract change in `droplet-local-LLM` first (it's the dependency).
3. Then land the orchestrator change in `droplet-onboard-services`.
4. Bump `models/model-manifest.json` and `OLLAMA_URL` only when both PRs are merged.

If you're making a change that touches **only this repo** (e.g. adding a new model, changing the lifecycle API), the orchestrator side needs no PR.

If you're making a change that touches **only the orchestrator** (e.g. new tool, new agent prompt), this repo needs no PR.

## Citations & anchors (WARP-287)

Citations from `/api/files/knowledge/search` and `/api/llm/chat` carry a structured
`anchor` field per WARP-287; the dashboard `<CitationCard>` renders deep-link
viewers (PDF at page N, audio/video at MM:SS, email modal, archive drawer).
The schema source of truth is `schemas/anchor.schema.json`; codegen produces
the Python `anchor_schema` module (consumed by `services/file-indexer`) and the
TypeScript `@droplet/shared-types` package (consumed by the orchestrator + web
dashboard). Legacy pre-WARP-287 chunks have `metadata.anchor` absent and
surface as `anchor: null`; the admin re-index route
(`POST /api/admin/files/:id/reindex`) upgrades them in place.
