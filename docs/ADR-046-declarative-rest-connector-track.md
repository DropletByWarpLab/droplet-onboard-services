# ADR-046 — The declarative REST connector track

**Status:** Accepted — the track landed on WARP-2707, 2026-09-07. See *Implementation record* below.
**Date:** 2026-09-03
**Ticket:** WARP-2707
**Supersedes nothing. Extends:** [ADR-041](ADR-041-cloud-connector-class.md) (cloud connector class), [ADR-042](ADR-042-customer-supplied-credentials.md) (customer-supplied credentials), WARP-2217 (provider descriptors)

---

## Context

### The measurement that prompted this

A survey of 341 business-tool APIs (2026-09-02) found **130 vendors** whose account owner can mint a credential in their own console and paste it into the box — the ADR-042 model-3 shape, with no Warp Lab app registration, no vendor review, and nothing of ours in the trust path. A follow-up pass (2026-09-03) took 34 of those and produced a **buildable** spec for each: exact endpoint paths, the literal watermark parameter, pagination shape, rate ceiling, SDK licence. Every spec was then handed to a second agent whose only instruction was to refute it against the vendor's own documentation. Across the 34 refutations: **179 claims refuted, 677 confirmed, 288 must-fix items**, and two verdicts overturned (Notion → NOT_FREE, Typeform → FREE_WITH_GATES). *(An earlier commit message on this branch cited 147 refuted claims; that figure was computed before the last eight refutations landed. 179 is the count over the complete set.)*

The shapes that came back are the reason for this ADR:

| Change-detection mechanism | Vendors |
|---|---|
| `modified-since` (a timestamp parameter) | 23 |
| `cursor` (opaque forward-only token) | 5 |
| `delta-token` (vendor-issued replay URL) | 3 |
| full-scan only (no watermark exists) | 3 |

| Destination | Vendors |
|---|---|
| One static host | 24 |
| Host assembled per account (region, subdomain, self-hosted) | 10 |

**Twenty-eight of thirty-four are the same program:** issue an authenticated HTTPS GET, pass a watermark, walk pages, project rows onto canonical columns. The differences between them are *values*, not *control flow*.

### Why the current shape cannot absorb them

Adding a provider today means writing a `Connector`. The shipped cloud connectors are 1,100–1,800 lines each (`mailchimp/connector.ts` is 1,816). Very little of that is vendor-specific logic — most is the same paging loop, the same host guard, the same budget accounting, the same canonical projection, re-expressed. At that cost, 28 vendors is a multi-quarter programme, and the marginal vendor never gets cheaper.

WARP-2217 already diagnosed this one level up. Its module comment says adding a provider used to mean hand-editing four sites, and that *"five vendors times four sites is a serialised merge queue on three regions of one file, which is the throttle on the integrations programme that adding engineers cannot fix."* The descriptor made provider *metadata* data. It did not make provider *behaviour* data, so the throttle moved rather than lifted.

### The precedent is already in the tree

This is not a new class of idea for this repo. The **export-drop track** is exactly it: one `exportDropFactory`, selected by `vendorFromExportProvider(provider)`, driven by declarative profiles — a header signature plus a column map — so a new vendor is a profile, not a connector. [`ADD-A-PROVIDER.md`](integrations/ADD-A-PROVIDER.md) §0 states the rule this ADR follows:

> **Before writing a connector at all — can the export-drop track cover it?** If the product can export its reports to a file, adding it is a **declarative profile**, not a provider… No connector, no driver, no vendor enrolment.

Export-drop answers that for products that write files to a folder. Nothing answers it for products that expose a REST API, which is the other 28.

---

## Decision

### 1. A third track: `rest`, alongside `lan` and `cloud`

One `Connector` implementation — `RestProfileConnector` — serving N vendors, each described by a `RestVendorProfile`. Provider dispatch mirrors export-drop exactly: `restProfileFor(provider)` returns a profile or `null`, and `connectorFactoryFor` consults it before the static factory map.

The profile is **pure data**, in the same sense `ProviderDescriptor` is: no I/O, no vendor-specific code path, no `if (provider === …)` anywhere in the connector.

### 2. What a profile must express — derived from the 34, not invented

The refutation pass is what fixes this list. Each item below exists because at least one verified vendor would be **silently wrong** without it. That is the admission criterion: a field earns its place by naming a real failure, not by seeming general.

* **Auth is a header template, not a bearer flag.** Six distinct shapes among eight vendors examined: `Authorization: Bearer <t>` (Square, GitHub), `Authorization: <t>` with **no** scheme (Linear), `Authorization: Zoho-oauthtoken <t>` (Zoho — *sending `Bearer` returns 401 despite the token response saying `token_type: "Bearer"`*), `x-api-token` (Pipedrive), `PRIVATE-TOKEN` (GitLab), `api-key` (Brevo). A boolean would be wrong five times out of six.
* **Mandatory constant headers.** Klaviyo requires `revision: <date>`; Square requires `Square-Version`; GitHub wants `X-GitHub-Api-Version`. Omitting one is a 400, not a default.
* **The watermark is PER DATASET, not per vendor.** GitLab uses `updated_after` for issues, `last_activity_after` for projects, and `after` for events — and `after` takes a **date only**, not a timestamp. Klaviyo's filter operators differ per endpoint. Square's differ per resource. A vendor-level watermark field would be a lie on four of the eight.
* **The watermark may be a REQUEST HEADER.** Zoho's is `If-Modified-Since`, not a query parameter.
* **Watermark completeness is declared, not assumed.** Postmark's `fromdate` is a *send-time* filter, not a last-modified filter, so an incremental pass keyed on it misses edits. This mirrors the `complete` flag the existing `CANONICAL_COLUMNS` comments already reason about for Xero and QuickBooks.
* **A watermark may be ABSENT on some endpoints of a vendor that has one elsewhere.** GitHub's `since` is verified present on `/issues` and verified **absent** on `/pulls` and `/orgs/{org}/repos`. GitHub silently ignores unknown query parameters — so the plausible guess produces a full scan reported as an incremental read.
* **Pagination is a closed union of five.** Opaque cursor in body (`additional_data.next_cursor`), RFC-5988 `Link` header (GitHub, GitLab keyset), `limit`/`offset` (Brevo), page-number with a `more_records` boolean **then** a `page_token` past 2,000 rows (Zoho — two modes on one endpoint), and Relay `pageInfo` (Linear).
* **The base URL may be assembled per account.** Ten of thirty-four. Pipedrive's company domain, GitLab self-managed, Zoho's *two* per-account hosts (accounts host for tokens, `api_domain` returned in the token response for data), BambooHR's subdomain.
* **Rate ceilings that dictate cadence.** Pipedrive 20 per 2 s; Klaviyo 150/min; Brevo 100/hour; Zoho 5,000/day; Linear 2,500/hour; GitHub 5,000/hour.

### 3. 🔴 Every dynamic host gets a code-side exact-host guard. The declaration is not the control.

This is inherited from ADR-041 §3 and from the Mailchimp connector's header, and it is the single most important rule here because **ten** vendors need it rather than one.

`scripts/check-egress-allowlist.py` is a static text scanner. `docs/SECURITY.md` states the limit plainly: it *"cannot see hostnames assembled at runtime"*, and `load_allowlist()` contributes **zero** host patterns for a `kind: dynamic` entry. So for these ten vendors the YAML entry is documentation and review — **not enforcement**. The enforcement is `assertSafe<Vendor>BaseUrl()`, anchored exact-host equality, in the shape of `QBO_ALLOWED_API_HOSTS` + `UnsafeBaseUrlError`.

Two consequences that must not be "tidied" later:

1. A profile whose host is dynamic must carry **no scheme-URL literal** for that host in tracked source. A `kind: dynamic` entry registers no hosts, so the scanner would extract the literal and fail the gate as unregistered.
2. The guard's tests assert the injected `fetch` was called **zero** times — never merely that an error was thrown. A test that inspects the outcome still passes when the request already went out carrying the customer's key.

Filing a per-account host as `kind: egress` with a wildcard, or with one sampled region, is **worse than useless**: it produces a green `egress-gate` over a host nothing constrains.

### 4. What the track does NOT do

* **No writes.** Read-only by construction. `applyWrite` throws. The write-command registry, the confirm-outbox and the forbidden-table rules exist for the LAN tracks and are not weakened by a track that cannot write at all.
* **No new persistence model.** Rows land exactly where the cloud tracks already land them, under the ADR-041 §4 rule as amended by WARP-2549: into tables that make no unkept promise. **`ErpEntityCache` still gains no writer.**
* **No new scheduler.** `createErpSyncRunner` already selects work via `entityServedBy(provider)` → `providerDescriptor(provider)`. A profile that ships a descriptor is scheduled, budgeted, swept and landed by machinery that exists.
* **No vendor whose shape it cannot express.** A vendor needing bespoke logic gets a bespoke connector, as Mailchimp and Stripe have. The track is the common case, not a mandate. GraphQL (Linear), EDI (Stedi), S3 SigV4 and IMAP/CalDAV are explicitly **out** of v1.

### 5. A profile ships only with its guide and its ADR-042 row

Unchanged from the cloud track, and restated because volume is the risk: `scripts/check-setup-guides.sh` requires six ordered sections and per-vendor fact pins, sourced from the ADR-042 §2 table. A profile without a guide is a connector the owner cannot use, and at 28 vendors the temptation to batch the profiles and defer the guides is precisely what this clause forbids.

---

## Consequences

**What gets better.** The marginal vendor becomes a profile, a guide, an egress entry and an ADR-042 row — reviewable in one sitting, by one person, against the vendor's own documentation. The 130 FREE_NOW vendors stop being a multi-quarter programme and become a queue. One paging loop, one host guard and one budget path are tested once instead of 28 times.

**What gets worse, stated honestly.**

* **A bug in the shared connector is a bug in every vendor at once.** The blast radius inverts: today a Mailchimp defect is a Mailchimp defect. This is the standing argument for the track's own test suite being heavier than any single connector's.
* **The profile type will accrete fields.** Every vendor that does not quite fit pressures it. The admission criterion in §2 — a field must name a real, verified failure — is the only thing holding that line, and it is a review rule, not a compile-time one.
* **A declarative profile is easier to get wrong quietly than code is.** A wrong watermark parameter is one string. Mitigation: the parameter names are pinned by tests that cite the vendor page, exactly as `graph-resources.test.ts` does for Microsoft Graph.

**What this does not change.** ADR-042's custody model is untouched — the customer still mints every credential, and a vendor requiring a Warp-Lab-registered app is still PARTNER_GATED and still out. ADR-041's outbound-only, owner-consent, registered-destination terms apply to every profile without exception.

---

## Drafting a profile on a box (WARP-2899)

ADR-056 slice L lets a Workshop run on a customer's box **draft** a profile of this track. It changes nothing in §5: a profile still ships only with its guide, its egress entry and its ADR-042 row, in a Warp Lab PR.

* **What a draft is.** A workspace made from the `rest-profile` template (`extensions/templates/rest-profile/`). The run fills one file, `connector-draft.json`, and `npm run build` renders `services/erp-connector/src/rest/vendors/<provider>.ts`, `docs/integrations/<provider>.md` (the six sections, in order), `docs/security/allowed-egress.<provider>.draft.yaml` (`kind: egress` for a static origin; `kind: dynamic` with `config_key` plus a `kind: reference` per suffix or host for a per-account one) and `docs/adr-042/<provider>.rows.md`. The sandbox has no network, so every vendor fact nobody has checked renders as `TODO(verify)`; a dynamic draft carries no scheme URL anywhere (§3's rule, enforced by the template's own check, because the egress gate does not scan `extensions/`).
* **What a draft is not.** Data in the box's git store. `workspace_propose` tags it without an extension manifest, so nothing installs it; `restProfileFor` is still the compiled `REST_VENDOR_PROFILES` table and nothing else. That is pinned, not promised: `services/erp-connector/__tests__/rest-profile-no-store-path.test.ts` (the registry has no second door) and `apps/orchestrator/src/__tests__/connector-draft.no-runtime-path.test.ts` (the lookup seam is test-only, only the sandbox image carries `extensions/`, the store's volumes are the sandbox's alone).
* **How it leaves the box.** An owner or admin — a person, never a run — downloads the workspace as a `git bundle`; one audit row records its sha256. The box dials nothing to do it. The PR is made by hand from the bundle (`ADD-A-PROVIDER.md` §0).
* **The vocabulary snapshot.** The template validates fieldMaps against `vocabulary.json`, a copy of `DATASETS` / `CANONICAL_COLUMNS` / `REQUIRED_CANONICAL` that `rest-profile-template-vocabulary.test.ts` pins to the live constants.

---

## Follow-ups

* **WARP-2707** — the track: `RestVendorProfile`, `RestProfileConnector`, the host guard, the five pagination modes, the test suite.
* **Vendor waves**, each its own ticket, guide, egress entry and ADR-042 row. Suggested order by cleanliness (static host, one auth header, documented per-dataset watermark, datasets that already exist in the vocabulary): **Brevo → Klaviyo → Pipedrive → Zoho CRM → Square → GitHub → GitLab**.
* **Dataset vocabulary widening** is required before the HR, scheduling, storage and task-tracker vendors can declare what they serve honestly. `DATASET_NAMES` is a closed union of 23 mirrored in two packages, with three *total* `Record`s keyed off it and `@ts-expect-error` fixtures in `vocabulary-contract.ts` that fail in both directions. That is a deliberate, gated change and its own ticket — not an append.
* **Vendors excluded by the survey, recorded so they are not re-researched:** Notion (**refuted to NOT_FREE** — the free internal-integration path no longer holds), Wave (API moved behind Wave Pro, 2025-05-26), NexHealth (one org-wide key spans every practice — the application-wide credential ADR-042 model 2 prohibits), Slack (ADR-042 §7 — the sole operator-registered case; **Romain owns that call, WARP-2373**, and nothing here pre-empts it).

---

## Implementation record — 2026-09-07 (WARP-2707)

The track shipped as specified. `RestVendorProfile` + `RestProfileConnector` +
`restProfileFor()` live in `services/erp-connector/src/rest/`, dispatched from
`connectorFactoryFor` ahead of the static factory map, exactly as export-drop is.
`ProviderTrack` gained `"rest"`, sharing the `cloud` arm of `ProviderDescriptor` so
that `CloudProviderCatalogMeta`'s required `setupGuideHref` keeps applying — a
separate arm would have dropped §5's guide rule silently.

**Two profile fields were added beyond §2's list**, each admitted under §2's own
criterion (a field must name a real, verified failure):

* `FieldTransform: "minor-units"` — Square returns money as integer minor units and
  a dotted path cannot divide. The divisor is not always 100 (JPY is ISO-4217
  exponent 0), so the transform reads the row's own currency. Without it every
  Square amount lands 100× too large, silently.
* `absentRowsMeansEmpty` — Square OMITS the rows array on an empty result (`{}`, not
  `{"payments": []}`), so a healthy account with no rows read as a broken connection.
* `probePath` — not a §2 field but a contract one: `integrations.service.ts` treats a
  successful `health()` as the evidence a pasted key works, so the track must make a
  real authenticated round trip. Resolving the credential locally would let a revoked
  key be written CONNECTED and fail hours later, unattended.

### The vendor programme, re-scoped against the evidence

Four vendors were taken to build-spec depth and each spec adversarially refuted
against the vendor's own documentation. The §2 suggested order did not survive
contact with the sources:

* 🔴 **Open Dental — DO NOT BUILD on this track.** Its REST API fails ADR-042 on two
  independent grounds, either fatal. The `DeveloperKey` is issued to Warp Lab only
  after an emailed application (company name, billing address, requested permission
  list) reviewed in one to three business days — a fleet-wide application credential
  of exactly the shape ADR-042 §1 model 2 declares not permitted, and the shape that
  already disqualified NexHealth. The `CustomerKey` is then generated *by the
  developer* in the portal, so Warp Lab would mint and hold the practice's credential
  before the practice ever saw it; Warp Lab is also the party on file for per-location
  billing. A BAA per practice is required on top. The practice's only control is
  enable/disable. **The existing `opendental` catalog placeholder should stay
  `track: "catalog"`, and its LAN direct-database path (whose ADR-042 §7 row is
  already clear) is the one worth building.**
* **Zoho CRM — deferred, not rejected.** Custody is clean (Self Client, minted by the
  owner) but it needs two structural things this track does not have: TWO independent
  per-account hosts (an accounts host for the token exchange and the `api_domain`
  returned in that response — `RestBaseUrl` models one), and an OAuth refresh-token
  exchange, which is control flow the declarative track deliberately lacks. Also
  refuted: `api_domain` is not always a `www.zohoapis.*` host, so a zohoapis-only
  allow-set is not sufficient.
* **Square — shipped, at three datasets of eight.** `charge`, `refund` and `payout`
  only. `order` needs a POST search body; `invoice` requires a `location_id` fan-out
  and has no total-money field at all; `product` needs a second endpoint for inventory
  and a client-side join; `customer` has no watermark of any kind. `appointment` is a
  vocabulary question, not a mapping one (below). Each omission is written out in
  `rest/vendors/square.ts` rather than left to be discovered.
* **Cal.com — shipped, hosted only.** `api.cal.com` is a static host (the earlier note
  calling it dynamic was wrong). Self-hosted `cal.diy` runs a *different* API contract
  (`take`/`skip`, a different `cal-api-version`, a feature-reduced build) and is a
  second profile, not a variable host on this one.

### 🔴 The finding that should shape the next ticket

**The declarative track is not the bottleneck any more; the dataset vocabulary is.**
Within the closed 23 names, nearly every slot a FREE_NOW vendor could fill is already
taken by a hand-written connector — which is why this wave found only three clean
datasets across four researched vendors. Two independent vendors hit the *same* wall
from opposite directions: Cal.com and Square Appointments both map onto `appointment`,
whose canonical columns (`patient_id`, `operatory_id`) are the dental
practice-management vocabulary from WARP-1964. Neither vendor has an honest source for
either column. Cal.com ships with both pinned `undefined` and a test that keeps them
that way; Square's `appointment` is not shipped at all pending that call.

So the follow-up below — *"dataset vocabulary widening is required before the HR,
scheduling, storage and task-tracker vendors can declare what they serve honestly"* —
is not a later nicety. It is the gate on the remaining ~127 vendors, and it should be
the next ticket rather than a fifth vendor.

### Resolved by WARP-2832, same day

The vocabulary went 23 → 26: **`booking`, `employee`, `task`**. `appointment` was NOT
touched — it is a WIRE FORMAT, named as a bare string in export-drop profile JSON that
operators author on their own sites and Warp Lab does not hold, so renaming it would
have been an un-migratable field change. `booking` was added beside it and Cal.com
moved there, filling nine of eleven columns where it had filled four of six.

🔴 **That ticket also fixed a defect this one shipped.** Cal.com was connectable and
UNREADABLE: `appointment` is in neither `ERP_SYNC_ENTITIES` nor `CLOUD_DATASET_READS`,
so a healthy connection was never polled and could not be asked anything, and
`erp.service.ts`'s `getSchedule()` resolves the Eaglesoft row specifically. Nothing went
red, because those two lists are gated **only against each other** and neither is typed
`DatasetName` — they can lag the vocabulary indefinitely, in lockstep, with every test
green. `cloud-dataset-tool.e2e.test.ts` now also asserts that every `available` cloud or
rest provider has at least one dataset the assistant can ask about.

**One correction to this ADR's own cost estimate, above:** the Follow-ups say three
*total* `Record`s key off `DATASET_NAMES`. There are **four** — `NATURAL_KEY` in
`export-drop/scan.ts` is the missed one, and it is the only one with no totality fixture
in `vocabulary-contract.ts`, so making it `Partial<>` is caught by nothing and would
silently key dedup on `undefined` for every dataset at once.


## Implementation record — 2026-09-18 (WARP-2916, GitHub)

**The third profile, and the first on the track that needed a change to the shared
connector.** `rest/vendors/github.ts` serves `task` from `GET /issues` — issues AND pull
requests, because GitHub's API "considers every pull request an issue" and the track has
no per-row filter; the undocumented `pulls` parameter is deliberately not sent. Static
host `api.github.com`; `since` (ISO, verified live to be inclusive, and a 422 rather than a
silent full scan when malformed); RFC-5988 `Link` pagination, which `profile.ts` had
declared with GitHub as the named vendor since WARP-2707 and which now has its first
shipped profile; bare-array body (`rowsPath: ""`); pacing at the documented 5,000/h
(720 ms). `assignee_id` reads `assignees[0].id` rather than the singular `assignee`, which
the 2026-03-10 API version removes — the profile is correct under both, and the
`X-GitHub-Api-Version: 2022-11-28` pin is the whole migration when it comes.

**One connector change, admitted under §2's criterion.** GitHub answers rate-limit
exhaustion with *"a 403 or 429"*, carrying `retry-after` (secondary limits) or
`x-ratelimit-remaining: 0` (primary). The shared connector read EVERY 403 as "the vendor
rejected the credential" — evicting the cached token and sending the owner to paste a new
one for a budget that refills within the hour, and a budget that is the USER's, shared with
every other tool on that account. `request()` now classifies a 403 carrying either header
as rate-limited, on the same path a 429 takes, and both raise a `RestRateLimitedError`
(a `RestVendorError` subclass carrying the raw `Retry-After`). The signals are the vendor's
own rate-limit vocabulary, not a `provider === "github"` branch. The orchestrator's sync
loop maps that class to TRANSIENT by `instanceof`, exactly as it maps
`XeroRateLimitedError` — without which the error's real 403 status would have reached
`classifySyncFailure` and been read as AUTH, re-creating the "paste a new key" it was
meant to remove one hop downstream. Pinned in `rest-track.test.ts`,
`github-profile.test.ts` and `erp-sync.service.test.ts`.

**Two constant-header findings, recorded so they are not re-derived:**

* `Accept` is NOT declared. `request()` spreads `constantHeaders` first and then sets
  `accept: application/json` unconditionally; Node's `Headers` merges the two
  case-variant keys, so a profile-level `Accept: application/vnd.github+json` cannot pin
  GitHub's media type — it can only claim to. GitHub answers 200 `application/json` to the
  connector's value (verified live).
* `User-Agent: droplet-erp-connector` IS declared. GitHub refuses a request with no
  User-Agent (403 text/html, verified live), and the track never set one — every REST
  vendor so far has worked only because undici sends `User-Agent: node` by default. That
  runtime-default dependency is now explicit for GitHub and is the obvious candidate for a
  track-level constant when the next vendor documents the same requirement.

**Datasets NOT served, and why:** `ticket` — an issue is a work item, not a support
conversation, and `CANONICAL_COLUMNS.ticket` wants a `contact_id` an issue does not have;
`task` and `ticket` were separated on purpose in WARP-2832. A repository or pull-request
dataset — no canonical name exists, and `since` is verified ABSENT on `/pulls` and
`/orgs/{org}/repos`, so neither would have an incremental watermark even if one did.
GitHub Enterprise Server / GHEC data residency — other hosts, a second `kind: dynamic`
profile, not a widening.

**Left open, stated rather than guessed:** whether `GET /issues` with `filter=all`
returns PRIVATE-repository issues for a fine-grained token that has repository access
but NO Issues permission (the endpoint says no permissions are required; the
permissions page does not list it). The guide tells the owner to grant `Issues:
Read-only` regardless, and warns that a token with too little — or an org-owned token
still pending approval — probes green and reads fewer rows.
## Implementation record — 2026-09-18 (WARP-2917, GitLab) — the first vendor on the widened vocabulary

* **GitLab (gitlab.com hosted) — shipped, one dataset: `task` ← `GET /api/v4/issues`.**
  Every issue the token's user can see, across every project and group. Eight of
  `task`'s nine columns are filled; `priority` stays `undefined` because GitLab issues
  carry no priority field (`severity` is incident-only, `weight` is Premium-only effort,
  `priority::high` is a per-project label convention). The watermark is `updated_after`,
  a complete last-modified filter, so `task` is polled, swept and read-through (it is
  `NEVER_LANDED` with a reason, like `booking` and `employee`).
* **Datasets GitLab could serve and does not, and why:** `ticket` (a GitLab issue has no
  `contact_id`; Service Desk exposes an author e-mail, which is a contact detail, not an
  id); `employee` (`/users` is admin-gated beyond the public profile and group membership
  is a per-group fan-out — one endpoint per dataset); `engagement` (`/events` filters
  `after` by DATE and by creation time; a candidate for `format: "date"` on its own
  ticket). Merge requests, pipelines, projects, groups and epics have no canonical name.
* **Self-managed GitLab is OUT**, and it is the same finding Cal.com's self-hosted edition
  produced from the other side: an arbitrary customer hostname cannot satisfy the dynamic
  arm's allowlist, so it is a separate provider, not a variable host.
* **No profile field was admitted.** Every value the track needs existed: static host,
  one literal auth header, GET only, `link-header` pagination (offset mode — keyset is
  documented for `GET /projects/:id/issues` only), `rowsPath: ""`. The `link-header` arm,
  declared on WARP-2707 for GitHub/GitLab and exercised only by `rest-track.test.ts` until
  now, has its first shipped profile.
* **The refutation caught a build-blocking literal, recorded so it is not re-proposed:** the
  spec's credential `pattern` `^glpat-[A-Za-z0-9_-]+$` rejects every routable token
  gitlab.com now mints (`glpat-<27..300>.<2>.<9>`, two dots). The descriptor ships with
  NO pattern, pinned absent by `gitlab-profile.test.ts`, and the prefix moved to the help
  text. Three cosmetic corrections also applied: `assignees[0].id` over the documented-
  deprecated singular `assignee`; 720 ms pacing from the 5,000/h sustained Free limit
  rather than 600 ms from the per-minute burst; and the 50,000 max-offset ceiling does NOT
  apply to the global `/issues` (only to keyset-capable endpoints), so `REST_MAX_PAGES` is
  the only ceiling on a first full scan.

## Implementation record — 2026-09-18 (WARP-2918, Todoist)

The third profile, and the first task-tracker vendor — the class the §2
follow-up said the vocabulary had to widen for, which WARP-2832's `task` did.
`rest/vendors/todoist.ts` serves **`task`** from `GET /api/v1/tasks` on the
unified v1 API (`https://api.todoist.com`, one static host). Custody is model 3:
the owner copies a personal API token from Settings → Integrations → Developer;
no app registration, no review, nothing held by Warp Lab. Todoist's OAuth path
exists and is deliberately not used.

**No profile field was admitted.** Everything Todoist needs is already in §2's
shape: a plain Bearer header, a static origin, `cursor` pagination (body
`next_cursor` echoed as query `cursor`), rows at `results`, a constant `limit=200`
query parameter. The refuter caught one shape error in the build spec — the
`cursor` arm carries exactly `nextCursorPath` and `cursorParam`, so the page size
lives in `query`, not in the pagination object — and the profile is written that
way.

* **`watermark: null`, declared.** `GET /api/v1/tasks` accepts exactly
  `project_id`, `section_id`, `parent_id`, `label`, `ids`, `cursor` and `limit`
  (verified from the OpenAPI document embedded in the reference). There is no
  last-modified filter under any spelling, so every read is a declared full scan
  — the GitHub case §2 names, handled the way §2 prescribes rather than by a
  guessed `updated_since` Todoist would ignore. The incremental read Todoist does
  offer is the Sync API (`POST /api/v1/sync`, `sync_token` form body): a POST with
  a body, which the GET-only track cannot express. Recorded as a possible future
  widening; it is not needed to ship.
* **Active tasks only — two columns are honest and thin.** The endpoint's own
  description is "Get all active tasks for the user". So `closed_at`
  (`completed_at`) is `undefined` on every row and a completed task VANISHES from
  the feed rather than arriving closed; and `status` (`checked`, a boolean) is
  the text `"false"` on every row, so `get_tasks_by_status` with its documented
  example `{ status: "open" }` matches nothing. Both are pinned by
  `todoist-profile.test.ts`. Completed tasks are on a separate endpoint whose
  `since` **and** `until` are required, with `until` a moving "now" — a query the
  constant-only track cannot express, and a profile cannot declare `task` twice.
  Out of scope, stated on the catalog card. A value mapping for `status`
  (`checked=false` → `"open"`) would be a §2 widening and is flagged for review,
  not shipped.
* **No rate ceiling, like Square.** The Request-limits section publishes ceilings
  only for the Sync endpoint; nothing for the REST-style GETs. `minRequestIntervalMs`
  is omitted and the connector reacts to `429` / `Retry-After` / `retry_after`.
* **No credential pattern.** Todoist documents no token format; the reference's
  single forty-hex example is not a contract. The build spec's `^[0-9a-f]{40}$`
  was dropped for the Brevo / Square / Cal.com reason.
* **Datasets not served, and why:** projects, sections, labels and comments have
  no canonical home (a project is a container, not a work item — a vocabulary
  question); completed tasks for the reason above.
* **§7b, per dataset:** `task` was already askable (`CLOUD_DATASET_READS` /
  `CLOUD_QUERY_DATASETS`, `get_tasks_by_status`), already polled
  (`ERP_SYNC_ENTITIES` row from WARP-2832), and already classified
  `NEVER_LANDED` (read-through). Todoist inherits all three; the only new fact is
  that its tick is a full scan, which the descriptor test records beside the
  `unscheduled` pin.
* **One thing unverified:** whether `GET /api/v1/user` (the probe) accepts a
  personal token — its description speaks of OAuth audiences. If a live token
  gets 401/403 there, the fallback is `/api/v1/projects?limit=1`, a one-line
  `probePath` change.
---

## Implementation record — 2026-09-18 (WARP-2919, Loyverse)

**Third profile, zero widening — and the first `assertValidRestProfile` rule added by a
vendor.** Loyverse POS shipped as `rest/vendors/loyverse.ts` with NO new profile field: one
static host (`api.loyverse.com`, the `/v1.0` version carried on every path because §2's
static-origin rule refuses a path on the origin), `Authorization: Bearer`, no constant
header, `GET /v1.0/merchant/` as the probe, `updated_at_min` as a genuine last-modified
filter on both endpoints (`complete: true`), body `cursor` echoed as query `cursor` with the
final page OMITTING the key — which the shared connector already treats as end-of-walk —
and `limit=250` as a constant query parameter (the `cursor` arm has no page size; the spec
JSON's `pageSize` was a shape artefact and was dropped). Money is already major-unit
decimals, so no `minor-units`. Custody is model 3: the owner mints a personal access token
in their own Back Office; the OAuth path (model 2) is not used. Paced at 1 s against the
published 300-per-300-s per-account ceiling.

* **Datasets shipped: `customer`, `product` (items).** Both were already askable
  (`CLOUD_DATASET_READS` / `CLOUD_QUERY_DATASETS`), scheduled (`ERP_SYNC_ENTITIES`,
  Shopify's rows) and in `land.test.ts`'s existing unclassified-debt pin, so §7b needed no
  edit — and that inheritance is recorded as a decision about Loyverse in
  `erp-provider.descriptor.test.ts`'s `unscheduled` pin, not left to apply by accident.
  `product` sends a constant `show_deleted=true` so a deleted item reaches the box as a
  change instead of quietly stopping.
* 🔴 **`order` (receipts) is NOT served, and the guard that refuses it is new.**
  `REQUIRED_CANONICAL.order` names `currency`, and Loyverse carries currency per MERCHANT
  (`GET /v1.0/merchant/` → `currency.code`), never per row. The track has no per-account
  constant. An earlier cut of this profile shipped receipts anyway with `currency`
  undefined, because `assertValidRestProfile` checked `fieldMap ⊆ CANONICAL_COLUMNS` and
  nothing checked `REQUIRED_CANONICAL ⊆ fieldMap` — so a `cloud_query_dataset` row of
  `total_amount: 17.52, currency: undefined` reached the model as a dollar-shaped answer for
  a merchant in Tokyo. The verifier caught it; the fix is two-fold. **(1) The guard:**
  `assertValidRestProfile` now refuses any dataset that leaves a `REQUIRED_CANONICAL`
  column unmapped, at module load, naming the column (`rest-track.test.ts` pins the
  refusal and that Square and Cal.com pass it). **(2) The dataset is dropped**, not
  hardcoded: `loyverse-profile.test.ts` keeps the researched receipts spec as a constant,
  pins that the guard refuses it naming `currency` and NOTHING else, and that the same spec
  with `currency` mapped passes — so the day the track gains a probe-derived per-account
  constant (§2's admission criterion is met: this is a verified failure, and Brevo's
  bespoke connector solves the same vendor shape with a second call to the account's
  display currency) the return is one fieldMap line. That widening is a separate decision,
  recorded here, not smuggled in behind one vendor.
* **Datasets NOT served, and why:** `refund` (a Loyverse refund is a receipt with
  `receipt_type: REFUND` in the SAME list, with no type filter — the track cannot route
  one endpoint to two datasets by row value; moot while receipts are not read, recorded so
  the future `order` dataset knows a refund lands with a POSITIVE total);
  `charge`/`payout` (payments are an array on the receipt, and there is no payout
  resource); `employee` (behind a paid add-on and HR-shaped — not researched to build
  depth); `inventory_quantity` on `product` (a second endpoint, `/v1.0/inventory`, per
  variant per store — a join one spec cannot express).
* **Two honest consequences of the read semantics, pinned rather than patched:** a
  NAMED `find_customer` search (a `last_name` prefix) returns zero rows from Loyverse,
  because Loyverse has one `name` field and the track has no split; and
  `get_low_stock_products` with a threshold returns zero rows, because
  `inventory_quantity` is on another endpoint. Both are limitations a reader can find;
  the wrong fixes (`last_name: "name"`, a fabricated quantity) are the mutations the tests
  refuse.
* **Tool selection:** `loyverse` joins the cloud-domain keyword regex as the vendor name,
  exactly as `shopify` and `square` do. `receipts?` does NOT: the word is already claimed
  by the `files` domain ("file this receipt"), and no cloud dataset serves receipts; a
  negative case pins it.
* **Left UNVERIFIED, deliberately:** the empty-list shape (`absentRowsMeansEmpty` left off
  so a wrong `rowsPath` fails loudly); whether `/customers` carries the top-level `cursor`
  its 200 schema omits while the generic Pagination section promises it; and
  customer-deletion visibility (the YAML contradicts itself — prose says hard delete, the
  schema carries `deleted_at` and `permanent_deletion_at` — so the reconciliation sweep is
  the control). The 31-day sales-history gate (402 vs truncation on a free account) is a
  receipts fact, recorded in the profile header for the day `order` ships.

### Fixed by WARP-2920 — the dynamic-host factory read the wrong declaration (2026-09-19)

🔴 **A defect this track shipped with, dormant only because no dynamic-host vendor had
landed.** `restProfileFactory` resolved a per-account host as
`providerConfigString(cfg, descriptor.dynamicEgress.configKey)`. But every shipped
`configKey` is the *documentation* path that mirrors the `allowed-egress.yaml` entry —
`IntegrationConnection.providerConfig.companyDomain` — while `providerConfigString`
reads `cfg[name]` by the **bare** field name, exactly as the hand-written tracks do
(`providerConfigString(cfg, "companyDomain")`). The first REST profile with
`baseUrl.kind: "dynamic"` that followed the registry's own convention would have
resolved `undefined`, and §3's host guard would have refused every one of its
connections at construction — *"this connection supplies no companyDomain"* — with a
green build. Nothing caught it because the guard's tests hand it `hostConfigValue`
directly and never go through the factory.

**What changed.** The factory now reads the field the *profile* names,
`profile.baseUrl.configField`, which is the only one of the three declarations that
was ever a lookup key. The `configKey` stays what it always was — the descriptor's half
of the YAML registration — and `PROVIDER_CONFIG_KEY_PREFIX` /
`providerConfigKeyFor(field)` in `@droplet/shared-types` spell that convention once.

**What now guards it.** `assertRestProfileAgreesWithDescriptor(profile, descriptor)` in
`erp-provider.ts`: for a dynamic profile the descriptor must declare `dynamicEgress`,
its `configKey` must equal `providerConfigKeyFor(configField)`, and the shared
`credentialFields` must carry an entry of that name with `storage: "providerConfig"`
and `secret: false` (the Pipedrive `companyDomain` shape); a static profile's
descriptor must declare no `dynamicEgress`. It runs at construction from the factory
and over every shipped profile in `erp-provider.descriptor.test.ts` — which lives in
the orchestrator because that is the one package that can see both a profile and a
descriptor. The guard is exercised by a fixture pair driven through the **real**
dispatch path via `__setRestProfileLookupForTest`, so it is not vacuous while both
shipped profiles are static.

**A second hazard of the same class, documented rather than changed.** The guard
completes a bare label (`acme`) with `allowedSuffixes[0]` only. A multi-region profile
listing several suffixes would send `acme` to the first region whether or not it is the
customer's, and the allow-set would pass it. The rule — such a profile must have the
customer enter the whole host, enforced by the credential field's `pattern` — is now on
`RestBaseUrl.dynamic.allowedSuffixes`, and the first-suffix behaviour is pinned in
`rest-track.test.ts` so the docstring cannot go stale.
