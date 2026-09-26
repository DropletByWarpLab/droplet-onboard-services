# Verifying an audit bundle offline

`POST /api/activity/export` (owner/admin; the **Export sealed bundle** button on
the Audit log page) downloads `droplet-activity-bundle.jsonl`. Since WARP-3153
the file carries **no secret**: holding it lets you check the history, never
rewrite it.

> **Limit today: the seal key is a software key.** The seal is signed by
> device-identity-svc. On the mock backend, which every box runs today
> (`DROPLET_TPM_BACKEND=mock`), that key is a file on the box, not a TPM key.
> Anyone with root on the box can read it and seal a forged bundle that
> verifies. The real TPM backend cannot sign yet: its `_tpm_sign` returns an
> empty signature (WARP-1181), and the export refuses to seal with one (HTTP
> 503). So the seal protects a bundle **after it leaves the box**; it does not
> protect it against the box's own administrator.

## What is in the file (format `droplet.activity-bundle.v3`)

| Line | Content |
|---|---|
| first | manifest: `type`, `rowAlgorithm` (`HMAC-SHA256`), `deviceCertPem` (the box's device identity certificate, public), `deviceCertFingerprint`, `exportedAt`, `filter` |
| middle | one audit row per line, ascending `id`: content, `signature`, `prevSignatureHash`, actor fields, `schemaVersion` |
| last | seal: `type`, `statement` (a JSON string), `algorithm`, `signature` |

The seal's `statement` holds every seal field, and the signature covers it
byte for byte:

- `digest`: base64url SHA-256 over every byte of the file before the seal
  line, newlines included;
- `rowCount`: the rows in the file;
- `rowHmac`: `{checked, failed, failedRowIds}`. This is the box's own check of
  every row's HMAC at export time. Row `signature`s are HMAC-SHA256 under the
  box's audit key, which stays on the box, so no one can re-check them
  offline.

`signature` is the device identity key's signature (ECDSA P-256 / SHA-256,
DER, base64) over the ASCII string `droplet-activity-bundle:v3:` followed by
`statement` verbatim. Editing any seal field, including the HMAC verdict,
breaks it.

## Verify

1. On the box, as owner or admin, read the device certificate fingerprint:
   `GET /api/admin/device-identity/status` → `certFingerprint`
   (`sha256:<hex>`). Record it once, somewhere you trust. It stays the same
   for every bundle from that box until the device identity is reprovisioned.
2. Run the verifier (Node 18+, no network, no dependencies):

   ```bash
   node scripts/verify-activity-bundle.mjs droplet-activity-bundle.jsonl \
     --fingerprint sha256:<hex from step 1>
   ```

   Exit `0` and `OK: <n> row(s) sealed by sha256:…` means verified. Any
   `FAIL:` line means the file must not be relied on.

The fingerprint is required. Anyone can mint a key and seal a fabricated
bundle; only the fingerprint ties the file to your box. `--no-fingerprint`
checks integrity only and prints a warning that origin is not checked.

The verifier checks:

- the seal's signature over the statement, against the bundled certificate;
- the statement's digest against the file's bytes: any edit, insertion or
  deletion of a line fails, including deleting rows from the head;
- the certificate against the expected fingerprint;
- `rowCount` and `rowHmac.checked` equal the rows in the file, and
  `rowHmac.failed` is 0;
- ascending ids, and, for an unfiltered export, that every row's
  `prevSignatureHash` is base64url SHA-256 of the previous row's `signature`.

### What a bundle cannot tell you

- **Rows missing before the first row.** The first row's `prevSignatureHash`
  points at a row that is not in the file: it was purged by retention, or it
  lies outside the filter. Nothing offline can check that link. So rows
  removed from the **start** of the chain on the box, before the export, are
  invisible in the bundle. Compare the first row against the device-signed
  daily roots (`GET /api/audit/roots`, WARP-237) to anchor it.
- **Filtered exports** (kind, actor, dates, search) have gaps, so links
  between consecutive rows are not checked. The seal still covers every row
  in the file.

### Without the script

```bash
sed '$d' bundle.jsonl > signed.bin                        # every byte but the seal line
tail -n1 bundle.jsonl | jq -r .statement | jq -r .digest  # compare with:
openssl dgst -sha256 -binary signed.bin | openssl base64 -A | tr '+/' '-_' | tr -d '='
head -n1 bundle.jsonl | jq -j .deviceCertPem > device.pem   # -j: exact bytes
openssl x509 -in device.pem -pubkey -noout > device.pub
printf 'droplet-activity-bundle:v3:%s' "$(tail -n1 bundle.jsonl | jq -j .statement)" > sealed.txt
tail -n1 bundle.jsonl | jq -r .signature | base64 -d > seal.sig
openssl dgst -sha256 -verify device.pub -signature seal.sig sealed.txt
shasum -a 256 device.pem                                  # must equal certFingerprint
tail -n1 bundle.jsonl | jq -r .statement | jq .rowHmac    # failed must be 0, checked = rows
```

## Bundles exported before WARP-3153

Formats `droplet.activity-bundle.v1`/`v2` carried the audit HMAC key itself in
the manifest's `publicKey` field. Whoever holds such a file can forge chain
entries that verify. Treat those files as secrets, and rotate the audit key
on any box that ever exported one (see WARP-3165 for rotation support).
