---
name: debug-ollama-call-path
description: |
  Debug "AI not reachable" / chat 500s / 502s from the inference host,
  and decide which Ollama endpoint a service should call. Use when chat
  requests fail or time out, when an agent loop dies mid-run on CPU
  inference or a cold model load, when choosing between Ollama (:11434)
  and ollama-manager (:8002), or when OLLAMA_URL looks wrong.
---

# Ollama call path (chat vs lifecycle) — full picture + debugging

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
