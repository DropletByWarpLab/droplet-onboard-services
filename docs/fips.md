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
full-stack activation smoke test), WARP-1063 (the boot fix: per-libcrypto
module copies + explicit TLS posture + positive self-test probes).

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
.env as it is", never a silent flip). `setup.sh` derives the activation
variables from it and manages them atomically:

| Derived var | FIPS ON | FIPS OFF | Who consumes it |
|---|---|---|---|
| `OPENSSL_CONF` | `/etc/ssl/openssl-fips.cnf` | *(empty → stock)* | Every OpenSSL in every provider container: system libcrypto (Python, Prisma engines, nginx), Node's bundled OpenSSL, pyca `cryptography`'s static OpenSSL |
| `DROPLET_FIPS_REQUIRED` | `true` | `false` | The boot self-test gate in every provider service |
| `NODE_OPTIONS` | `--openssl-shared-config` | *(empty)* | Node (reads the shared `openssl_conf` key instead of `nodejs_conf`) |

`OPENSSL_MODULES` is deliberately **not** set — `setup.sh` actively deletes it
from older `.env`s. The validated `fips.so` cannot be initialized by two
libcrypto instances in one process (upstream limitation,
[openssl#25553](https://github.com/openssl/openssl/issues/25553); the second
activation fails with `common libcrypto routines::init fail`), and several
Droplet processes carry two — Node's bundled OpenSSL + Prisma's system libssl
in the orchestrator/mcp-server, pyca `cryptography`'s static OpenSSL + the
system libssl in ai-gateway/file-indexer. A process-wide `OPENSSL_MODULES`
forces every instance onto the *same* module file; instead each image installs
a dedicated **copy** of `fips.so` into each bundled runtime's own baked
`MODULESDIR` (`docker/fips/install-fips-provider.sh`, WARP-1063), so every
libcrypto resolves and activates its own module.

Do **not** hand-edit the derived vars; `setup.sh --fips/--no-fips` converges
them in both directions (`tests/fips-mode.test.sh` proves the round-trip).

## Verifying a FIPS-on box

Every provider service refuses to start if FIPS is required but not active,
and emits one structured log line when it is:

```sh
# 1) The knob and derived vars are consistent (OPENSSL_MODULES must NOT
#    appear at all — WARP-1063):
grep -E '^(DROPLET_FIPS_MODE|OPENSSL_CONF|DROPLET_FIPS_REQUIRED|OPENSSL_MODULES|NODE_OPTIONS)=' .env

# 2) Each self-testing service logged its boot self-test. Since WARP-1063 a
#    fips:true line also proves the provider is ALIVE (the self-test requires
#    an approved digest, SHA-256, to WORK — a dead provider logs fips:false
#    with a provider-not-active reason instead):
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

**Symptom.** With FIPS ON, a service that constructs a TLS client dies:
OpenSSL reports `library has no ciphers` (error `0A0000A1`). Prisma surfaces
it as `P1011: Error opening a TLS connection`; Python's `ssl` raises
`ssl.SSLError: [SSL: LIBRARY_HAS_NO_CIPHERS]`.

**What it means (root-caused + fixed by WARP-1063).** This error means **the
validated provider is not active in the libcrypto instance that threw** — not
that a peer offered bad suites. Under the shared config's
`default_properties = fips=yes` pin, a libcrypto whose `fips` provider failed
to activate has **zero fetchable algorithms**, so a default `SSL_CTX` comes up
with no ciphersuites and TLS-client construction fails *before any peer is
contacted*. Deceptively, such a process still *looks* enforcing to the old
checks: Node's `getFips()` and pyca `cryptography`'s `_fips_enabled` mirror
the property pin (not provider state), and MD5 is refused because *everything*
is refused. That is exactly how the WARP-317 smoke test first hit this as an
undiagnosed boot block: several Droplet processes host **two** libcrypto
instances (Node bundled OpenSSL + Prisma's system libssl; pyca
`cryptography`'s static OpenSSL + the system libssl), and the FIPS module
cannot be initialized by two libcryptos resolving the *same* `fips.so` file
([openssl#25553](https://github.com/openssl/openssl/issues/25553) — the second
activation fails with `common libcrypto routines::init fail`). The old
process-wide `OPENSSL_MODULES` forced exactly that collision; whichever
instance initialized second lost, and its first TLS client crashed the boot.

**The WARP-1063 fix** (all landed):
- no process-wide `OPENSSL_MODULES`; each image installs a dedicated **copy**
  of `fips.so` into every bundled runtime's own baked `MODULESDIR`
  (`docker/fips/install-fips-provider.sh`), so each libcrypto activates its
  own module;
- `docker/openssl-fips.cnf` pins an explicit FIPS-approved TLS posture on the
  default context (`ssl_conf`/`system_default`: AES-GCM `CipherString` +
  `Ciphersuites`, `MinProtocol TLSv1.2`) matching the nginx edge profile;
- both boot self-tests gained a **positive probe** — an approved digest
  (SHA-256) must *work* — so a dead provider now fails the boot with
  `fips_self_test fips:false` and a provider-not-active reason instead of an
  opaque TLS error three stack frames later.

**Quick diagnosis if you ever see it again.**

1. *Which libcrypto threw?* If the `fips_self_test` line says `fips:false`
   with an "approved digest SHA-256 unavailable" reason, the provider did not
   activate in that service's *primary* instance — check `fips.so` presence in
   the consuming runtime's baked `MODULESDIR`, `/etc/ssl/fipsmodule.cnf`
   integrity, and that nothing reintroduced a process-wide `OPENSSL_MODULES`
   (an empty value is NOT harmless: it becomes a real, empty search path).
2. *Self-test green but a TLS client still dies?* Then a *secondary* libcrypto
   instance in that process lost its activation — the openssl#25553 collision
   above. Verify the per-runtime module copies exist (the image build probes
   enforce this) and that the two instances resolve *different* `fips.so`
   inodes.
3. *Is a specific peer the problem instead?* If a handshake reaches a peer and
   only *then* fails, check whether that peer offers a FIPS-approved suite
   (ChaCha-only / CBC-SHA1 peers are unfixable without changing the peer or
   scoping it out). The **future** Postgres-TLS case (WARP-233 enforcing
   `sslmode=require`) is this kind — its reconciliation (FIPS-path-scoped
   `sslmode=disable` vs. server-side FIPS ciphers) is owned by that review.

## Failure mode: a VENDOR PROTOCOL mandates a non-approved digest

**Symptom.** With FIPS ON, one feature of an otherwise-healthy integration
throws `ERR_OSSL_EVP_UNSUPPORTED` (`error:0308010C:digital envelope
routines::unsupported`) — Node — or `ValueError: unsupported hash type` —
Python — while every other call in the same service keeps working. Nothing is
wrong with the provider: it is enforcing exactly as designed. The code asked
it for an algorithm FIPS does not have.

**The shipped case: Mailchimp subscriber hashing (WARP-2460).** Mailchimp
addresses a single list member by the **MD5 of the lowercased email address**
— `GET /3.0/lists/{list_id}/members/{subscriber_hash}`. It is the vendor's
URL addressing scheme and the API offers no other way to key a member. A
`node:crypto` MD5 there throws before any request is made, so on a FIPS box
list and campaign reads would keep working while **every contact read failed**
— a connector that half-works, with an error that reads like a crypto bug.

**Why that is acceptable, and how it is resolved.** The digest is an
*identifier*, not a security primitive: it authenticates nothing, protects
nothing, and is not secret — the same address must always produce the same
hash, because that is how the URL is formed. Such a use does not need, and
must not take, a FIPS-approved algorithm — it needs a digest that is simply
**independent of the provider**. `services/erp-connector/src/mailchimp/md5.ts`
is an arithmetic RFC 1321 implementation with **no imports at all**; it
reaches no OpenSSL provider and behaves identically with the knob on or off.
Registered as `mailchimp-subscriber-hash` in
[`docs/security/fips-exceptions.md`](security/fips-exceptions.md).

Note the digest is not a privacy control either — MD5 of an email address is
trivially reversible by dictionary attack — so its output is treated as
equivalent to the address itself in logs and exports.

**The general rule when you meet this.** Ask *what the digest is for* before
reaching for a workaround:

- **It secures something** (authentication, signature, integrity, key
  derivation) → this is a real finding. Move to a FIPS-approved algorithm; see
  [`docs/security/fips-allowed-algorithms.md`](security/fips-allowed-algorithms.md).
- **A third-party protocol mandates it and it secures nothing** → implement it
  independently of the provider (or use a pure-language library), and register
  the exception. Do **not** reach for `setFips(0)`, a process-wide
  `OPENSSL_CONF` override, or a second provider: Node exposes no per-call
  provider selection, so every one of those disables FIPS for the whole
  process to serve one call.
- Either way the exception registry is not optional. Note the static lint
  matches *call sites* (`createHash("md5")`, `hashlib.md5(`), so a hand-rolled
  implementation matches no pattern and will pass silently — register it
  anyway, or the next auditor grepping for MD5 will not find it.

## Scope — which services enforce

| Service | Provider in image | Under `--fips` | Why |
|---|---|---|---|
| orchestrator | ✅ (WARP-967) | boots FIPS-enforcing with working TLS clients — Node and Prisma's system libssl each activate their own `fips.so` copy (WARP-1063) | The FIPS boundary |
| ai-gateway | ✅ (WARP-967) | boots FIPS-enforcing with working TLS clients — pyca `cryptography` and the system libssl each activate their own copy (WARP-1063) | The FIPS boundary |
| web-dashboard, mcp-server | ✅ (WARP-967) | enforce (mcp-server's lazy Postgres hop works via the system-libssl copy) | The FIPS boundary |
| file-indexer | ✅ (WARP-967) | boots FIPS-enforcing — same dual-instance shape and fix as ai-gateway | The FIPS boundary |
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
