# AI Gateway — Testing Guide

## Local Testing (No Jetson Required)

The ai-gateway can be fully tested on macOS/Linux without Jetson hardware using the included mock Ollama server.

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
JETSON_OLLAMA_URL=http://localhost:11434 python -m uvicorn main:app --reload --port 8000
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
export JETSON_OLLAMA_URL=http://host.docker.internal:11434
docker compose up
```

Then start the mock Ollama on the host machine.

---

## Remote Jetson Testing

When you have access to a Jetson device (physical or remote):

### Option A: Jetson on local network

1. Deploy Ollama on the Jetson:
   ```bash
   # On the Jetson
   cd inference-engine/docker && docker compose up -d
   ```

2. Point the ai-gateway to the Jetson:
   ```bash
   # On your dev machine
   JETSON_OLLAMA_URL=http://<jetson-ip>:11434 python -m uvicorn main:app --reload
   ```

3. Pull models:
   ```bash
   cd inference-engine
   ./scripts/pull-models.sh http://<jetson-ip>:11434
   ```

### Option B: SSH tunnel to remote Jetson

If the Jetson is behind a firewall or on a different network:

```bash
# Create SSH tunnel
ssh -L 11434:localhost:11434 user@jetson-host

# In another terminal, run ai-gateway
JETSON_OLLAMA_URL=http://localhost:11434 python -m uvicorn main:app --reload
```

### Option C: Docker Compose with real Jetson

Edit `edge-platform/docker/docker-compose.yml` and change `JETSON_OLLAMA_URL`:

```yaml
ai-gateway:
  environment:
    - JETSON_OLLAMA_URL=http://<jetson-ip>:11434
```

---

## What Can't Be Tested Locally

| Feature | Requires Jetson | Workaround |
|---------|----------------|------------|
| Real LLM inference | Yes | Mock Ollama returns canned responses |
| GPU telemetry | Yes | Mock returns `{"available": false}` |
| TensorRT-LLM | Yes | Not applicable locally |
| PCIe latency | Yes (production PCB) | HTTP over LAN is functional equivalent |
| Model hot-swap | Yes (GPU memory) | Mock always reports models loaded |

The mock covers all API contract testing. Real inference quality and latency must be validated on Jetson hardware.
