# AI Gateway — Testing Guide

## Local Testing (No Inference Host Required)

The ai-gateway can be fully tested on macOS/Linux without inference host hardware using the included mock Ollama server.

### 1. Run the mock Ollama server

```bash
cd edge-platform/services/ai-gateway
python testing/ollama_mock.py
# Starts on port 11434 (same as real Ollama)
```

The mock provides:
- `GET /api/tags` — returns two fake models (llama3.2:3b, mistral:7b)
- `GET /api/ps` — returns loaded model info
- `POST /v1/chat/completions` — returns canned responses (streaming + non-streaming)
- `POST /api/pull` / `DELETE /api/delete` — no-ops that return success

### 2. Run the ai-gateway against the mock

```bash
# In a separate terminal
OLLAMA_URL=http://localhost:11434 python -m uvicorn main:app --reload --port 8000
```

### 3. Test with curl

```bash
# Health check
curl http://localhost:8000/ai/health

# List models (should show mock models)
curl http://localhost:8000/ai/models

# Create a session
curl -X POST http://localhost:8000/ai/sessions \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.2:3b", "title": "Test session"}'

# Chat in session (non-streaming)
curl -X POST http://localhost:8000/ai/sessions/<SESSION_ID>/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "hello", "stream": false}'

# Chat in session (streaming)
curl -N -X POST http://localhost:8000/ai/sessions/<SESSION_ID>/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "hello", "stream": true}'

# List sessions
curl http://localhost:8000/ai/sessions
```

### 4. Run unit tests

```bash
cd edge-platform/services/ai-gateway
pip install -r requirements-dev.txt
python -m pytest tests/ -v
```

Tests use an in-memory session store and don't require Redis or Ollama.

### 5. Run with Docker Compose (full stack)

```bash
cd edge-platform/docker
# Set mock Ollama URL
export OLLAMA_URL=http://host.docker.internal:11434
docker compose up
```

Then start the mock Ollama on the host machine.

---

## Remote Inference Host Testing

When you have access to an inference host (physical or remote):

### Option A: Inference host on local network

1. Deploy Ollama on the inference host:
   ```bash
   # On the inference host
   cd droplet-local-LLM/docker && docker compose up -d
   ```

2. Point the ai-gateway to the inference host:
   ```bash
   # On your dev machine
   OLLAMA_URL=http://<inference-host-ip>:11434 python -m uvicorn main:app --reload
   ```

3. Ensure the model is provisioned on the appliance. Model lifecycle is
   owned by the `ollama-manager` sidecar (`:8002`) in the
   [`droplet-local-LLM`](https://github.com/DropletByWarpLab/droplet-local-LLM)
   repo, not a manual `pull` script in this repo. The canonical path is:

   ```bash
   # On the inference host — idempotent sync against models/model-manifest.json
   curl -X POST http://<inference-host-ip>:8002/models/sync
   ```

   See `droplet-local-LLM/services/ollama-manager/` for the full
   `/models/*` API. To add a new model the appliance can serve, edit
   `droplet-local-LLM/models/model-manifest.json` and re-run
   `/models/sync` — no code changes in either repo.

   > **One Model Rule.** Do NOT `ollama pull` a different model from
   > the host or change `LLM_MODEL` to swap models at runtime — voice +
   > dashboard + every agent loop runs on the single configured model.
   > See [CLAUDE.md](../../CLAUDE.md) and
   > `docs/agentic-workflows.md` for the rationale.

### Option B: SSH tunnel to remote inference host

If the inference host is behind a firewall or on a different network:

```bash
# Create SSH tunnel
ssh -L 11434:localhost:11434 user@inference-host

# In another terminal, run ai-gateway
OLLAMA_URL=http://localhost:11434 python -m uvicorn main:app --reload
```

### Option C: Docker Compose with real inference host

Edit `edge-platform/docker/docker-compose.yml` and change `OLLAMA_URL`:

```yaml
ai-gateway:
  environment:
    - OLLAMA_URL=http://<inference-host-ip>:11434
```

---

## What Can't Be Tested Locally

| Feature | Requires inference host | Workaround |
|---------|------------------------|------------|
| Real LLM inference | Yes | Mock Ollama returns canned responses |
| GPU telemetry | Yes | Mock returns `{"available": false}` |
| TensorRT-LLM | Yes | Not applicable locally |
| PCIe latency | Yes (production hardware) | HTTP over LAN is functional equivalent |
| Model hot-swap | Yes (GPU memory) | Mock always reports models loaded |

The mock covers all API contract testing. Real inference quality and latency must be validated on the inference host.
