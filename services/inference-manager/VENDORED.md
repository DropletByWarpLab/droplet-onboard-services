# Vendored from `droplet-local-LLM`

This directory is **not original to this repo**. It is a trimmed copy of
`services/inference-manager/` from
[`DropletByWarpLab/droplet-local-LLM`](https://github.com/DropletByWarpLab/droplet-local-LLM),
brought here by **WARP-2131** so the Models page's model catalog works on a
shipped box.

Read this before editing anything in this directory.

## Why it is here rather than pulled as an image

`GET /api/models/catalog` proxies to this service. Until WARP-2131 it had
nothing to reach: no `inference-manager` service existed in
`docker/docker-compose.yml`, so the endpoint 503'd on every call and
`models/page.tsx` — which guards the section on a non-empty list — silently
rendered nothing.

Fixing that needed the service on this box, and the service's source is in
another repo. Three ways to close that gap were considered; vendoring won:

| Option | Why not |
|---|---|
| Publish to GHCR and reference by digest | No precedent. Every Droplet-authored service here is `build:` from local source; the only `image:` entries are third-party plus `droplet/openwrt-singlebox`, which is built here and tagged. GHCR appears once, for buildcache, never for shipping an image. This would add registry credentials on the box, a signing story, and a version-skew axis between two repos' release cadences. |
| Clone droplet-local-LLM at provision time | Puts a network fetch and a second git repo on the provisioning critical path — the worst failure mode of the three on a customer install. |
| **Vendor (chosen)** | Idiomatic here, no new infrastructure, works with the existing build-cache and factory-reset paths. **Cost: this is a fork and it has to be kept in sync.** That cost is accepted explicitly, and this file is how it stays tractable. |

## Provenance

| | |
|---|---|
| Upstream repo | `DropletByWarpLab/droplet-local-LLM` |
| Upstream path | `services/inference-manager/` |
| `origin/main` at time of vendoring | `fab4471d24579d52e3ea1069240e30cb290f0e58` |
| Plus PR #53 (WARP-2129) | `f746a995022f58e5d99468f24222fb0988349835` |
| Plus PR #54 (WARP-2130) | `2f35429933e40f6f8ec0a0718ad7512d6a15dc87` |
| Effective source tree | `7072640abeef6f9fcd148ebbb45b66f0d95fca55` (clean merge of the three, zero conflicts) |

**Both PRs were open when this was vendored.** Taking plain `main` was not an
option: it carries two known identifier defects — `/models/eligible` omitting
`pull_tag`, and `pulled` computed without the runtime adapter so every entry
reads `pulled: false` on a DMR box — and it lacks the `oci` manifest field
entirely. **If either PR changes before it merges, refresh this copy.**

## What was removed, and why

Nothing here was edited for style. Every removal is a deliberate reduction of
what runs on the appliance.

| Removed | Reason |
|---|---|
| `chat_proxy.py`, `tool_repair.py` | `ANY /proxy/{path}` is a catch-all second inference path to the daemon. Chat traffic through the manager's proxy is a drift pattern `droplet-architecture-guard` blocks by name — the orchestrator owns dispatch and ai-gateway owns the inference call. Deleting the modules rather than un-mounting the router means the route cannot return by accident. |
| `placement.py`, `metrics.py` | `placement` imports `chat_proxy` for a metrics label helper, and brings `apscheduler` plus a second GPU-residency watchdog this repo did not ask for. `metrics` exists only to serve those two. |
| `POST /models/sync` | Pulls every eligible manifest entry in one call — tens of GB behind a single request. Nothing in this repo calls it. |
| `DELETE /models/{path}` | WARP-1827 is install-only by design; the orchestrator has no matching route. |
| `/metrics` instrumentation | Nothing scrapes it on this shape. Removing it takes `prometheus-fastapi-instrumentator` and `prometheus-client` out of the appliance's dependency surface. |
| Their tests | `test_chat_proxy.py`, `test_placement.py`, `test_tool_repair.py`, `test_circuit.py`, `test_metrics.py`, and the `test_delete_*` / `test_sync_*` suites in `test_lifecycle.py`. |

**Kept deliberately:** `circuit.py`. It has no dependencies, and `/health`'s
`circuit_breaker` field is part of the v2 schema ai-gateway observes. Nothing
trips the breaker without the chat proxy, so it reports `closed` — which is
true, not a stub.

### Surviving routes

`GET /health` · `GET /models/available` · `GET /models/loaded` ·
`GET /models/manifest` · `GET /models/eligible` · `POST /models/pull`

## Deliberate divergences from upstream

These are edits, not omissions. Re-apply them on every re-sync.

1. **`auth.py` reads `INFERENCE_AUTH_TOKEN`, not `AUTH_TOKEN`.** Upstream maps
   `AUTH_TOKEN=${INFERENCE_AUTH_TOKEN}` in compose. That mapping is unsafe
   here: this repo delivers secrets through `env_file: ../.env`, and
   re-declaring an env_file key as a `${VAR}` substitution resolves it against
   `docker/.env` — a different file, untracked and absent outside a provisioned
   box — yielding `""`. Because `environment:` outranks `env_file:`, that empty
   string *shadows* the real value, and an empty token is permissive mode, not
   a failure. The orchestrator block in `docker/docker-compose.yml` carries the
   post-mortem: the same mistake blanked `SERVICE_TOKEN_RAG_EVAL` and 401'd 15
   consecutive nightly eval runs. Reading the `.env` name directly means there
   is no substitution anywhere and nothing to shadow.
2. **`setup_auth` warns louder** when the token is empty, naming the file to
   check. Upstream calls it "dev mode"; on an appliance it is a silent gap.
3. **`/health` reports `placement: {"state": "not_applicable", "models": []}`**
   statically, and keeps `schema_version: 2`. Dropping to v1 would be worse
   than useless: ai-gateway's `_LimitsCache` logs a one-time warning on *any*
   non-equal version, so a correct deployment would look like a stale appliance
   forever. `not_applicable` is one of v2's own documented states, and every
   field ai-gateway actually consumes (`limits`) is unchanged.
4. **The manifest lives at `models/model-manifest.json` inside this directory**
   and is baked into the image by the Dockerfile's existing
   `COPY services/inference-manager/ .` (WORKDIR `/app` puts it exactly at
   `DEFAULT_MANIFEST_PATH`). Upstream bind-mounts it as a single *file*, and a
   single-file bind mount breaks when git checks out a different branch under
   it — which this repo's deploy path does routinely.
5. **The two manifest tests read `parents[1]`**, following (4).
6. **`requirements.txt` drops** `prometheus-fastapi-instrumentator`,
   `prometheus-client`, and `apscheduler`, following the removals above. Both
   `.lock` files were regenerated with `scripts/refresh-lockfile.sh`.
7. **`test_shipped_manifest_agrees_with_oci_sources` is not vendored.**
   `models/oci-sources.json` is a build-time packaging input that belongs
   upstream; that cross-check stays there.

## Re-syncing

```bash
# 1. Diff this tree against upstream to see what moved.
git -C ../droplet-local-LLM diff <last-synced-sha>..origin/main -- services/inference-manager/

# 2. Apply what is relevant, skipping anything in "What was removed".
# 3. Re-apply every item under "Deliberate divergences".
# 4. Regenerate the locks if requirements.txt changed:
./scripts/refresh-lockfile.sh
# 5. Update the Provenance table above with the new upstream SHA.
```

**The manifest is the part most likely to drift**, because it is content rather
than code and both copies are edited by hand. A model added upstream will not
appear on a box until it is copied here.
