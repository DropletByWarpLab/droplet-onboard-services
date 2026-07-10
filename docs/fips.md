# FIPS 140-3 Mode — Operator & Auditor Guide

**Audience:** operators flipping the option, auditors verifying it, engineers
debugging it.
**One-line summary:** FIPS mode is a **per-customer runtime option, default
OFF**, switched by a single knob (`DROPLET_FIPS_MODE`), that makes every
crypto-bearing service run on the **NIST-validated OpenSSL FIPS provider**
(OpenSSL 3.0.9 module, CMVP certificate **#4282**) that is already baked —
dormant — into every shipped image. Flipping it requires **no rebuild**.

Related: [`docs/security/fips-allowed-algorithms.md`](security/fips-allowed-algorithms.md)
(what crypto is allowed), [`docs/security/fips-exceptions.md`](security/fips-exceptions.md)
(registered escapes), [`docs/ENVIRONMENT.md`](ENVIRONMENT.md) (the env-var
contract), [`docs/compliance-progress.md`](compliance-progress.md) (program
status). Tickets: WARP-229 (apparatus + lint), WARP-967 (validated module in
every image), WARP-316 (CI build gate + sabotage proof), WARP-318 (customer
option), WARP-1021 (FIPS-capable nginx edge), WARP-317 (this guide + the
full-stack activation smoke test).

---

## What FIPS mode means (and does not mean)

- **It RESTRICTS algorithms; it does not add strength.** FIPS 140-3 narrows
  the usable crypto to the validated set (AES-GCM, SHA-2, ECDHE, RSA≥2048…)
  for *certification* purposes. MD5, ChaCha20-Poly1305, X25519, Ed25519 stop
  working in OpenSSL-backed code paths. A FIPS-on box is not "more secure"
  in the informal sense — it is *provably confined* to validated crypto.
- **Default posture is byte-identical to a non-FIPS install.** With
  `DROPLET_FIPS_MODE=0` (the default) the rendered compose config is exactly
  today's: OpenSSL defaults, TLS 1.3 with ChaCha available at the edge,
  `crypto.getFips() === 0`, MD5 available. The provider ships in the images
  either way — **dormant**.
- **The FIPS boundary is the six provider-carrying images**: `orchestrator`,
  `web-dashboard`, `mcp-server`, `ai-gateway`, `file-indexer` (WARP-967) and
  the `gateway` nginx edge (WARP-1021). Each installs `fips.so` at build time
  and fails its *image build* if the module's Known Answer Tests fail
  (`docker/fips/install-fips-provider.sh`, gated per-PR by
  `docker-build.yml`).
- **Everything else is deliberately outside the boundary** and is *pinned*
  out of the FIPS boot gate (see [Scope](#scope-which-services-enforce)).

## Activating / deactivating

```sh
# turn ON (rewrites .env; no image rebuild):
./scripts/setup.sh --fips --skip-docker --skip-build --skip-drivers
docker compose -f docker/docker-compose.yml --env-file .env up -d   # restart the stack

# turn OFF (restores the byte-identical default posture):
./scripts/setup.sh --no-fips --skip-docker --skip-build --skip-drivers
docker compose -f docker/docker-compose.yml --env-file .env up -d
```

`DROPLET_FIPS_MODE` is the **only** thing an operator sets, and only through
`setup.sh` (explicit boolean — the flag is tri-state: absent means "leave the
.env as it is", never a silent flip). `setup.sh` derives the four activation
variables from it and manages them atomically:

| Derived var | FIPS ON | FIPS OFF | Who consumes it |
|---|---|---|---|
| `OPENSSL_CONF` | `/etc/ssl/openssl-fips.cnf` | *(empty → stock)* | Python services (system libcrypto) + nginx + Prisma engines |
| `DROPLET_FIPS_REQUIRED` | `true` | `false` | The boot self-test gate in every provider service |
| `OPENSSL_MODULES` | system `ossl-modules` dir | *(empty)* | Node's bundled OpenSSL (its baked-in module dir is not Debian's) |
| `NODE_OPTIONS` | `--openssl-shared-config` | *(empty)* | Node (reads the shared `openssl_conf` key instead of `nodejs_conf`) |

Do **not** hand-edit the derived vars; `setup.sh --fips/--no-fips` converges
them in both directions (`tests/fips-mode.test.sh` proves the round-trip).

## Verifying a FIPS-on box

Every provider service refuses to start if FIPS is required but not active,
and emits one structured log line when it is:

```sh
# 1) The knob and derived vars are consistent:
grep -E '^(DROPLET_FIPS_MODE|OPENSSL_CONF|DROPLET_FIPS_REQUIRED|OPENSSL_MODULES|NODE_OPTIONS)=' .env

# 2) Each self-testing service logged its boot self-test:
for s in orchestrator mcp-server ai-gateway file-indexer; do
  docker compose -f docker/docker-compose.yml --env-file .env logs "$s" \
    | grep '"event":"fips_self_test"'
done
# → {"event":"fips_self_test","service":"…","fips":true,"provider":"OpenSSL 3 FIPS"}

# 3) The edge selected the FIPS cipher profile (WARP-1021):
docker compose -f docker/docker-compose.yml --env-file .env logs gateway \
  | grep '"event":"fips_edge_tls"'          # → …"fips":true…
echo | openssl s_client -connect <box>:443 -brief 2>&1 | grep Ciphersuite
# → TLS_AES_256_GCM_SHA384 (an AES-GCM suite; a ChaCha-only client is refused)

# 4) The provider is genuinely enforcing (MD5 must FAIL in both stacks):
docker compose -f docker/docker-compose.yml --env-file .env exec ai-gateway \
  python -c 'import _hashlib; _hashlib.new("md5", b"x", usedforsecurity=True)'   # error = correct
docker compose -f docker/docker-compose.yml --env-file .env exec orchestrator \
  node -e 'const c=require("crypto");console.log("fips",c.getFips());c.createHash("md5")' # throws = correct

# 5) Operator endpoint (no auth, GET only):
curl -sk https://<box>/_/fips     # → {"fips": true/false, …} from the orchestrator
```

The same checks run end-to-end in CI: `tests/integration/fips-stack.test.sh`
boots the full compose stack with `DROPLET_FIPS_MODE=1` and asserts all of
the above plus API liveness (`/api/llm/conversations`,
`/api/files/search/status`, `/api/calendar/places`) — see the `fips-stack`
job in `.github/workflows/test-fips.yml`.

## Developer opt-out

Do nothing: the default is OFF. The boot self-test skips silently whenever
`DROPLET_FIPS_REQUIRED` is unset/`false` (dev/CI default), so dev boxes,
unit-test lanes, and macOS Docker Desktop never need the provider active.
If you flipped a dev box on and want out: `./scripts/setup.sh --no-fips
--skip-docker --skip-build --skip-drivers` and restart the stack.

## Failure mode: "library has no ciphers" (`P1011` / `LIBRARY_HAS_NO_CIPHERS`)

**Symptom.** With FIPS ON, a service that constructs a TLS client at startup
dies immediately: OpenSSL reports `library has no ciphers` (error `0A0000A1`).
Prisma surfaces it as `P1011: Error opening a TLS connection`; Python's `ssl`
raises `ssl.SSLError: [SSL: LIBRARY_HAS_NO_CIPHERS]`. Observed on the
orchestrator (Prisma `$connect`, before the API server listens) and the
ai-gateway (httpx `ssl.create_default_context()` building the Ollama client).

**KNOWN OPEN DEFECT (WARP-317 finding, awaiting a WARP-967/WARP-318 fix).**
This is **not** about a peer offering the wrong suites. The shared FIPS config
`docker/openssl-fips.cnf` activates only the `fips` + `base` providers and pins
`default_properties = fips=yes`. Under that config a **default client
`SSL_CTX` comes up with zero usable ciphersuites**, so *constructing any TLS
client fails before a peer is contacted*. The validated provider itself is
fine — it loads and enforces (boot self-tests pass, MD5 is refused); the gap is
that the config never re-exposes the FIPS-approved TLS suites to the default
context. **The fix belongs to the provider-config work** (add an
`ssl_conf`/`system_default` section to `docker/openssl-fips.cnf` that sets a
FIPS-approved `CipherString`/`Ciphersuites` on the default context), not to any
one service and not to a `DATABASE_URL` edit. WARP-317's `fips-stack` test
asserts this failure as the *expected* current behavior and flips to asserting
a clean boot once `EXPECT_FIPS_STACK_BOOTS=1` is set after the config fix.

**Quick diagnosis.**

1. *Is the provider loaded + enforcing?* Inside the container:
   `openssl list -providers` (with the container's `OPENSSL_CONF`) must show
   `fips … version: 3.0.9 … status: active`. If it does **not**, a
   non-provider image got the FIPS env by mistake (see the compose pins) or
   the image predates WARP-967 — that is a *different* bug from the one above.
2. *Where does it throw?* If the traceback is in TLS-client construction
   (`create_default_context`, `SSL_CTX_new`, Prisma `$connect`) rather than
   during a handshake with a specific peer, it is the default-context
   no-ciphers defect above — the config, not the peer.
3. *Is a specific peer the problem instead?* If a handshake reaches a peer and
   only *then* fails, check whether that peer offers a FIPS-approved suite
   (ChaCha-only / CBC-SHA1 peers are unfixable without changing the peer or
   scoping it out). The **future** Postgres-TLS case (WARP-233 enforcing
   `sslmode=require`) is this kind — its reconciliation (FIPS-path-scoped
   `sslmode=disable` vs. server-side FIPS ciphers) is owned by that review and
   stacks *on top of* fixing the default-context defect first.

## Scope — which services enforce

| Service | Provider in image | Under `--fips` | Why |
|---|---|---|---|
| orchestrator | ✅ (WARP-967) | provider enforces (self-test passes); **app boot currently blocked** by the default-context no-ciphers defect (Prisma `$connect` → `P1011`) | The FIPS boundary |
| ai-gateway | ✅ (WARP-967) | provider enforces (self-test passes); **app boot currently blocked** (httpx `create_default_context` → `LIBRARY_HAS_NO_CIPHERS`) | The FIPS boundary |
| web-dashboard, mcp-server | ✅ (WARP-967) | enforce; no boot-time default-context TLS client, so they stay up (mcp-server's Postgres use is lazy) | The FIPS boundary |
| file-indexer | ✅ (WARP-967) | provider enforces; same Prisma-client boot block as the orchestrator when its watch loop connects | The FIPS boundary |
| gateway (nginx edge) | ✅ (WARP-1021) | FIPS cipher profile + provider for edge TLS | Customer-facing TLS termination |
| matter-controller, email-indexer, device-identity-svc, camera-discovery, fleet-agent | ❌ | **pinned OFF** in compose (`DROPLET_FIPS_REQUIRED=false`, stock `OPENSSL_CONF`) | No validated module in the image — the pin prevents a `setup.sh --fips` crash-loop (the boot self-test would exit 1 forever). Enforcement here is a deliberate future decision, not an oversight. |
| cache (redis:7-alpine) | ❌ | untouched | Terminates no TLS (plaintext on the private bridge, `requirepass`-guarded; WARP-234 owns the Redis-TLS hop) and performs no customer-facing crypto. Alpine/musl has no validated provider path. |
| db, nextcloud, broker, frigate, ollama, … (pulled images) | ❌ | untouched | `OPENSSL_CONF` points at a path that does not exist in these images; OpenSSL ignores a missing config file. |

Application-source discipline is enforced separately and always-on:
`scripts/test-fips.sh` (PR-blocking static lint) fails any PR introducing
MD5/SHA-1/DES/small-RSA/TLS≤1.1 without a registered exception in
[`docs/security/fips-exceptions.md`](security/fips-exceptions.md) — so the
code is FIPS-clean even on boxes running with the knob OFF.

## How CI keeps this honest

| Layer | Where | What breaks the build |
|---|---|---|
| Source lint | `test-fips.yml` → `fips-lint` (PR-blocking) | A non-FIPS algorithm in source without a registered escape |
| Build-time module gate | `docker-build.yml` (required check) | `fips.so` KATs fail, provider won't load, or MD5 survives in any image build |
| Sabotage proof | `test-fips.yml` → `fips-sabotage` | Removing `fips.so` does *not* break the gate (i.e. the gate is a no-op) |
| Full-stack activation | `test-fips.yml` → `fips-stack` (gated on FIPS option paths) | The stack fails to boot FIPS-enforcing end-to-end, the edge accepts ChaCha, MD5 works at runtime, or a non-provider service crash-loops |
| Harness logic | `test-fips.yml` → `fips-lint` step | `tests/fips-stack-logic.test.sh` — the stack harness or the compose pins regress, even on Docker-less runners |
