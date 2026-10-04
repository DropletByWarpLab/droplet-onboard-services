# Droplet STRIDE Threat Model — single-box + fleet

> **Status:** Draft for review (WARP-965). Becomes **Accepted** on
> Romain + Stefan sign-off; re-review on any change to a trust
> boundary (new listener, new egress destination, new privileged
> container, new cloud plane).
>
> **Date:** 2026-07-03. Control statements corrected on 2026-10-03 to match the
> shipped defaults and code (WARP-3626, WARP-3657, WARP-3663): rows A2, A4, T5.3,
> T5.6, T5.8, T6.3, R3 and R4. Where a row says "Target", that is the intended
> design, not the current state.
> **Scope:** the shipping single-box appliance (34-service compose
> stack + OpenWrt) and the fleet planes as they exist after the
> 2026-07-03 WARP-961 ratification (ADR-028 Accepted): analytics-portal
> telemetry, fleet-hq Worker TLS issuance, signed release manifests,
> Cloudflare-native remote access (ADR-025A, proposed).
> **Out of scope:** the v2.6 dual-domain hardware architecture
> (Vault/WAN-Edge physical split — covered by
> `droplet-hardware/docs/FOUNDATION.md`); Warp Lab corporate IT;
> physical attacks beyond casual access (see §9 accepted risks).
>
> **Method:** STRIDE per trust boundary. Severity is impact×likelihood
> collapsed to Critical/High/Medium/Low. **Every Critical/High threat
> maps to an implemented control or a tracked WARP ticket** (the
> WARP-965 acceptance criterion). Feeds the OpenWrt/privileged
> container hardening (WARP-585 → WARP-1016) — see §8.

## 1. What we are protecting (assets)

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | Customer files (Nextcloud data volume) + their metadata DBs (`droplet`, `nextcloud` in the `db` container) | The product promise: private data that never leaves the box |
| A2 | Device identity: ECC key held by device-identity-svc (a file on the box under the default mock backend; TPM-sealed is the Target, WARP-1181), `DEVICE_SECRET_KEY`, `JWT_SECRET`, service bearer tokens, `.env` | Whoever holds these IS the box |
| A3 | The signed audit trail (append-only activity log, HMAC key `data/secrets/audit.key`, WARP-456) | Tamper-evidence for every operator/AI action |
| A4 | Update trust: release-manifest signing key (today a GitHub Actions repository secret, `COSIGN_PRIVATE_KEY`; Target: two hardware security keys per ratified ADR-028 Q2), WARP-537 verification | A forged update = persistent fleet-wide compromise |
| A5 | LAN control plane: OpenWrt UCI, managed switch, Matter controller | Controls the customer's whole network |
| A6 | Camera streams + NVR footage (Frigate, camera VLAN) | High-sensitivity surveillance data |
| A7 | BYOK cloud-provider keys (`/data/keys/`), user credentials (argon2id directory, ADR-013) | Direct financial/identity abuse |
| A8 | Backups (restic repo, WARP-254/WARP-1013) | Contains A1+A2 in one place |

## 2. Trust boundaries

```
                      WAN (hostile)
                          │
        ┌────────────TB1──┴──────────────┐
        │  nginx :443 (TLS, HSTS) — the ONLY inbound listener
        │  (ADR-009: no other public inbound; remote access is
        │   outbound cloudflared → Cloudflare ZT, ADR-025A)
        │
   Customer LAN ──TB2── bridge-net services (orchestrator :3000,
        │               dashboard, ai-gateway :8000/:50051, db,
        │               redis, mqtt, nextcloud, frigate, docserver)
        │
   Camera/IoT VLAN ──TB3── trusted LAN (ADR-018 segmentation,
        │                  ADR-012 egress blocks)
        │
   container↔container ──TB4── docker bridge + service bearers
        │
   containers↔host ──TB5── host-network + caps (routing :8080,
        │                  matter-controller :8083, switch :8081,
        │                  oled :8082, openwrt, /dev/tpm0 →
        │                  device-identity-svc unix socket)
        │
   box↔Warp cloud ──TB6── fleet-hq Worker (cert issuance, ADR-023),
        │                 analytics portal (agent-api v1.0.0,
        │                 fleet-agent OFF by default), releases repo
        │                 (signed manifests), Cloudflare ZT (ADR-025A)
        │
   box↔3rd-party cloud ──TB7── cloud LLM providers (BYOK via
        │                      ai-gateway), customer IdP (OIDC,
        │                      ADR-016 Option A)
        │
   physical ──TB8── TPM PCRs [0,2,4,7], disks, factory reset
```

## 3. TB1 — WAN edge

Inbound surface is nginx :443 only (`docker/nginx/nginx.conf`; ADR-009).
Remote access is outbound-only (`relay` compose profile cloudflared →
per-box VNET, ADR-025A — proposed, sign-offs pending on WARP-1000).

| ID | STRIDE | Threat | Sev | Control / ticket | Status |
|----|--------|--------|-----|------------------|--------|
| T1.1 | S | Phishing-grade TLS spoof of the box (fake `d-<hmac>` host) | Med | Public-CA per-device cert, ADR-023; opaque HMAC label keeps customer identity out of CT logs | Mitigated |
| T1.2 | T/I | TLS terminator downgrade / weak ciphers; nginx runs non-FIPS OpenSSL (`nginx:alpine`) | High | HSTS + modern ciphers today; FIPS posture decision for the edge terminator = **WARP-1021**; on-hardware rest+transit verification pass = **WARP-966** | Open → tickets |
| T1.3 | D | Volumetric/slowloris DoS on :443 | Med | Container resource limits (ADR-021); no other listeners; accepted residual (appliance serves its own LAN; WAN reachability not a product promise) | Accepted |
| T1.4 | E | nginx CVE → edge RCE pivots into bridge net | High | Non-privileged container, bridge isolation, resource caps; image patching cadence = **WARP-259** (CVE scanner + patch agent); SBOM per release = **WARP-245** | Partial → tickets |
| T1.5 | S/E | Cloudflare ZT misconfig routes user A to box B (fleet remote access) | High | ADR-025A design: one VNET per box + per-user Gateway allow rule over org-wide catch-all block, fail-closed provisioning order; **pending sign-off + spike-object re-provisioning (WARP-1000, 5 listed items)** | Open → WARP-1000 |
| T1.6 | I | Cloudflare sees traffic metadata; must never see plaintext | High | ADR-025A trust invariant: L3/L4 only, TLS decryption OFF, end-to-end phone↔box TLS (ADR-023 padlock survives); release-gate check specified | Open → WARP-1000 (gate not yet implemented) |
| T1.7 | I/E | **Widened gateway surface for the embedded editor (WARP-1688)**: five new `location` legs publish Nextcloud paths at the dashboard's own origin (`/apps/`, `/core/`, `/dist/`, `/index.php/apps/richdocuments/`, `/index.php/apps/theming/`) | Med | Scope tight on the `/index.php/` side (§3a): only richdocuments + theming, so NC's login/settings/admin UI stays unreachable here. `/apps/`, `/core/`, `/dist/` are WHOLE-NAMESPACE legs, not enumerations — but the exposure delta is ZERO (those bytes were already served at `/nextcloud/apps/…`, same origin, same cookie scope, since that leg strips its prefix), and Nextcloud's own authn/authz still gates every one (verified: `/apps/files/` → 401). Narrowing them is tracked separately | Mitigated (documented) |
| T1.8 | S/I | **Unauthenticated richdocuments direct-editing URL (WARP-1688)**: `/index.php/apps/richdocuments/direct/<token>` renders the editor with NO cookie and NO Authorization header — whoever holds the URL holds that file until the token expires | Med | Token is minted server-side ONLY after the orchestrator's own gate chain (auth middleware → ADR-029 department space-access → NC share-permission mode decision), is bound to ONE file and ONE minting user, is short-lived (richdocuments TTL), and is returned only to the authenticated caller that asked for it. Residual: the URL is bearer-equivalent while it lives. "Must never be logged" is now ENFORCED, not just asserted — it was reaching logs with nobody writing a log statement (the gateway sets no `access_log`, so nginx logs `$request` verbatim; `nextcloud:29-apache` symlinks its access log to stdout; `nextcloud` is in the diagnostics collector's `DEFAULT_SERVICES`), which put live tokens in a downloadable support bundle. Controls: `access_log off` on the richdocuments leg, plus a `richdocuments-direct-token` redaction rule in BOTH mirrored redactors (`apps/orchestrator/src/lib/log-redaction.ts`, `scripts/host/droplet-collect-logs.sh`) that keeps the route and replaces only the token. Still must never be screenshotted into a ticket or pasted into chat. See §9 R6 | Mitigated w/ residual |

### 3a. Why the editor's gateway scope is narrow (WARP-1688)

The dashboard embeds the document editor in an iframe served from the
**dashboard's** origin. The richdocuments page inside that iframe
requests every asset by ROOT-ABSOLUTE path (`/apps/…`, `/core/…`,
`/dist/…`, plus two dynamic `/index.php/apps/…` prefixes), none of
which carried the `/nextcloud/` prefix the gateway routes — so they
404'd and the editor rendered unstyled and script-less.

The obvious fix is to route the whole `/index.php/` leg. That was
**considered and rejected**. Nextcloud's dynamic surface is live behind
that prefix — `/index.php/login` answers 200 — so a blanket leg would
publish Nextcloud's own login, settings and admin UI at the same origin
as a dashboard the user is already signed in to. That is a second,
independent authentication surface on the box's only inbound listener,
with its own session cookies and its own account model, for no product
benefit: the Droplet dashboard is the product's UI, and Nextcloud is a
headless backend by design (`docker/nginx/nginx.conf`, ADR-009).

What is exposed instead is scoped to the prefixes the editor page
actually loads, measured from the rendered page rather than guessed.

**Be precise about what that means.** Three of the five legs — `/apps/`,
`/core/`, `/dist/` — are WHOLE-NAMESPACE prefixes, not an enumeration
of individual assets. `/apps/files`, for instance, IS routed by
`^~ /apps/`. Two consequences follow, and both matter:

- Reaching any of it still requires Nextcloud's own authentication —
  measured: `/apps/files/` → 401. The gateway leg moves *where* a
  request can be addressed, not *who* may complete it.
- **The exposure delta versus today is zero.** Every path under those
  namespaces was already reachable at `/nextcloud/apps/…` on the SAME
  origin and the same cookie scope, because the `/nextcloud/` leg
  strips its prefix and Nextcloud believes its webroot is `/`. This
  change adds a second address for bytes that were already served, not
  a new class of reachable resource.

Narrowing those three legs (e.g. to a static-file-extension pattern) is
a genuine tightening and is tracked separately; it is not a fix for a
hole this change opened, and it carries a real risk of 404-ing an asset
that cannot be browser-tested from CI.

What the tight scope *does* buy is on the `/index.php/` side, where the
legs ARE an enumeration: only `richdocuments` and `theming` are routed.
`/index.php/login`, `/index.php/settings`, `/index.php/apps/files` and
every other `/index.php/…` path stay UNREACHABLE at this origin — which
is what keeps Nextcloud's login/settings/admin UI off the dashboard's
origin. Nextcloud's WOPI callback endpoint is likewise unrouted: the
engine→Nextcloud callback is server-to-server over the compose network
(`wopi_callback_url=http://nextcloud/`) and never a browser request, so
it needs no gateway leg at all. Nextcloud remains reachable under the
existing `/nextcloud/` leg, except for its OCS sharing API and the OCS routes that mint a bearer-style URL (last two paragraphs).

Enforcement: `tests/nginx-nextcloud-assets.test.sh` fails the build if a
blanket `/index.php` leg appears in ANY form — prefix with or without a
trailing slash, or a regex leg mentioning php — or if one of the named
`/index.php/…` paths gets its own leg. It deliberately makes no claim
about `/apps/files`: `^~ /apps/` routes it, and an assertion that said
otherwise would be a guard that lies.

**The `/nextcloud/` leg refuses Nextcloud's OCS sharing API (WARP-3053).**
Every user's Nextcloud password equals their Droplet password and app
passwords (device pairing, per-user WebDAV drive logins) are full-scope, so
without this any member or guest could call `ocs/v1.php|v2.php/apps/files_sharing/`
directly and mint a public link to Workspace files, bypassing the
owner/admin-only rule the orchestrator enforces. Two `^~` locations answer 403
for any suffix and any method; the web app is unaffected because the
orchestrator reaches Nextcloud over the compose network (`NEXTCLOUD_URL`), not
through the gateway. Enforcement: Phase 7 of
`tests/nginx-nextcloud-assets.test.sh`.

**The same leg refuses the other OCS routes that mint a credential-free URL
(WARP-3318 audit).** `apps/richdocuments`, `apps/files/api/v1/directEditing`
and `apps/dav/api/v1/direct` answer 403 under `/nextcloud/` (same four
spellings); the editor's own direct-editing mint is an orchestrator-to-Nextcloud
call over `NEXTCLOUD_URL`, so it is unaffected. Audit table and what was left
open: [`SECURITY.md`](SECURITY.md) "Nextcloud OCS audit".

## 4. TB2 — LAN clients ↔ box services

Auth model: Nextcloud-credential login → per-device JWT (15 min
access / 7 d refresh in Redis), `sub = User.id` (WARP-485);
`__Secure`/`HttpOnly`/`SameSite=Strict` cookies; RBAC per route
(ADR-004: owner/admin/family/guest/service); exact-match CORS.

| ID | STRIDE | Threat | Sev | Control / ticket | Status |
|----|--------|--------|-----|------------------|--------|
| T2.1 | S | Credential stuffing / brute force on `/api/auth/login` | High | argon2id directory (ADR-013), Redis brute-force blocklist; WebAuthn deferred post-GA (WARP-328 bucket) | Mitigated (residual accepted until WebAuthn) |
| T2.2 | S | Device self-revoke Basic-auth path is an unauthenticated app-password oracle | High | **WARP-1030** (rate-limit the path) | Open → ticket |
| T2.3 | T | Guest/family role escalates via unguarded mutating route | High | ADR-004 route matrix + per-tool MCP RBAC; live-box e2e gate on onboarding/orchestrator PRs = **WARP-971**; regression coverage gate = **WARP-970** | Mitigated → gates pending |
| T2.4 | R | Operator/AI action disputed with no proof | High | HMAC-signed append-only activity log (WARP-456); dashboard audit surface = **WARP-1009**; concurrent-write chain fork bug = **WARP-1026** (High, in progress) | Partial → tickets |
| T2.5 | I | Credentials leak into logs: orchestrator request logger records `Authorization` + `Cookie` headers | High | **WARP-1015** (redact) | Open → ticket |
| T2.6 | I | LLM/RAG exfiltration: prompt-injected agent reads files user shouldn't see | High | Tool dispatch through MCP with per-tool RBAC + service principals read-only (ADR-004/014); `requiresConfirmation` on write tools; voice spoken-confirmation tier (ADR-015) | Mitigated (design); adversarial-prompt test suite is a gap — fold into **WARP-971** e2e or file follow-up at review |
| T2.7 | D | One user's chat/inference load starves the box | Med | ADR-021 mem/cpu/pids limits; ai-gateway rate limits (`RATE_LIMIT_TRUSTED_PROXIES` default trust-none) | Mitigated |
| T2.8 | E | Unauthenticated LAN device hits internal service directly (bypassing nginx) | High | Bridge services publish no host ports (compose); host-network services carry bearer tokens (TB5); Frigate and the inference runtime publish on loopback only — but on the single-box shape the OpenWrt container routes the guest Wi-Fi zone (and the staff Wi-Fi in routed-AP mode) onto the compose network, so those clients reach container addresses without nginx: **WARP-3454** (High), see T5.4 (and T3.2) | Partial → WARP-3454 |

## 5. TB3 — Camera/IoT VLAN ↔ trusted LAN

| ID | STRIDE | Threat | Sev | Control / ticket | Status |
|----|--------|--------|-----|------------------|--------|
| T3.1 | S/T | Compromised camera pivots into LAN | High | ADR-018 camera VLAN isolation (`cameras_to_wan` dropped, no inter-VLAN forward), ADR-012 per-device egress REJECT with NTP carve-out | Mitigated |
| T3.2 | I | Camera phones home footage/telemetry to vendor cloud | High | ADR-012 phone-home block + `DeviceEgressState` reconciler cron; CI gate proving the telemetry-free invariant = **WARP-269** | Mitigated → gate pending |
| T3.3 | D | IoT device floods MQTT/mDNS | Med | Broker credentials; resource limits; segmented VLAN | Mitigated |
| T3.4 | E | Matter commissioning hijack (BLE/mDNS) grabs a device mid-pair | Med | Matter session security + spoken/UI confirmation (ADR-015/022); commissioning is operator-initiated | Mitigated |

## 6. TB4/TB5 — inside the box (containers, host, privileged services)

Bearer-token mesh: routing (`ROUTING_SERVICE_TOKEN`), ai-gateway
(`SERVICE_TOKEN_AI_GATEWAY`, WARP-560), switch (`SERVICE_TOKEN_SWITCH`,
WARP-559 fix), matter (`X-Droplet-Auth`, ADR-022), display, MCP (JWT).
Privileged set: routing/matter/switch/oled on `network_mode: host`
(NET_ADMIN, NET_RAW where needed), openwrt container, `/dev/tpm0` →
device-identity-svc (unix socket only).

| ID | STRIDE | Threat | Sev | Control / ticket | Status |
|----|--------|--------|-----|------------------|--------|
| T5.1 | S | Container on the bridge net replays a stolen service bearer | Med | Tokens are per-service, per-device (setup.sh `scripts/lib/secrets.sh`), never tracked; rotation on factory reset (WARP-983 flow) | Mitigated |
| T5.2 | E | **Compromise of a host-network container = host-level network control** (no `cap_drop`, full host stack) | **Critical** | By-design caps documented (ADR-022); staged cap reduction for the OpenWrt container = **WARP-1016** (WARP-585 follow-up); §8 extends the same treatment to routing/matter/switch/oled | Open → tickets (see §8) |
| T5.3 | E | Orchestrator compromise → token-rich pivot (holds every service bearer) with a mounted Docker socket | High | The orchestrator mounts `/var/run/docker.sock` (read-only mount flag, but the daemon still honors writes over the API) for the OTA apply path (WARP-539); the socket is fenced by a single audited host helper and a cosign-verified release gate, see the comment in `docker/docker-compose.yml`. `ops-console` (compose profile `ops`, off by default) also mounts it read-write. A socket is root-equivalent on the host, so the blast radius is the host plus the bearer mesh (accepted concentration — the orchestrator is the control plane); mitigations: ADR-021 limits, CI gates (**WARP-968/969**), typecheck job (**WARP-1011**); socket review: **WARP-3578** | Partial → tickets |
| T5.4 | I | Unauthenticated internal listeners: Frigate, and the inference runtime — DMR by default (WARP-1870), Ollama when opted in. Neither runtime checks credentials (ADR-036 records DMR with exactly the same property as Ollama), and both carry a model-management surface (`/api/pull`, `/api/create`, DMR `/models/create`). Their host ports are loopback-only: the single-box compose publishes DMR on `127.0.0.1:12434`, Ollama on `127.0.0.1:11434` and Frigate on `127.0.0.1:5000`. **But the compose network is reachable from Wi-Fi today:** on the single-box shape the OpenWrt container (no `networks:` key, attached by `droplet-openwrt-attach`) forwards the guest zone to its `lan` zone, which includes its compose-network interface, and the staff Wi-Fi in routed-AP mode is routed the same way. Those clients can reach every compose container address, the unauthenticated runtime (`dmr:12434`, `ollama:11434`) among them (**WARP-3454**) | High | Loopback-only host publish (ADR-036 §6), which does not cover the routed path above. The WARP-3452 `/llm/` endpoint is token-gated, allowlisted and default-off on every path regardless (ADR-067); what is exposed until WARP-3454 lands is the raw runtime, management surface included. Residual after WARP-3454: a process on the host or a container on the compose network (the T5.1/T5.3 insider), and the droplet-local-LLM two-box compose still publishing Ollama on `0.0.0.0:11434` (**WARP-2780**) | Open → WARP-3454 (single-box), WARP-2780 (two-box) |
| T5.5 | T | `db` container hosts BOTH `droplet` + `nextcloud` DBs — single postgres blast radius | Med | Docker-network isolation, no published port; restore integrity now covers both DBs (**WARP-1013**, PR #810) | Mitigated |
| T5.6 | I/E | Device-key misuse from a compromised container | High | Target: key non-extractable, sealed to PCRs [0,2,4,7] (**WARP-1181**). Today: the default mock backend keeps the key as a file in the sidecar's storage directory, protected by the container boundary and file mode, not by a TPM; the real TPM backend is a scaffold that fails closed. In both cases device-identity-svc exposes sign-only gRPC over a unix socket with no network listener (WARP-230) | Partial (process boundary only) → WARP-1181 |
| T5.7 | T | Silent tamper with audit chain or its key (`data/secrets/audit.key`, mode 0600) | High | HMAC chain + drill; fork-under-concurrency bug = **WARP-1026**; sealing doc-encryption KEK to Vault TPM = **WARP-1033** (same custody direction for at-rest keys) | Partial → tickets |
| T5.8 | I | Secrets at rest in plaintext `.env` (chmod 600) on unencrypted disk | High | Per-device generation (ADR-020, no baked creds); disk encryption = **WARP-232** LUKS2/Argon2id data partition + TPM-sealed unlock (PCRs 0+2+4+7), **active only on hardware with a TPM (`/dev/tpm0`); without one the data partition is not encrypted unless a development override is set**; shipped, pending hardware verify — on TPM hardware `.env` + `data/secrets` are relocated onto the encrypted `/data`; per-document DEKs = **WARP-242** with TPM KEK sealing = **WARP-1033**; hardware verification = **WARP-966** | Conditional (TPM hardware only) → WARP-966 hw verify |
| T5.9 | S | BYOK keystore falls back to a hardcoded passphrase when `DEVICE_SECRET` missing | High | **WARP-581** (fail-closed, drop fallback) | Open → ticket |

## 7. TB6/TB7 — cloud planes (fleet + third-party)

Post-ratification reality (ADR-028 Accepted 2026-07-03): telemetry →
analytics portal (agent-api v1.0.0; fleet-agent double-gated OFF,
fail-open, observe-only); cert issuance → fleet-hq Worker (ADR-023,
TPM PoP); updates → signed release manifests (WARP-537 verify;
box-side poll = WARP-1025); remote access → Cloudflare ZT (ADR-025A,
proposed). Egress table discipline per ADR-012 lives in
`services/fleet-agent/README.md`.

**ADR-068 (proposed 2026-10-03) changes this boundary.** Every enrolled box
mints a short-lived HQ JWT (≤ 600 s, ES256) from a device-key proof. It
pulls the now-private release images from a read-only registry on the HQ
Worker (R2-backed) and sends always-on operational telemetry and redacted
warn/error/fatal logs to the portal, which verifies the token through HQ's
JWKS. Revoking a box at HQ stops both. Rows T6.4 and T6.7 are updated, and
T6.11–T6.14 are new.

| ID | STRIDE | Threat | Sev | Control / ticket | Status |
|----|--------|--------|-----|------------------|--------|
| T6.1 | S | Rogue device registers into the fleet (stolen provisioning code) | Med | One-time codes minted in portal `/settings/tokens`, consumed on register; bearer `dpl_<machineId>_<secret>` SHA-256-hashed server-side; revocation via token rotate/archive | Mitigated |
| T6.2 | S | Portal impersonation feeds the box bogus commands | High | v1 agent answers EVERY command "unsupported" (no actuation channel, ADR-028); enabling any command type is security-reviewed follow-up | Mitigated by absence |
| T6.3 | T | **Forged/rolled-back update** | **Critical** | Target (ratified ADR-028 Q2): signing key on two hardware security keys, so an HQ compromise is not a signing capability. Today: the manifest is signed in CI with the `COSIGN_PRIVATE_KEY` repository secret (`.github/workflows/publish-release.yml`); the key is not on a box, on HQ or on the portal; manifest signature verify library (**WARP-537**, in review); box-side verified poll = **WARP-1025**; apply→fail→auto-rollback E2E on hardware = **WARP-964** | Open → tickets (chain designed) |
| T6.4 | I | Telemetry or logs exfiltrate customer data. Since ADR-068, telemetry is **always on** for enrolled boxes (heartbeat, events, warn/error/fatal logs) | High | Closed allowlist schemas (`heartbeat.v1`, `events.v1`, `logs.v1`): the box validates before sending, and the portal rejects unknown keys (`400`). Log `msg` is redacted on the box (secret scrub plus masks for emails, IPs, MACs, URLs and hosts, and paths), truncated to 500 characters after redaction, and then rejected or masked again on the portal. Records carry stable codes, and activity is integer counts only. An owner-visible "What this Droplet sends to Warp" page shows the last payload, and a daily ActivityRow summarizes what was sent. ADR-012 egress audit logger; telemetry-free-invariant CI gate = **WARP-269**. Residual: a novel free-text pattern in `msg` that both redactors miss | Mitigated w/ residual (ADR-068 implementation) |
| T6.5 | I | CT logs leak customer identity via cert issuance | Med | Opaque HMAC device labels (ADR-023); no PII in Cloudflare object names (ADR-025A idempotent naming) | Mitigated |
| T6.6 | R/I | Unknown-device heartbeats rejected but only Pino-logged (no portal audit surface) | Med | Rejection is enforced (401/403); audit-surface gap tracked on rescoped **WARP-962** AC (close or accept for GA) | Open → ticket |
| T6.7 | D | HQ/portal/Cloudflare outage. Since ADR-068, HQ's token service and registry are a single point of failure for OTA and telemetry | Med | Fail-open agent (never degrades box); cert renewal window tolerant + bootstrap self-signed fallback (ADR-023); `remote_access: pending` reconcile (ADR-025A); box functions fully offline by design. OTA fails to "no update", never to "broken": a refused or unreachable token parks the update for retry (`token.refused`), the running stack is untouched, and rollback recreates from local images with `--pull never`. Telemetry spools to a bounded buffer | Mitigated |
| T6.8 | I | BYOK cloud LLM calls leak prompts/files to provider | High | Explicit user choice per model call (local Ollama is default path); BYOK per-user keys; **cloud-LLM egress audit = WARP-268** (deferred — the one egress class not yet audited) | Partial → ticket |
| T6.9 | S | OIDC misconfig (ADR-016 BYO-IdP) lets IdP-side attacker into the box | Med | Exact-match redirect URIs, per-box OAuth client, no central relay to compromise | Mitigated |
| T6.10 | I | Fleet remote-access privacy: customer emails + flow metadata in Warp's Cloudflare ZT org | High | Explicitly listed as ADR-025A sign-off item (1); decision owed by Romain/Stefan on **WARP-1000** | Open → decision |
| T6.11 | S | HQ token theft or minting on a box (ADR-068). Anyone who can call device-identity-svc `Sign` over its socket, read the mock key from the sidecar's storage, or copy a live JWT can act as **that** box | Med | The JWT lives ≤ 600 s and carries only `registry:pull` and `telemetry:ingest`. It is bound to one box (`sub` = key fingerprint, `did`). The nonce is single-use, lives 60 s, and is signed over a domain-separated `droplet-hq-token:v1:` string. No token is persisted. Revocation at HQ stops new tokens. The portal rate-limits per machine, so a stolen token can only pull images that box already holds and pollute that one box's telemetry. It can never yield an installable update, because the manifest key and cosign identity are separate. Residual: the mock key is extractable by root until the TPM backend lands, and `Sign` signs any payload for any socket caller (narrower RPC = follow-up) | Accepted until TPM backend |
| T6.12 | I | A compromised box, or one whose lease has ended, reads the private release images | Low | Accepted: the box already runs them. The images carry no secrets (pre-push image secret scan, ADR-066 §2, kept). Revoking a box at lease end or on compromise stops future releases within one token lifetime | Accepted |
| T6.13 | S/T | The HQ token-signing key (Worker secret) leaks, or JWKS rotation breaks verifiers (ADR-068) | Med | Leaking the key lets an attacker pull images and inject telemetry for any box. It **cannot** forge an update: the manifest key stays off HQ, the portal and Cloudflare (ADR-028), and images still need the CI cosign identity. Rotation is by `kid`, with the JWKS publishing the current and previous keys; the old key is kept longer than the token lifetime plus verifier cache, then dropped. The portal refetches the JWKS on an unknown `kid` at a bounded rate, so `kid` spam cannot flood HQ. Compromise response: rotate, then let old tokens expire (≤ 600 s) | Mitigated |
| T6.14 | T/D | The R2 mirror write credential (bucket-scoped R2 API token, a GitHub Actions secret) leaks (ADR-068) | Med | The registry is content-addressed. Docker verifies every blob and manifest digest, cosign verifies the publish-workflow identity, and the signed manifest pins every digest, so overwritten or injected objects fail verification and the box keeps its current release. Worst case is denial of updates. The token lives only in CI, never on a box or in the Worker, and the Worker has no write path | Mitigated |

## 8. Feed into privileged-container hardening (WARP-585 → WARP-1016)

T5.2 is this model's top structural risk. Priority order for the
staged cap reduction (single-box compose):

1. **openwrt** — apply the staged cap reduction (**WARP-1016**):
   explicit `cap_drop: [ALL]` + add-back minimum (NET_ADMIN, NET_RAW,
   SYS_NICE, SYS_RESOURCE as measured), `no-new-privileges`, and
   document the verified-minimal set in the compose file.
2. **matter-controller** — needs NET_RAW (HCI) + NET_ADMIN (mDNS)
   by design (ADR-022); add `cap_drop: ALL` + the two add-backs,
   `no-new-privileges`, read-only rootfs if matter.js tolerates it.
3. **routing** — NET_ADMIN only; same drop-all-add-back pattern.
4. **switch / oled-display** — likely need NO added caps (HTTP client
   to the switch; i2c/spi via device node) — try `cap_drop: ALL`
   first; move oled to a device mount instead of host net if feasible.
5. Add a `scripts/test-security.sh` static check pinning `cap_drop`
   presence on every `network_mode: host` service so regressions fail
   CI (extends the existing mem-limit check pattern).

## 9. Accepted risks (explicit, revisit at GA review)

| # | Risk | Rationale |
|---|------|-----------|
| R1 | LAN is a semi-trusted zone (Frigate/Ollama unauthenticated on it) | Product model: the box IS the LAN's security authority; ADR-018 segmentation contains the untrusted classes (cameras/IoT) |
| R2 | WAN DoS on :443 degrades remote access only | Appliance value is local; remote reach via ZT is best-effort |
| R3 | Bearer-token concentration in the orchestrator | It is the control plane by design (ADR-009); compensated by resource limits and CI gates. The orchestrator also mounts the Docker socket for OTA apply (T5.3), so this is not compensated by socket absence |
| R4 | WARP-232 LUKS2/Argon2id data partition + `.env`/`data/secrets` relocation, active only on TPM hardware (pending WARP-966 hardware verify) | On TPM hardware, physical theft is covered by TPM-sealed LUKS2 (disk removed → ciphertext only). On hardware without a TPM the data partition is not encrypted by default (setup logs a warning; a development override exists). A8 backups are encrypted restic repositories, but the default repository is on the same box (`/var/lib/droplet/restic-repo`), so they do not protect against loss or theft of the box; off-device targets are planned |
| R5 | WebAuthn/SIEM/DLP/pen-test deferred post-GA | WARP-328 long-tail bucket, per the GA cut-line decision |
| R6 | The richdocuments direct-editing URL is bearer-equivalent for its lifetime (T1.8) | It is the only session-free path richdocuments offers, and a session-free path is what an iframe on a different origin requires; the alternative (embedding Nextcloud's login) is a worse posture. Scoped to one file, one user, short TTL, minted only behind the orchestrator's gates, kept out of the gateway access log, and redacted by both log-bundle scrubbers. What remains accepted is human handling — a screenshot or a pasted URL |

## 10. Critical/High register (roll-up)

Every Critical/High above maps to a control or one of:
**WARP-232** (LUKS2), **WARP-245** (SBOM), **WARP-259** (CVE/patch),
**WARP-268** (cloud-LLM egress audit), **WARP-269** (telemetry-free CI
gate), **WARP-537** (manifest verify), **WARP-581** (BYOK fail-closed),
**WARP-964** (OTA rollback E2E), **WARP-966** (on-hardware encryption
verification), **WARP-968/969/970/971** (CI + coverage + e2e gates),
**WARP-1000** (ADR-025A sign-offs), **WARP-1009** (audit surface),
**WARP-1011** (typecheck gate), **WARP-1015** (log redaction),
**WARP-1016** (cap reduction), **WARP-1021** (edge FIPS posture),
**WARP-1025** (signed update poll), **WARP-1026** (audit-chain fork),
**WARP-1030** (self-revoke rate limit), **WARP-1033** (KEK TPM
sealing), **WARP-962** (rejected-ingest audit decision).

Gap candidates surfaced by this model with **no existing ticket**
(file at review if agreed): adversarial-prompt/RAG-exfiltration test
suite (T2.6, or fold into WARP-971); `test-security.sh` cap_drop
static check (§8 item 5, or fold into WARP-1016).

## 11. Review

- [ ] Romain — review + accept (flips Status to Accepted)
- [ ] Stefan — review + accept
- Re-review triggers listed in the header. Owner: WARP-957 epic.
