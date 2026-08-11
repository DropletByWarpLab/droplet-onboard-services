# Docker Model Runner on the single-box shape (WARP-1772)

**State: DEFAULT (WARP-1870).** DMR is what a freshly provisioned box comes up
running. `scripts/lib/secrets.sh` writes `INFERENCE_RUNTIME=dmr` and a
registry-qualified `LLM_MODEL`; `scripts/lib/single-box.sh` derives the compose
profile and both the chat and RAGAS-judge URLs from that runtime. Chat flows
ai-gateway → `dmr`.

To provision an Ollama box instead: `INFERENCE_RUNTIME=ollama ./scripts/setup.sh`.
The two runtime profiles are mutually exclusive — exactly one may hold
`/dev/kfd` and the render node (SINGLE GPU OWNER, WARP-1826) — and
`single-box.sh` appends whichever matches the runtime while stripping the
other, in both directions.

**An already-deployed box is never flipped by a setup re-run.** `migrate_env`
only writes ABSENT keys, so a legacy box backfills `INFERENCE_RUNTIME=ollama`
— the truth about what it has been serving. Boxes flipped by hand already
carry the key and are untouched.

History: this shipped dark under WARP-1772 (a `dmr` service on a non-default
profile, so the box was merely *flip-capable*). The Phase-0 hardware gate
(WARP-1741) **passed** on the lab box on 2026-08-08 — numbers and operational
findings in [ADR-036 §5a](ADR-036-inference-runtime-abstraction.md). The lab
box itself was flipped on 2026-08-10; the default followed under WARP-1870.
This doc is the operator side.

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

## The flip is now an executable runbook

`scripts/dmr/flip-single-box.sh` **is** the flip — preflights (override file,
soak marker, env snapshots), dark-service activation, store population,
**`LLM_MODEL` derived from the id DMR itself reports** (never hardcoded — the
id-vocabulary gap is the measured #1 failure class), the four runtime vars
written to BOTH env files, `--force-recreate` of every consumer (ai-gateway,
orchestrator, voice-io, rag-eval — env binds at import time), and a verify
battery that fails loud: capability-table env present, context canary
`n_ctx_slot`, no readiness re-pull, serving round-trip, Ollama demoted to
empty standby. `scripts/dmr/rollback-single-box.sh` is the ~60 s inverse —
DMR stopped FIRST (VRAM), both env files together, placement-verified re-warm
(`size_vram`, not just presence — keep_alive pins a CPU placement otherwise).

Setup re-runs are flip-durable: `scripts/lib/single-box.sh` reads
`INFERENCE_RUNTIME` before writing `OLLAMA_URL` / `RAGAS_OLLAMA_URL` /
`LLM_MODEL`, so a re-provision keeps the DMR wiring instead of silently
reverting it.

### The lifecycle decision — resolved for this shape

The flip runs **option (b)**: lifecycle consumers (readiness, metrics, models
summary) ride DMR's Ollama-compat surface, with WARP-1749's honest-metrics
work (PR #1424) supplying serveability checks, id translation, and the honest
Models-page display. No manager service joins the single-box compose. The
out-of-band `droplet-local-llm` manager some lab boxes run keeps fronting the
(empty-standby) Ollama store — benign, nothing on this shape consumes it
(`INFERENCE_MANAGER_URL` unset); refreshing or retiring it is WARP-1748
follow-up work, deliberately not coupled to the flip.

### Known post-flip degradations (accepted, tracked)

- Pre-warm and the Models-page "Measure speed" used Ollama's `/api/generate`,
  which DMR does not serve — both are being made runtime-agnostic on the
  WARP-1749 branch (OpenAI-path warm + wall-clock benchmark).
- `prettify` renders the qualified id as `Docker.io/ai/gpt-oss 20B F16` —
  cosmetic, display-polish follow-up.
- The broad docs sweep (README, COMPONENTS, agentic-workflows, the
  debug-ollama-call-path skill — all `:11434`-shaped) lands as its own PR
  after the flip, when the described default actually changes.

## Preconditions (unchanged, verbatim from WARP-1749/WARP-1772)

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
