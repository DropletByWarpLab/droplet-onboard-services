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

> **What "blocks PRs" means here — the one-line rule.** A check blocks a merge
> **only** if it is a leg of `ci.yml` aggregated by `ci-summary`, **or** it is
> itself a required context in a ruleset (`ci-summary`, `egress-gate`,
> `title carries a WARP key`). Nothing else blocks, however red it goes. The
> "Blocks PRs?" column below names the mechanism for every `yes`; if a row
> cannot name one, the answer is no.
>
> This table claimed `gitleaks`, `hadolint` and Trivy blocked PRs when none of
> them did (WARP-2493, corrected 2026-08-28) — the same defect WARP-2481 fixed
> for `fips-lint` and `semgrep`. Verify with
> `docs/ci-required-checks.md#verifying`, never from this prose.

| Workflow | Tool (pinned) | Blocks PRs? | Scope | Baseline / escape hatch |
|---|---|---|---|---|
| `ci.yml` job `gitleaks` | gitleaks 8.30.1 | yes — via the required `ci-summary` fan-in (WARP-2493); previously `gitleaks.yml`, red-but-advisory | working tree + PR commit range | `.gitleaks.toml` (test fixtures only) |
| `ci.yml` job `semgrep` | semgrep 1.136.0, `p/owasp-top-ten` + `.semgrep/droplet.yaml` | yes (new findings only) — blocks via the required `ci-summary` fan-in since WARP-2481; before that it was red-but-advisory | code, excl. tests (`.semgrepignore`) | diff-aware `--baseline-commit`; `// nosemgrep: <rule-id>` with reviewer sign-off |
| `ci.yml` job `hadolint` | hadolint 2.14.0 | yes — via the required `ci-summary` fan-in (WARP-2493); previously `hadolint.yml`, red-but-advisory | all tracked Dockerfiles | `.hadolint.yaml` ignored rules (DL3008/DL3059/DL4006, reasons inline) |
| `docker-build.yml` (Trivy step) | trivy-action 0.36.0, **DB pinned by digest** | **no** — advisory today. Its verdict IS a job exit status (`exit-code: "1"`, no SARIF upload) and it already fans into `docker-build ok`, but that context is **not required** and cannot be as written: `docker-build.yml` is path-filtered, so on an out-of-scope PR it never reports (WARP-2172). See [Trivy is a job status, and still does not block](#trivy-blocking) | every image the PR rebuilds | `.trivyignore` baseline + `.github/trivy-db-version` (see [Trivy determinism](#trivy-determinism)) |
| `ci.yml` job `gitleaks`, step "Trivy dependency scan" (WARP-3665) | trivy-action 0.36.0 `scan-type: fs`, **same DB pin** | yes (new findings only) — blocks via the required `ci-summary` fan-in; runs on a PR only when a lockfile, requirements file, `.trivyignore`, the DB pin or `ci.yml` changed, and on every main push | lockfiles + requirements files (fixable HIGH/CRITICAL, dev dependencies excluded) | the same `.trivyignore` baseline, each entry with an `exp:` expiry. The same scan is a step of `publish-release.yml`'s `gate-node` job, so a release dispatch fails before anything is built, pushed or signed |
| `codeql.yml` | CodeQL (JS/TS + Python + Actions) | no — advisory signal only (not a required check; no `code_scanning` ruleset rule exists — see [CodeQL ownership](#codeql)) | code paths + `.github/workflows/**` | GitHub per-PR alert diffing |
| `osv-nightly.yml` | osv-scanner 2.3.8 action | no (nightly signal) | lockfiles + requirements | `osv-scanner.toml` (every ignore has `ignoreUntil`, WARP-3667) |
| `egress-gate.yml` | `scripts/check-egress-allowlist.py` | yes | outbound destinations | `docs/security/allowed-egress.yaml` (security review required) |
| Dependabot | `.github/dependabot.yml` | n/a (opens fix PRs) | npm ×2, pip ×13, actions | grouped weekly, limits per ecosystem |

### Trivy is a job status, and still does not block {#trivy-blocking}

Unlike CodeQL, Trivy's verdict is an **ordinary job exit status**, not a
code-scanning alert. Evidence in `docker-build.yml`'s scan step:

- `exit-code: "1"` — the action fails the step on a qualifying finding.
- No `format: sarif`, no `github/codeql-action/upload-sarif`, and no
  `security-events: write` permission anywhere in the workflow, so nothing is
  ever uploaded to the Security tab.

So it *could* be folded into `ci-summary` — but only by relocating the whole
13-image build matrix (GHCR layer cache, per-image `detect` filters, 20–60 min
runtime) into `ci.yml`. That is a large, expensive change and a deliberate
decision in its own right, not a side effect of a docs correction. It was
**not** done under WARP-2493.

The cheaper correct shape is the one `docs/ci-required-checks.md` calls option
2: leave the builds where they are and give `docker-build.yml` an unfiltered
job that reports green when no image is in scope, making `docker-build ok`
requireable. That is WARP-2172's territory.
[`docs/security/fips-ci-gate-required.md`](security/fips-ci-gate-required.md)
covers the same ground for the FIPS build-time gate; it previously instructed
adding `docker-build ok` as a required context, which would have hung every
out-of-scope PR on "Expected". That instruction and its ruleset JSON were
removed under WARP-2493.

Until one of those lands: **a fixable HIGH/CRITICAL in a rebuilt image turns
`docker-build ok` red and does not stop the merge.** Treat it as review-blocking
by convention, not by machine.

**What does block today (WARP-3665).** The image scan above is unchanged. What
reaches `ci-summary` is a second Trivy pass over the dependency inputs
(lockfiles and requirements files) with the same pinned DB and the same
`.trivyignore` baseline, a step of the `gitleaks` job in `ci.yml`, plus the
same step in `publish-release.yml`'s `gate-node` job. It blocks a new fixable
HIGH/CRITICAL in a dependency a PR adds or bumps, and a release dispatch on a
tree carrying one. It does not see OS packages or bundled Go binaries; those
remain covered only by the image scan, so making `docker-build ok` a required
context (WARP-2172) is still the open item for them.

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

**Everything frozen has an expiry (WARP-3667).** Each `.trivyignore` entry
carries `exp:YYYY-MM-DD` (Trivy stops ignoring it that day, so the finding
fails the build again), each `osv-scanner.toml` ignore carries `ignoreUntil`,
and `scripts/check-vuln-exceptions.sh` (a `ci.yml` `detect` step) fails a PR
when an entry has no expiry, is past due, or the pinned DB snapshot is more
than 35 days old. Extend an exception by editing its date in a reviewed PR;
never delete one to make a scan pass. The initial dates are 2027-01-02 (90 days
from 2026-10-04) for every entry, the conservative choice; owners shorten or
extend per finding. The monthly refresh is a manual PR today; a scheduled job
that opens it is a CI-spend decision (see the WARP-3667 proposal in the PR).

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

Every ignore in `osv-scanner.toml` has an `ignoreUntil` date (WARP-3667), so an
accepted advisory reappears on its expiry day instead of staying hidden. The
nightly stays advisory because its absolute result is not green today (it
reports advisories that are in no baseline); dependency findings that block a
merge or a release come from the Trivy dependency scan above, which has a
reviewed baseline.

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

The registry must also stay honest in the other direction. A `kind: egress`
entry's `code_refs` are load-bearing: one of its hosts has to appear there as
a non-comment literal, or the entry carries a `no_code_literal:` reason naming
who owns the destination instead (WARP-2452). That reason is checked **per
host** since WARP-2487, and may be written either as one string covering every
host of the entry or as a `{host: reason}` mapping — an entry with one
SDK-owned host and one the code really dials was previously impossible to
describe truthfully. Those paths must themselves be inside the scan's own
scope — a `docs/` path cannot be evidence that a host is dialled, because the
scan never reads it (WARP-2468). Entry ids must be unique; YAML does not
object to two blocks sharing one, so the gate does (WARP-2487).

**What counts as a hostname** is the Public Suffix List, vendored at
`scripts/data/public_suffix_list.dat` and refreshed by
`scripts/fetch-public-suffix-list.sh` (WARP-2487). It replaces a fifteen-entry
TLD tuple that was, since WARP-2467, the gate for code as well as config — so
a destination on `.sh`, `.app` or `.xyz` was invisible until somebody
remembered to widen the tuple. The scanner never fetches the list: it runs
offline in CI and on the box, reads the committed snapshot, and
`--check-psl-freshness` fails once that snapshot's own `VERSION` line is more
than 180 days old.

Limits: the static scan cannot see a hostname whose every part is assembled at
runtime — that is what WARP-268's runtime audit is for; reviewers should treat
dynamic URL construction toward the network as a smell requiring a `dynamic`
entry. It CAN now see the common half of that pattern: since WARP-2467 a bare
hostname in a code string literal is extracted just like a full URL, so
`const H = "api.vendor.com"` followed by `fetch(\`https://${H}/v1\`)` no longer
passes unregistered. Two bounded blind spots come with the wider suffix list,
both deliberate and both visible in a diff: a destination whose name equals a
tracked file's basename is read as a filename, and a bare host on a
non-legacy TLD is only taken when it is written as a *value* — the whole
string literal or the whole right-hand side of a config setting — rather than
as a word inside running text.

## Per-user WebDAV drive logins (credential surface, WARP-3318)

`POST /api/storage/network-drive/personal` mints a per-user, per-computer,
full-scope Nextcloud app password (stored encrypted as a `DeviceClient`,
revocable from the devices list) so a user can map their drive in Finder or
File Explorer. It is limited to owner/admin/family (never guest) and OFF by
default behind the owner setting `Workspace.personalDriveEnabled` (Settings ->
Personal drives). Access through the drive is NOT recorded as downloads in the
activity log and skips the per-file upload cap; WARP-3318 records that
unaudited-read trade-off and the owner's explicit opt-in to it. Nextcloud's OCS
sharing API (`/nextcloud/ocs/v{1,2}.php/apps/files_sharing`) is refused at the
gateway so no app password can mint shares or public links (WARP-3053), and so
are the other OCS routes that mint a bearer-style URL (audit below).
Details: [`network-drive.md`](network-drive.md#per-user-drive-webdav); gateway
rule: [`THREAT_MODEL.md`](THREAT_MODEL.md) §3a.

Turning the setting off revokes every active personal-drive login: each row
carries the explicit `DeviceClient.kind` (`personal_drive`, set by the POST
above; native-app pairings are `app_pairing`), and
`PUT /api/settings/workspace/personal-drive` with `enabled: false` marks the
active `personal_drive` rows revoked and returns the count as
`revokedDriveLogins`. The flag change is an Activity row written right after
the flag; the revoke outcome is a second row (the count, or "failed after N
revoked" plus the error message if the sweep throws, in which case the request
is a 500 and the flag stays off). Each row's `{ clientId, userId }` is listed
in that row's `refs`. The count is rows **marked revoked**, not app passwords
Nextcloud confirmed deleted: the upstream delete is best-effort, and
`ncDeleteAppPassword` does not check the HTTP status (tracked as WARP-3383).
A mint that passed its flag check just before the switch-off can insert its
row after the sweep has run, so the POST re-reads the flag once the row exists
and, if it is now off, revokes that login and answers 403
`personal_drive_disabled` without returning the password. **Logins minted before the `kind` column
existed** (migration `20260930100000_device_client_kind`) default to
`app_pairing`: nothing explicit tells them apart from pairings (the name is
free text, and the pairing-code link is purged daily), so they are NOT
bulk-revoked. They show in each person's devices list (Paired devices) as
"Finder on …" / "File Explorer on …", where each person can remove theirs
(`DELETE /api/devices/clients/:id`).

### Nextcloud OCS audit: routes that mint a bearer-style URL (WARP-3053, WARP-3318)

Rule: through `/nextcloud/` an app password (paired devices, personal drive) is
full-scope, so any OCS route that returns a URL or token usable **without the
caller's credentials** lets it skip the orchestrator's policy (download audit,
owner/admin-only publish). Such a route is denied at the gateway only if
nothing legitimate calls it through the gateway. Evidence for "nothing does":
the dashboard requests no OCS path; the orchestrator builds every OCS URL from
`NEXTCLOUD_URL` (compose network), including the editor's direct-editing mint
(`ncCreateRichdocumentsDirectUrl`); root `/ocs/` is not routed to Nextcloud at
all (it falls to the dashboard), so a page served by Nextcloud cannot reach
OCS through the gateway either. Pinned by Phase 7 of
`tests/nginx-nextcloud-assets.test.sh`.

Apps enabled on the box: the digest-pinned `nextcloud:29-apache` bundle,
plus `groupfolders` and `files_external` (`docker/nextcloud-init.sh`),
plus `richdocuments` (default engine; installed from the appstore, unpinned) or
`onlyoffice` (`DOCS_ENGINE=onlyoffice`), minus the Hub apps
`disable_hub_apps` switches off. Route names below are from the Nextcloud 29
app sources, not probed on a live box.

| App | OCS route (under `/nextcloud/ocs/v{1,2}.php/`) | Mints a credential-free URL? | Used via gateway? | Decision |
|---|---|---|---|---|
| files_sharing | `apps/files_sharing/…` (shares, sharees, remote_shares) | Yes: public link, any share | No (web sharing is orchestrator to `NEXTCLOUD_URL`) | **Denied** (WARP-3053) |
| richdocuments | `apps/richdocuments/…` (`api/v1/document` direct-editing link, `api/v1/templates/new`, other editor helpers) | Yes: `…/richdocuments/direct/<token>` renders the editor with no cookie and no `Authorization`, short-lived | No: the orchestrator mints it over `NEXTCLOUD_URL`; the browser only loads the resulting page, a non-OCS route that stays proxied | **Denied**, whole app (unpinned appstore app, no consumer) |
| files (core) | `apps/files/api/v1/directEditing/{open,create}` | Yes: `…/apps/files/directEditing/<token>` for any registered editor (text, richdocuments, onlyoffice) | No | **Denied**, by route |
| dav | `apps/dav/api/v1/direct` (POST) | Yes: `…/remote.php/direct/<token>` downloads one file; the caller picks the lifetime (up to 24 h) | No | **Denied**, by route |
| files (core), other routes | `apps/files/api/v1/{stats,templates,thumbnail,transferownership}` | No: authenticated reads/actions | Nextcloud clients only | Left open |
| dav, other routes | `apps/dav/api/v1/outOfOffice/…` | No | Nextcloud clients only | Left open |
| core | `core/getapppassword`, `core/apppassword` | No link; mints an app **password** (a credential) for a caller that already authenticated. The orchestrator uses it internally for pairing | Nextcloud clients' login | Left open, see residual below |
| provisioning_api | `cloud/users…`, `cloud/groups…` | No; needs Nextcloud admin credentials | No (orchestrator, internal) | Left open |
| groupfolders | `apps/groupfolders/folders…` | No; admin-only management | No | Left open |
| federatedfilesharing, cloud_federation_api, federation | `cloud/shares`, `apps/federatedfilesharing/…` | No outward URL; inbound share offers from a remote server. Outgoing shares are created via files_sharing (denied) | No | Left open: not confirmed whether federation is configured off |
| sharebymail | none of its own (rides the files_sharing routes) | n/a | n/a | Covered by the files_sharing denial |
| circles, notifications, activity, files_reminders, files_downloadlimit, files_external, user_status, dashboard, comments, systemtags, serverinfo, oauth2, app_api | their own `apps/<app>/…` | No | No | Left open |

Left open on purpose, for the reasons in the table. Three things the audit
found that are NOT OCS and are NOT closed here, for a follow-up:

- **Photos public albums** mint a public URL from a DAV request
  (`PROPPATCH`/`POST` under `remote.php/dav/photos/…`), not from OCS. Closed
  (WARP-3606): `nextcloud-init.sh` disables the `photos` app on every start via
  `disable_hub_apps`. CalDAV `publish-calendar` is a separate route in the
  `dav` app and is still open.
- **richdocuments' non-OCS routes still mint WOPI `access_token` URLs**, and
  they are reachable through BOTH spellings: the `/nextcloud/` leg
  (`/nextcloud/index.php/apps/richdocuments/…`) and the root
  `/index.php/apps/richdocuments/` leg. The root leg is a prefix, so it carries
  every richdocuments route (the WOPI file endpoints, which need a WOPI token,
  and token minting for a credentialed caller). The editor needs the root leg,
  so it stays; the `/nextcloud/` spelling has no consumer and is a candidate to
  deny by route once the route names are confirmed on a live box. Not closed
  here; the OCS denials above do not cover it.
- **The owner switch is not a WebDAV gate.** It controls whether the
  orchestrator mints app passwords and, now, revokes the rows it created. A
  user can still authenticate to `/nextcloud/remote.php/dav` with their own
  Nextcloud password (equal to their Droplet password, THREAT_MODEL §3a), or
  mint an app password through `core/getapppassword` or Login Flow v2
  (`/nextcloud/index.php/login/v2`); neither leaves a `DeviceClient` row, so
  "turn off" cannot revoke them.

Cost of the three denials: the Nextcloud mobile apps cannot open a document in
their in-app editor or ask for a direct download link through the gateway.

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
| **Keyless image signatures** (WARP-244) | "this individual image was built by our release CI" | GitHub Actions OIDC identity of `.github/workflows/publish-release.yml@refs/heads/main` (stable) or `@refs/heads/stage` (stage channel, WARP-1670), certificate from Fulcio, entry in the public Rekor transparency log | on-device before every `docker pull` (`docker/ota/apply-update.sh`), in CI post-sign self-check, and by anyone (below) |
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
(`docker/ota/apply-update.sh`, `pull-images`). The helper runs on the host
(WARP-3007), which has no cosign, so it runs the orchestrator image's
vendored, checksum-pinned cosign in a throwaway `docker run --rm` off that
image (pinned by image ID). For each digest-pinned ref it runs, **before**
`docker pull`:

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
- **Credential (WARP-3503, ADR-068).** The images are private. The box pulls
  them from the fleet HQ registry with a short-lived (10 min) HQ device token:
  the orchestrator proves possession of the device key to HQ (nonce challenge,
  signature through device-identity-svc) and gets a `registry:pull` JWT. It
  reaches the helper as an env var for one `pull-images` call, is written as
  `{"auths":{"<hq-host>":{"registrytoken":"<JWT>"}}}` into the helper's
  ephemeral `DOCKER_CONFIG` (0600, removed on exit) that both cosign and
  `docker pull` read, and is never in argv or a log. It is sent only to the
  HQ host. A box HQ will not serve (unreachable, not enrolled, revoked) gets
  no token: the apply logs `update.registry_auth_failed` with the reason,
  keeps its current release and retries next window. A GitHub token for
  `ghcr.io` refs (`DROPLET_OTA_GITHUB_TOKEN`) remains as a lab-only fallback
  and is never provisioned on an appliance (ADR-045).
- **Why fail closed is safe on an offline appliance:** verification runs
  only when pulling, and pulling already requires the HQ registry to be reachable. An
  offline box never reaches the verifier — it simply has no update to
  apply. Rollback recreates from images already on the box (`--pull
  never`) and never re-pulls, so a refusal can block an update but never
  the running stack.
- **No new egress:** `--offline=true` verifies the signature bundle
  (stored in the registry alongside the image) against the trust root embedded in
  the checksum-pinned cosign binary vendored in the orchestrator image.
  No Rekor or TUF endpoints are contacted from the appliance.
- **Break-glass:** a human with host shell access can `docker pull` and
  recreate manually. That action is outside the orchestrator's OTA
  surface on purpose — it requires the same physical/SSH trust as any
  other host-level intervention.

## Image packages: pre-push secret scan {#public-packages}

The first-party packages `ghcr.io/dropletbywarplab/droplet-*` stay **private**
(Romain, 2026-10-03). A box carries no GitHub token (ADR-045), so box pulls are
to become device-authenticated instead (WARP-3423; ADR-066's anonymous-delivery
decision is to be superseded). Whatever the transport, an image must never
carry a secret, so `publish-release.yml` scans it before it is pushed
(WARP-3429):

- **Secret scan before the push.** Each image is built, exported with
  `docker save`, and scanned with the pinned gitleaks (v8.30.1, same as
  `ci.yml`) before `docker push`: the image config (Env, history — where
  build args land) and every layer on its own, so a secret deleted by a later
  layer is still found (`scripts/release/scan-ghcr-secrets.py --docker-save`).
  Findings under vendor paths (`node_modules`, `site-packages`, `/usr/lib`, …)
  are reported but do not block; any other finding that is not in the reviewed
  baseline `scripts/release/image-secret-baseline.txt` fails the publish
  before the image reaches the registry. The baseline is `<rule> <path>` per
  line (no line number, no digest, so it survives a rebuild) and starts empty:
  a real secret is never baselined — rotate it and fix the image; only a
  reviewed false positive is. The failing step prints the exact lines to add.
  The image config is split into one pseudo-file per key before scanning, so
  its fingerprints name the key (`config.json#Env.<NAME>`,
  `config.json#Labels.<label>`, `config.json#history.<hash>`): a baseline line
  can never excuse a rule across a whole config.
  gitleaks runs with `scripts/release/gitleaks-images.toml`: the default rules
  plus one allowlist entry, the python base images' public `GPG_KEY`
  fingerprint (exactly `GPG_KEY=` and 40 uppercase hex characters, matched on
  the finding's match text, not the whole line). That is the only built-in
  exception; do not baseline it.
  `ghcr-secret-scan.yml` (WARP-3423) runs the same scanner and config over
  every version already in the registry, on demand (dispatch only). Its inputs
  `package`, `shards` and `digests` scan a single package, split it over N jobs
  (`--shard K/N` scans `versions[K::N]`), or rescan only the versions whose
  digest starts with the given prefixes.

## R2 registry mirror (private images, WARP-3502) {#r2-registry-mirror}

Because the packages stay private, a box pulls from the fleet HQ read-only
registry (a Cloudflare Worker in front of an R2 bucket, device-authenticated;
fleet contract v1 section 3), not from GHCR. CI is the only writer of that
bucket. After the images are pushed, keyless-signed and self-verified, and
before the GitHub Release exists, `publish-release.yml` runs
`scripts/release/mirror-to-r2.py copy`, which for every image in the release:

- reads the image by digest from GHCR with the pinned `crane`: the manifest (or
  the index and each child manifest), the config blob and every layer blob;
- reads the cosign signature artifact at tag `sha256-<hex>.sig` the same way
  (the publish fails if an image has none, since a box could never verify it);
- writes them with the pinned `aws` CLI to R2's S3 endpoint in the layout the
  Worker serves: `oci/blobs/sha256/<hex>`, `oci/manifests/sha256/<hex>` with
  `Content-Type` = the manifest media type, and
  `oci/tags/droplet-<name>/sha256-<hex>.sig` = text `sha256:<manifest hex>`.

Properties that matter for the trust model: the copy is by digest and every
blob and manifest is re-hashed before it is stored, so R2 cannot hold bytes
that do not match their name; blobs are written first, then manifests, then
tags, so nothing in the bucket points at missing content; a copy failure fails
the job before the Release exists, so no signed `release.json` can name a
digest the registry cannot serve; and an object already present with the right
size is skipped. Multipart uploads use one explicit 64MB part size because R2
requires equal-sized parts.

`release.json` names the HQ host (`<host>/droplet-<name>@sha256:…`, same
digests) only when the `OTA_REGISTRY_HOST` repo variable is set; empty keeps
`ghcr.io`. With no R2 secrets and no variable the mirror is skipped with a
warning, with the variable set missing secrets fail the publish before the
build. The secrets, the variable and the one-time setup are in
`scripts/README.md` ("R2 registry mirror: one-time setup").

## Signed channel index (`ota-index`) {#channel-index}

After the Release exists, the workflow's `index` job publishes a **signed
pointer** to the newest release of the channel, so a box can find it with one
anonymous download instead of listing releases through the GitHub API. The
pointers live on one rolling release, `ota-index`, at stable URLs:

```
https://github.com/DropletByWarpLab/droplet-onboard-services/releases/download/ota-index/channel-<stage|stable>.json
https://github.com/DropletByWarpLab/droplet-onboard-services/releases/download/ota-index/channel-<stage|stable>.json.sig
```

`channel-<channel>.json` (`scripts/release/gen-channel-pointer.py`; compact
JSON, fixed key order, UTF-8, trailing newline):

```json
{"schemaVersion":1,"kind":"droplet-ota-channel-pointer","channel":"stage","tag":"ota-stage-<run>-g<sha7>","gitSha":"<40 hex>","builtAt":"<release.builtAt, verbatim>","manifestSha256":"<sha256 of the uploaded release.json>","publishedAt":"<UTC ISO-8601>"}
```

- It is signed exactly like `release.json`: the same org cosign key,
  `--tlog-upload=false`, `.sig` beside it; verify the same way
  (`cosign verify-blob --key cosign.pub --signature channel-stage.json.sig
  --insecure-ignore-tlog=true channel-stage.json`). `manifestSha256` is
  computed over the `release.json` bytes GitHub serves for the release, so it
  pins exactly the manifest a box will download.
- **It is a hint and an integrity pin, never the trust decision.** The box
  still verifies `release.json.sig` and re-checks the channel inside the
  signed manifest before accepting anything (same rule as the release tag).
- `ota-index` is a **prerelease, never `latest`**, and its tag does not start
  with `ota-stage-` / `ota-stable-`, so neither `/releases/latest` (stable
  boxes) nor the `ota-<channel>-` prefix match (older boxes) can ever select
  it as a release. Do not delete it: it is created once and rewritten in
  place (`--clobber`) on every publish.
- A box that fetches between the `.json` and `.sig` uploads sees a pair that
  fails verification and retries on its next poll. If the `index` job alone
  fails, use **Re-run failed jobs**: it re-runs only that job, not the
  two-hour build.

## Third-party images

Upstream images in the compose file (Postgres, Redis, mosquitto, Nextcloud,
the document server, Frigate, Ollama, the voice and model-runner images, …)
are not built or signed by our CI and are out of scope for this policy. Each
is pinned as `name:tag@sha256:<digest>` in `docker/docker-compose.yml` (and
`docker/docker-compose.dev.yml`), keeping the tag for readability; the digest
is the multi-architecture index digest, so amd64 and arm64 hosts both resolve.
They never flow through the OTA pull path: the updater pulls and verifies only
the first-party images named in the signed release manifest, by digest.

`scripts/check-pinned-images.sh` (a `ci.yml` `detect` step, so it reports under
the required `ci-summary`) fails any `image:` that is not digest-pinned.
Services with a `build:` key are exempt. A variable default is checked at its
default, so the digest lives inside it (`${FRIGATE_IMAGE:-repo:tag@sha256:…}`);
an operator who overrides the variable in `.env` opts out of the pin on
purpose. To bump an image, change tag and digest together in one PR.

Not yet done (WARP-3601): recording these digests in the signed release
manifest, and verifying upstream signatures where a publisher provides them.

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
