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
| `release.channel-beta.json` + `.sig` | Valid manifest claiming an unsubscribed channel → the poller's `channel_mismatch` gate. |
| `release.channel-stage.json` + `.sig` | Valid manifest on `channel: stage` (WARP-1670) — the stage-box happy path, and the counter-example proving a stage-tagged release still has to say `stage` in its SIGNED manifest. |

The malformed / downgrade / invalid fixtures are signed with the **valid**
key on purpose: each test must prove its rejection comes from the named gate,
not from an incidental signature failure earlier in the chain.

## Regenerating

```bash
export COSIGN_PASSWORD=droplet-test-fixtures
cosign generate-key-pair --output-key-prefix TEST-ONLY-signing      # only if rotating the fixture key
for f in release.valid.json release.valid-v2.json release.schema-downgrade.json \
         release.schema-invalid.json release.malformed.json \
         release.channel-beta.json release.channel-stage.json; do
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

On cosign v3 the signing defaults moved: add
`--use-signing-config=false --new-bundle-format=false` to each
`sign-blob` above, or it refuses `--tlog-upload=false` and emits a bundle
the device-side `verify-blob --signature` path cannot read. Verification
is unaffected — v3 still verifies these v2-shaped signatures.

## Extension statements (WARP-2900, ADR-056 slice H1)

Test-only material for `extension-verify*.test.ts`,
`release-paths-stay-release-only.test.ts`, `extension-cross-protocol.test.ts`
and `extension-promotion.service.test.ts`. Same rule: nothing here carries
trust.

| File | Role |
|---|---|
| `TEST-ONLY-extension.key/.pub` | Stand-in for the BOX extension key ("key E"). Plain unencrypted PKCS8 PEM, because Node signs with it in tests; the sidecar holds the real one. |
| `extension.manifest.json` | A valid schemaVersion-1 extension manifest (the word_count template shape). |
| `extension.manifest.tampered.json` | The same manifest with `memoryMb` changed after the statement was signed → `extension_digest_mismatch`. |
| `extension.valid.json` | The canonical statement for that manifest (`buildExtensionStatement` output, byte-for-byte; a test pins it). |
| `extension.valid.json.box.sig` | Key E over `droplet-extension-statement:v1:` \|\| statement. The box happy path. |
| `extension.valid.json.box-unprefixed.sig` | Key E over the bare statement (the sidecar never makes this) → `signature_failed`. |
| `extension.valid.json.release.sig` | **(d)** Key A (release) over the raw statement, in `cosign sign-blob --key` format → ok, signer `release`. |
| `extension.valid.json.neither.sig` | **(b)** Key B over the raw statement: neither trusted key → `signature_failed`. |
| `extension.kind-release.json` + `.box.sig` | **(a)** `kind: "release"` signed by key E → `key_usage_mismatch`. |
| `extension.kind-release.json.release.sig` | The same statement signed by key A: a valid release-key signature on something that is not an extension → `extension_schema_invalid`. |
| `extension.no-kind.json` + `.box.sig` | **(c)** No `kind`, signed by key E → `extension_kind_missing`. |
| `extension.tampered.json` + `.box.sig` | One byte of the statement changed after signing; `.sig` is a copy of the valid box sig → `signature_failed`. |
| `extension.wrong-digest.json` + `.box.sig` | Correctly signed by key E, but `manifestSha256` names the tampered manifest → `extension_digest_mismatch`. |
| `release.valid.json.ext-key.sig` / `.ext-key-prefixed.sig` | `release.valid.json` signed by key E, raw and in the extension envelope. The OTA release verifier must refuse both. |

Every `.sig` is base64 of a DER ECDSA-P256-SHA256 signature, which is exactly
what `cosign sign-blob --key` writes and what `cosign verify-blob --signature`
reads. The box signatures are over the prefixed envelope, so they are not
cosign signatures of the statement file and are verified in-process
(`extension-verify.ts`), never by cosign.

### How these were minted

Key E and every key-E signature: Node `crypto.sign("sha256", data, keyE)`.

**(d) and the other key-A / key-B signatures were minted WITHOUT the cosign
binary**, which was not available on the machine that generated them: the
encrypted `TEST-ONLY-signing.key` / `TEST-ONLY-wrong-key.key` were decrypted
with their committed password (scrypt + NaCl secretbox, the sigstore
encrypted-key format) and Node signed the raw statement with the result. That
is the same computation `cosign sign-blob --key` performs; the proof that the
bytes are cosign-compatible is `extension-verify.cosign.test.ts`, which
verifies (d) with the real `cosign verify-blob` in CI. To regenerate with
cosign instead:

```bash
export COSIGN_PASSWORD=droplet-test-fixtures
cosign sign-blob --yes --key TEST-ONLY-signing.key --tlog-upload=false   --use-signing-config=false --new-bundle-format=false   --output-signature extension.valid.json.release.sig extension.valid.json
cosign sign-blob --yes --key TEST-ONLY-signing.key --tlog-upload=false   --use-signing-config=false --new-bundle-format=false   --output-signature extension.kind-release.json.release.sig extension.kind-release.json
cosign sign-blob --yes --key TEST-ONLY-wrong-key.key --tlog-upload=false   --use-signing-config=false --new-bundle-format=false   --output-signature extension.valid.json.neither.sig extension.valid.json
```

(Drop the two `--use-signing-config` / `--new-bundle-format` flags on cosign
v2.) ECDSA signatures are randomized, so regenerated `.sig` files differ
byte-wise and still verify.

Key-E signatures (box envelope), from this directory:

```bash
node -e '
const c = require("node:crypto"), fs = require("node:fs");
const k = c.createPrivateKey(fs.readFileSync("TEST-ONLY-extension.key"));
const P = Buffer.from("droplet-extension-statement:v1:");
for (const f of ["extension.valid.json", "extension.kind-release.json",
                 "extension.no-kind.json", "extension.wrong-digest.json"])
  fs.writeFileSync(f + ".box.sig",
    c.sign("sha256", Buffer.concat([P, fs.readFileSync(f)]), k).toString("base64"));
'
cp extension.valid.json.box.sig extension.tampered.json.box.sig
```

The statement files are canonical JSON with no trailing newline; if the
manifest changes, rebuild `extension.valid.json` with `buildExtensionStatement`
(the pinning test prints the expected bytes on mismatch) and re-sign.
