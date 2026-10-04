# FIPS 140-3 — Allowed Cryptographic Algorithms

**Audience:** auditors, security reviewers, future engineers.
**Question this page answers:** "What cryptography does the Droplet edge appliance use?"
**Source of truth:** checked against [NIST FIPS 140-3 Implementation Guidance](https://csrc.nist.gov/projects/cryptographic-module-validation-program/standards). The cryptographic provider is the **OpenSSL FIPS provider 3.0.9**, cited against NIST CMVP certificate **#4282**, source-built and shipped inside the service images that carry it, on the Debian Bookworm base (WARP-967).

> **Current state (corrected 2026-10-03, WARP-3657).**
>
> - **FIPS mode is opt-in and off by default** (`DROPLET_FIPS_MODE=0`, `DROPLET_FIPS_REQUIRED` false or defaulting to false in the shipped compose). With it off, the provider is present but dormant and the stack runs ordinary OpenSSL algorithms. The tables below describe the **Target** algorithm set for a box with FIPS mode on.
> - **Where it is enforced** when switched on: the services in the scope table in [`docs/fips.md`](../fips.md) that carry the provider (orchestrator, web-dashboard, mcp-server, ai-gateway, file-indexer and the nginx gateway). Other first-party services either are pinned off in `docker/docker-compose.yml` or carry no provider and no FIPS boot gate, and the pulled third-party images (Postgres, Redis, Mosquitto, Nextcloud, Collabora and others) are outside the boundary. The pinned-off services include ones that handle mail and ERP data (email-indexer, erp-sql-bridge).
> - **Known deviations that are not yet in the exceptions registry** are listed under "Known deviations" below.
> - **Certificate applicability is not asserted here.** The certificate number, the standard it was issued under (140-2 or 140-3), its status and its tested operating environments must be verified against the NIST CMVP listing before this page is used as evidence or the words "FIPS 140-3 validated" are used anywhere. The module is built from source in our images, and a validation applies to specific tested builds and environments, so build equivalence is also unconfirmed.


Maintained as part of WARP-229. Updates require a code review + entry in the auditor changelog (see end of page).

---

## At-a-glance (Target algorithm set with FIPS mode on)

| Use case | Algorithm | Key / Output size | Where |
|---|---|---|---|
| Symmetric encryption (data at rest) | AES-256-GCM (column level); AES-XTS (LUKS2 disk) | 256-bit key, 96-bit IV, 128-bit tag (GCM) | WARP-242 per-document encryption; WARP-232 LUKS2 (TPM hardware only) |
| Symmetric encryption (TLS payload) | AES-128-GCM / AES-256-GCM | per cipher suite | All TLS 1.2 / 1.3 across services |
| Authenticated digest | SHA-256, SHA-384, SHA-512 | 256/384/512-bit | Hashing, signatures, audit-log HMAC-SHA-256 hash chain |
| HMAC | HMAC-SHA-256 | 256-bit key | API request signing, session tokens |
| Key agreement (TLS) | ECDH P-256, P-384 | 256/384-bit curve | TLS handshakes, mTLS |
| Digital signature | RSA-2048+ PSS / ECDSA P-256, P-384 | 2048+ / 256+ bit | Cosign release signing (WARP-244), TPM (WARP-230) |
| Key derivation | PBKDF2-HMAC-SHA-256, HKDF-SHA-256 | 256-bit output | BYOK key store (PBKDF2), backup repository key (HKDF). **Account password hashing uses Argon2id, which is not in this approved set; see Known deviations** |
| Random bit generation | CTR_DRBG (AES-256-based) | 256-bit security | OpenSSL DRBG, seeded from kernel `/dev/urandom` |
| TLS protocol | TLS 1.2 (legacy interop) / TLS 1.3 (preferred) | — | All service-to-service + browser-facing connections |

---

## Provider

**OpenSSL FIPS provider 3.0.9** — cited against NIST CMVP certificate #4282 (to be verified against the NIST CMVP listing, see the current-state note above).
- Source-built from the pinned, sha256-verified `openssl-3.0.9` release tarball (`docker/fips/build-openssl-fips.sh`) and installed as `fips.so` into every shipped service image — orchestrator, mcp-server, web-dashboard, file-indexer, ai-gateway (WARP-967). Only the module comes from 3.0.9; runtime `libcrypto`/`libssl` stay Debian Bookworm's (the provider API isolates the validated boundary inside `fips.so`).
- Self-tested at image build time: `openssl fipsinstall` runs the module's KATs and emits `/etc/ssl/fipsmodule.cnf`; the build then asserts the provider loads under the FIPS config and that MD5 is rejected (`docker/fips/install-fips-provider.sh`), plus a runtime-native probe (Node bundled OpenSSL / CPython `_hashlib`) per image.
- Loaded via `OPENSSL_CONF=/etc/ssl/openssl-fips.cnf` (config file shared across services in `docker/openssl-fips.cnf`); Node services additionally need `NODE_OPTIONS=--openssl-shared-config` (node reads the config under its own `nodejs_conf` appname; the flag makes it honor the shared `openssl_conf` key). Each bundled runtime (node's static OpenSSL, pyca cryptography's static OpenSSL) resolves its OWN `fips.so` copy from its baked module dir — never a process-wide `OPENSSL_MODULES` (WARP-1063; the FIPS module cannot be initialized by two libcryptos from one file, openssl#25553). Runtime activation is opt-in, per-customer, default OFF — owned by WARP-318.
- Activation verified at container boot by the per-runtime self-test helper (`@droplet/fips-selftest` for Node services, `services/_shared/fips_selftest.py` for Python services). The container refuses to start if `DROPLET_FIPS_REQUIRED=true` and FIPS is not active.

## Approved digests

| Algorithm | Output | FIPS 140-3 approved | Notes |
|---|---|---|---|
| SHA-224 | 224-bit | yes | Rarely used; SHA-256 preferred |
| SHA-256 | 256-bit | yes | Default digest across the platform |
| SHA-384 | 384-bit | yes | Used in TLS 1.3 + P-384 signatures |
| SHA-512 | 512-bit | yes | High-throughput hashing where keyspace matters |
| SHA-3-256 / SHA-3-384 / SHA-3-512 | 256/384/512-bit | yes | Available but not in primary use |

**Forbidden:** MD5, SHA-1 (any output), MD4, RIPEMD. See "Forbidden algorithms" below.

## Approved ciphers (symmetric)

| Algorithm | Mode | Key size | FIPS 140-3 approved | Notes |
|---|---|---|---|---|
| AES | GCM | 128 / 256 bit | yes | Primary AEAD mode |
| AES | CBC | 128 / 256 bit | yes (with PKCS#7 padding + separate HMAC) | TLS 1.2 cipher suites only |
| AES | CTR | 128 / 256 bit | yes | LUKS2 device encryption |
| AES | XTS | 256 / 512 bit | yes | Disk encryption (WARP-232) |

**Forbidden:** DES, 3DES, RC4, Blowfish, Camellia, ChaCha20-Poly1305 *(approved by NIST as of FIPS 140-3 IG D.4 but not yet activated in the OpenSSL FIPS provider build we ship; reconsider on OpenSSL 3.1+ FIPS module rebase)*.

## Approved asymmetric algorithms

| Algorithm | Use | Key size / curve | FIPS 140-3 approved |
|---|---|---|---|
| RSA-PSS | Signature | ≥ 2048-bit | yes |
| RSA-OAEP | Encryption / key wrap | ≥ 2048-bit | yes |
| ECDSA | Signature | P-256, P-384, P-521 | yes |
| ECDH | Key agreement | P-256, P-384, P-521 | yes |

**Forbidden:** RSA < 2048-bit, DSA (any key size), Ed25519 *(approved by NIST as of FIPS 186-5 but not yet activated in our provider build)*, X25519 *(approved by NIST but not in our provider build — used by WireGuard via the registered exception, see `fips-exceptions.md`)*.

## Approved key derivation

| Algorithm | Notes |
|---|---|
| PBKDF2-HMAC-SHA-256 | Password-based key derivation; ≥ 100,000 iterations |
| HKDF-SHA-256 / HKDF-SHA-384 | TLS key schedule, session keys |
| Counter-mode KDF (NIST SP 800-108) | Token derivation |

## Approved random bit generation

OpenSSL FIPS provider's **CTR_DRBG (AES-256-CTR)**, seeded from the Linux kernel CSPRNG via `/dev/urandom`. The kernel pool is itself seeded by hardware entropy sources (CPU `RDRAND` + interrupt timing). DRBG instance is **reseeded** every 1,000 generate-calls or 1 hour, whichever comes first.

## Approved protocol versions

| Protocol | Status | Where |
|---|---|---|
| TLS 1.3 | preferred | All new TLS connections |
| TLS 1.2 | allowed | Browser interop where 1.3 isn't supported by the client |
| TLS ≤ 1.1, SSLv3, SSLv2 | **forbidden** | Refused at the OpenSSL provider level |
| SSH protocol 2 (OpenSSH 9.x) | allowed | Operator login (off-device) |
| WireGuard | allowed via documented exception | Per-tunnel keys are X25519 (see `fips-exceptions.md` → `wireguard-x25519`); session keys post-handshake are ChaCha20-Poly1305, which is also outside the FIPS provider's current activation set. WireGuard is used for remote access: the routing service provisions per-employee remote-access peers (`apps/orchestrator/src/routes/vpn.ts`), so files and other Workspace data from remote staff cross these tunnels. It is not used for in-cluster traffic. The exception is registered as `wireguard-x25519`; the earlier rationale that the tunnels carry only operator administration traffic was inaccurate and is corrected there. A maintainer should review the risk acceptance with this scope. |

## Edge TLS (nginx gateway) — WARP-1021

The public `:443` terminator is the `gateway` service (`docker/nginx/Dockerfile`):
Debian **Bookworm** nginx linking the **system OpenSSL 3**, with the same
dormant validated provider (`fips.so`, CMVP #4282) baked at build time as the
five service images. The offered cipher suites are keyed on the single
`DROPLET_FIPS_MODE` knob by `/docker-entrypoint.d/00-fips-profile.sh`:

| `DROPLET_FIPS_MODE` | Profile | TLS 1.3 suites | TLS 1.2 suites |
|---|---|---|---|
| `0` (default) | `cipher-profile.default.conf` | OpenSSL defaults (incl. ChaCha20-Poly1305) | `HIGH:!aNULL:!MD5` — byte-identical to the pre-WARP-1021 nginx:alpine posture |
| `1` | `cipher-profile.fips.conf` | `TLS_AES_256_GCM_SHA384`, `TLS_AES_128_GCM_SHA256` only (ChaCha dropped) | `ECDHE-{ECDSA,RSA}-AES{128,256}-GCM-SHA{256,384}` only (no CBC, no ChaCha, no SHA-1) |

The FIPS profile **restricts** the negotiable set — it adds no strength. With
`DROPLET_FIPS_MODE=1` the entrypoint also points nginx's OpenSSL at
`/etc/ssl/openssl-fips.cnf`, so the handshake crypto itself runs on the
validated provider, not just an approved-suite allowlist.

**Out of scope:** the `cache` service (`redis:7-alpine`) stays on Alpine and carries
no FIPS provider. It terminates TLS 1.3 on `:6380` with per-user ACL passwords
(WARP-234), so that TLS runs on Redis's own, non-validated crypto, outside the
FIPS boundary. Revisit if a validated path for the image becomes available.

---

## Known deviations

These uses are not in the approved tables above and are **not yet registered**
in [`fips-exceptions.md`](./fips-exceptions.md). The static lint does not see
them (it matches forbidden call sites such as `createHash("md5")`). They are
listed so the documents match the code (WARP-3657). Resolution is either a
registered exception with a risk acceptance or a FIPS-mode alternative such as
PBKDF2-HMAC-SHA-256; that decision is open.

| Use | Where | Why it is outside the approved set |
|---|---|---|
| Account password hashing (and TOTP recovery-code hashing) | Argon2id via the `argon2` package: `apps/orchestrator/src/services/password.service.ts`, `recovery.service.ts` | Argon2id is not an approved key derivation function |
| SSH login password hash | SHA-512 crypt (`$6$`): `apps/orchestrator/src/lib/sha512-crypt.ts`, used by `ssh-access.service.ts` | The crypt(3) construction is not an approved KDF, although it uses SHA-512 as its primitive. Linux PAM accepts only crypt formats |
| Disk encryption passphrase and recovery slots | LUKS2 Argon2id PBKDF (`docs/security/at-rest-encryption.md`) | Argon2id is not an approved KDF |
| Remote-access VPN | WireGuard (X25519, ChaCha20-Poly1305) | Registered as `wireguard-x25519`; scope is per-user remote access, see the protocol table above |

## Forbidden algorithms

A static lint (`scripts/test-fips.sh`) runs on every PR. It scans `apps/`, `services/`, `packages/`, `scripts/`, and `docker/` for the following forbidden invocations and fails the build on any unescaped match:

| Pattern | Why |
|---|---|
| `hashlib.md5(`, `hashlib.new("md5", ...)` (Python) | MD5 is collision-broken and not FIPS-approved |
| `hashlib.sha1(`, `hashlib.new("sha1", ...)` (Python) | SHA-1 is collision-broken and not FIPS-approved |
| `createHash("md5"\|"sha1")`, `createHmac("md5"\|"sha1")` (Node) | Same |
| `Crypto.Cipher.DES`, `Crypto.Cipher.DES3`, `Crypto.Cipher.ARC4` (PyCryptodome) | Banned ciphers |
| `createCipheriv("des"\|"3des"\|"des-ede3"\|"rc4"\|"arc4", ...)` (Node) | Same |
| `crypto.constants.*RSA*1024*` (Node) | RSA key size below FIPS minimum |
| Literal `TLSv1.0` / `TLSv1.1` | Forbidden TLS protocol versions |
| `ssl_min_protocol_version = TLSv1` (without `.2` or `.3`) | Same |

### Escape mechanism

A protocol-mandated non-FIPS algorithm can be allowed by:

1. Adding a comment within ±2 lines of the matching source line:
   - Python: `# fips:allowed: <reason-id>`
   - TS/JS: `// fips:allowed: <reason-id>`
2. Registering `<reason-id>` in [`docs/security/fips-exceptions.md`](./fips-exceptions.md).

Dead or non-resolving reason-ids fail the lint. Every entry in `fips-exceptions.md` has a documented rationale, owner, and review cadence.

---

## Auditor changelog

| Date | Change | Reviewer |
|---|---|---|
| 2026-05-10 | Initial page published as part of WARP-229. | (TBD) |
| 2026-07-02 | WARP-967: validated `fips.so` (OpenSSL FIPS provider 3.0.9, CMVP #4282) now source-built into every shipped service image with a build-time KAT self-test; provider section updated (was described as the distro 3.0.13 build). | (TBD) |
| 2026-07-05 | WARP-1021: edge TLS moved off `nginx:alpine` to a Bookworm nginx image carrying the same dormant validated provider; `DROPLET_FIPS_MODE`-keyed cipher profiles documented (new "Edge TLS" section); redis:7-alpine explicitly noted out of scope. | (TBD) |
| 2026-10-03 | WARP-3657: page corrected to the shipped defaults. Added current-state note (opt-in, off by default, enforcement scope), certificate verification note, Known deviations (Argon2id, SHA-512 crypt, LUKS2 Argon2id), HMAC hash chain wording in place of "Merkle", WireGuard scope, Redis TLS note. | (TBD) |
