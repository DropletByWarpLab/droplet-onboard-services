# Docker Model Runner on the single-box shape (WARP-1772)

**State: DARK.** This repo's compose carries a `dmr` service (profile `dmr`,
never default) so the shipping single-box shape is *flip-capable* — nothing
more. With no configuration change the box behaves byte-identically to a tree
without this service: `docker compose config --services` does not list `dmr`,
no volume materializes, no port binds, and every chat still flows
ai-gateway → `ollama`. The Phase-0 hardware gate (WARP-1741) **passed** on
this box on 2026-08-08 — numbers and the run's operational findings live in
[ADR-036 §5a](ADR-036-inference-runtime-abstraction.md); this doc is the
operator side.

## What exists after this change

| Piece | Where | Guarantee |
|---|---|---|
| `dmr` service | `docker/docker-compose.yml`, beside `ollama` | profile-gated (`dmr`), pinned `v1.2.6-rocm`, loopback-only `127.0.0.1:12434`, own `dmr-models` volume, non-root image, no docker socket, `no-new-privileges` |
| Context parity | `LLAMA_ARG_CTX_SIZE=16384` on the service | same 16k window as `OLLAMA_CONTEXT_LENGTH` (WARP-854), survives container restarts — unlike `_configure`, whose state dies with the container |
| Env knobs | `.env.example` (`DMR_*` block) | commented out; nothing reads them until the profile is on |

## Running it dark (side-by-side, no serving change)

```bash
cd /home/droplet/edge-platform/docker
# additive: keep every existing profile, add dmr
sed -i 's/^COMPOSE_PROFILES=.*/&,dmr/' .env        # or edit by hand
docker compose -p droplet up -d dmr
curl -s http://127.0.0.1:12434/engines/status      # llama.cpp: Running
```

Pull a model into DMR's own store (never Ollama's):

```bash
curl -sS -X POST http://127.0.0.1:12434/api/pull \
  -H 'Content-Type: application/json' \
  -d '{"name":"ai/gpt-oss:20B-F16","stream":true}' | tail -1
```

**VRAM rule on a 16 GiB card: one resident 20B, ever.** Ollama holds
`gpt-oss:20b` at ~11.9 GiB with a 24 h keep-alive. Loading a second 20B into
DMR beside it is an OOM on a live appliance. Dark-mode experiments on the 20B
must evict Ollama's model first (`{"model":"gpt-oss:20b","keep_alive":0}` to
`/api/generate`) and re-warm it after — or use a ≤3B model, which coexists.

Two traps measured on this box (details in ADR-036 §5a):

- `_configure` accepts a short model id with a **202 and silently does
  nothing** — it keys by the registry-qualified id
  (`docker.io/ai/gpt-oss:20B-F16`). Canary the loaded `n_ctx_slot` in the
  container log, never the HTTP status.
- A pulled model can appear in `/api/tags` yet be unserveable (`size: 0`
  wedge after an interrupted pull) — presence in `/api/tags` is not
  readiness.

## What a real flip needs (do not improvise one)

The serving flip is **not** an operator action on this box. Preconditions,
verbatim from WARP-1749/WARP-1772:

1. WARP-1741 PASS — **done, 2026-08-08** (ADR-036 §5a).
2. A lab **soak**, not just a bench run.
3. The `size_vram` **product decision** — DMR cannot report per-model VRAM,
   so decide what the Models page shows *before* it changes.
4. The **lifecycle design decision** for single-box (below).
5. **Explicit human sign-off.** Not implied by any of the above.
6. The change itself arrives via main (the box deploys main; it is not a
   dev environment).

### The open design decision: model lifecycle on single-box

The chat hot path under a flip is mechanical (ai-gateway's provider already
speaks the OpenAI surface DMR serves at `/v1/chat/completions` — measured, no
path change). The unresolved half is lifecycle — `/api/tags`, `/api/ps`,
`/api/pull`, `/api/delete` consumers (`model-readiness.service.ts`,
`model-metrics.service.ts`, the Models page) and the manager sidecar:

- **(a) Runtime-only flip.** Chat moves to DMR; lifecycle (pull/readiness/
  metrics) stays pointed at Ollama. Two daemons, two model stores, split
  brain — cheap and wrong-shaped. Rejectable on sight but listed for
  honesty.
- **(b) Point lifecycle consumers at DMR's Ollama-compat surface.** No new
  service; accepts the measured gaps (`size: 0` in tags, no `size_vram`) and
  leans on WARP-1424's honest-metrics work for display.
- **(c) Deploy the inference-manager (WARP-1748 rename) on single-box** the
  way the lab box already runs one out-of-band today, fronting whichever
  runtime `INFERENCE_RUNTIME` selects. Most uniform with multi-box; adds a
  service to the shipping shape.

This is WARP-1772's stated design question — **surfaced here, deliberately
not decided in the PR that added the dark service.**

## Rollback (dark service)

The dark service has no serving role, so rollback is removal:

```bash
docker compose -p droplet stop dmr && docker compose -p droplet rm -f dmr
# then remove `dmr` from COMPOSE_PROFILES in docker/.env
docker volume rm docker_dmr-models   # only if you also want the weights gone
```

If DMR held a model when stopped, Ollama reclaims the VRAM on its next load;
nothing else references the service. (Post-flip rollback is a different,
bigger procedure — it lands with the flip change, not here.)
