# WARP-230 — TPM 2.0-sealed device identity + first-boot enrollment

**Status:** Design approved 2026-05-11 across 3 sections.

**Parent epic:** [WARP-228](https://warp-lab.atlassian.net/browse/WARP-228) — Trust & Compliance Foundations. Ticket 2 of 50. Blocked-by WARP-229 FIPS (merged); blocks WARP-231 (UEFI Secure Boot + dm-verity).

**Sequential position:** Compliance lane next ticket after WARP-229. Product lane interleaves; the next product ticket is **WARP-287** (anchors + citation deep-linking).

## Goals

1. The Droplet appliance has a **non-extractable hardware-rooted identity key** generated on first boot, sealed to the TPM 2.0's boot-state PCRs (0, 2, 4, 7). The private key never leaves the TPM in plaintext after provisioning.
2. The orchestrator can sign payloads with the device key (`signWithDeviceKey`), fetch the device's public certificate (`getDeviceCert`), and report on the seal's validity (`getDeviceIdentityStatus`).
3. After firmware/kernel updates, an authenticated admin can **reseal** the key against the new PCR state via the dashboard or a CLI command — without exposing the private key.
4. Dev and CI environments (no real TPM) use a **pure-Python in-memory mock backend** indistinguishable from the real one at the orchestrator boundary.
5. Investor + auditor + enterprise-sales story: "device identity is held by a dedicated hardware security service" — sidecar topology, not in-process.

## Non-goals

- CSR / external CA-issued device certs — self-signed for v1; real CA path is a future ticket
- mTLS to cloud connectors using this identity — uses device identity, but connector code is Phase D
- Hardware variant where the appliance lacks fTPM and external TPM module is required — single-appliance assumption
- Physical-button-press reseal trigger (GPIO hardware path) — future federal-customer ticket

## Locked decisions from brainstorm

| Q | Decision |
|---|---|
| Q1 — mock TPM strategy | **A** — pure-Python in-memory mock for dev + CI. Doesn't exercise real TSS2 wire encoding; mitigate by manual verification on the appliance before each release. |
| Q2 — deployment topology | **B** — sidecar `services/device-identity-svc/`. Stronger audit + investor story. Clean security boundary (only one container has `/dev/tpm0`). |
| Q3 — operator-presence for reseal | **D** — dashboard re-auth (MFA within 60s) OR admin CLI. No physical button. |

## Architecture

```
                 ┌───────────────────────────────────────┐
                 │  scripts/provision-device-identity.sh │
                 │  (first-boot, then post-reseal)       │
                 └─────────────┬─────────────────────────┘
                               │  generates EK cert + SRK +
                               │  device-id key, seals to TPM
                               ▼
              ┌────────────────────────────────────────┐
              │  /var/lib/droplet/tpm/                 │
              │   ├─ ek-cert.pem        (read by all)  │
              │   ├─ srk-pub.pem        (read by all)  │
              │   ├─ device-id-pub.pem  (read by all)  │
              │   ├─ device-id-cert.pem (self-signed   │
              │   │                      until CSR'd)  │
              │   ├─ device-id.sealed   (TPM-encrypted │
              │   │                     private key)   │
              │   └─ provisioned.json   (marker +      │
              │                          PCR snapshot) │
              └────────────┬───────────────────────────┘
                           │  (bind-mounted, read-only)
                           ▼
        ┌──────────────────────────────────────────────┐
        │ services/device-identity-svc/                │
        │  Python gRPC sidecar — only container with   │
        │  /dev/tpm0 device passthrough on the box.    │
        │                                              │
        │  gRPC methods:                               │
        │   • Sign(payload, scheme) → signature        │
        │   • GetCert() → x509 cert PEM                │
        │   • GetStatus() → {pcr_state, seal_valid,    │
        │                    cert_subject,             │
        │                    cert_expires_at}          │
        │   • Reseal(operator_auth_token) → new sealed │
        │                                   blob       │
        │                                              │
        │  Backend (selected by DROPLET_TPM_BACKEND):  │
        │   • real:  tpm2-pytss + /dev/tpm0            │
        │   • mock:  pure-Python in-memory dict        │
        └────────────┬─────────────────────────────────┘
                     │ gRPC over Unix socket
                     │ /var/run/droplet/device-identity.sock
                     ▼
        ┌──────────────────────────────────────────────┐
        │ Orchestrator                                 │
        │  apps/orchestrator/src/services/             │
        │      device-identity.client.ts               │
        │  Thin gRPC client. Exposes:                  │
        │   • signWithDeviceKey(payload)               │
        │   • getDeviceCert()                          │
        │   • getDeviceIdentityStatus()                │
        │   • requestReseal(operatorAuthToken)         │
        └──────────────────────────────────────────────┘
                     │
                     ▼ admin route
        ┌──────────────────────────────────────────────┐
        │ POST /api/admin/device-identity/reseal       │
        │ GET  /api/admin/device-identity/status       │
        │  Requires admin role + recent re-auth        │
        │  (TOTP/WebAuthn within last 60s).            │
        │  Also reachable via                          │
        │  `droplet-admin device-identity {status,     │
        │  reseal}` CLI (calls the same routes).       │
        └──────────────────────────────────────────────┘
```

### Key implementation choices

- **Key type:** ECC P-256 (FIPS 140-3 approved, smaller signatures, faster on the appliance; matches WARP-229's allowlist)
- **PCRs sealed against:** `[0, 2, 4, 7]` per the Jira description (SRTM/firmware + option ROMs + IPL/bootloader + Secure Boot Policy)
- **Storage:** `/var/lib/droplet/tpm/`, bind-mounted into the sidecar from the host
- **Sidecar transport:** Unix socket (`/var/run/droplet/device-identity.sock`) — faster than TCP, doesn't need a port, container-internal only
- **Real-TPM library:** `tpm2-pytss` on the appliance. Cleaner errors than tpm2-tools CLI shell-out.
- **Mock backend selector:** `DROPLET_TPM_BACKEND` env var (`real` default in production; `mock` default for dev/CI)
- **FIPS posture:** all crypto via the FIPS-validated stack from WARP-229. ECDSA P-256 + SHA-256 + AES-256-GCM (wrapping key) all approved.

## Provisioning, reseal, mock backend

### First-boot provisioning ceremony

`scripts/provision-device-identity.sh` is idempotent (re-runnable; detects existing identity and exits 0). Steps:

1. **Detect TPM presence.** `[ -e /dev/tpm0 ]` (real appliance) or `DROPLET_TPM_BACKEND=mock` (dev/CI). If neither: log + exit cleanly with `provisioned=false` so the rest of setup.sh can finish.
2. **Read or generate Endorsement Key Certificate.** TPM 2.0 ships with a permanent endorsement primary seed. Re-derive the EK + extract its cert (or generate a self-signed EK cert if hardware doesn't ship one; the appliance TPM may not). Persist to `/var/lib/droplet/tpm/ek-cert.pem`.
3. **Create Storage Root Key.** Derived from the SRK seed under the Owner hierarchy. Persistent at handle `0x81000001`. Persist public key to `srk-pub.pem`.
4. **Generate device identity key.** ECC P-256, scheme = ECDSA + SHA-256, attributes = `sign|fixedTPM|fixedParent|sensitiveDataOrigin`. The `fixedTPM | fixedParent` flags make the key non-extractable. Public key to `device-id-pub.pem`.
5. **Self-sign a device certificate.** Subject CN derived from `hostname` or `DROPLET_DEVICE_ID` env. Persist to `device-id-cert.pem`. WARP-244 (cosign signing) can replace this with a real CA-issued cert later.
6. **Seal the device-id private key blob to PCRs [0, 2, 4, 7].** Persist sealed blob to `device-id.sealed`. The private key never exists in plaintext outside the TPM after this step.
7. **Drop a `provisioned.json` marker** with `{at, pcrs, cert_fingerprint}`. Used to detect "already provisioned, don't re-run."

Invoked by `setup.sh` in Step 4 (Secrets section, after MQTT password + TLS cert + JWT secret). Idempotent on re-run.

### Reseal flow

Triggered by either:
- **POST `/api/admin/device-identity/reseal`** — admin route, requires `req.user.role === 'admin'` AND a recent (within 60s) MFA re-auth. Body carries the re-auth token.
- **CLI** — `droplet-admin device-identity reseal` walks the admin through a re-auth challenge locally and calls the same route.

Both converge in `services/device-identity-svc`'s `Reseal` gRPC method:

1. **Verify operator-auth token.** Sidecar holds a short-lived nonce table; orchestrator hands a fresh nonce per request, sidecar checks it's recent + admin-issued.
2. **Read current PCR values** from `/dev/tpm0`.
3. **Verify the old sealed blob unseals against the OLD PCR set** (sanity check that this isn't a tampered reseal trying to bypass).
4. **Unseal the device-id private key into TPM volatile memory**, re-seal against NEW current PCR values, write the new `device-id.sealed` atomically (write to `.sealed.tmp`, fsync, rename).
5. **Update `provisioned.json`** with the new PCR snapshot + reseal timestamp.
6. **Emit an audit event.** Will flow into WARP-237's tamper-evident log once it lands; until then, structured JSON to stdout.

If step 3 fails (old seal doesn't unseal — usually means the device booted into an unexpected state), reseal aborts and the operator gets "could not verify previous identity — initiate recovery flow." Recovery flow = re-provision from scratch, which means losing any peer trust established against the old cert. Documented in the runbook.

### Mock backend (pure Python in-memory)

`services/device-identity-svc/backends/mock.py`:

- In-memory dict: `{ek_cert, srk_pub, device_id_priv, device_id_pub, device_id_cert, sealed_blob, pcrs}`.
- `pcrs` is `dict[int, bytes]` keyed on PCR index; starts at all-zeros for the sealing set; `simulate_kernel_update()` (test-only) bumps PCR 4.
- `seal(blob, pcrs)` returns opaque bytes containing `blob + PCR snapshot`. `unseal(sealed, current_pcrs)` returns blob only if snapshot matches.
- `sign(payload)` uses the in-memory ECC P-256 key (via `cryptography.hazmat.primitives.asymmetric.ec`).
- Persistence: mock writes to `/var/lib/droplet/tpm/` like the real backend so file-format tests exercise the same paths.

Lets every unit test + integration test on dev/CI behave indistinguishably from production except for the actual hardware-backed key material.

### Status surface

`GET /api/admin/device-identity/status`:

```json
{
  "provisioned": true,
  "backend": "real" | "mock",
  "cert_subject": "CN=droplet-12ab34cd",
  "cert_fingerprint": "sha256:af3e...",
  "cert_expires_at": "2031-05-11T03:00:00Z",
  "sealing_pcrs": [0, 2, 4, 7],
  "seal_valid": true,
  "last_reseal_at": "2026-05-11T03:00:00Z",
  "current_pcr_snapshot": {
    "0": "8d6e3a...",
    "2": "0000...",
    "4": "5f7b2c...",
    "7": "1234..."
  }
}
```

`seal_valid: false` flips when sealing-set PCRs don't match values from `provisioned.json` — operator must reseal. Dashboard surface (later ticket) renders this as a red banner. CLI: `droplet-admin device-identity status`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `services/device-identity-svc/` | new dir | Python gRPC sidecar |
| `services/device-identity-svc/Dockerfile` | new | `python:3.12-slim` + FIPS provider (WARP-229 pattern) + tpm2-pytss + grpcio |
| `services/device-identity-svc/main.py` | new | gRPC server entrypoint, Unix socket binding, env-var backend selection |
| `services/device-identity-svc/backends/__init__.py` | new | `Backend` protocol every implementation satisfies |
| `services/device-identity-svc/backends/real.py` | new | tpm2-pytss-backed implementation |
| `services/device-identity-svc/backends/mock.py` | new | pure-Python in-memory implementation |
| `services/device-identity-svc/tests/test_backend_mock.py` | new | pytest contract tests; the mock validates the spec the real backend must satisfy |
| `services/device-identity-svc/tests/test_grpc_handler.py` | new | gRPC handler tests — happy path, auth failure, reseal flow |
| `services/device-identity-svc/requirements.txt` | new | grpcio, tpm2-pytss, cryptography |
| `proto/device_identity.proto` | new | gRPC service definition (Sign, GetCert, GetStatus, Reseal) |
| `services/device-identity-svc/grpc_generated/` | new (generated) | Python stubs |
| `apps/orchestrator/src/grpc-generated/device_identity_*.ts` | new (generated) | TS stubs |
| `apps/orchestrator/src/services/device-identity.client.ts` | new | TS gRPC client wrapper |
| `apps/orchestrator/src/services/device-identity.client.test.ts` | new | unit tests with mocked gRPC channel |
| `apps/orchestrator/src/routes/admin-device-identity.ts` | new | admin status + reseal routes |
| `apps/orchestrator/src/__tests__/admin-device-identity.test.ts` | new | route integration tests |
| `apps/orchestrator/src/middleware/require-recent-mfa.ts` | new | middleware asserting MFA re-auth within 60s |
| `scripts/provision-device-identity.sh` | new | First-boot enrollment ceremony |
| `scripts/setup.sh` | modify | Call provision script in Step 4 (Secrets), idempotently |
| `scripts/lib/droplet-admin/device-identity.sh` | new | `droplet-admin device-identity {status,reseal}` |
| `docker/docker-compose.yml` | modify | Add `device-identity-svc` service with `/dev/tpm0` passthrough + bind-mount `/var/lib/droplet/tpm/` |
| `docker/docker-compose.test.override.yml` | modify | Override `DROPLET_TPM_BACKEND=mock` for test lane |
| `.env.example` + `scripts/lib/secrets.sh` | modify | Add `DROPLET_TPM_BACKEND=real` + `DROPLET_DEVICE_ID` |
| `docs/security/device-identity.md` | new | Architecture, provisioning ceremony, reseal flow, recovery flow, FIPS posture |

## Phasing — single PR, 10 commits

1. **`feat(proto): device_identity.proto with Sign/GetCert/GetStatus/Reseal`** — proto + regenerate Python + TS stubs.
2. **`feat(device-identity-svc): scaffold gRPC server + Backend protocol + mock backend`** — sidecar skeleton, full mock backend, 15+ pytest cases covering seal/unseal/sign/PCR-change semantics. No real backend yet.
3. **`feat(device-identity-svc): real (tpm2-pytss) backend`** — production backend. Tests gated by `RUN_TPM_INTEGRATION=1`.
4. **`build(device-identity-svc): Dockerfile with FIPS provider + tpm2-pytss`** — follows WARP-229 Python image pattern.
5. **`feat(orchestrator): device-identity.client.ts gRPC client + unit tests`** — TS client wrapper.
6. **`feat(orchestrator): require-recent-mfa middleware`** — middleware asserting `last_mfa_at` within 60s. Used by reseal + future sensitive admin actions.
7. **`feat(orchestrator): admin device-identity routes`** — `GET /status` + `POST /reseal`, both behind admin + MFA re-auth.
8. **`feat(scripts): provision-device-identity.sh + setup.sh integration`** — first-boot ceremony, idempotent on re-run. Mock-backend bypass when `DROPLET_TPM_BACKEND=mock`.
9. **`feat(scripts): droplet-admin device-identity {status,reseal} CLI`** — shell wrapper authenticating against orchestrator + calling admin routes.
10. **`docs(security): device-identity.md + compose passthrough + .env.example`** — wire sidecar into Compose with `/dev/tpm0` passthrough on Linux + bind-mount, document FIPS posture + recovery flow.

Total: ~5-7 days of subagent work. Single PR. Mirrors WARP-229 structure.

## Error handling

| Failure | Behavior |
|---|---|
| TPM not present + DROPLET_TPM_BACKEND not set | provision exits cleanly with `provisioned=false`; orchestrator routes return `503 device_identity_unavailable` |
| Mock backend in production | startup log emits a warning; status surface shows `backend: "mock"` so the operator sees it |
| PCR snapshot doesn't match seal | reseal route returns 409 `seal_invalid_needs_reseal`; dashboard shows the red banner |
| Reseal called without recent MFA | 401 `mfa_required` from `require-recent-mfa` middleware |
| Reseal called by non-admin | 403 `admin_required` |
| Old seal doesn't unseal during reseal verification | 409 `previous_identity_unverifiable`; CLI surfaces recovery-flow instructions |
| Sidecar gRPC unreachable | orchestrator routes return `503 device_identity_svc_unreachable`; structured warning logged |
| `provision-device-identity.sh` rerun after successful provision | exits 0; logs "already provisioned, skipping" |
| tpm2-pytss import fails at startup (missing native deps) | real backend init fails; sidecar refuses to start; setup.sh detects + falls back to mock with a warning |

## Risks

- **tpm2-pytss build/install difficulty.** Native deps; may need extra apt packages on the Python image. Mitigation: mock backend means we don't block on this — real backend can be iterated post-merge if Dockerfile takes time to get right.
- **PCR set may differ from generic UEFI.** PCRs 0/2/4/7 are canonical for standard UEFI boot; some bootloaders may not match. Mitigation: detect actual PCR values during provisioning, persist the SET we use to `provisioned.json`. Set is configurable via env (`DROPLET_TPM_PCRS=0,2,4,7`) so a platform-specific override is one config change away.
- **Reseal after firmware update fails because old seal doesn't unseal.** Documented recovery: re-provision from scratch. Loses any peer trust established against the old cert. For v1 acceptable since no cloud-connector peers exist yet.
- **Mock backend silently masks real-TPM bugs.** Mitigation: explicit "manual appliance verification before release" in the release runbook (added in commit 10).

## Acceptance criteria

- All 10 commits land in a single PR; all PR-required CI lanes green including `test-fips`
- `device-identity-svc` boots in both `real` and `mock` modes
- `GET /api/admin/device-identity/status` returns the structured payload above
- `POST /api/admin/device-identity/reseal` succeeds with valid MFA re-auth; 401 without; 403 without admin role
- Reseal flow correctly re-binds the key to new PCR values (verified in mock test by `simulate_kernel_update()` → reseal → unseal succeeds)
- `seal_valid` flips to `false` when PCR snapshot drifts
- `droplet-admin device-identity status` prints the same fields as the HTTP route
- `provision-device-identity.sh` is idempotent on re-run
- Mock backend tests pass on Mac + Linux CI; real backend tests skip-gated on `RUN_TPM_INTEGRATION=1`
- `docs/security/device-identity.md` documents provisioning + reseal + recovery flows
- New `device-identity-svc` Dockerfile uses FIPS provider via the WARP-229 pattern

## Out of scope (other tickets)

- CSR / CA-issued device certs — future ticket
- mTLS to cloud connectors — Phase D
- External TPM module hardware variant — single-appliance assumption
- Physical button reseal trigger — future federal-customer ticket
- WebAuthn MFA for reseal (vs current TOTP) — WARP-238 hooks in once it ships
- Audit log integration — WARP-237 ingestor picks up the structured-JSON events retroactively when it lands
