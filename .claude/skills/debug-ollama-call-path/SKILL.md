---
name: debug-ollama-call-path
description: |
  Debug "AI not reachable" / chat 500s / 502s from the inference host, and
  decide which inference endpoint a service should call. Covers BOTH runtimes:
  Docker Model Runner (:12434, the default since WARP-1870) and Ollama
  (:11434, opt-in). Use when chat requests fail or time out, when an agent
  loop dies mid-run on CPU inference or a cold model load, when every model
  reports tools=false, when a box appears to re-pull its model on every boot,
  when choosing between Ollama (:11434) and ollama-manager (:8002), or when
  OLLAMA_URL looks wrong. Start with the runtime check at the top — OLLAMA_URL
  is a DMR pointer on a default box.
---

# Inference call path (chat vs lifecycle) — full picture + debugging

> **FIRST: which runtime is this box on? (WARP-1870)**
>
> ```bash
> docker exec droplet-ai-gateway-1 env | grep -E '^(INFERENCE_RUNTIME|OLLAMA_URL)='
> ```
>
> - `INFERENCE_RUNTIME=dmr` + `OLLAMA_URL=http://dmr:12434` — **the default
>   for any box provisioned after 2026-08-11.** Chat is served by the Docker
>   Model Runner, and **most of this page does not apply**: there is no
>   ollama-manager, no `:8002`, no `/proxy`, and `:11434` is not listening.
>   Skip to the DMR section at the bottom.
> - `INFERENCE_RUNTIME=ollama` + a `:11434` URL — the Ollama shape this page
>   describes. Still supported, selected with
>   `INFERENCE_RUNTIME=ollama ./scripts/setup.sh`.
> - **`OLLAMA_URL` containing `dmr` or `:12434` while `INFERENCE_RUNTIME` is
>   NOT `dmr`** — that is a self-contradiction, and it is the highest-value
>   thing on this page. It means the runtime variable was LOST (a compose
>   `${VAR:-}` resolving against the wrong env file — the WARP-1860 shape).
>   ai-gateway reads that variable at module IMPORT, so every model silently
>   reports `tools=false` and tool schemas stop being grammar-stripped
>   (WARP-1839). ai-gateway logs this at ERROR on startup. **A `docker
>   restart` does not re-read env — only `--force-recreate` does.**
>
> The variable names are historical: `OLLAMA_URL`, `RAGAS_OLLAMA_URL` and
> `OLLAMA_CHAT_PATH` are how **DMR** is consumed too. Never judge the runtime
> by a variable's name — read its value.

## The Ollama shape (`INFERENCE_RUNTIME=ollama`)

The sibling repo `droplet-local-LLM` ships two services on the inference
host: **Ollama** (`:11434`, the inference engine) and **ollama-manager**
(`:8002`, a lifecycle + opt-in observability sidecar). They are NOT
interchangeable proxy layers — each owns separate concerns:

- **Chat path is direct to Ollama** (`OLLAMA_URL=http://...:11434`).
  ai-gateway's `OllamaLocalProvider` posts straight to Ollama's
  OpenAI-compat `/v1/chat/completions`. Production's `.env` and the
  `OllamaLocalProvider` code default both point here. Going direct
  matters because ollama-manager's `TIMEOUT_PROXY` read leg is 120 s
  (see `droplet-local-LLM/services/ollama-manager/timeouts.py`), which
  the orchestrator's agent loop blows past on CPU inference and on
  cold-loads of larger models — surfacing as 502 from the manager and
  500 from the orchestrator. ADR-004 in `droplet-local-LLM` records the
  original rationale for the sidecar's `/proxy` endpoint, but the chat
  path in production deliberately does not use it.
- **ollama-manager owns model lifecycle**: `GET/POST /models/*`,
  `GET /health` (limits contract that `OllamaLocalProvider._LimitsCache`
  reads), `GET /metrics`. These are NOT exposed through ai-gateway —
  they're called directly by setup scripts and observability tooling.
- **ollama-manager's `/proxy/v1/chat/completions` is opt-in observability**
  (tool-call counter, JSON repair, circuit breaker). Point
  `OLLAMA_URL` at `http://...:8002/proxy` ONLY when you want those
  signals and your prompts fit inside the 120 s read budget — typical
  for production on the inference host with warm models, NOT for CPU dev or
  heavy first-call cold loads.

## Debugging checklist

If you're debugging an "AI not reachable" issue, the first thing to
check is `OLLAMA_URL` inside the running ai-gateway container
(`docker exec droplet-ai-gateway-1 env | grep OLLAMA`).

- A trailing `/proxy` is the smoking gun for "manager timed out my
  agent loop".
- A stale `inference-engine.local` is the smoking gun for "mDNS doesn't
  resolve from inside Docker on macOS" (use
  `host.docker.internal:11434` locally).
- Remember `docker restart` does not re-read `.env` — if you fix
  `OLLAMA_URL`, recreate the service (see the `docker-stack` skill).

## The DMR shape (`INFERENCE_RUNTIME=dmr` — the default)

Docker Model Runner serves chat on **`:12434`**, in the `droplet-dmr`
container, on the `dmr` compose profile. There is no manager sidecar and no
`/proxy` leg, so the whole timeout class above simply does not exist here.

Smoking guns specific to DMR:

- **Nothing listening on `:11434`** is CORRECT on a DMR box, not a fault.
  `droplet-ollama` is not running and its profile is not active.
- **`LLM_MODEL` not matching `/api/tags` byte-for-byte.** DMR reports
  registry-qualified ids (`docker.io/ai/gpt-oss:20B-F16`); the Ollama short
  tag (`gpt-oss:20b`) never matches. The orchestrator's readiness compares raw
  strings, so a mismatch reads as "model absent" and kicks a background pull of
  a ~13.79 GB artifact **on every orchestrator boot**. Check with:
  ```bash
  docker exec droplet-dmr sh -c 'curl -s http://127.0.0.1:12434/api/tags'
  docker exec droplet-orchestrator-1 env | grep '^LLM_MODEL='
  ```
- **Every model reports `tools=false`** — `INFERENCE_RUNTIME` was lost; see the
  contradiction check at the top. Not a model problem.
- **Tool-bearing chats 400 with "failed to parse grammar"** — llama.cpp
  compiles tool schemas into a GBNF grammar and bounded keywords
  (`maxLength`, `pattern`, …) blow its repetition guard. WARP-1839.
  `_GRAMMAR_SAFE_TOOL_SCHEMAS` strips them, and it is gated on the same
  runtime variable, so a lost variable brings this outage back too.
- **`droplet-ollama` running ALONGSIDE `droplet-dmr`** — both hold `/dev/kfd`
  and the render node. That is the WARP-1826 single-GPU-owner violation and
  the WARP-1824 shape, where a 20B model landed 0/25 layers on the GPU and
  served from CPU while looking healthy. Exactly one runtime profile may be
  active; `single-box.sh` strips the loser in both directions.

Rolling back to Ollama is `scripts/dmr/rollback-single-box.sh`. Note it must
pull the model first on any box that has been on DMR for a while — the Ollama
store is empty there, and the script handles that, but it is not instant.
