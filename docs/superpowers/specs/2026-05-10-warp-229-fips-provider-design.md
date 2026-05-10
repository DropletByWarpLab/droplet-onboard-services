# WARP-229 — FIPS 140-3 cryptographic provider + non-FIPS algorithm CI lint

**Status:** Design approved 2026-05-10. Spec → Plan → Single PR → admin-merge.

**Parent epic:** [WARP-228](https://warp-lab.atlassian.net/browse/WARP-228) — Trust & Compliance Foundations.

**Sequential position:** Ticket 1 of 50. Blocks WARP-230 (TPM device identity), which depends on FIPS-validated cryptographic primitives being available system-wide.

## Goals

1. Every Droplet application service container loads a FIPS 140-3 validated cryptographic provider at startup and refuses to start if it doesn't.
2. Every PR that introduces a non-FIPS-approved algorithm in source code is blocked at CI by a deterministic static check, with an audit-trail-friendly escape mechanism for protocol-mandated legacy uses.
3. Anyone (auditor, future engineer, security reviewer) can answer the question "what crypto does this device use?" in 30 seconds by reading two markdown files.

## Non-goals

- Postgres / Redis / MQTT data-store FIPS hardening — covered by WARP-233 / WARP-234 / WARP-235 respectively. WARP-229 enforces FIPS on **application service code paths**, not on the data-store wire protocols.
- Network TLS configuration changes — covered by the same downstream tickets.
- HSM-backed key management — covered by WARP-244 (cosign release signing).
- Replacing protocol-required non-FIPS algorithms (RTSP Digest MD5, WireGuard X25519). These are explicitly allowlisted with documented justification.

## Discoveries during brainstorm

Three findings shape the design:

1. **Mixed base images.** Node services use `node:20-alpine` (Alpine has no OpenSSL FIPS provider). Python services already use `python:3.12-slim` (Debian Bookworm — FIPS-capable). Node containers must migrate to `node:20-bookworm-slim`.
2. **Three real legitimate non-FIPS uses already in the code:**
   - `services/camera-discovery/rtsp_prober.py` — MD5 in RTSP Digest auth (RFC 2617 mandates it). Allowlisted.
   - `services/routing/droplet_openwrt_sdk.py` — X25519 for WireGuard keys (RFC mandates X25519; not in FIPS-approved curve list). Allowlisted.
   - `services/file-indexer/brain_ingest.py:291` — MD5 of an item_id for storage path fingerprinting. **Not protocol-mandated; replaced with SHA-256 in this PR.**
3. **Existing pattern to mirror.** `scripts/test-security.sh` already runs as a PR-required static security check. `test-fips.sh` follows the same shape, alongside it.

## Locked decisions from brainstorm

| Q | Decision |
|---|---|
| How do we handle protocol-mandated non-FIPS algorithms? | **A** — global FIPS mode + documented per-line allowlist for protocol exceptions, validated against a registry doc. |
| Which FIPS provider? | **OpenSSL 3 FIPS provider** (NIST cert #4282) — universal across Node + Python + Postgres + Redis + MQTT, ships with Debian Bookworm. |
| Single PR or staged rollout? | **A** — single PR migrating every service together. Mechanical work once the pattern is established; cleaner audit story. |

## Architecture

### Container base image migration

| Service | Before | After |
|---|---|---|
| `apps/orchestrator` | `node:20-alpine` (build + run) | `node:20-bookworm-slim` (both stages) |
| `apps/web-dashboard` | `node:20-alpine` runtime | `node:20-bookworm-slim` runtime; build stage may stay Alpine (no crypto at build) |
| `services/mcp-server` | `node:20-alpine` | `node:20-bookworm-slim` |
| `services/file-indexer`, `services/ai-gateway`, `services/camera-discovery`, `services/routing`, `services/switch`, `services/oled-display`, `services/automount` | `python:3.12-slim` (Debian Bookworm) | unchanged base; FIPS provider activated via env + apt package |

### FIPS provider activation per runtime

**Node services** — Dockerfile additions:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf

# Run with FIPS enabled
CMD ["node", "--enable-fips", "--openssl-config=/etc/ssl/openssl-fips.cnf", "dist/index.js"]
```

`docker/openssl-fips.cnf` (single file shared across all Node services) loads the FIPS provider as default and sets `fips=yes` as the default property.

**Python services** — Dockerfile additions:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV OPENSSL_CONF=/etc/ssl/openssl-fips.cnf
COPY docker/openssl-fips.cnf /etc/ssl/openssl-fips.cnf
```

The `cryptography` Python library auto-honors `OPENSSL_CONF` and refuses non-FIPS algorithms at call time.

### Self-test contract

Each service, at startup, calls `assertFipsAtBoot(serviceName)` (TS) or `assert_fips_at_boot(service_name)` (Python). The helper:

1. Confirms `crypto.getFips()` (Node) or `backend._fips_enabled` (Python) is true.
2. Negative-confirms by attempting MD5 and asserting the call raises a FIPS-disabled error.
3. Logs a structured JSON line: `{"event":"fips_self_test","service":"<name>","fips":true,"provider":"OpenSSL 3 FIPS"}`.
4. On failure, the helper exits with non-zero. Container won't start.

HTTP-bearing services additionally expose `GET /_/fips` returning the same payload, used by integration tests and `scripts/verify-fips.sh` (operator runtime check).

### Helper packages

- `packages/fips-selftest/` — new TypeScript workspace package. Exports `assertFipsAtBoot()`. Used by orchestrator, mcp-server, web-dashboard.
- `services/_shared/fips_selftest.py` — new Python helper file copied into each Python service's image (we don't ship internal Python packages; build-time copy is fine).

## Static lint — `scripts/test-fips.sh`

### Forbidden patterns

| Algorithm / Property | Pattern (regex) | Rationale |
|---|---|---|
| MD5 (Python) | `hashlib\.md5\(` and `hashlib\.new\(\s*['\"]md5['\"]` | Not in FIPS-approved digests |
| MD5 (TS / Node) | `createHash\s*\(\s*['\"]md5['\"]` and `createHmac\s*\(\s*['\"]md5['\"]` | Same |
| SHA-1 | as above with `sha1` | Same |
| RC4 / DES / 3DES | `Crypto\.Cipher\.(DES|ARC4)` and Node `createCipheriv\s*\(\s*['\"](des|3des|rc4)` | Banned ciphers |
| RSA < 2048 | `crypto\.constants\..*RSA.*1024` | Below FIPS-approved key size |
| TLS < 1.2 | `TLSv1\.0|TLSv1\.1` and `ssl_min_protocol_version\s*=\s*TLSv1[^.]` | Banned protocols |

### Scan scope

- **Yes:** `apps/`, `services/`, `packages/`, `scripts/`, `docker/` config files
- **No:** `node_modules/`, `__pycache__/`, `dist/`, `build/`, `.git/`, vendored protobufs, `tests/fixtures/` (fixture data may legitimately contain forbidden bytes)

### Escape mechanism

A forbidden match in a file is allowed if a `fips:allowed: <reason-id>` comment appears within ±2 lines:

- TypeScript / JavaScript: `// fips:allowed: rtsp-digest-rfc2617`
- Python: `# fips:allowed: rtsp-digest-rfc2617`

The `<reason-id>` must resolve to an entry in `docs/security/fips-exceptions.md`'s YAML front-matter. The lint also fails if the reference doesn't resolve, preventing dead allowlists.

### CI wiring

`.github/workflows/test-fips.yml` — runs `scripts/test-fips.sh` on every PR and on every push to `main`. Required check on all PRs touching `apps/`, `services/`, `packages/`, `scripts/`, or `docker/`. Same path-filter pattern as the existing `test-security.yml`.

## Documentation

### `docs/security/fips-allowed-algorithms.md`

Single-page reference: every approved algorithm + key size + use case. Forbidden list with rationale. Maintained as the auditor-facing answer to "what crypto does this device use?"

### `docs/security/fips-exceptions.md`

Registry of every line-level escape. YAML front-matter for machine validation, markdown body for auditor reading. Initial entries:

- `rtsp-digest-rfc2617` — MD5 in `services/camera-discovery/rtsp_prober.py`. Annual review.
- `wireguard-x25519` — X25519 in `services/routing/droplet_openwrt_sdk.py`. Annual review.

The third candidate (`brain-item-id-fingerprint`) is **not** allowlisted; the underlying MD5 is replaced with SHA-256 in this PR.

### README addendum

Pointers to both docs. Brief description of the FIPS posture.

## Test coverage

### Per-service unit tests

For each application service:

1. **Positive:** assert FIPS provider is loaded at module import (`crypto.getFips()` true / `backend._fips_enabled` true).
2. **Negative:** assert MD5 call raises a FIPS-disabled error.
3. **Integration (HTTP services):** `GET /_/fips` returns 200 + `{fips: true}`.

### Lint test

`tests/test-fips-script.sh` (new):
- Feeds known-bad source samples to `scripts/test-fips.sh` and asserts non-zero exit.
- Feeds known-good samples and asserts zero exit.
- Feeds known-bad-with-valid-allowlist-comment and asserts zero exit.
- Feeds known-bad-with-broken-allowlist-ref and asserts non-zero exit.

## Phasing — commit order in the single PR

1. `tooling: add fips-selftest packages` — `packages/fips-selftest/` + `services/_shared/fips_selftest.py` with their own unit tests; no consumers yet.
2. `tooling: add scripts/test-fips.sh + GitHub Actions workflow` — workflow in **report-only mode** for this commit so CI doesn't break before allowlist entries are added.
3. `docs(security): allowed algorithms + exceptions registry skeleton`.
4. `fix(file-indexer): replace MD5 item-id fingerprint with SHA-256` — eliminates the third "exception" candidate.
5. `feat(camera-discovery): add fips:allowed escapes for RTSP digest-auth`.
6. `feat(routing): add fips:allowed escapes for WireGuard X25519`.
7. `build(orchestrator): migrate to node:20-bookworm-slim + FIPS provider` — Dockerfile, entrypoint, boot self-test, tests.
8. `build(mcp-server): migrate to node:20-bookworm-slim + FIPS provider`.
9. `build(web-dashboard): runtime to node:20-bookworm-slim`.
10. `build(file-indexer + ai-gateway + connectors): activate FIPS in python:3.12-slim` — across these specific Python services.
11. `build(camera-discovery + routing + switch + automount + oled-display): activate FIPS` — the remaining Python services.
12. `ci: flip test-fips.yml from report-only to PR-blocking + README update`.

## Error handling

| Failure | Behavior |
|---|---|
| FIPS provider not loaded at boot | Service exits non-zero; container won't start; structured error logged. |
| `assertFipsAtBoot` import-time failure | Same — fail-closed. |
| `OPENSSL_CONF` env var missing | Boot self-test fails (FIPS not loaded). |
| Lint regex matches without escape comment | `test-fips.sh` exits non-zero with file:line + matched algorithm. |
| Allowlist comment with non-resolving reason-id | `test-fips.sh` exits non-zero with file:line + the bad reason-id. |
| Audit log integration (WARP-237) not yet shipped | Boot self-test logs to stdout in structured JSON; WARP-237's ingestor picks it up retroactively. |
| Performance regression on TLS hot path | Benchmark in orchestrator's perf tests; if >10% regression, file separate follow-up. Not in WARP-229 scope to fix. |

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Node 20 + Bookworm-slim adds ~80 MB per Node image vs Alpine ~50 MB | high | Accept; resource budget on Jetson has 6-9 GB headroom (design doc §7.6). |
| FIPS provider rejects an unexpected library call path | medium | Boot self-test fails closed; caught at first PR-CI run, not in production. |
| `cryptography._fips_enabled` is internal API — may change | low | Behind our `assert_fips_at_boot` helper; one place to fix on upgrade. |
| Two-line escape misused as silencing | medium | Escape requires registry-doc resolution; new entries trigger code-review for the doc. Annual review process. |
| Performance regression on TLS handshake | medium | Benchmark before/after in orchestrator perf tests. Follow-up ticket if >10%. |

## Acceptance criteria

- ✅ Every application service container, on boot, emits a structured `fips_self_test` log line with `fips:true`.
- ✅ Per-service test exists asserting an MD5 call raises a FIPS-disabled error.
- ✅ `scripts/test-fips.sh` exists, wired into `.github/workflows/test-fips.yml`, marked PR-required.
- ✅ `docs/security/fips-allowed-algorithms.md` published.
- ✅ `docs/security/fips-exceptions.md` published with the two real protocol exceptions registered.
- ✅ `services/file-indexer/brain_ingest.py` MD5 fingerprint replaced with SHA-256.
- ✅ README links to both security docs.
- ✅ `docs/compliance-progress.md` updated: WARP-229 row → ✅ done; workstream rollup; "Recent closes" entry.
- ✅ All other PR-required workflows still green.
- ✅ Single PR, admin-merged after CI green.

## Out of scope

- TPM-sealed device identity — WARP-230.
- UEFI Secure Boot + signed kernel + dm-verity — WARP-231.
- LUKS2 disk encryption — WARP-232.
- Postgres / Redis / MQTT TLS hardening — WARP-233 / 234 / 235.
- Internal service mTLS — WARP-236.
- Audit log integration — WARP-237 (boot self-test logs to stdout in the meantime; ingestor will pick up retroactively).
- HSM-backed release signing — WARP-244.
- Performance optimization for FIPS-induced regression — separate follow-up if needed.
