/**
 * WARP-3698 / ADR-046 — Capsule CRM, as a declarative REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The account owner generates a PERSONAL access token entirely inside their own
 * Capsule — their name (top menu bar) → *My Preferences* → *API Authentication*
 * → *Generate new API token* — and copies it. They revoke it on the same page
 * ("revoke tokens that you don't need anymore"). Capsule's OAuth path (grants
 * under *My Preferences* → *Authorized Applications*) is NOT used. Warp Lab
 * registers nothing, reviews nothing and holds nothing. [src: Capsule support
 * article "How to integrate with Capsule" and the developer authentication
 * page, accessed 2026-10-04]
 *
 * API access is "included in every tier" [src: Capsule pricing blog post
 * 2026-02-03, accessed 2026-10-04] and a Free plan exists (2 users, 250
 * contacts, 1 pipeline, 5 custom fields) [src: Capsule pricing pages, accessed
 * 2026-10-04]. ⚠ UNVERIFIED that a Free-plan account can mint a token — that is
 * inferred from "every tier"; the developer docs name no plan gate.
 *
 * 🔴 **The default scope is `read write`, and the guide asks for `read`.** The
 * scopes are `read`, `read write` and `read write user_preference` [src: Capsule
 * developer authentication page, accessed 2026-10-04]. A read-only token answers
 * 403 to anything that writes ("read-only token or non-admin user" [src: Capsule
 * handling-api-responses page, accessed 2026-10-04]), which is exactly what the
 * box wants. The support article says to "restrict the scope of the token to only
 * what is required" but does not show the picker — whether the UI offers the
 * choice is UNVERIFIED, so the help text says "if Capsule offers the choice".
 *
 * 🔴 **Do NOT validate the token's shape.** Capsule documents no token format. A
 * regex anchored on an undocumented shape is the Brevo / Square / Cal.com false
 * rejection: it blocks a paying owner for zero security gain. Emptiness is the
 * only thing refused; the probe is what proves a token. No expiry is documented
 * for a personal token (OAuth tokens last 604,799 seconds and are not used).
 *
 * Capsule also ships an OAuth-based MCP server (Growth plan and above) and a
 * read-only local MCP beta. Neither is used: the REST token path needs no OAuth
 * app and is not Growth-gated the way the MCP server is. [src: Capsule developer
 * announcements page, accessed 2026-10-04]
 *
 * ## Two datasets
 *
 * `deal` ← `GET /api/v2/opportunities` (the pipeline: milestone and value) and
 * `task` ← `GET /api/v2/tasks`. Both are plain lists under their resource name,
 * paged by the RFC-5988 `Link` header — "pagination info is included in the Link
 * header. It is recommended to follow these Link header values instead of
 * constructing your own URLs" [src: Capsule reading-from-the-api page, accessed
 * 2026-10-04] — with `perPage` as a constant query parameter.
 *
 * ## 🔴 The task default is OPEN ONLY
 *
 * Capsule's task model page: "By default the body will contain only the open
 * tasks". Without the constant `status=open,completed,pending` below the box
 * would read a feed with no completed work, on every tick, and look healthy —
 * `closed_at` would be undefined on every row and COMPLETED would never appear.
 * The `status` parameter takes a "comma separated list" of `open`, `completed`
 * and `pending`. `GET /tasks` has NO `since` or any other modification filter
 * (its parameters are `page`, `perPage`, `embed` and `status`), so `task` is a
 * DECLARED full scan: every tick re-reads every task. [src: Capsule task
 * operation and model pages, accessed 2026-10-04]
 *
 * ## 🔴 `status` is the vendor's UPPER-CASE word
 *
 * The enum is `OPEN | COMPLETED | PENDING`, passed through verbatim. The `equals`
 * read filter in `read-semantics.ts` compares `status` as case-sensitive text, so
 * `get_tasks_by_status { status: "open" }` — the documented example — matches
 * ZERO Capsule rows while `{ status: "OPEN" }` matches. A value mapping or a
 * case-insensitive `equals` is a track widening, not something to smuggle in
 * behind one vendor; it is recorded in the ADR-046 wave-3 record and pinned by
 * `capsule-profile.test.ts`.
 *
 * ## 🔴 What this profile deliberately does NOT do, and why
 *
 * * **`contact` and `company`** — both live behind ONE `GET /parties` that returns
 *   persons AND organisations, with no type filter (`since`, `page`, `perPage`,
 *   `embed` only). The track cannot route one endpoint to two datasets by row
 *   value (the Loyverse refund case), and landing would write organisations into
 *   the owner's address book and persons into Companies named "Capsule <id>".
 *   That is a named widening (per-row-type routing), not a mapping detail.
 * * **`engagement`** — `GET /entries` has no `since`, is newest-first and returns
 *   every note, e-mail and completed task: an unbounded full scan, and the
 *   500-page ceiling would cap it at 50,000 entries.
 * * **Projects (`kases`)** — no canonical dataset name.
 * * **`company_id` on `deal`** — `party` may be a PERSON or an organisation, so
 *   `party.id` would put a person's id in a company column, and no `company`
 *   dataset is served for it to join to. Left UNDEFINED.
 * * **`priority` on `task`** — Capsule's task has no such field.
 * * **`project_id` is LOSSY** — it reads `kase.id`, which exists only when the
 *   task hangs off a Capsule project; a task attaches to exactly one of party,
 *   opportunity or kase, so the column is undefined on most rows.
 *
 * ## What landing does with `deal` (shared behaviour, stated so it is not
 * re-derived)
 *
 * `deal` lands in the box CRM: one "Capsule CRM" pipeline per connection and a
 * stage per distinct milestone NAME. `closedAt` is kept only for stage keys
 * `closedwon` / `closedlost` (`erp-sync/land.ts`), so Capsule's own "Won" and
 * "Lost" milestones land as OPEN — a shared landing limitation, not a Capsule
 * one, and the guide says so. `task` is read-through (`NEVER_LANDED`).
 */
import type { RestVendorProfile } from "../profile.js";

export const CAPSULE_PROVIDER = "capsule";

/**
 * Capsule's ONE static API origin. No region, no account subdomain, no self-hosted
 * edition — so a plain `kind: egress` allowlist entry the static scanner reads
 * directly from this literal. The `/api/v2` version rides on every path, because
 * `assertValidRestProfile` refuses a path on a static origin. [src: Capsule
 * reading-from-the-api page, accessed 2026-10-04]
 */
export const CAPSULE_API_ORIGIN = "https://api.capsulecrm.com";

/**
 * `perPage` — "range 1-100. Default: 50" [src: Capsule reading-from-the-api page,
 * accessed 2026-10-04]. The maximum, because `task` has no watermark and is paid
 * in pages. A CONSTANT QUERY PARAMETER: the `link-header` arm carries no page
 * size. A string, because `RestDatasetSpec.query` is `Record<string, string>`.
 */
export const CAPSULE_PAGE_SIZE = "100";

/**
 * "Each Capsule user is allowed 4,000 requests per hour when using Bearer Token
 * Authentication" [src: Capsule handling-api-responses page, accessed
 * 2026-10-04] → 3,600,000 / 4,000 = 900 ms. The docs also suggest "a one-second
 * delay", and say excessive requests "may result in temporary application
 * blocking or account suspension", so the box paces rather than reacts.
 *
 * ⚠ The allowance is the USER's: it is shared with every other tool using that
 * user's tokens. A 429 carries `X-RateLimit-Reset` (UTC epoch seconds) and no
 * `Retry-After`, so `RestRateLimitedError.retryAfter` is undefined on one and the
 * sync's generic backoff applies; this pacing is what prevents the 429.
 */
export const CAPSULE_MIN_REQUEST_INTERVAL_MS = 900;

/** RFC-5988 `Link: <...>; rel="next"`, followed verbatim and re-guarded per request. */
const LINK_PAGING = { kind: "link-header" } as const;

export const CAPSULE_PROFILE: RestVendorProfile = {
  provider: CAPSULE_PROVIDER,
  baseUrl: { kind: "static", origin: CAPSULE_API_ORIGIN },
  // `Authorization: Bearer {token}` — a genuine RFC-6750 Bearer scheme. [src:
  // Capsule developer authentication page, accessed 2026-10-04]
  auth: { headerName: "Authorization", valueTemplate: "Bearer {{token}}" },
  // Nothing. `Accept: application/json` is sent by the shared connector itself,
  // and no version or revision header is documented — an invented one is a
  // contract Capsule never stated.
  constantHeaders: {},
  // `GET /api/v2/users/current` — "the user who approved your application": one
  // object, no paging, so a 401 on it is unambiguous evidence about the TOKEN. [src:
  // Capsule user operation page, accessed 2026-10-04]
  probePath: "/api/v2/users/current",
  minRequestIntervalMs: CAPSULE_MIN_REQUEST_INTERVAL_MS,
  datasets: [
    {
      dataset: "deal",
      path: "/api/v2/opportunities",
      // `milestone` is an optional embedded resource; without this request the
      // mapped `milestone.name` stage is absent from the list response.
      query: { perPage: CAPSULE_PAGE_SIZE, embed: "milestone" },
      // `since` "includes only entities that have been changed after this date",
      // ISO 8601. [src: Capsule opportunity operation page, accessed 2026-10-04]
      //
      // `complete: true` is DECLARED on that sentence and is not verified: which
      // field it filters (`updatedAt`?) and whether the bound is inclusive are not
      // stated (UNVERIFIED). If it is exclusive and the timestamps are
      // second-precision, an edit inside the watermark's own second waits for the
      // reconciliation sweep. The docs show second-precision instants
      // (`2015-09-15T10:43:23Z`) while `format: "iso"` emits milliseconds — also
      // UNVERIFIED that Capsule accepts that form.
      //
      // 🔴 An unknown parameter is not guaranteed to 4xx, so this one name is
      // pinned by `capsule-profile.test.ts` against every plausible spelling.
      watermark: { name: "since", location: "query", format: "iso", complete: true },
      pagination: LINK_PAGING,
      rowsPath: "opportunities",
      fieldMap: {
        deal_id: "id",
        created_at: "createdAt",
        // `closedOn` is nullable and a date or a datetime; both parse. It marks
        // conclusion — won or lost is carried by the milestone, not by this.
        closed_at: "closedOn",
        // `company_id`: ABSENT — `party` may be a person; see the header.
        name: "name",
        // The pipeline stage: the milestone's NAME ("Bid"). `milestone.name` ends
        // in the `.name` TLD, so it is registered `kind: reference`
        // (`ref-capsule-milestone-name-path`). Capsule's own "Won" and "Lost"
        // milestones land as OPEN — see the header.
        stage: "milestone.name",
        // Money is a JSON number in MAJOR units with a per-row currency
        // (`value: { amount: 500, currency: "GBP" }`) — no transform. `value` is
        // null on an unpriced opportunity, so both columns are absent together.
        amount: "value.amount",
        currency: "value.currency",
        updated_at: "updatedAt",
      },
    },
    {
      dataset: "task",
      path: "/api/v2/tasks",
      // 🔴 `status` is load-bearing: the DEFAULT is open tasks only. See the header.
      // These are optional embedded resources; ask for both fields mapped below
      // rather than relying on account- or API-default expansion behavior.
      query: { perPage: CAPSULE_PAGE_SIZE, status: "open,completed,pending", embed: "kase,owner" },
      // Declared, never inferred: `GET /tasks` has no modification filter, so
      // every tick is a declared full scan.
      watermark: null,
      pagination: LINK_PAGING,
      rowsPath: "tasks",
      fieldMap: {
        task_id: "id",
        // LOSSY: `kase.id` exists only when the task hangs off a Capsule project.
        // `kase.id` ends in the `.id` TLD, so it is registered `kind: reference`
        // (`ref-capsule-kase-id-path`).
        project_id: "kase.id",
        created_at: "createdAt",
        closed_at: "completedAt",
        // The task's text — Capsule's `description`.
        title: "description",
        // `OPEN` | `COMPLETED` | `PENDING`, verbatim and UPPER-CASE; see the header.
        status: "status",
        // `priority`: ABSENT — Capsule's task has no such field.
        //
        // The task's owner. `owner.id` ends in the `.id` TLD, so it is registered
        // `kind: reference` (`ref-capsule-owner-id-path`).
        assignee_id: "owner.id",
        updated_at: "updatedAt",
      },
    },
  ],
};
