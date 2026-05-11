# Device identity (WARP-230)

Every Droplet appliance generates a **non-extractable hardware-rooted
identity key** on first boot, sealed to TPM 2.0 PCRs `[0, 2, 4, 7]`.
The private key never leaves the TPM in plaintext.

## Architecture

`services/device-identity-svc/` is a Python gRPC sidecar — the only
container with `/dev/tpm0` access. The orchestrator talks to it over a
Unix domain socket (`/var/run/droplet/device-identity.sock`).

```
┌─────────────────┐   gRPC over Unix    ┌────────────────────────┐
│  orchestrator   │ ◀──────socket──────▶│  device-identity-svc   │
│  (TS, no TPM)   │                     │  (Python, /dev/tpm0)   │
└─────────────────┘                     └────────────────────────┘
                                                   │
                                                   ▼
                                          ┌────────────────────┐
                                          │  Backend           │
                                          │  • real (tpm2-pytss│
                                          │  • mock (in-memory)│
                                          └────────────────────┘
```

The orchestrator never imports tpm2-pytss; it only knows the gRPC surface,
so swapping the backend (real ↔ mock) is invisible to every caller above
the sidecar.

## Backends

| Backend | Selected when | Behavior |
|---|---|---|
| `real` | `DROPLET_TPM_BACKEND=real` (Jetson production) | tpm2-pytss against `/dev/tpm0`; ECC P-256 key sealed to PCRs |
| `mock` | `DROPLET_TPM_BACKEND=mock` (dev, CI) | Pure-Python in-memory; persists artifacts to `/var/lib/droplet/tpm/` for cross-process interchangeability |

`scripts/lib/secrets.sh` picks the default at install time: `real` when
`/dev/tpm0` exists on the host, `mock` otherwise. Operator can override
in `.env`.

The orchestrator can't tell the difference — `getDeviceIdentityStatus()`
returns the same shape from both. The `backend` field of the status
response is the only signal.

## Provisioning ceremony

`scripts/provision-device-identity.sh` runs in `setup.sh` Phase 4. It is
idempotent — if `/var/lib/droplet/tpm/provisioned.json` already exists,
it exits 0. Otherwise, on first sidecar start (the Compose service runs
with `DROPLET_AUTO_PROVISION=1`), the sidecar:

1. Detects TPM presence (real backend) or skips straight to step 4 (mock).
2. Reads or synthesizes the Endorsement Key Certificate. Jetson modules
   don't ship a pre-installed EK cert; the real backend synthesizes a
   self-signed cert over the EK public key.
3. Creates the Storage Root Key, persistent at handle `0x81000001`.
4. Generates the device identity key: ECC P-256, scheme `ECDSA + SHA-256`,
   attributes `sign | fixedTPM | fixedParent | sensitiveDataOrigin`.
   The `fixedTPM | fixedParent` flags make the key non-extractable.
5. Self-signs a 5-year X.509 cert with subject `CN=<DROPLET_DEVICE_ID>`.
   `DEVICE_CERT_VALIDITY_DAYS = 365 * 5` is a named constant in both
   backends.
6. Seals the private key blob to the sealing PCR set (default
   `[0, 2, 4, 7]`, override via `DROPLET_TPM_PCRS`).
7. Writes `provisioned.json` with `{at, device_id, pcrs, cert_fingerprint}`.
   This file is the canonical "already provisioned" marker.

Artifacts at `/var/lib/droplet/tpm/`:

| File | Contents |
|---|---|
| `ek-cert.pem` | Endorsement Key cert (synthesized for Jetson) |
| `srk-pub.pem` | Storage Root Key public component |
| `device-id-pub.pem` | Device identity public key |
| `device-id-cert.pem` | Self-signed X.509 cert |
| `device-id.sealed` | TPM-sealed private-key blob |
| `provisioned.json` | Marker + PCR snapshot + cert fingerprint |

## Reseal flow

When firmware/kernel updates change the sealing PCRs, the sealed blob
becomes invalid. The status surface flips `seal_valid: false`.

**Two reseal paths, both auth-gated:**

- **Dashboard:** `Admin → Security → Device identity → Reseal`. Requires
  admin role + MFA re-auth within 60s.
- **CLI:** `droplet-admin device-identity reseal`. Same gating; the CLI
  hits the same admin route as the dashboard.

The reseal flow:

1. Operator authenticates + completes MFA challenge.
2. Orchestrator validates `req.user.lastMfaAt` is within 60s
   (`require-recent-mfa` middleware).
3. Orchestrator mints a fresh operator-auth nonce and calls the sidecar's
   `Reseal` gRPC method.
4. Sidecar verifies the nonce (single-use, 60s TTL), reads current PCRs,
   re-binds the sealed blob, writes the new sealed blob atomically.
5. Status flips back to `seal_valid: true`.

All thresholds are named constants:
- `DEFAULT_MFA_WINDOW_SEC = 60` (orchestrator middleware)
- `RESEAL_NONCE_TTL_SEC = 60` (sidecar)

## Recovery flow

If the old seal doesn't unseal (device booted into an unexpected state,
or a firmware downgrade broke the chain), reseal returns
`previous_identity_unverifiable`. Recovery:

1. Wipe `/var/lib/droplet/tpm/` on the host after operator confirmation.
2. Sidecar re-provisions on next start with a **new** device key.
3. Any peer trust established against the old cert is lost.
4. Update peer-side trust stores to accept the new cert.

For v1, no peers exist yet (cloud connector path = Phase D), so recovery
is low-cost. Document the runbook in the operator manual when peers are
introduced.

## FIPS posture

- **ECC P-256 + SHA-256** — FIPS 140-3 approved (matches WARP-229's
  allowlist).
- **ECDSA** — FIPS-approved signature scheme.
- **AES-256-GCM** (TPM-internal wrapping key, real backend) — FIPS-approved.
- **TPM 2.0 hardware module** — FIPS 140-2 Level 2 on most Infineon
  SLB 96xx series shipping on Jetson modules.

The sidecar Dockerfile uses the WARP-229 FIPS provider pattern:
`/etc/ssl/openssl-fips.cnf` ships in the image, the runtime
`OPENSSL_CONF` env can be set by the Compose service once the validated
FIPS module is layered on. The boot self-test is gated by
`DROPLET_FIPS_REQUIRED` — same mechanism as `file-indexer` and
`ai-gateway`.

## Operational notes

- Dashboard renders a red banner when `seal_valid: false`. The banner
  links to the reseal action.
- The sidecar's `/var/run/droplet/` directory is the only filesystem
  location the orchestrator can reach the sidecar. Move it via
  `DROPLET_DI_SOCKET` env if your deployment has filesystem constraints.
- On Mac dev (no TPM, no `/dev/tpm0`), the Compose service starts
  cleanly with `DROPLET_TPM_BACKEND=mock` and the `/dev/tpm0` device
  entry is silently skipped by Docker. The test override
  `docker/docker-compose.test.override.yml` makes this explicit by
  clearing the `devices:` list.

## Risk register

- **Mock backend in production.** Sidecar logs a warning at startup if
  `DROPLET_TPM_BACKEND=mock` + `DROPLET_ENV=production`. Operator must
  set `real` explicitly when shipping.
- **PCR set drift between vendors.** PCRs `[0, 2, 4, 7]` are canonical
  for x86/UEFI; Jetson's cboot may not match exactly. The sidecar
  detects actual PCR values during provisioning and persists the SET
  used to `provisioned.json`. Override the set via `DROPLET_TPM_PCRS`
  env (e.g. `DROPLET_TPM_PCRS=0,4,7`).
- **Reseal lock-out.** If the MFA system is broken AND reseal is needed
  (after firmware update), operator falls back to the recovery flow
  above.
- **Real-backend tss2 placeholders.** Task 3's `RealBackend` ships with
  scaffold method bodies in `_create_and_seal_device_key`,
  `_unseal_into_tpm`, `_tpm_sign`, `_seal_against_current_pcrs`, and
  `_self_sign_cert`. The contract tests are skip-gated by
  `RUN_TPM_INTEGRATION=1`. The agent finishing the real-TPM wiring
  fills in the actual tpm2-pytss calls; each method's docstring points
  at the canonical example file to consult.

## Out of scope (other tickets)

- CSR / CA-issued device certs — future ticket
- mTLS to cloud connectors using this identity — Phase D
- Physical button for reseal trigger — future federal-customer ticket
- External TPM module hardware variant — single-Jetson assumption
- WebAuthn MFA for reseal (vs current TOTP) — WARP-238 hooks in once it
  ships
- Audit log integration — WARP-237 ingestor picks up the structured-JSON
  events retroactively when it lands

## Cross-references

- Design spec: `docs/superpowers/specs/2026-05-11-warp-230-tpm-device-identity-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-11-warp-230-tpm-device-identity-plan.md`
- FIPS allowlist: `docs/security/fips-allowed-algorithms.md`
- Jira: WARP-230
