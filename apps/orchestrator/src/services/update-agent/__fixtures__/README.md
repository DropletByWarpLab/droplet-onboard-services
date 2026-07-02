# update-agent golden fixtures (WARP-537)

Test-only material for `manifest.test.ts` / `verify.test.ts`. **Nothing in
this directory carries any trust** — the keypairs were minted purely to sign
test fixtures and are deliberately committed (private halves included) so the
fixtures can be regenerated or extended. They are never read by any
production code path: the production trust anchor is
`../cosign.pub` (see `verify.ts` → `defaultTrustAnchorPath()`), and no code
outside the tests references this directory.

| File | Role |
|---|---|
| `TEST-ONLY-signing.key/.pub` | Fixture signing keypair ("key A"). Password: `droplet-test-fixtures`. |
| `TEST-ONLY-wrong-key.key/.pub` | Second keypair ("key B") for the wrong-key rejection case. Same password. |
| `placeholder-cosign.pub` | Copy of the shipped placeholder trust anchor — the fail-closed case. |
| `release.valid.json` + `.sig` | Schema-v1 manifest signed with key A. The happy path. |
| `release.valid-v2.json` + `.sig` | A second, newer valid release (different `gitSha`) — used by the WARP-538 poller supersede test. |
| `release.tampered.json` + `.sig` | Valid manifest with one byte changed **after** signing (`.sig` is a copy of `release.valid.json.sig`) → `signature_failed`. |
| `release.valid.json.wrong-key.sig` | `release.valid.json` signed with key B; verified against key A → `signature_failed`. |
| `release.malformed.json` + `.sig` | Truncated JSON, correctly signed with key A — passes signature, fails parse → `malformed_manifest`. |
| `release.schema-downgrade.json` + `.sig` | `schemaVersion: 0`, correctly signed → `schema_downgrade`. |
| `release.schema-invalid.json` + `.sig` | Parseable JSON with invalid fields (bad gitSha, empty services, bad sha256), correctly signed → `schema_invalid`. |

The malformed / downgrade / invalid fixtures are signed with the **valid**
key on purpose: each test must prove its rejection comes from the named gate,
not from an incidental signature failure earlier in the chain.

## Regenerating

```bash
export COSIGN_PASSWORD=droplet-test-fixtures
cosign generate-key-pair --output-key-prefix TEST-ONLY-signing      # only if rotating the fixture key
for f in release.valid.json release.valid-v2.json release.schema-downgrade.json \
         release.schema-invalid.json release.malformed.json; do
  cosign sign-blob --yes --key TEST-ONLY-signing.key --tlog-upload=false \
    --output-signature "$f.sig" "$f"
done
cosign sign-blob --yes --key TEST-ONLY-wrong-key.key --tlog-upload=false \
  --output-signature release.valid.json.wrong-key.sig release.valid.json
cp release.valid.json.sig release.tampered.json.sig   # tampered = valid sig, mutated content
```

`--tlog-upload=false` mirrors the production publish workflow
(`.github/workflows/publish-release.yml`): private releases, offline
key-based device verification, no public Rekor entry.
