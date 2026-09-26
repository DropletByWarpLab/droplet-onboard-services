# Verifying an audit bundle offline

`POST /api/activity/export` (owner/admin; the **Export sealed bundle** button on
the Audit log page) downloads `droplet-activity-bundle.jsonl`. Since WARP-3153
the file carries **no secret**: holding it lets you check the history, never
rewrite it.

## What is in the file (format `droplet.activity-bundle.v3`)

| Line | Content |
|---|---|
| first | manifest: `type`, `rowAlgorithm` (`HMAC-SHA256`), `deviceCertPem` (the box's device identity certificate, public), `deviceCertFingerprint`, `exportedAt`, `filter` |
| middle | one audit row per line, ascending `id`: content, `signature`, `prevSignatureHash`, actor fields, `schemaVersion` |
| last | seal: `rowCount`, `rowHmac` (the box's own check of every row at export time), `digest`, `algorithm`, `signature` |

- `digest` is base64url SHA-256 over every byte of the file before the seal
  line, newlines included.
- `signature` is the device identity key's signature (ECDSA P-256 / SHA-256,
  DER, base64) over the ASCII string `droplet-activity-bundle:v3:` followed by
  `digest`. The key lives in device-identity-svc (TPM-held on a real backend)
  and never leaves it.
- Row `signature`s are HMAC-SHA256 under the box's audit key. That key stays
  on the box, so rows cannot be re-checked offline one by one. The seal's
  `rowHmac` records the box's verdict at export time, and the device-key seal
  protects that verdict with everything else in the file.

## Verify

1. On the box, as owner or admin, read the device certificate fingerprint:
   `GET /api/admin/device-identity/status` → `certFingerprint`
   (`sha256:<hex>`). Record it once, somewhere you trust; it is the same for
   every bundle from that box until the device identity is reprovisioned.
2. Run the verifier (Node 18+, no network, no dependencies):

   ```bash
   node scripts/verify-activity-bundle.mjs droplet-activity-bundle.jsonl \
     --fingerprint sha256:<hex from step 1>
   ```

   Exit `0` and `OK: <n> row(s) sealed by sha256:…` means verified. Any `FAIL:`
   line means the file must not be relied on.

Without `--fingerprint` the verifier still checks integrity but warns that
**origin is not checked**. Anyone can mint a key and seal a fabricated bundle;
only the fingerprint ties the file to your box.

The verifier checks:

- the seal's signature against the bundled certificate;
- the digest against the file's bytes (any edit, insertion or deletion fails);
- the certificate against the expected fingerprint;
- `rowCount`, ascending ids, and, for an unfiltered export, that every row's
  `prevSignatureHash` is base64url SHA-256 of the previous row's `signature`;
- that the box reported no row failing its HMAC check.

A filtered export (kind, actor, dates, search) contains gaps, so links between
consecutive rows are not checked; the seal still covers every row in the file.

### Without the script

```bash
sed '$d' bundle.jsonl > signed.bin                        # every byte but the seal line
tail -n1 bundle.jsonl | jq -r .digest                     # compare with:
openssl dgst -sha256 -binary signed.bin | openssl base64 -A | tr '+/' '-_' | tr -d '='
head -n1 bundle.jsonl | jq -j .deviceCertPem > device.pem   # -j: exact bytes
openssl x509 -in device.pem -pubkey -noout > device.pub
printf 'droplet-activity-bundle:v3:%s' "$(tail -n1 bundle.jsonl | jq -r .digest)" > sealed.txt
tail -n1 bundle.jsonl | jq -r .signature | base64 -d > seal.sig
openssl dgst -sha256 -verify device.pub -signature seal.sig sealed.txt
shasum -a 256 device.pem                                  # must equal certFingerprint
```

## Bundles exported before WARP-3153

Formats `droplet.activity-bundle.v1`/`v2` carried the audit HMAC key itself in
the manifest's `publicKey` field. Whoever holds such a file can forge chain
entries that verify. Treat those files as secrets, and rotate the audit key
on any box that ever exported one (see WARP-3165 for rotation support).
