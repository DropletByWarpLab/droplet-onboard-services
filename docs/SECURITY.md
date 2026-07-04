# Security gates and how to work with them

This repo ships an appliance whose pitch is "your data stays on the box."
Two layers defend that promise in CI:

1. Long-standing invariant gates: `security-tests.yml`
   (`scripts/test-security.sh` — compose/secret hygiene, CORS, mem-limits,
   OTA trust anchor) and `test-fips.yml` (`scripts/test-fips.sh` — banned
   crypto algorithms, exceptions in `docs/security/fips-exceptions.md`).
2. The WARP-243 scanner lane (this document) plus the WARP-269 egress gate
   (see the Egress section).

## Scanner inventory

| Workflow | Tool (pinned) | Blocks PRs? | Scope | Baseline / escape hatch |
|---|---|---|---|---|
| `gitleaks.yml` | gitleaks 8.30.1 | yes | working tree + PR commit range | `.gitleaks.toml` (test fixtures only) |
| `semgrep.yml` | semgrep 1.136.0, `p/owasp-top-ten` + `.semgrep/droplet.yaml` | yes (new findings only) | code, excl. tests (`.semgrepignore`) | diff-aware `--baseline-commit`; `// nosemgrep: <rule-id>` with reviewer sign-off |
| `hadolint.yml` | hadolint 2.14.0 | yes | all tracked Dockerfiles | `.hadolint.yaml` ignored rules (DL3008/DL3059/DL4006, reasons inline) |
| `docker-build.yml` (Trivy step) | trivy-action 0.36.0 | yes (HIGH/CRITICAL, fixable) | every image the PR rebuilds | `.trivyignore` (comment + burn-down required per entry) |
| `codeql.yml` | CodeQL (JS/TS + Python) | yes (new alerts, via ruleset code-scanning rule) | code paths | GitHub per-PR alert diffing |
| `osv-nightly.yml` | osv-scanner 2.3.8 action | no (nightly signal) | lockfiles + requirements | `osv-scanner.toml` |
| `egress-gate.yml` | `scripts/check-egress-allowlist.py` | yes | outbound destinations | `docs/security/allowed-egress.yaml` (security review required) |
| Dependabot | `.github/dependabot.yml` | n/a (opens fix PRs) | npm ×2, pip ×13, actions | grouped weekly, limits per ecosystem |

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
  burn-down ticket — reviewer-enforced.
- **CodeQL**: fix, or dismiss the alert in the Security tab with a reason
  (dismissals are audited).
- **egress gate**: see the Egress section below.

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
