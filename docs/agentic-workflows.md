# Agentic Workflows on Droplet — Where Each Component Lives

> **This file is mirrored at `droplet-jetson-ai/docs/agentic-workflows.md`.** Keep both copies in sync. Each repo's copy is full content (not a stub) so each repo is readable in isolation.

## TL;DR for future agents and developers

- **`droplet-pi-platform`** (this repo) — runs **intelligence**. The orchestrator's ReAct agent loop, the MCP server with the tool registry, the AI gateway that proxies model requests to Ollama.
- **`droplet-jetson-ai`** (sibling repo) — runs **inference**. Ollama + a small Python sidecar that does manifest pulls and exposes `/models/eligible`. **No agent runtime there.**
- The two repos are deployed side-by-side on the same Jetson (single device).

If you're looking for "where is Ollama" or "how do I add a new model" — **the answer is the other repo, not this one**. There is intentionally zero inference-server code in `droplet-pi-platform`.

## Architecture

```
              ┌─────────────── single Jetson Orin Nano 8 GB ───────────────┐
              │                                                            │
              │   droplet-pi-platform (orchestrator)                       │
              │   ─ apps/orchestrator/      ReAct agent loop, owns chat    │
              │   ─ services/mcp-server/    stdio child, ~50 tools         │
              │   ─ services/ai-gateway/    pure model proxy: routing      │
              │             │                                              │
              │             │  Ollama native API                           │
              │             │  (/api/chat, /api/tags, /api/pull, etc.)     │
              │             ▼                                              │
              │   http://jetson-ai.local:11434                             │
              │             ▲                                              │
              │             │                                              │
              │   droplet-jetson-ai (this repo — LLM appliance)            │
              │   ─ ollama (Docker container)              :11434         │
              │   ─ ollama-manager (FastAPI sidecar)        :8002         │
              │       /health   /models/manifest                          │
              │       /models/available  /models/loaded                   │
              │       /models/eligible    (VRAM-gated)                    │
              │       /models/sync         (idempotent pulls)             │
              │       /models/pull         DELETE /models/{name}          │
              └────────────────────────────────────────────────────────────┘
```

## Where things live

| Concern | Location |
|---|---|
| Agent loop (read → tool-call → act → re-prompt) | `droplet-pi-platform/apps/orchestrator/src/services/llm-agent.service.ts` |
| Tool definitions (~50 tools) | `droplet-pi-platform/packages/tools-core/` |
| MCP server (stdio child of orchestrator) | `droplet-pi-platform/services/mcp-server/` |
| Model routing (`llama*` → local, `claude*` → Anthropic, `gpt*` → OpenAI) | `droplet-pi-platform/services/ai-gateway/router.py` |
| HTTP API exposed to the world (`/ai/chat`, `/ai/sessions/*`, `/ai/keys/*`) | `droplet-pi-platform/services/ai-gateway/main.py` |
| BYOK API key storage (Fernet-encrypted) | `droplet-pi-platform/services/ai-gateway/` |
| Model serving (Ollama process) | `droplet-jetson-ai/docker/docker-compose.yml` (ollama service) |
| Model lifecycle (pull/sync/list) | `droplet-jetson-ai/services/ollama-manager/` |
| Per-device VRAM detection | `droplet-jetson-ai/services/ollama-manager/vram.py` |
| Manifest of supported models | `droplet-jetson-ai/models/model-manifest.json` |

## How a chat request flows

1. **Web dashboard or API client** → `POST /ai/chat` on the orchestrator (port 3000) or directly on ai-gateway (port 8000).
2. **Orchestrator's agent loop** (`llm-agent.service.ts`) starts: get tools from MCP, send first turn to ai-gateway.
3. **ai-gateway** (`main.py` → `router.py`) inspects the model name. If it starts with `llama*`, `mistral*`, `phi*`, etc., route to `JETSON_OLLAMA_URL` (`http://jetson-ai.local:11434`).
4. **Jetson Ollama** (this repo's `ollama` container) generates a response, possibly with `tool_calls`.
5. **Orchestrator** parses `tool_calls`, dispatches each via `mcp.callTool()` (JSON-RPC over stdio), gets results, appends `role="tool"` messages, re-prompts.
6. Loop until model produces final text or hits `MAX_ITERATIONS` (~10).
7. **Response streams back** via SSE through ai-gateway → orchestrator → caller.

The Jetson side (this repo) is involved only in step 3-4. We see one HTTP call per loop iteration. We do not see tool calls, conversation history, or session state — those live in the orchestrator.

## Adding a new agent capability

**Add a new tool the agent can call:** edit `droplet-pi-platform/packages/tools-core/src/index.ts`. The tool registry is shared between the orchestrator's agent loop and the MCP server, so adding it once exposes it both ways.

**Add a new model the appliance can serve:** edit `droplet-jetson-ai/models/model-manifest.json` to add an entry, then run `POST /models/sync` on the appliance. The manifest entry needs a `min_vram_gb` so the appliance knows whether to actually pull it. No code changes in either repo.

**Change the agent's system prompt:** edit the orchestrator-side prompt in `droplet-pi-platform/apps/orchestrator/src/services/llm-agent.service.ts`. There is no system prompt on the Jetson side; the appliance is stateless w.r.t. agent identity.

**Change which provider a model name routes to:** edit `droplet-pi-platform/services/ai-gateway/router.py`. The Jetson is unaware of which model the orchestrator chose; it just receives a `model` field in the API request and serves it.

## What is NOT in this repo

- ❌ Ollama process (it lives in `droplet-jetson-ai`)
- ❌ Model files / weights
- ❌ Model lifecycle endpoints (`/models/sync`, `/models/pull`, `/models/eligible`)
- ❌ VRAM detection
- ❌ The `model-manifest.json`
- ❌ Anything that talks Ollama's native protocol directly (we go through ai-gateway)

If you find yourself wanting to add any of those here, **stop**. They go in `droplet-jetson-ai`.

## Historical note

Until April 2026 the agent runtime lived in `droplet-jetson-ai`'s OpenClaw container. Two things invalidated that:

1. The OpenClaw upstream broke (the install URL `get.openclaw.ai` went NXDOMAIN, and the config schema diverged from what the project shipped).
2. WARP-104 absorbed the agent loop end-to-end into this repo's orchestrator.

`droplet-jetson-ai/docs/ADR-003-llm-appliance-simplification.md` records the decision to retire OpenClaw and consolidate the agentic logic here. This file exists in part so that the next person reading either repo doesn't yak-shave on resurrecting OpenClaw.

## Cross-repo development checklist

When making changes that touch both repos:

1. Branch and PR each repo separately, but link the PRs in their descriptions.
2. Land the inference contract change in `droplet-jetson-ai` first (it's the dependency).
3. Then land the orchestrator change in `droplet-pi-platform`.
4. Bump `models/model-manifest.json` and `JETSON_OLLAMA_URL` only when both PRs are merged.

If you're making a change that touches **only this repo** (e.g. adding a new model, changing the lifecycle API), the orchestrator side needs no PR.

If you're making a change that touches **only the orchestrator** (e.g. new tool, new agent prompt), this repo needs no PR.
