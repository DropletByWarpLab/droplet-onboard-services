# Droplet supply-chain security — signing & verification

How every released Droplet container image is signed, how the appliance
verifies before pulling, and how anyone can verify independently.

> Repo history note: this repository was renamed from
> `droplet-pi-platform` to `droplet-onboard-services`. All signing
> identities use the current name. Ticket texts referencing the old name
> refer to this repository.

## Two trust layers

| Layer | What it authenticates | Key/identity | Where verified |
|---|---|---|---|
| **Keyless image signatures** (WARP-244) | "this individual image was built by our release CI" | GitHub Actions OIDC identity of `.github/workflows/publish-release.yml@refs/heads/main`, certificate from Fulcio, entry in the public Rekor transparency log | on-device before every `docker pull` (`scripts/lib/apply-update.sh`), in CI post-sign self-check, and by anyone (below) |
| **Key-based release-manifest signature** (WARP-536) | "this exact set of image digests + configs constitutes release X" | org-held cosign keypair; public half baked into the orchestrator image at `apps/orchestrator/src/services/update-agent/cosign.pub` | on-device by the OTA update agent before a manifest byte is parsed |

Images are referenced **by digest only** end to end (`…@sha256:…`), so a
verified reference and the pulled bytes are the same content by
construction.

## Verify a released image yourself

Install cosign (`brew install cosign` on macOS), then:

```bash
cosign verify \
  --certificate-identity "https://github.com/DropletByWarpLab/droplet-onboard-services/.github/workflows/publish-release.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/dropletbywarplab/droplet-orchestrator@sha256:<digest-from-release.json>
```

Exit 0 plus a JSON verification bundle = genuine. Any other image ref —
including a re-tagged copy of our own image pushed by someone else —
fails with `no signatures found` / `no matching signatures`.

Every GitHub Release attaches `image-signatures.json`: per image, the
digest, the certificate identity/issuer above, and the **Rekor
transparency-log index** (search it at https://search.sigstore.dev).

## Verify a release manifest yourself

```bash
cosign verify-blob \
  --key cosign.pub \
  --signature release.json.sig \
  --insecure-ignore-tlog=true \
  release.json
```

`cosign.pub`, `release.json` and `release.json.sig` are attached to every
release. `--insecure-ignore-tlog=true` is the documented pairing for
key-based signatures made with `--tlog-upload=false` (the manifest is
deliberately not in the public log; the images are).

## What the appliance enforces at pull time

The only path that ever pulls a first-party image is the OTA apply step
(`scripts/lib/apply-update.sh`, `pull-images`). For each digest-pinned
ref it runs, **before** `docker pull`:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github\.com/DropletByWarpLab/droplet-onboard-services/\.github/workflows/publish-release\.yml@refs/heads/main$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --offline=true \
  "$img"
```

- **Fail closed.** Any non-verification refuses the pull; the update row
  records `failureReason: image_signature_failed`. There is **no bypass
  environment variable**.
- **Why fail closed is safe on an offline appliance:** verification runs
  only when pulling, and pulling already requires ghcr.io reachability. An
  offline box never reaches the verifier — it simply has no update to
  apply. Rollback recreates from images already on the box (`--pull
  never`) and never re-pulls, so a refusal can block an update but never
  the running stack.
- **No new egress:** `--offline=true` verifies the signature bundle
  (stored in GHCR alongside the image) against the trust root embedded in
  the checksum-pinned cosign binary vendored in the orchestrator image.
  No Rekor or TUF endpoints are contacted from the appliance.
- **Break-glass:** a human with host shell access can `docker pull` and
  recreate manually. That action is outside the orchestrator's OTA
  surface on purpose — it requires the same physical/SSH trust as any
  other host-level intervention.

## Third-party images

Upstream images in the compose file (nginx, Nextcloud, Frigate, Ollama,
mosquitto, …) are not built or signed by our CI and are out of scope for
this policy; they are version- or digest-pinned in
`docker/docker-compose.yml` and never flow through the OTA pull path.

## Key handling

The manifest-signing private key exists only in GitHub Actions secrets,
minted by a human key ceremony (`scripts/README.md`, "OTA release signing
— key ceremony"). Keyless image signing has no long-lived private key at
all — that is the point: certificates are minted per run against the
workflow's OIDC identity and expire in minutes; the Rekor log makes every
signing event publicly auditable.
