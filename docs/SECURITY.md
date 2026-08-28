# Security gates and how to work with them

This repo ships an appliance whose pitch is "your data stays on the box."
Two layers defend that promise in CI:

1. Long-standing invariant gates: `security-tests.yml`
   (`scripts/test-security.sh` — compose/secret hygiene, CORS, mem-limits,
   OTA trust anchor) and `ci.yml`'s `fips` leg (`scripts/test-fips.sh` —
   banned crypto algorithms, exceptions in
   `docs/security/fips-exceptions.md`; moved out of `test-fips.yml` by
   WARP-2481 so that it actually blocks a merge).
2. The WARP-243 scanner lane (this document) plus the WARP-269 egress gate
   (see the Egress section).

Supply-chain integrity — how every released image is signed, verified at
pull time, and shipped with a bill of materials (WARP-244 / WARP-245) — is
documented in [Supply-chain security](#supply-chain) at the end of this
file.

## Scanner inventory

| Workflow | Tool (pinned) | Blocks PRs? | Scope | Baseline / escape hatch |
|---|---|---|---|---|
| `gitleaks.yml` | gitleaks 8.30.1 | yes | working tree + PR commit range | `.gitleaks.toml` (test fixtures only) |
| `ci.yml` job `semgrep` | semgrep 1.136.0, `p/owasp-top-ten` + `.semgrep/droplet.yaml` | yes (new findings only) — blocks via the required `ci-summary` fan-in since WARP-2481; before that it was red-but-advisory | code, excl. tests (`.semgrepignore`) | diff-aware `--baseline-commit`; `// nosemgrep: <rule-id>` with reviewer sign-off |
| `hadolint.yml` | hadolint 2.14.0 | yes | all tracked Dockerfiles | `.hadolint.yaml` ignored rules (DL3008/DL3059/DL4006, reasons inline) |
| `docker-build.yml` (Trivy step) | trivy-action 0.36.0, **DB pinned by digest** | yes (fixable HIGH/CRITICAL not in baseline) | every image the PR rebuilds | `.trivyignore` baseline + `.github/trivy-db-version` (see [Trivy determinism](#trivy-determinism)) |
| `codeql.yml` | CodeQL (JS/TS + Python + Actions) | no — advisory signal only (not a required check; no `code_scanning` ruleset rule exists — see [CodeQL ownership](#codeql)) | code paths + `.github/workflows/**` | GitHub per-PR alert diffing |
| `osv-nightly.yml` | osv-scanner 2.3.8 action | no (nightly signal) | lockfiles + requirements | `osv-scanner.toml` |
| `egress-gate.yml` | `scripts/check-egress-allowlist.py` | yes | outbound destinations | `docs/security/allowed-egress.yaml` (security review required) |
| Dependabot | `.github/dependabot.yml` | n/a (opens fix PRs) | npm ×2, pip ×13, actions | grouped weekly, limits per ecosystem |

### CodeQL ownership: this repo runs advanced setup only (WARP-2167) {#codeql}

GitHub allows exactly **one** owner of code scanning per repo. This repo uses
the **advanced** workflow (`.github/workflows/codeql.yml`), and GitHub’s CodeQL
**default setup** must stay off. Verify with:

    gh api repos/DropletByWarpLab/droplet-onboard-services/code-scanning/default-setup
    # -> {"state":"not-configured", ...}

If default setup is ever re-enabled, every upload from `codeql.yml` is rejected
— *"CodeQL analyses from advanced configurations cannot be processed when
the default setup is enabled"* — and the lane goes permanently red while its
results are silently discarded. That happened on 2026-08-24 and is what
WARP-2167 fixed.

**The trap.** This repo is attached to the org-level *"GitHub recommended"* code
security configuration, which sets `code_scanning_default_setup=enabled`.
Applying or re-applying that configuration here turns default setup back on and
re-breaks the lane. Its `enforcement` is `unenforced`, so the repo-level
override wins until someone re-applies it. Re-disable with:

    gh api -X PATCH repos/DropletByWarpLab/droplet-onboard-services/code-scanning/default-setup -f state=not-configured

That call touches code scanning only — secret scanning, push protection,
Dependabot alerts, dependency graph, and private vulnerability reporting all
stay enabled (verified after the 2026-08-24 flip).

**Why advanced and not default setup.** Every PR here targets `stage`; `main`
moves only via a promotion PR. Default setup runs on the default branch, PRs
targeting it, and a weekly cron — it never scans a `stage` PR, so handing it
ownership would mean no code scanning at review time. Advanced setup also
carries `.github/codeql/codeql-config.yml`, whose `paths-ignore` keeps test
fixtures, mocks and docs out of the results.

**Languages.** `javascript-typescript`, `python`, and `actions`. The `actions`
job exists because default setup was covering it; dropping default setup
without it would have silently ended GitHub Actions scanning.

**Not merge-blocking.** These checks are advisory. They are not in the
`required_status_checks` of either ruleset ("Main Protection" 14884851 /
"Stage Protection" 20877684), and neither ruleset carries a `code_scanning`
rule. An earlier version of this document claimed CodeQL blocked merges "via
ruleset code-scanning rule"; that rule was never wired. Findings land in the
Security tab and on the PR. Turning on real enforcement is a separate decision
— deliberately not part of WARP-2167.

Decision D1 (GHAS per-committer billing gating uploads on a *private* repo) no
longer applies: this repo is public, so code scanning is free. The preflight
probe that implemented D1 has been removed — it was what silently armed the
failing jobs the moment default setup flipped code scanning on.

## When a gate fails your PR

- **gitleaks**: if it is a REAL secret — rotate it immediately (the value is
  in the PR's git history even if you force-push), then recommit clean. If
  it is a test fixture, put it under a test path (`*.test.ts`, `tests/`,
  `__fixtures__/`) and name it `TEST-ONLY-*`; never widen `.gitleaks.toml`
  for shipped code.
- **semgrep**: fix the finding. For a true false positive add
  `// nosemgrep: <rule-id>` (or `# nosemgrep: <rule-id>`) on the line — a
  reviewer must explicitly ack it. Banned-crypto rules additionally require
  a registered FIPS exception (`docs/security/fips-exceptions.md`).
- **hadolint**: fix the Dockerfile. Rule-level ignores live only in
  `.hadolint.yaml` with a written reason.
- **Trivy**: upgrade the dependency (Dependabot usually already has the
  PR). `.trivyignore` additions need a comment naming package, image, and
  burn-down ticket — reviewer-enforced. See "Trivy determinism" below for
  why a plain `.trivyignore` alone is not enough.
- **CodeQL**: fix, or dismiss the alert in the Security tab with a reason
  (dismissals are audited).
- **egress gate**: see the Egress section below.

## Trivy determinism — why the DB is pinned {#trivy-determinism}

A Trivy image gate that blocks on "any fixable HIGH/CRITICAL" against
Trivy's **rolling** vulnerability DB is non-deterministic over time: the
same image built from the same code goes red the day the DB publishes a new
CVE for an already-installed package — Debian point-release lag
(`libcap2`, `libgnutls30`, `libssl3`), fresh npm/pip/Go advisories for
pinned deps, or a new CVE in a bundled release binary (e.g. `cosign`). None
of that is a code change, so blocking on it violates the "never flake-block
on pre-existing findings" contract. Two mechanisms keep the gate
reproducible while still failing a genuinely NEW fixable vuln:

1. **Pinned DB.** `.github/trivy-db-version` holds the Trivy vuln-DB **OCI
   digest**; `docker-build.yml` exports it as `TRIVY_DB_REPOSITORY`. A given
   commit always scans the same snapshot — a green run stays green until the
   pin is deliberately bumped.
2. **Complete baseline.** `.trivyignore` lists **every** fixable
   HIGH/CRITICAL present at that snapshot (generated by building each image
   and scanning against the pinned DB — see the file header). The
   trivy-action's `trivyignores` then fails the build **only** on a fixable
   finding *not* in the baseline, i.e. one a PR introduces or a DB-pin bump
   newly surfaces. `ignore-unfixed` drops un-patchable base CVEs on top.

**Bumping the pin is a reviewable event, not a silent one.** Update the
digest in `.github/trivy-db-version`, re-run the scan locally, and reconcile
any newly-surfaced fixable IDs into `.trivyignore` (patch via the dep bump,
or baseline with a burn-down note) in the *same* PR. Editing `.trivyignore`
or the DB pin rebuilds+rescans all images (both are `global` detect-filter
paths). Proof the gate still catches new vulns:
`tests/probe/trivy-newcve.md`.

## Dependabot state

Version updates are configured in `.github/dependabot.yml`. Alerts and
security updates are repo settings, enabled one-time by an admin:

    gh api -X PUT repos/DropletByWarpLab/droplet-onboard-services/vulnerability-alerts
    gh api -X PUT repos/DropletByWarpLab/droplet-onboard-services/automated-security-fixes

## osv nightly

Red-on-findings by design and NOT PR-blocking. The initial baseline
(2026-07-04) is ~85 vulnerable entries — burning down via Dependabot
upgrades; watch the trend, not the binary status, until it is green, then
treat any new red as a same-day fix.

## Known baseline debt (tracked, not blocking)

- 25 pre-existing Semgrep prod findings on main — notably
  `gcm-no-tag-length` in `apps/orchestrator/src/services/encryption.service.ts:76`
  (verify tag-length handling), `direct-response-write` in
  `routes/cameras.ts`/`routes/files.ts`, `python-logger-credential-disclosure`
  in ai-gateway/routing/switch loggers.
- 15 images run as root (`missing-user`) — container-hardening follow-up.
- 67 unpinned `uses:` action tags across workflows — pin-by-SHA follow-up.
- `.trivyignore` CVE baseline — burn down via Dependabot upgrades
  (litellm 1.30.0 and pillow 10.0 first; both have CRITICALs).

## Reporting a vulnerability

Email romain.jouffret31@gmail.com (repo owner). Do not open public issues
for exploitable findings.

## Egress — the telemetry-free contract (WARP-269) {#egress}

The appliance's promise: **customer data never leaves the device** except
through channels the customer initiated or an admin explicitly configured,
each registered and reviewed. `docs/security/allowed-egress.yaml` is the
single registry of every outbound destination — consumed by the
`egress-gate.yml` CI lane (static scan of URL/host literals, PR-blocking)
and by the WARP-268 runtime egress audit (on-device enforcement).

Adding a destination = add a registry entry (schema in the file header:
kind, hosts, ports, protocol, phase, `data_class`, purpose, ticket) +
security review on the PR. `data_class` is the contract field: nothing may
ever be `data_class: ambient-customer-content` — such a request is rejected
in review, no exceptions. Hostnames that are not egress (XML namespaces,
doc links) register as `kind: reference`; runtime-configured destinations
(user mail servers, fleet HQ URL) as `kind: dynamic` with their config key.

Limits: the static scan cannot see hostnames assembled at runtime — that is
what WARP-268's runtime audit is for; reviewers should treat dynamic URL
construction toward the network as a smell requiring a `dynamic` entry.

# Supply-chain security — signing & verification {#supply-chain}

How every released Droplet container image is signed, how the appliance
verifies before pulling, and how anyone can verify independently.

> Repo history note: this repository was renamed from
> `droplet-pi-platform` to `droplet-onboard-services`. All signing
> identities use the current name. Ticket texts referencing the old name
> refer to this repository.

## Two trust layers

| Layer | What it authenticates | Key/identity | Where verified |
|---|---|---|---|
| **Keyless image signatures** (WARP-244) | "this individual image was built by our release CI" | GitHub Actions OIDC identity of `.github/workflows/publish-release.yml@refs/heads/main` (stable) or `@refs/heads/stage` (stage channel, WARP-1670), certificate from Fulcio, entry in the public Rekor transparency log | on-device before every `docker pull` (`scripts/lib/apply-update.sh`), in CI post-sign self-check, and by anyone (below) |
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

For an image from a **stage** release (`ota-stage-*`), swap the identity's
`@refs/heads/main` for `@refs/heads/stage` — a stage build is signed by the
same workflow running on the stage branch, so the identity differs by ref.

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
  --certificate-identity-regexp '^https://github\.com/DropletByWarpLab/droplet-onboard-services/\.github/workflows/publish-release\.yml@refs/heads/(main|stage)$' \
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

## Software bill of materials (SBOM)

Every OTA release attaches, as GitHub Release assets:

- `droplet-<service>.cdx.json` — one CycloneDX **1.5** JSON SBOM per
  released image, generated by syft against the exact pushed digest;
- `droplet-device.cdx.json` — the aggregated appliance SBOM
  (`scripts/release/aggregate-sboms.py`): `metadata.component` is the
  device (version = the release commit), each image is a nested
  `container` component, and every `bom-ref` is namespaced
  `droplet-<service>:…` so identical libraries in different images never
  collide.

All SBOM assets are schema-validated in CI before the release is created:

```bash
cyclonedx validate --input-file droplet-device.cdx.json \
  --input-format json --input-version v1_5 --fail-on-errors
```

Validate locally the same way (`brew install syft` and
`brew install cyclonedx/cyclonedx/cyclonedx-cli` on macOS). The Trust
Center page on the appliance links the releases page where the assets
live.
