# fleet-server — Warp fleet HQ TLS issuance service

The first concrete component of the Warp fleet HQ (`hq.warp-lab.com`).
It issues **publicly-trusted Let's Encrypt certificates** to Droplet
boxes via **Cloudflare DNS-01**, using a **box-supplied CSR** so the
box's private serving key never leaves the box.

> Implements ADR-023 action item C1 (`docs/ADR-023-public-ca-per-device-tls-via-hq-dns01.md`).
> **Deployed to HQ, NOT to a box.** It is intentionally absent from the
> box monorepo `docker-compose.yml`; see the standalone compose here.

## Why HQ-mediated

A box cannot safely hold a Cloudflare DNS-write credential (it sits on
customer hardware). So the box generates its own keypair + CSR, proves
possession of its TPM identity key, and HQ performs the DNS-01 dance with
that CSR and returns only the signed leaf + chain. No public A/AAAA
record is ever created — only a transient `_acme-challenge` TXT, deleted
after each order. The box's home IP is never published.

## The issuance contract (box side must match EXACTLY)

Base path `/api/issuance`, all over HTTPS.

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /order/challenge` | `{device_id}` | `{nonce, expires_at, public_label, fqdn}` | 404 device not in registry; 429 rate-limited (+`Retry-After`) |
| `POST /order` | `{device_id, csr_pem, nonce, signature, sig_alg, key_fingerprint}` | `202 {order_id, status:"pending", fqdn}` | 401 bad/expired/used nonce or bad signature; 403 not registered / fingerprint mismatch; 400 CSR SAN != fqdn; 409 order in progress; 502 ACME/Cloudflare upstream |
| `GET /order/{order_id}?device_id=` | — | `{order_id, status, fqdn, fullchain_pem?, not_after?, last_error?}` | 404 not found / non-matching device |
| `POST /renew` | same as `/order` | `202` (same `fqdn`/label) | same as `/order` |
| `DELETE /registration?device_id=` | `{device_id, nonce, signature, sig_alg, key_fingerprint}` (fresh challenge) | `200 {device_id, status:"revoked"}` | 401/403 as above; 404 no cert |

`status` ∈ `{pending, active, renewing, revoked, failed}` — an explicit
enum, never derived from `IS NULL`.

### Proof-of-possession (the security boundary)

- The nonce grants nothing; it is single-use, 120s TTL, consumed
  atomically at `/order`. No bearer token is required.
- The box signs the **exact** string:

  ```
  droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>
  ```

  against the private key whose public half is in the device registry.
- `signature` is **base64**. Primary `sig_alg` is **`ecdsa-sha256`**
  (ECDSA P-256, WARP-230 TPM key) with a **DER-encoded (r,s)** signature.
  `rsa-pss` (RSA-PSS / SHA-256) is also accepted.
- `key_fingerprint` must match the registry row for `device_id`.
- The CSR must be valid (self-signature checks) and carry **exactly one**
  DNS SAN equal to the device's `fqdn`.

### Opaque per-device label

```
public_label = "d-" + HMAC_SHA256(HQ_LABEL_SECRET, device_id).hexdigest()[:16]
fqdn         = "<public_label>.<ISSUANCE_DOMAIN_BASE>"   # e.g. devices.warp-lab.ai
```

Keyed HMAC (not a bare hash) so a Certificate-Transparency-log
enumerator can't confirm a guessed `device_id`. Deterministic per device;
stored on the first order so it is stable across renewals.

## Registry seeding (out-of-band)

Devices are pre-registered at provisioning — this service does **not**
self-register them. Insert a row before a box can order:

```sql
INSERT INTO devices (device_id, public_key_pem, key_fingerprint)
VALUES ('<device_id>', '<TPM public key PEM>', '<fingerprint>');
```

## Configuration (all via env — no tracked secrets)

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Postgres DSN (required) |
| `HQ_LABEL_SECRET` | — | HMAC key for the opaque label (required, HQ-only) |
| `ISSUANCE_DOMAIN_BASE` | `devices.warp-lab.ai` | zone for per-device FQDNs |
| `CLOUDFLARE_API_TOKEN` | — | `Zone:DNS:Edit` scoped to the zone (required, HQ-only) |
| `CLOUDFLARE_ZONE_ID` | — | required |
| `ACME_DIRECTORY_URL` | LE **staging** | flip to prod only after verification |
| `ACME_CONTACT_EMAIL` | — | optional ACME contact |
| `ACME_ACCOUNT_KEY_PATH` | `/data/fleet-server/acme-account.key` | persisted, HQ-only secret-file |
| `NONCE_TTL_SEC` | `120` | challenge nonce TTL |
| `CHALLENGE_RATE_LIMIT` / `CHALLENGE_RATE_WINDOW_SEC` | `5` / `60` | per-device challenge throttle |
| `RENEW_BEFORE_DAYS` | `30` | renew when `not_after` within N days |
| `RENEWAL_CRON_HOUR` | `3` | daily renewal job hour |

> **Use LE staging for all plumbing tests** (ADR-023 §Risk: LE rate
> limits ~50 certs/registered-domain/week — per-device names rule out a
> wildcard).

## Renewal & revocation

- An apscheduler **daily cron** (no `while True`) selects `active` rows
  with `not_after` within `RENEW_BEFORE_DAYS` and re-finalizes against the
  **stored CSR** (the box keeps a stable serving keypair across
  renewals — ADR-023 §Decision 5), so routine renewal needs no box call.
- `DELETE /registration` ACME-revokes the leaf and frees the label
  (box factory-reset). Revocation proceeds even if the upstream revoke
  errors — the label must be freed.

## Deploy (HQ)

```bash
# Provide secrets via a .env file (NEVER committed):
#   POSTGRES_PASSWORD=... HQ_LABEL_SECRET=... CLOUDFLARE_API_TOKEN=...
#   CLOUDFLARE_ZONE_ID=... ACME_CONTACT_EMAIL=...
docker compose up -d --build
```

Migrations apply idempotently at startup (numbered `.sql` in
`migrations/`, recorded in a `schema_migrations` ledger — there is no
alembic/SQLAlchemy in this codebase). Probes: `/healthz`, `/readyz`.

## Tests

```bash
pip install -r requirements-dev.txt
pytest            # hermetic — no live LE / Cloudflare / Postgres
```

ACME + Cloudflare are mocked (`respx`); the ACME client is injected as a
fake. A real-SQL integration suite is gated behind
`FLEET_PG_TESTS=1` (+ `FLEET_TEST_DATABASE_URL`) and applies the
migrations twice to prove idempotency. Use **Python 3.12** (not 3.14).
