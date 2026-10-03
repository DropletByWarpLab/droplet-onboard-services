# ADR-068: One fleet identity per box; private OTA through a read-only HQ registry; operational telemetry and logs to the portal

- **Status:** Proposed, 2026-10-03 ([WARP-3423](https://warp-lab.atlassian.net/browse/WARP-3423)). The decisions it records are Romain's, 2026-10-03, quoted below and on the ticket (comments 15566 and 15567).
- **Supersedes:** [`ADR-066`](ADR-066-ota-update-delivery-without-registry-credentials.md) (anonymous delivery from public GHCR packages). What still holds from it is listed in §6.
- **Builds on:** [`ADR-020`](ADR-020-appliance-image-build-and-flash-pipeline.md) (the signed manifest), [`ADR-023`](ADR-023-public-ca-per-device-tls-via-hq-dns01.md) and its Worker amendment in `droplet-fleet-hq` (HQ device registry and device-key proof of possession), [`ADR-028`](ADR-028-fleet-telemetry-and-design-answers.md) (no Warp-operated servers; the update signing key stays off the portal, Cloudflare and HQ; one on-device agent), [`ADR-045`](ADR-045-client-app-distribution.md) ("no GitHub token may ever sit on a customer appliance"), [`ADR-012`](ADR-012-phone-home-egress-control.md) (egress discipline), WARP-1670 (stage and stable channels).
- **Binding contract:** "Fleet identity, private OTA and operational telemetry: shared contract v1". The wire details in §2–§4 restate it; every implementation PR builds from it.
- **Number:** 068 is unclaimed by any open PR on 2026-10-03. Re-check before merge.

## Context

ADR-066 (2026-10-01) made the first-party images public so boxes could pull them with no credential. Two days later Romain reversed that and widened the scope:

> "I don't want our images public for now, re-evaluate solutions to keep it automated but not publicly available."

> "Yes with A and I want to update the ADR to reflect this as well. We need a way to authenticate boxes and trace the activity. No customer data but activity, uptime, machine usage etc."

> "update droplet-analytics as well to be ready to receive the data from the telemetry and logs as well."

Option A, as recorded on WARP-3423: a **read-only OCI registry on Cloudflare (Worker + R2) extending fleet HQ**. It accepts a short-lived pull JWT, which HQ mints after the same device-key proof it already verifies for TLS issuance.

The constraints, all verified on 2026-10-03:

- **Only image pulls need a credential.** `droplet-onboard-services` is public, so `release.json`, its signature, `configs.tar.gz` and the signed channel pointer already download anonymously.
- **Integrity never depended on the transport.** The signed manifest pins every image by digest, and cosign verifies each image offline against the publish-workflow identity. Any mirror works.
- **GHCR cannot mint a short-lived pull credential, and ADR-045 bans a GitHub token on a box.**
- **ADR-028 rules out a Warp-operated server.** The portal cannot serve image bytes. Fleet HQ is a Cloudflare Worker that runs on every box by default (`fleet-hq-issuance`), and it already checks a nonce and a device-key signature.
- **The device key is a mock everywhere.** `device-identity-svc` runs a software ECDSA P-256 key in every deployment, because the real TPM backend is still a scaffold.

## Decision

### 1. One box identity

- **The key.** Each box has one device key, an ECDSA P-256 key held by `device-identity-svc`. It is a **mock software key** today: the private key sits in the sidecar's storage, so it is per-box and revocable, but **anyone with root on the box can extract it** until the real TPM backend lands. Once that backend lands, the key cannot be exported. Nothing in this ADR changes when it lands.
- **`key_fingerprint`** is the SHA-256 of the key's DER `SubjectPublicKeyInfo`, as lowercase hex with no prefix. This is the portal's definition. HQ computes it from the public key it stored at enrollment and never trusts a fingerprint the box sends.
- **Enrollment.** Warp enrolls every box in the HQ device registry (D1 `devices`) at provisioning, using the existing one-time provision-token path: the admin mints a token with `POST /api/admin/provision-token`, then the box calls `POST /api/issuance/provision` with `DROPLET_PROVISION_TOKEN` and a proof of possession (WARP-983). Each enrollment record gets an explicit status column, `status IN ('active','revoked')`, and a migration sets every existing row to `active` explicitly, never by default inference. `key_fingerprint` is unique across the registry.
- **Revocation** is an admin action at HQ, used at lease end or for a compromised box. It is audited in `audit_log`. A revoked box, or one HQ has never enrolled, gets no token, so revocation stops **both** updates and telemetry. A token minted before the revocation stays valid until it expires, at most 10 minutes later. Factory-reset `release` keeps the box `active`, and `deregister` removes it, after which it is `not_enrolled`.

### 2. Token service on the HQ Worker

| Endpoint | Request | Success |
|---|---|---|
| `POST /v1/device/challenge` | `{ "key_fingerprint": "<hex>" }` | `200 { "nonce": "<base64url, 32 random bytes>", "expires_at": "<ISO>" }` |
| `POST /v1/device/token` | `{ "key_fingerprint", "nonce", "sig_alg": "ecdsa-p256-sha256", "signature": "<base64 DER>", "scopes": ["registry:pull", "telemetry:ingest"] }` | `200 { "token": "<JWT>", "token_type": "Bearer", "expires_in": 600, "scope": "registry:pull telemetry:ingest" }` |
| `GET /.well-known/jwks.json` | — | the public keys, by `kid`: the current key and the previous one |

- **Nonces** live 60 s and are single-use. A nonce is bound to the fingerprint that asked for it and is consumed whether the signature verifies or not.
- **The signed string** is UTF-8, exactly `droplet-hq-token:v1:<nonce>:<key_fingerprint>`. Its prefix differs from every other device-key message (`droplet-cert:`, `droplet-provision:`, `droplet-claim:`, `droplet-release:`, `droplet-overlay-*:`, and the portal's `droplet-register:`), so a signature captured for one endpoint can never be replayed against another.
- **Scopes** must be a non-empty subset of `registry:pull` and `telemetry:ingest`. The token grants exactly the scopes requested.
- **Refusals** carry a machine-readable `code`:
  - `400 invalid_request` or `unknown_scope`;
  - `401 bad_nonce` (unknown, expired or used) or `bad_signature`;
  - `403 not_enrolled` or `revoked`.

  The challenge endpoint answers an unenrolled or revoked fingerprint with the same `403` codes. It also applies HQ's existing per-device challenge rate limit, answering `429` with `Retry-After`.
- **The JWT** is signed ES256, and its header carries a `kid`. Claims:

  | Claim | Value |
  |---|---|
  | `iss` | the HQ origin, from config, e.g. `https://droplet-fleet-hq.rjouffret.workers.dev` |
  | `sub` | `key_fingerprint` |
  | `did` | the HQ `device_id` |
  | `aud` | `["droplet-registry", "droplet-portal"]` |
  | `scope` | the granted scopes, space-separated |
  | `iat` | issue time |
  | `exp` | at most 600 s after `iat` |
  | `jti` | a unique id, recorded for audit |

- **The signing key** is a P-256 key stored as a Worker secret. To rotate it: make the new key current, keep the old one as `previous` in the JWKS for longer than the token lifetime plus any verifier's cache, then drop it. This is not the update-signing key: holding it lets someone pull images and post telemetry as a box, but never produce an update a box will install (§6).
- **Each box-side consumer mints its own token**, through device-identity-svc's `Sign`, when it needs one. No token is written anywhere persistent.

### 3. Private OTA through a read-only registry on HQ

**What CI publishes** (`publish-release.yml`):

- GHCR stays private and remains the build cache. ADR-066's "every package is public" gate is removed (#2588).
- After the images are signed and self-verified, CI copies each one **by digest** from GHCR into an R2 bucket. The copy covers:
  - the image manifest (and the index plus its child manifests, if there is one);
  - the config and every layer;
  - the cosign `sha256-<hex>.sig` artifact (and `.att`, if present) with its blobs.

  It uses crane or regctl to build an OCI layout, then writes the layout to R2 over the S3 API.
- **The bucket layout** is content-addressed, and only CI writes to it:
  - `oci/blobs/sha256/<hex>`;
  - `oci/manifests/sha256/<hex>`, with the R2 `httpMetadata.contentType` set to the manifest's media type;
  - `oci/tags/<repo>/<tag>`, a text file holding `sha256:<hex>`. Tags exist only for cosign `.sig` and `.att` artifacts and for release pointers.
- **Upload order is blobs, then manifests, then tags.** An existing key is skipped, so uploads are idempotent and deduplicated across releases. The `release.json` and channel-pointer steps run only after the copy succeeds, so no published release ever names a digest that R2 does not hold. A failed copy fails the job before any release exists.
- **The R2 write credential** is a bucket-scoped R2 API token stored as a GitHub Actions secret. It never reaches a box or the Worker.
- **Pushes never go through the Worker.** A Worker request body is capped at roughly 100–500 MB depending on the plan, and Cloudflare's own serverless registry hits that cap on large layers.
- **R2 multipart caveat.** Every part except the last must be the same size, between 5 MiB and 5 GiB, with at most 10,000 parts, and a single PUT is capped at about 5 GiB. Pin a fixed chunk size in the upload tool; R2 rejects uneven parts.

**What the Worker serves** is a read-only OCI Distribution pull API, read from the R2 binding:

- **`GET /v2/`** answers `200` to a valid bearer. Otherwise it answers `401` with `WWW-Authenticate: Bearer realm="<origin>/v1/registry/token",service="droplet-registry"`.
- **`GET` or `HEAD /v2/<repo>/manifests/<digest|tag>`** and **`GET` or `HEAD /v2/<repo>/blobs/<digest>`**:
  - `<repo>` must match `^droplet-[a-z0-9-]+$`;
  - responses carry `Docker-Content-Digest` and the right `Content-Type` and `Content-Length`;
  - blobs are streamed from R2 and honor `Range`, so an interrupted multi-GB layer can resume.
- **`GET /v1/registry/token`** is the realm, for clients that follow it. It accepts Basic `droplet-device:<device JWT>` and returns `{ "token": <the same or a narrower JWT>, "expires_in" }`.
- **Authorization** is `Authorization: Bearer <JWT>`. The Worker checks the signature, `iss`, that `aud` contains `droplet-registry`, `exp`, and the `registry:pull` scope. It does so **once, when each request starts**, so a blob stream that began while the token was valid runs to completion.
- **Anything else is refused.** Every other method gets `405`. There is no push, no `_catalog`, no tag listing and no upload session, and the Worker code only reads R2.

**What the box does:**

1. **It rewrites only the host.** The signed manifest still names `ghcr.io/dropletbywarplab/droplet-<name>@sha256:<hex>`, and the box pulls `<hq-host>/droplet-<name>@sha256:<hex>`. The digest, and so the trust decision, is unchanged. The HQ host is the origin the box already uses for issuance (`HQ_ISSUANCE_URL`), so the vanity-domain cutover remains a default swap.
2. **It mints a fresh `registry:pull` token for each image.** The orchestrator's update agent does this immediately before calling `pull-images` for that image. The token goes to `apply-update.sh` through the existing pull-images-only channel, which today carries `DROPLET_OTA_GITHUB_TOKEN` and gets replaced. `setup_registry_auth` writes `{"auths":{"<hq-host>":{"registrytoken":"<JWT>"}}}` to its `mktemp` `0700` `DOCKER_CONFIG`, and both `docker pull` and the cosign container send the bearer directly.
3. **cosign verification is unchanged.** cosign checks the digest inside the signed payload and the certificate identity, not the registry name, so signatures copied by digest verify against the new host. This is what `cosign copy` relies on. The identity regexp stays the enumerated `(main|stage)` one.
4. **It fails to "no update", never to "broken".** If HQ is down, or the token is refused (`not_enrolled`, `revoked`, or HQ unreachable), the update stays parked and is retried later. The box records the event (`token.refused`). If the registry answers `401` mid-pull because the token expired, the helper reports `registry-auth:` and the update is a transient retry with a new token (ADR-066 §6). Docker keeps the layers it already fetched, so retries converge. The running stack is never touched, and rollback recreates from local images with `--pull never`.

### 4. Operational telemetry and logs

**Who sends.** Every enrolled box sends telemetry. The sender is `fleet-agent`, the single on-device agent under ADR-028.

- For enrolled boxes, the agent leaves the `telemetry` compose profile and drops the `DROPLET_TELEMETRY_ENABLED` gate.
- It gains the device-identity socket mount and mints its own `telemetry:ingest` token.
- It stays fail-open: an outage is spooled to a bounded buffer, and the agent never degrades the box.
- A box that HQ answers with `not_enrolled` sends nothing.

**Where it goes.** Telemetry goes to the operator portal (droplet-analytics) with `Authorization: Bearer <HQ JWT>`.

- The portal verifies the JWT against HQ's JWKS (`HQ_JWKS_URL`). It caches the key set, refreshes it on an unknown `kid` at a bounded rate, and checks `iss` (`HQ_ISSUER`), `exp`, the `telemetry:ingest` scope, and that `aud` contains `droplet-portal`.
- A machine is identified by `sub` plus `did`, and the portal creates its record on the first valid call. **One identity, no separate portal registration.** The portal's provisioning-code and RSA-2048 registration (`/agents/register*`, `dpl_` tokens) becomes legacy: still accepted, but no new box uses it.

**Endpoints.** All three are strict: an unknown key is a `400`, the body is at most 256 KB, and each is rate-limited per machine.

- **`POST /api/v1/telemetry/heartbeat`**, about every 5 minutes, schema `heartbeat.v1`:

  ```json
  { "schema": "heartbeat.v1", "sentAt": "<ISO>",
    "release": { "tag": "...", "gitSha": "...", "channel": "stage|stable" },
    "os": { "kernel": "...", "distro": "..." },
    "uptime": { "bootedAt": "<ISO>", "seconds": 0 },
    "services": [ { "name": "orchestrator", "state": "running|exited|restarting|created|paused|dead",
                    "health": "healthy|unhealthy|starting|none", "restarts": 0 } ],
    "usage": { "cpuPct": 0, "memPct": 0, "diskPct": 0, "netRxBytes": 0, "netTxBytes": 0,
               "gpus": [ { "utilPct": 0, "vramUsedMb": 0, "vramTotalMb": 0, "tempC": 0 } ] },
    "activity": { "windowSec": 300, "chatTurns": 0, "agentRuns": 0, "activeUsers": 0,
                  "ota": { "checks": 0, "downloads": 0, "applies": 0, "rollbacks": 0, "failures": 0 },
                  "errorsByClass": { "<class>": 0 } } }
  ```

- **`POST /api/v1/telemetry/events`**: `{ "schema": "events.v1", "events": [ { "type", "at", "code"?, "release"? } ] }`, where `type` is one of:
  - `boot`, `shutdown`;
  - `service.crash`, `service.recovered`;
  - `ota.check`, `ota.download`, `ota.apply`, `ota.rollback`, `ota.failed`;
  - `token.refused`, `disk.low`, `gpu.error`.
- **`POST /api/v1/telemetry/logs`**: `{ "schema": "logs.v1", "records": [ { "at", "service", "level": "warn|error|fatal", "code", "msg", "count" } ] }`, with at most 500 records per call.
  - `service` is a compose service name.
  - `code` is a stable error code or class from source, never free text.
  - Records are aggregated by `(service, level, code)` over the window, with a `count`.

**What may be sent: an allowlist.** Each item maps to a field above.

- **Identity:**
  - the key fingerprint and HQ device id (from the JWT, not the body);
  - the release tag, git sha and channel;
  - per-service names and state, with the image digests implied by the release;
  - the kernel and distribution.
- **Uptime:** boot time, uptime, and per-service state, health and restart counts.
- **Machine usage:**
  - CPU, memory and disk percentages;
  - GPU utilization, VRAM and temperature;
  - aggregate network bytes.
- **Activity counts, never content:**
  - chat turns and agent runs;
  - the number of active members, never who they are;
  - OTA check, download, apply, rollback and failure counts;
  - error counts by class.
- **Warn, error and fatal log records:** a stable code plus a short message redacted on the box.

The orchestrator computes the activity counts and hands only the integers to `fleet-agent`.

**What is never sent:**

- prompts or responses;
- file names, paths or contents;
- names, emails or identifiers of members, guests or anyone else;
- hostnames the customer chose;
- LAN IPs, MACs or device lists;
- camera data;
- business data;
- anything `allowed-egress.yaml` classes as `user-content-on-request`.

The legacy agent API's `hostname`, geolocation and `/agents/network` device-list fields are not used on this path.

**How the allowlist is enforced:**

- **The payload is a closed schema on both sides.** The box validates every payload against the same `*.v1` schema before sending, and a payload that fails is not sent and becomes a local error. The portal rejects unknown keys with `400`.
- **Log messages are redacted on both sides.** The box truncates `msg` to 500 characters only *after* redaction. Redaction applies:
  - the existing secret scrub (`apps/orchestrator/src/lib/log-redaction.ts` and its mirrored host-side copy in `scripts/host/droplet-collect-logs.sh`);
  - masks for emails, IPv4 and IPv6 addresses, MACs, URLs and host names, and long path-like tokens.

  The portal then rejects or masks emails, IPv4 and IPv6 addresses, MACs and long path-like tokens in `msg` again, and stores only the masked text.

**Retention:**

- raw heartbeats, events and logs: 30 days;
- daily per-machine aggregates: 13 months.

Both are defaults, tunable by environment variable. Purges run on a scheduler, never in a `while (true)` loop.

**The portal contract moves as one unit.** In droplet-analytics, `apps/portal/lib/ingest/schemas.ts`, `docs/superpowers/agent-api.md` and `docs/superpowers/agent-api.openapi.yaml` change in the same PR, gated by `scripts/check-agent-api-sync.mjs`.

**Always on.** Telemetry is part of the managed lease and is always on for enrolled boxes, at Romain's request. There is no opt-out toggle (see the open questions).

### 5. Transparency to the owner

- **A page, "What this Droplet sends to Warp".** It is visible to the owner, and to admins. It shows the last payload of each kind, verbatim, next to the schema it was validated against.
- **One daily ActivityRow** summarizes what was sent that day: the counts of heartbeats, events and log records, the bytes sent, and any refusals or failures.
- **The egress registry has an entry for this traffic,** with `data_class: operational-telemetry` (§8).

### 6. What carries over from ADR-066

- **Integrity comes only from signatures (ADR-066 §1).** That means the cosign-signed `release.json`, with its key baked into the image, plus the keyless per-image signatures, verified offline against `publish-release.yml@refs/heads/(main|stage)`. The HQ registry, its token and R2 are transport: a malicious or compromised mirror can withhold an update, but it cannot change one.
- **ADR-045 holds.** No GitHub token sits on any box. A box holds only an HQ JWT of at most 10 minutes, in memory or in the one-shot's `0600` temp directory.
- **ADR-028 holds.** Everything new runs on Cloudflare (Worker, D1, R2), beside HQ issuance. There is no VM or VPS. The update-signing key stays off the portal, Cloudflare and HQ.
- **Discovery is unchanged.** It is the signed channel pointer on the public `ota-index` release (ADR-066 §3), plus downloads by tag, the no-downgrade floor and the `registry-auth:` classification (ADR-066 §4–§6). Moving discovery from GitHub to HQ is optional and later.
- **The pre-push image secret scan stays.** The images are private now, but a box still holds them.

### 7. Product claim change (approved by Romain, 2026-10-03)

PRODUCT.md says the product "never phones home" (lines 39 and 118) and uses "Off-LAN: 0 B" as sovereignty language (lines 152 and 205). **For updates and operational telemetry, those claims are no longer accurate.** The box now authenticates to Warp to update itself and sends health counters and redacted error records.

FOUNDATION.md's own rule, that everything crossing the boundary is "default-deny and audited", still holds: each destination is allowlisted and has a data class.

Replacement wording, approved by Romain on 2026-10-03 ("approve the wording"):

> "Customer data never leaves the box. The box sends Warp only signed update requests and operational health counters, which the owner can inspect."

The badge would read "Customer data off-LAN: 0 B".

PRODUCT.md lives outside this repository; it is updated to this wording separately.

### 7a. Customer assignment (decided by Romain, 2026-10-03)

A box is assigned to its customer by a **Warp provisioning step in the portal**: before a box ships, an operator pre-registers its HQ identity (`did` / `key_fingerprint`) against the customer. The portal links the machine record to that customer on its first valid telemetry call. A box that authenticates without a pre-registration lands with an explicit `unassigned` status (never inferred from a missing customer id) and shows in an "Unassigned boxes" list for an operator to assign; reassignment is audited. HQ stays customer-agnostic: the JWT carries no customer claim.

### 8. Egress changes the implementation PRs make

The implementation PRs edit `docs/security/allowed-egress.yaml`. This PR does not, because the gate requires a literal in code.

- **Add `fleet-hq-registry`** with the same hosts as `fleet-hq-issuance` (`droplet-fleet-hq.rjouffret.workers.dev`, `fleet-hq.droplet-us.com`) and `data_class: none`. Its purpose: the device-token challenge and token, plus image pulls by digest. It sends a device-key proof, the key fingerprint and the digests requested, and no customer data. It is a separate row on purpose, so retiring issuance cannot un-register OTA.
- **Re-point `fleet-telemetry-portal`** (`analytics.warp-lab.ai`, already `operational-telemetry`) at the three `/api/v1/telemetry/*` endpoints, with `services/fleet-agent` as the code reference. Its purpose text lists the allowlist and the never-send list above.
- **Remove `ota-image-registry`** (`ghcr.io`, `pkg-containers.githubusercontent.com`) once no box pulls from GHCR at runtime. `build-container-registries` still covers CI's own use.

## Consequences

- **The box now identifies itself to Warp.** HQ learns which box asked for which release, and when. The portal receives health counters and redacted error records every 5 minutes. This replaces ADR-066's "an update check sends no device identity".
- **Leases get a real off switch.** Revocation at HQ stops updates and telemetry within 10 minutes, with no change on the box.
- **HQ becomes a single point of failure for OTA and telemetry.** It is not one for anything the box does locally: an HQ outage means no update and spooled telemetry, never a broken box (§3, step 4).
- **Running cost.** R2 storage runs about $5–10 a month and R2 egress is $0. Worker requests sit on the existing HQ account, and streamed R2 bodies cost no Worker CPU time. Docker deduplicates layers per box, and R2 deduplicates them per release.
- **A compromised box can read the images.** That is accepted: it already runs them (THREAT_MODEL T6.12).
- **Until the TPM backend lands, a root attacker can extract the device key.** That lets them impersonate that box for pulls and telemetry, but never another box, and never produce an update (T6.11).

## Migration

1. **#2570 (merged).** Its public-package gate is removed by open PR **#2588**. The pre-push secret scan and the signed channel pointer stay.
2. **#2571 (merged).** Its discovery, floor and `registry-auth:` work stays. Its `ota-image-registry` egress entry and the anonymous-pull text become follow-ups: §8, plus `docs/SECURITY.md` § "Public packages" and the `DROPLET_OTA_GITHUB_TOKEN` / `DROPLET_OTA_DOWNLOAD_BASE` rows in `docs/ENVIRONMENT.md`.
3. **ADR-066** is marked Superseded by ADR-068.
4. **HQ (droplet-fleet-hq `worker/`):**
   - a D1 migration: `devices.status` with an explicit `active` backfill, a server-computed SPKI fingerprint column with a unique index, and the token nonces;
   - the token endpoints and JWKS;
   - the admin revoke endpoint;
   - the R2 binding and the read-only `/v2/` routes.
5. **CI:** the R2 copy step in `publish-release.yml`, placed before the release steps.
6. **Box:**
   - the update agent mints tokens and rewrites the host;
   - `setup_registry_auth` writes `registrytoken`;
   - `fleet-agent` is default-on for enrolled boxes, using the new endpoints and the transparency page.
7. **Portal (droplet-analytics):** JWKS verification, the three endpoints, retention, and the three-file contract.
8. **Already-deployed boxes need a one-time step.** Warp enrolls each one (a provision token, then `provision`), and it reaches code that has this ADR once, by local build as the test box does today, because pre-068 code cannot pull private images. Until Option A ships, every box updates by local build.

### Where today's code differs from this ADR (verified 2026-10-03)

| Today | This ADR |
|---|---|
| The box sends HQ `key_fingerprint` = device-identity's `certFingerprint`, which is `"sha256:" + sha256(cert PEM)` (`backends/mock.py`, `tls-issuance.service.ts` `signChallenge`). HQ stores whatever string the box sends at `provision`. | The token service matches on the SHA-256 of the DER SPKI, which HQ computes from the stored `public_key_pem`. The issuance messages keep their current string until they migrate on their own schedule. |
| HQ's verifier accepts `sig_alg` `ecdsa-sha256` or `rsa-pss`, and device-identity's `Sign` labels its output `ECDSA-P256-SHA256`. | `/v1/device/token` accepts exactly `ecdsa-p256-sha256`, which is the same ECDSA P-256 / SHA-256 verify. |
| D1 `devices` has no status column and no unique `key_fingerprint`. `deregister` deletes the row. | `status IN ('active','revoked')`, explicitly backfilled to `active`, plus a unique server-computed fingerprint. |
| HQ issuance nonces are 24 random bytes in hex, live 120 s (`NONCE_TTL_SEC`), and are bound to a `device_id`. | Token nonces are 32 bytes in base64url, live 60 s, and are bound to the fingerprint. Issuance nonces are unchanged. |
| The portal's `/agents/register*` requires an RSA-2048 PoP and a provisioning code, and `RegisterSchema` requires `hostname`. `fleet-agent` sends no PoP at all, so it cannot register against `origin/main`. | Not used. The HQ JWT is the only box credential the portal needs. |
| `fleet-agent` sits behind the `telemetry` profile and `DROPLET_TELEMETRY_ENABLED=0`, and does not mount `/var/run/droplet`. | Default-on for enrolled boxes, with the socket mounted. |

## Threat-model deltas

The deltas are in [`THREAT_MODEL.md`](THREAT_MODEL.md) §7:

- T6.4 (telemetry leaking content) is rewritten for always-on telemetry and logs.
- T6.7 (HQ outage) now covers the OTA dependency.
- New rows:
  - T6.11, token theft or minting on a box;
  - T6.12, a compromised box reading images;
  - T6.13, the HQ token-signing key, JWKS rotation and compromise;
  - T6.14, the R2 write credential.

## Not decided here

- **Opt-out for a future non-leased SKU.** Telemetry is always on under the lease, and whether a box the customer owns outright may turn it off is open.
- **Token lifetime against slow, multi-GB pulls** (WARP-3423 comment 15567, item 1). The contract caps tokens at 600 s. This ADR relies on authorization at request start, a token per image, and resumable retries. If field data shows pulls that do not converge, the contract needs a longer, pull-scoped TTL.
- **A narrower signer.** device-identity-svc's `Sign` signs any payload for any caller on its socket. A dedicated RPC that signs only the `droplet-hq-token:v1:` form, like the extension-signing envelope, would shrink who can mint tokens.
- **R2 retention and garbage collection** for old releases.
- **The mirror could carry more later.** It could also serve third-party images and DMR models, which would remove Docker Hub's anonymous-pull limits from runtime egress.
- **Carried over from ADR-066 and still open:**
  - pointer expiry and a TUF-style root;
  - the manifest key on hardware keys;
  - first install from a signed release;
  - `fleet-agent`'s `update_poll.py` still uses API discovery;
  - host OS, driver and firmware updates.

## Alternatives considered

| Option (WARP-3423 comment 15566) | Why not |
|---|---|
| B. CNCF Distribution on a VM with an R2 backend and a token server | A Warp-operated server, which ADR-028 forbids. |
| C. AWS ECR with IAM Roles Anywhere (TPM X.509) | Needs an AWS account and costs $0.09/GB egress, about $1.3k a month at 500 boxes, and the real TPM is not there yet. |
| D. Signed image tarballs on R2, presigned by HQ | No layer deduplication, so each box downloads about 15 GB per release. |
| E. A shared machine-user PAT on every box | Forbidden by ADR-045. It is extractable and cannot be revoked per box. |
| F. Encrypted public images (ocicrypt) | Docker Engine cannot decrypt them, and the ciphertext would still be public. |
| Keep ADR-066 (public images) | Withdrawn by Romain, 2026-10-03. |
