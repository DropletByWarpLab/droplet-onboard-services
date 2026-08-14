# ADR-036: The inference runtime becomes an abstraction — Docker Model Runner as a second backend behind one contract

**Status:** Accepted — and shipped as the default (WARP-1870, 2026-08-11).

The Phase-0 hardware gate **has** run: it passed on the lab box 2026-08-08,
measured in §5a. The lab box was flipped 2026-08-10, and WARP-1870 made DMR
what a freshly provisioned box gets. §8's "ships dark" posture below describes
the WARP-1772 state and is retained as history, not as current behaviour —
see the note at the head of §8.
**Date:** 2026-08-04
**Deciders:** Engineering (WARP-1740 epic) — human gate required before any phase past 0b
**Builds on:** [ADR-003 (LLM appliance simplification)](../../droplet-local-LLM/docs/ADR-003-llm-appliance-simplification.md) — **generalized, not superseded** (§1), [ADR-004 (tool-aware resilience)](../../droplet-local-LLM/docs/ADR-004-tool-aware-resilience.md)
**Companion:** [`droplet-local-LLM/docs/ADR-005-inference-runtime-abstraction.md`](../../droplet-local-LLM/docs/ADR-005-inference-runtime-abstraction.md) — the appliance-side half of this same decision. Read both; neither is complete alone.
**Scope:** this repo owns the *consumer* half — the six call sites that make Ollama load-bearing, the egress allowlist, and the gateway containment. The appliance repo owns the runtime, the model manifest, and the lifecycle sidecar.

Everything cited below as "verified against upstream source" was read out of `docker/model-runner` @ main (Apache-2.0, v1.2.6), not out of the docs site. That distinction is load-bearing and §2 explains why.

**Citation baseline:** every `file:line` below is against **`origin/main` @ `15f8d010`** — the state *before* the WARP-1740 epic. That is deliberate: this ADR's Context describes the problem the epic exists to solve, so it must cite the code as it was, not as the branch is leaving it. Line numbers will drift on the branch as WARP-1742/1744 land; re-anchor to the baseline commit, not to the tip.

## Context — what is actually true today

**Our Ollama dependency is six endpoints wide, and only one of them is chat.** That is the whole surface, enumerated by reading every call site rather than by assuming:

| Endpoint | Caller (file:line) | What breaks without it |
|---|---|---|
| `POST /v1/chat/completions` | `services/ai-gateway/providers/ollama_local.py:113` (`_CHAT_PATH`) | all local inference |
| `GET /api/tags` | `ollama_local.py:447` (`list_models`), `:609` (`is_reachable`); `apps/orchestrator/src/services/model-metrics.service.ts:70`; `model-readiness.service.ts:285`; appliance `services/ollama-manager/main.py:135,167,386` | model picker, wizard readiness, health |
| `GET /api/ps` | `model-metrics.service.ts:69`; `model-readiness.service.ts:206`; appliance `main.py:180` | VRAM/loaded-model reporting (`size_vram`) |
| `POST /api/show` | `ollama_local.py:422` | per-model capability probe (vision/tools) |
| `POST /api/pull` | `model-readiness.service.ts:334`; appliance `main.py:226,316,435` | first-boot weight download, NDJSON progress |
| `DELETE /api/delete` | appliance `main.py:354` | model eviction / disk reclaim |

Note what is *not* in that table: nothing in this repo speaks Ollama's native `/api/chat`. `ollama_local.py:108-113` is explicit that we always use the OpenAI-compatible path so the local provider and the cloud providers share one code path in `router.py`. The chat contract we depend on is therefore the *OpenAI* contract, not the Ollama one — which is the single biggest reason this ADR is even tractable.

**The runtime is already pinned, contained, and tuned — but only by convention.** `docker/docker-compose.yml:2250` pins `ollama/ollama:0.30.8-rocm` (WARP-590 — the floating `rocm` tag could swap the inference runtime under the box on a routine pull); `:2260` publishes only `127.0.0.1:11434`; `:2270` pins `OLLAMA_KEEP_ALIVE: "24h"`; `:2278` pins `OLLAMA_CONTEXT_LENGTH` to 16384 (WARP-854 — the 4096 default overflowed the ~80-tool agent prompt and returned `finish_reason=length` with zero output tokens). Every one of those is a property of *the Ollama daemon specifically*, expressed as a compose environment variable. There is no place in the codebase that says "the inference runtime must provide keep-alive control and a ≥16k context" — the requirement exists only as an env var aimed at one implementation.

**Weight distribution is the one hole in the egress model.** `docs/security/allowed-egress.yaml:167` carries the `ollama-model-registry` entry for `registry.ollama.ai:443`, and its own `purpose` field at `:177-179` admits the shape of the problem verbatim: *"No repo literal — the Ollama daemon owns the destination."* Every other entry in that file names a host our code dials. This one names a host our code cannot see, cannot pin, and cannot verify — the daemon resolves it, fetches from it, and hands us weights. The allowlist records the exception honestly; it does not close it.

**The capability probe already has a fallback, and the fallback is weaker than anyone assumes.** `services/ai-gateway/capabilities.py:42-46`:

```python
caps = show.get("capabilities") or []
families = ((show.get("details") or {}).get("families")) or []
vision = ("vision" in caps) or any(f in _VISION_FAMILIES for f in families)
tools = "tools" in caps
```

`vision` degrades to a `details.families` heuristic when `capabilities` is absent. **`tools` does not.** Against any daemon that omits the `capabilities` array, `tools` is `False` for every model, silently, forever — and the probe is best-effort by design (`ollama_local.py:426` swallows the failure to `debug`). §3 is entirely about this.

## Decision

### 1. What changes, and what this ADR is careful *not* to overturn

**The inference runtime becomes configuration, not architecture.** We introduce a named runtime contract — the six endpoints above plus the OpenAI chat path — and Docker Model Runner (DMR) becomes a second implementation of it behind an explicit backend discriminator. Ollama remains the default and the only runtime any box takes today.

**Relationship to ADR-003 — this ADR *generalizes* it, it does not supersede it.** ADR-003 named Ollama by name and was right to: at the time, "reduce the appliance to two services, one of which is the upstream Ollama image" was the correct simplification, and every consequence it recorded still holds. What ADR-003 actually decided is that *the appliance is a hardened inference host, not an agent runtime* — a statement about the appliance's role, not about which daemon fills it. This ADR keeps that decision intact and lifts one clause: where ADR-003 says "the upstream Ollama image", read "a daemon satisfying the inference contract in §2, of which the upstream Ollama image is the default and reference implementation." Nothing in ADR-003's Decision, Alternatives, or Consequences is reversed. Its rejected alternatives (repair OpenClaw, add an agent framework, strip the manifest layer) stay rejected on their original reasoning. ADR-004's `ollama-manager` proxy, circuit breaker, and `/health.limits` contract likewise survive unchanged — they sit *above* the runtime seam, not across it.

### 2. Compatibility, verified against upstream source — and why we did not trust the docs

Read out of `pkg/ollama/api.go` and `pkg/ollama/http_handler.go` @ main. DMR v1.2.6 listens on **12434**, `MODELS_PATH=/models`, healthcheck `GET /engines/status`, runs as non-root `USER modelrunner`, and requires **no docker socket**.

| Our dependency | DMR endpoint | Response shape | Verdict |
|---|---|---|---|
| `POST /v1/chat/completions` | **`POST /v1/chat/completions`** (bare path works) | OpenAI + `usage` + `timings` | ✅ **no change needed** — `/engines/v1/…` also works but is not required |
| `GET /api/tags` | `GET /api/tags` | `{models:[{name, model, modified_at, size, digest, details:{format, family, families, parameter_size, quantization_level}}]}` | ⚠️ shape matches but **`size` is always `0`** — §3 |
| `GET /api/ps` | `GET /api/ps` | `{models:[{name, model, digest, expires_at}]}` | ❌ **`size_vram` NEVER populated** — §3 |
| `POST /api/show` | `POST /api/show` | `{details:{…}}` only | ⚠️ **no `capabilities` array** — §3 |
| `POST /api/pull` | `POST /api/pull` | streaming NDJSON `{status, digest, total, completed, error}` | ✅ exact, terminates `{"status":"success"}` |
| `DELETE /api/delete` | `DELETE /api/delete` | body `{"name": …}` → 200 | ✅ **identical** — the native path form is not needed |

**Every row above was measured**, not inferred: a live `docker/model-runner:v1.2.6` container on 2026-08-05, model `ai/smollm2`. Two rows came back better than the desk analysis predicted (the bare `/v1` chat path works; delete takes the Ollama body form), and two came back worse (`size: 0`; `size_vram` absent). The suite that produced them is `droplet-local-LLM/tests/contract/` (WARP-1742) and it is the artifact this table is derived from.

**Three gaps, not one.** DMR tells us strictly less about a model than Ollama does:

1. `/api/show` — no `capabilities`. Fixed by a static table (WARP-1744), gated off by default.
2. `/api/tags` — `size` always `0`. The real size exists only on native `GET /models`, as a human-readable **string** (`config.size = "256.35 MiB"`), not an integer. Fixable: the adapter enriches from `/models` (WARP-1743).
3. `/api/ps` — `size_vram` never populated. **Not fixable by configuration.** Per-model VRAM residency is unobtainable from DMR: `/metrics` was checked on a live container with a model loaded and returns nothing. This forces a **product decision** on the WARP-836 honest-metrics surface before WARP-1749 flips anything — show disk size and a resident/not-resident flag, source total GPU memory from the host and stop claiming per-model attribution, or upstream a patch (Apache-2.0; `GetRunningBackendsInfo` already returns the backend, so the fix looks close to one field).

None is fatal, and neither the supply-chain nor the vLLM argument depends on any of them. But "field-for-field compatible" was too generous a summary of this runtime and should not be repeated.

DMR additionally serves `/engines/v1/completions`, `/engines/v1/embeddings`, `GET /engines/v1/models`, Ollama-compat `POST /api/chat` (accepting `{model|name, messages, tools, stream, think, keep_alive, options}` and returning `{model, created_at, message:{role, content, tool_calls, thinking}, done, done_reason}`), `GET /api/version`, and a native OCI surface: `GET /models`, `POST /models/create`, `GET /models/{ns}/{name}`, `DELETE /models/{ns}/{name}`.

**Why the source and not the docs — and why the source was not enough either.**

Docker's published compatibility documentation **omits `/api/ps` entirely**, while `handlePS` does exist in `pkg/ollama/http_handler.go`. Scoping this off the docs would have made `model-metrics.service.ts:69` and `model-readiness.service.ts:206` look unimplementable. So the docs understate the surface, and every claim here is sourced from `pkg/ollama/api.go` @ main rather than from the docs site.

**But reading the struct produced a wrong answer, and it is worth recording how.** `PSModel` declares `SizeVram int64 \`json:"size_vram,omitempty"\``, which we read as "`size_vram` is present". A live run on 2026-08-05 against `docker/model-runner:v1.2.6` returned `/api/ps` entries with keys `[digest, expires_at, model, name, size]` — no `size_vram`, and `size` a literal `0`. Re-reading the **handler** rather than the type explains it: `handlePS` constructs `PSModel{Name, Model, Digest}`, conditionally sets `ExpiresAt`, and **never assigns `Size` or `SizeVram` anywhere.** They are declared fields that no code writes. `omitempty` then drops `size_vram` from the wire entirely.

This is not a CPU-build artifact. It holds identically on CUDA and ROCm; **no GPU run will produce a `size_vram` value.**

The rule this establishes: **a field's existence in a Go struct says nothing about whether any code assigns it.** Read the handler, then measure. This ADR's compatibility table is now backed by a live conformance run (WARP-1742, `tests/contract/`) rather than by type declarations, and re-verification means re-running that suite, not re-reading the source — because "verified against main on 2026-08-04" decays either way.

**One real incompatibility, and it is not an endpoint.** Model identifiers are OCI-style — `ai/smollm2`, `ai/gpt-oss`, `ai/qwen2.5` — not Ollama's `name:tag`. Every id in `models/model-manifest.json` (appliance repo) is `name:tag`, and `model-readiness.service.ts` passes those ids straight through. Identifier translation is a first-class part of the Phase-0b contract, not a detail.

### 3. The one gap: `/api/show` has no `capabilities` — and the fix is right regardless

DMR's `/api/show` returns license/modelfile/parameters/template/details and no `capabilities` array. Feed that to `capabilities.py:42-46` and `tools` is `False` for every model on every request, permanently, with a `logger.debug` as the only trace. The agent loop would degrade to a no-tools chatbot on a box that looks entirely healthy. This is precisely the class of silent-capability-regression the founder rule about never skipping a check exists to catch, and it is the single reason a naive runtime swap must not be attempted.

**The fix (WARP-1744): make the static manifest the capability source of truth, for both runtimes.**

`droplet-local-LLM/models/model-manifest.json` **already declares capabilities for every model it ships** — all six entries, at `:16, :33, :50, :67, :84, :101` (`["tools","thinking"]`, `["vision","tools"]`, `["vision","tools","thinking"]`, …). We are not inventing a static table; we are connecting one that already exists to a consumer that ignores it in favour of a runtime probe.

A static table is arguably the better design *independent of which runtime wins*:

- **It is the same answer the runtime would give, minus a network call.** Capabilities are a property of the *model* — `gpt-oss:20b` either emits tool calls or it does not — not a property of the daemon serving it. Probing the daemon per model id (`ollama_local.py:371`, cached per id) asks the wrong oracle a question it answers from its own static metadata anyway.
- **It removes a failure mode that currently fails silently.** Today a transient `/api/show` failure caches `None` and degrades to conservative behaviour (`ollama_local.py:413-427`). A manifest lookup cannot fail transiently.
- **It removes a second source of truth.** Right now the manifest says `gpt-oss:20b` has `tools`, and the gateway independently asks the daemon whether it does. Two answers, no reconciliation, no alert if they diverge. §1 of ADR-035 makes the same argument for network state and reaches the same conclusion.
- **It is testable without a daemon.** The capability table becomes a fixture, not a mock of an HTTP probe.

The honest cost: models pulled outside the manifest (an operator's ad-hoc `ollama pull`) lose capability detection and must fall back. The fallback stays the existing `details.families` heuristic from `capabilities.py:43-44`, **extended to cover `tools`** — which is a bug fix owed regardless of DMR, because that asymmetry is a latent silent-degradation path against *any* daemon that returns a sparse `/api/show`.

### 4. Why move at all — three reasons, in order of weight

1. **Supply chain.** DMR distributes models as **OCI artifacts from a registry we can mirror, pin by digest, and sign** — the same trust machinery every other image on the box already uses. That converts `allowed-egress.yaml:167` from an unpinnable exception into a normal registry pull, and lets the entry be **deleted**, not merely re-justified. An allowlist entry whose own comment says the destination is owned by a third-party daemon is a gap we wrote down instead of closing; this is the mechanism that closes it. This reason stands alone — see Alternative D.
2. **Container posture.** `docker/model-runner:v1.2.6` runs as non-root `USER modelrunner` and needs no docker socket. `ollama/ollama` runs as root and mounts its data at `/root/.ollama` (`docker-compose.yml:2288`). We hold the line on non-root everywhere else on the box; the inference container is the exception, and it is the container with the largest attack surface and the widest data volume.
3. **v2.6 needs a runtime Ollama cannot be.** The four-GPU Vault's serving profile (batched, high-concurrency, tensor-parallel) is vLLM's design centre and outside llama.cpp's. Ollama is llama.cpp-only and will remain so. If v2.6 ships, a second runtime backend is not optional — it is a schedule item. The abstraction this ADR introduces is the thing that makes vLLM an implementation of an existing contract rather than a fork of the inference path. **This is the reason the seam is worth building even if DMR itself never ships.**

### 5. Why not yet — the gate, stated honestly

**The hardware is unvalidated.** `llamacpp/native/rocm.Dockerfile` lists `gfx1200;gfx1201` in `AMDGPU_TARGETS` on a ROCm 7.0.2 base, so our RDNA4 part is a *build target*. Compiled-for is not validated-on: Docker's own GPU-validation issue **#659 has been open and unassigned since 2026-02-11**, and **#600 is unresolved**. We would be the validation. Ollama's `0.30.8-rocm` natively supports gfx1200 today and is running in production on the lab box.

**The maturity delta is large and one-directional.** Ollama: MIT, ~177.8k stars, weekly releases, years of field exposure, and the specific harmony-500 flake at `ollama_local.py:115-121` is a known quantity with a bounded retry budget. DMR: Apache-2.0, ~627 stars, v1.2.6. Apache-2.0 is the better license for us and the codebase is legible, but 627 stars means we would find the bugs.

**Therefore Phase 0 is a measurement, not a migration** (WARP-1741): stand DMR up on the lab box's gfx1200, run the existing bench and the agent loop, and compare tokens/sec, time-to-first-token, tool-call correctness, and VRAM residency against `0.30.8-rocm` head to head. **If DMR does not run correctly on gfx1200, Phases 1–3 do not start and this ADR is withdrawn to Rejected**, keeping only the §3 capability fix (which is owed anyway) and possibly Alternative D.

### 5a. Phase 0 result — measured 2026-08-08 on the lab box: **PASS** (WARP-1741)

Run on the shipping single-box (`droplet-sys`, gfx1200, 15.92 GiB VRAM; `ollama/ollama:0.30.8-rocm` live and serving throughout; candidate `docker/model-runner:v1.2.6-rocm`) using the WARP-1741 harness — `droplet-local-LLM` `scripts/bench-runtime.sh` @ `e32c557` for the 3B pair, plus hand-driven `bench_probe.py` arms for the 20B because two 20B models cannot co-reside on a 16 GiB card (arms serialized around explicit evictions; the box's model was re-warmed afterwards). Raw artifacts: `.data/bench/` and `.data/bench20b/` from the run, mirrored off-box; summary tables in WARP-1741.

| | 3B pair (50-trial tool arm) | 20B — the real model (25-trial tool arm) |
|---|---|---|
| models | `qwen2.5:3b` vs `ai/qwen2.5:3B-Q4_K_M` | `gpt-oss:20b` vs `ai/gpt-oss:20B-F16` |
| GPU gate | **gfx1200 via `rocminfo` inside the DMR container** | same container, same wiring |
| decode median (gate: ≥85%) | 90.41 vs 87.37 tok/s — **DMR 103.5%** | 65.87 vs 64.10 tok/s — **DMR 102.8%** |
| tool-call parse (80 schemas) | **100% vs 100%** (50/50 each side) | **100% vs 100%** (25/25 each side) |
| TTFT, medium prompt | 0.016 s vs 0.123 s | 1.356 s vs 1.810 s |
| cold / first load | DMR 0.849 s (probe-measured) | DMR 14.0 s vs Ollama 43.9 s (manual stopwatch, both cache-warm-ish) |
| keep_alive | honored (per-request arm) | `_configure keep_alive=24h` → `/api/ps` `expires_at` stamped +24 h |
| context | model-native 32k | 16384 confirmed via `n_ctx_slot` canary |

Both runs print **PASS** against the §5 stop rule. Both reports carry a quantization-label warning (`Q4_K_M` vs `IQ2_XXS/Q4_K_M`; `MXFP4` vs `MOSTLY_F16`) — these are artifact-metadata labels of equivalent layouts (the two 20B artifacts differ by 0.8 MB in 13.79 GB), recorded here rather than dismissed.

Operationally load-bearing findings from the run, beyond the gate itself:

1. **`_configure` keys strictly by REGISTRY-QUALIFIED model id.** `POST /engines/llama.cpp/_configure` with `{"model":"ai/qwen2.5:3B-Q4_K_M","context-size":16384}` returns **202 and silently does nothing** — the next load came up at the model's native window. The identical call with `docker.io/ai/qwen2.5:3B-Q4_K_M` applied (`n_ctx_slot = 16384`). Any tooling that configures by short id — including the WARP-1749 branch's `configure-runtime.sh` as of this writing — must qualify the id (or configure both forms) **and canary the loaded `n_ctx_slot`, never the HTTP status**.
2. **`LLAMA_ARG_CTX_SIZE` is the restart-surviving context mechanism**, and it is what this repo's dark `dmr` service sets. `_configure` state dies with the container.
3. **The reasoning channel breaks naive stream-timing.** gpt-oss spends a small `max_tokens` budget entirely on `reasoning_content` before any `content` delta; the probe's cold-load arm ("warm baseline request did not stream a token") and the 20B long-prompt row failed for exactly that reason **on both runtimes** — a probe assumption, not a runtime defect. The manual load timings above fill that gap; a future probe revision should count reasoning deltas as liveness.
4. The three §2 gaps re-confirmed live on ROCm: `/api/tags` `size: 0`, `/api/ps` without `size_vram` (though `expires_at` **is** present), and ids reported registry-qualified (`docker.io/ai/…`).

**Status stays Proposed.** Per §8 and WARP-1749, the flip still requires a lab soak, the `size_vram` product decision, and explicit human sign-off. What this section changes is narrower: the hardware gate can no longer be the reason to wait, and the dark `dmr` service this repo now carries (WARP-1772) makes the single-box shape flip-capable the day those judgments land.

### 6. Security — parity, written down instead of inherited

**DMR's API is unauthenticated by design.** Docker documents this plainly; there is no token, no allowlist, no per-caller identity. `POST /models/create` is an **arbitrary-registry-pull primitive**: anything that can reach port 12434 can make the box fetch and materialise an arbitrary OCI artifact from an arbitrary registry, consuming disk and egress, with no credential.

**Ollama has exactly the same property.** `POST /api/pull` on :11434 is the identical primitive with the identical absence of auth. We already contain it, and the containment is the thing that matters, not the daemon:

- **Loopback bind.** `docker-compose.yml:2260` publishes `127.0.0.1:11434:11434` — never `0.0.0.0`. The chat path reaches the daemon by compose service name on the internal bridge network (`docker-compose.yml:2242-2245`), not through the published port.
- **A gateway in front.** No caller outside the compose network speaks to the daemon; everything goes through ai-gateway, which carries the auth and the request context.
- **Token auth on the lifecycle surface.** The appliance's `services/ollama-manager/auth.py:11-15` gates *every* path except `/health` on `Authorization: Bearer`. Its own docstring at `:3-5` is precise about the limit of that protection: *the direct-inference path to :11434 bypasses this service.* The lifecycle API is authenticated; the daemon port is protected by network placement, not by a credential.

**The decision: DMR inherits identical containment, stated as a requirement rather than assumed.** If DMR is ever enabled it binds **loopback and the internal compose network only, never the LAN bridge, never `0.0.0.0`**, and `POST /models/create` and the native `/models/*` surface are never reachable from outside the compose network. This is **parity, not a regression** — but the parity is deliberate and asserted, not inherited by accident. Two specific notes:

- The appliance repo's standalone compose binds `11434:11434` on **all interfaces** (`droplet-local-LLM/docker/docker-compose.yml:15`), because the two-box shape needs cross-host reach from the orchestrator. That is a real divergence from the single-box posture and it applies to any runtime we put there. Companion ADR-005 §5 owns it; a DMR profile in that repo must not widen it further.
- DMR's non-root container (§4.2) makes the *consequences* of a successful pull-primitive abuse smaller than Ollama's root container. It does not make the primitive smaller.

### 7. Keep-alive and lifecycle divergence — a real behavioural difference

**DMR defaults to idle-unload.** We deliberately do the opposite: `docker-compose.yml:2270` pins `OLLAMA_KEEP_ALIVE: "24h"` on the single-box shape so the first chat after an idle period does not pay a multi-second model load — a UX property, deliberately bought with VRAM. (The appliance shape defaults to `${OLLAMA_KEEP_ALIVE:-300}` at `droplet-local-LLM/docker/docker-compose.yml:27` — the two shapes already disagree, which is itself worth knowing.)

DMR accepts `keep_alive` on `/api/chat`, and per-model context is configurable via `docker model configure --context-size N <model>`, the compose top-level `models:` element (`context_size` + `runtime_flags`), and `LLM_URL`/`LLM_MODEL` env injection. So the capability exists — but it is expressed **per request or per model**, where ours is expressed **per daemon**. Our OpenAI chat path (`ollama_local.py:113`) has no `keep_alive` field to carry it.

**Decision:** residency policy becomes part of the runtime contract, not a compose env var. Each backend adapter is responsible for realising "keep the default model resident" using its own mechanism — daemon env for Ollama, per-model configuration for DMR. Phase 0's bench must measure **cold-start latency after idle** explicitly, because a runtime that is faster per token and colder on first touch is slower to the user, and the current benchmark would not notice.

### 8. Ships dark — the constraint that governed every phase up to the flip

> **SUPERSEDED 2026-08-11 (WARP-1870).** This section describes the WARP-1772
> posture and is retained as the record of how the change was staged. It is no
> longer current: Phase 0 passed (§5a), the lab box was flipped 2026-08-10, and
> DMR is now what a freshly provisioned box gets. The reviewer test below —
> *"grep the diff for any default that resolves to DMR and find none"* — was
> the correct gate for Phase 1 and is exactly what WARP-1870 deliberately
> inverted, with `scripts/lib/secrets.sh` writing `INFERENCE_RUNTIME=dmr`.
> The discriminator discipline in this section still holds and still binds: the
> backend is chosen by an explicit named value, never inferred from absence.

Every change up to and including Phase 1 is **additive and opt-in**. With no configuration change, behaviour is byte-identical to today: the default backend is Ollama, the DMR path exists in code but is never taken, no default value anywhere selects it, and no existing call site changes shape. The backend is chosen by an **explicit discriminator** — a named value, never inferred from the absence of a setting, never from `is None`, never from "a DMR URL happens to be set" (the ApOnboardBackend discipline from ADR-035 §2, and the `compose ${VAR:-}` trap: an explicitly-empty env var is not an unset one). A reviewer should be able to `grep` the diff for any default that resolves to DMR and find none. **Flipping the default is Phase 2, it is its own ticket (WARP-1749), and it is gated on Phase 0 passing.**

## Alternatives considered

### A) Stay on Ollama indefinitely

Genuinely strong, and it is the status quo this ADR must beat rather than assume away. Ollama is MIT, ~177.8k stars, weekly releases, already pinned (`docker-compose.yml:2250`), already tuned for our exact failure modes (WARP-854 context, WARP-590 pin, WARP-1333/1606 harmony retries), already validated on gfx1200, and every one of the six endpoints is a shape we have run in production for months. The migration cost is real and the upside is mostly future-facing.

Rejected as a *permanent* answer for exactly one reason: **v2.6**. A four-GPU Vault serving profile needs vLLM, Ollama is llama.cpp-only, and the alternative to an abstraction is a hard fork of the inference path when that hardware lands. Rejected as the answer for *today*: it is not — Ollama stays the default until Phase 0 says otherwise, and Alternative A is what we ship if Phase 0 fails. The honest framing is that this ADR builds the seam and defers the swap, and Alternative A remains live at every gate.

### B) Move to llama.cpp's `llama-server` directly, skipping both wrappers

Removes a whole layer: llama.cpp is what Ollama and DMR both wrap, `llama-server` speaks the OpenAI API natively, and we would own our own GGUF distribution with no third-party registry — which incidentally solves `allowed-egress.yaml:167` more completely than DMR does, because there would be no model registry at all.

Rejected: we would have to build model lifecycle ourselves. Five of our six endpoints (`/api/tags`, `/api/ps`, `/api/show`, `/api/pull`, `/api/delete`) are *lifecycle*, not inference — `llama-server` serves one model per process and provides none of them. We would reimplement pull-with-NDJSON-progress, the loaded-model/VRAM registry that `model-metrics.service.ts` consumes, multi-model residency, and the on-disk layout — and then maintain it against llama.cpp's release cadence with no upstream to inherit fixes from. That is the ADR-003 "strip the manifest layer" alternative resurfacing at a lower level, and it fails for the same reason: the lifecycle helper is small, useful, and fleet-facing, and hand-rolling it is more code than the layer it removes. Revisit only if we ever ship exactly one model per box.

### C) Move to vLLM directly, no DMR

Skips the intermediate step and goes straight to the runtime v2.6 actually needs. vLLM's OpenAI server would satisfy the chat path immediately.

Rejected for the current hardware, not on principle. vLLM's design centre is batched high-concurrency serving on datacentre GPUs; its ROCm/RDNA4 support is weaker than llama.cpp's, its memory model assumes headroom a 16 GB consumer part does not have, and it has no equivalent of the six lifecycle endpoints at all (no `/api/tags`, no `/api/ps`, no pull) — so it needs the same abstraction this ADR builds *plus* a lifecycle layer, on hardware it does not suit. vLLM is the **Phase 3** target, behind the same contract, on the v2.6 four-GPU Vault where it makes sense. Choosing it today would mean building the abstraction anyway and getting worse single-user latency in exchange.

### D) Adopt DMR for model *distribution* only, never for the runtime

Pull models as OCI artifacts, keep Ollama as the serving daemon. This is Phase 1 standing on its own, and it is **genuinely viable** — arguably the highest value-per-risk option on this list.

It captures reason 4.1 (the entire supply-chain argument, including deleting `allowed-egress.yaml:167`) at close to zero inference risk: the serving path, the tuning, the harmony retries, and the gfx1200 validation all stay exactly as they are. It does not require Phase 0 to pass, because nothing about GPU execution changes. Its cost is a distribution/serving impedance mismatch — OCI-pulled artifacts have to land in a layout Ollama will serve, which is real work and possibly a `Modelfile`-shaped shim — and it captures none of reason 4.3, so v2.6 still forces the abstraction later.

**Not rejected — sequenced.** It is Phase 1 (WARP-1745) and it is explicitly permitted to ship *without* Phase 2 ever happening. If Phase 0 fails the gate, D is the fallback plan and this ADR is rewritten around it rather than withdrawn wholesale.

## Consequences

**Better:** the inference runtime stops being a load-bearing proper noun scattered across six call sites, an egress allowlist entry, and four compose env vars. `allowed-egress.yaml:167` becomes deletable rather than permanently re-justified. Model capabilities get one source of truth — the manifest that already declares them (`model-manifest.json:16,33,50,67,84,101`) — instead of a best-effort probe with a silent-false path for `tools`. The `tools` fallback asymmetry in `capabilities.py:45` gets fixed regardless of outcome. v2.6's vLLM requirement becomes an adapter behind an existing contract instead of a fork. The non-root/root question on the box's largest container gets an answer.

**Harder:** a second runtime is a second matrix in every integration test, and the six-endpoint contract needs conformance tests that run against both or the abstraction is decorative. Model-id translation (`name:tag` ↔ `ai/name`) is a translation layer with its own bug class, and it touches `model-readiness.service.ts`, which is on the first-boot path. The `/engines/v1` path prefix means the chat URL is no longer a constant. Residency policy (§7) moves from one compose line to per-adapter logic. Cross-repo coupling deepens: the contract is defined here and implemented there, so a contract change is two PRs.

**Explicitly deferred:** vLLM (Phase 3, unscheduled, hardware-gated on v2.6); embeddings via `/engines/v1/embeddings` (we do not use DMR for embeddings and this ADR does not propose to); DMR's native `/models/*` OCI surface as an *external* API (it stays unreachable per §6); any change to ADR-004's `ollama-manager` proxy, circuit breaker, or `/health.limits` contract; and DMR's `think` / `thinking` fields on `/api/chat` (we do not use native `/api/chat`).

## Sequencing — each phase independently valuable, each revertible, each gated

| Phase | Ticket | Deliverable | Gate to proceed |
|---|---|---|---|
| **0 — measure** | WARP-1741 | DMR v1.2.6-rocm on the lab gfx1200; head-to-head bench vs `ollama/ollama:0.30.8-rocm` — tokens/sec, TTFT, **cold-start-after-idle** (§7), tool-call correctness, VRAM residency | DMR runs correctly on gfx1200 **and** is not materially worse on any axis. Fails ⇒ stop; §5. |
| **0b — contract** | WARP-1742 (consumer) / WARP-1743 (appliance) | The six-endpoint runtime contract as an explicit interface + backend discriminator + conformance tests. **Ships dark** (§8) — Ollama default, DMR path unreachable without explicit config. | Byte-identical behaviour with no config change; conformance suite green against Ollama. |
| **0b — capability fix** | WARP-1744 | Manifest becomes the capability source of truth; `tools` gains the `details.families` fallback `capabilities.py:45` lacks | Owed regardless of outcome — ships even if every later phase is cancelled. |
| **1 — distribution** | WARP-1745 | Models as pinned/signed OCI artifacts; **delete** `allowed-egress.yaml:167` | Standalone-viable (Alternative D). Does **not** require Phase 0 to pass. |
| **2 — runtime swap** | WARP-1749 | Flip the default backend to DMR | **Hard-gated on Phase 0 + a soak on the lab box + explicit human sign-off.** Not implied by anything above it. |
| **3 — vLLM** | WARP-1747 | vLLM as a third backend for the v2.6 four-GPU Vault | Unscheduled. Gated on v2.6 hardware existing. |

This ADR is WARP-1746.

**Stop rule.** Phase 0 failing on gfx1200 stops Phases 2 and 3 outright. Phases 0b and 1 continue on their own merits — 0b because a runtime contract with conformance tests is worth having with exactly one implementation, 1 because Alternative D is viable alone. Nothing in this sequence may flip a default as a side effect; every default change is its own ticket with its own gate.

**What would reverse this decision:**
- DMR failing on gfx1200 → withdraw §4.1/§4.2 reasoning, keep §3 and re-scope to Alternative D.
- Ollama shipping first-class OCI model distribution → reason 4.1 evaporates; A becomes the answer and only 4.3 survives.
- Ollama adding a non-llama.cpp backend (vLLM or equivalent) → reason 4.3 evaporates; with 4.1 solved upstream the abstraction is unjustified and A wins outright.
- v2.6 being cancelled or shipping on a single GPU → 4.3 evaporates, Phase 3 dies, and the case narrows to supply chain alone (Alternative D).
- DMR's unauthenticated `POST /models/create` proving reachable in any shipped topology → hard stop on Phase 2 until §6 containment is provably enforced, not merely configured.
- DMR going unmaintained (v1.2.6 is the current tag; 627 stars is a thin bus factor) → A, permanently.

## Action items

- [ ] WARP-1741 — Phase 0 gate: DMR on gfx1200, head-to-head bench incl. cold-start-after-idle (blocks Phases 2–3)
- [ ] WARP-1742 — runtime contract + backend discriminator in ai-gateway/orchestrator, **shipping dark** (this repo)
- [ ] WARP-1743 — appliance-side runtime contract + opt-in DMR compose profile (`droplet-local-LLM`)
- [ ] WARP-1744 — manifest-backed capability table; fix the `tools` fallback asymmetry at `services/ai-gateway/capabilities.py:45` (owed regardless)
- [ ] WARP-1745 — Phase 1 OCI model distribution; delete `docs/security/allowed-egress.yaml:167`
- [x] WARP-1746 — this ADR + the companion in `droplet-local-LLM` (Proposed, not Accepted)
- [ ] WARP-1749 — Phase 2 default flip (hard-gated; do not open until 1741 passes)
- [ ] WARP-1747 — Phase 3 vLLM backend for v2.6 (unscheduled)
- [ ] WARP-1748 — rename ollama-manager → inference-manager (deferred tech debt)
- [ ] Model-id translation (`name:tag` ↔ `ai/<name>`) design note — touches the first-boot path in `model-readiness.service.ts`

## References

- Upstream: `docker/model-runner` @ main — `pkg/ollama/api.go`, `pkg/ollama/http_handler.go`, `llamacpp/native/rocm.Dockerfile` (Apache-2.0, v1.2.6). Docker validation issues **#659** (open, unassigned since 2026-02-11) and **#600** (unresolved).
- Companion ADR: [`droplet-local-LLM/docs/ADR-005-inference-runtime-abstraction.md`](../../droplet-local-LLM/docs/ADR-005-inference-runtime-abstraction.md)
- Generalized: [`droplet-local-LLM/docs/ADR-003-llm-appliance-simplification.md`](../../droplet-local-LLM/docs/ADR-003-llm-appliance-simplification.md) — **not superseded**; see §1
- Unchanged above the seam: [`droplet-local-LLM/docs/ADR-004-tool-aware-resilience.md`](../../droplet-local-LLM/docs/ADR-004-tool-aware-resilience.md)
- Consumer call sites: `services/ai-gateway/providers/ollama_local.py`, `services/ai-gateway/capabilities.py`, `apps/orchestrator/src/services/model-metrics.service.ts`, `apps/orchestrator/src/services/model-readiness.service.ts`
- Runtime deployment: `docker/docker-compose.yml:2242-2300` (single-box), `scripts/host/docker-compose.poc.yml:57-73`
- Egress: `docs/security/allowed-egress.yaml:167-183`
