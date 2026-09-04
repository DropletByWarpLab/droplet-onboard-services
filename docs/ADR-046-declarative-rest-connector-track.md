# ADR-046 — The declarative REST connector track

**Status:** Proposed
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

## Follow-ups

* **WARP-2707** — the track: `RestVendorProfile`, `RestProfileConnector`, the host guard, the five pagination modes, the test suite.
* **Vendor waves**, each its own ticket, guide, egress entry and ADR-042 row. Suggested order by cleanliness (static host, one auth header, documented per-dataset watermark, datasets that already exist in the vocabulary): **Brevo → Klaviyo → Pipedrive → Zoho CRM → Square → GitHub → GitLab**.
* **Dataset vocabulary widening** is required before the HR, scheduling, storage and task-tracker vendors can declare what they serve honestly. `DATASET_NAMES` is a closed union of 23 mirrored in two packages, with three *total* `Record`s keyed off it and `@ts-expect-error` fixtures in `vocabulary-contract.ts` that fail in both directions. That is a deliberate, gated change and its own ticket — not an append.
* **Vendors excluded by the survey, recorded so they are not re-researched:** Notion (**refuted to NOT_FREE** — the free internal-integration path no longer holds), Wave (API moved behind Wave Pro, 2025-05-26), NexHealth (one org-wide key spans every practice — the application-wide credential ADR-042 model 2 prohibits), Slack (ADR-042 §7 — the sole operator-registered case; **Romain owns that call, WARP-2373**, and nothing here pre-empts it).
