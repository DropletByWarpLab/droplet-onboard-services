# Appliance image release-signing keys (WARP-663 / ADR-020)

`droplet-image sign` / `verify` use **OpenSSL ECDSA over P-256** to sign and
verify the release `manifest.json`. This is the FIPS-approved primitive per
[`docs/security/fips-allowed-algorithms.md`](../../../docs/security/fips-allowed-algorithms.md);
**Ed25519 / minisign is explicitly forbidden** by that policy (ADR-020 §D5).

## What lives here

| File | Tracked? | What it is |
|---|---|---|
| `droplet-release.pub` | **Yes** | The PUBLIC verify key. `droplet-image verify` reads it (or `--pubkey`) to check a manifest signature. Safe to distribute — it can only verify, never sign. |
| `droplet-release.key` | **NEVER** | The PRIVATE signing key. Never committed; `.gitignore`d. Referenced only via `$DROPLET_RELEASE_SIGNING_KEY` at sign time. |

> **The `droplet-release.pub` checked in here is the REAL release trust anchor.**
> Minted 2026-06-04 for the v0.2.0 first publish. Key id (SHA-256 of the SPKI
> public key): `f797b7c207780951d651f697eeadb2452722d7f3bcc2fc4ac0d770f364d154ea`.
>
> **Private-key custody — ACTION REQUIRED.** The matching private key currently
> lives at `C:\Users\stefa\.droplet-secrets\droplet-release-signing.key` on the
> signing host, with the ACL restricted to the owner. This is **interim escrow**
> — it must be moved into the org's proper key store (password manager / vault /
> HSM) and removed from the local disk once escrowed. It is outside every repo
> and OneDrive-synced path; it is never committed (referenced only via
> `$DROPLET_RELEASE_SIGNING_KEY`). If this key is lost, rotate per the section
> below; if it is exposed, rotate immediately and re-sign every live manifest.

## Generating the real release keypair (first-publish step)

```bash
# Private key — generate on an air-gapped/HSM-backed host, escrow per the
# org key-custody policy. NEVER commit it; NEVER leave it on a CI runner.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
  -out droplet-release.key
chmod 600 droplet-release.key

# Public key — commit this to scripts/image/keys/droplet-release.pub.
openssl pkey -in droplet-release.key -pubout -out droplet-release.pub
```

Then sign/verify a manifest:

```bash
DROPLET_RELEASE_SIGNING_KEY=./droplet-release.key \
  ./scripts/droplet-image sign --manifest manifest.json --sig manifest.json.sig

./scripts/droplet-image verify \
  --manifest manifest.json --sig manifest.json.sig \
  --pubkey scripts/image/keys/droplet-release.pub
```

## Key rotation

Rotation is a **superset-trust** transition so in-field boxes that only know the
old key keep verifying until they update:

1. Mint a new keypair (`droplet-release-2.key` / `.pub`) as above; escrow the
   new private key, retire the old one from the signing host.
2. Commit the new public key alongside the current one
   (`droplet-release-2.pub`) — do **not** delete the old `.pub` yet.
3. Re-sign the live `manifest.json` with the new key and publish.
4. Teach `verify` to accept the union of `(current, prior)` public keys for the
   overlap window (the verifier tries each tracked `*.pub` and accepts on the
   first match). This mirrors the audit-key rotation note in
   `scripts/lib/secrets.sh::sync_audit_signing_key`.
5. After every supported box has updated past the overlap window, remove the
   retired `.pub` in a follow-up commit.

The **strategic** upgrade path is cosign (WARP-244), which replaces the openssl
primitive without changing the manifest contract or this key layout.
