/**
 * WARP-2918 / ADR-046 — Todoist, as a declarative REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The account owner copies a PERSONAL API token entirely inside their own
 * Todoist client — avatar → *Settings* → *Integrations* tab → *Developer* tab →
 * *Copy API token*. Warp Lab registers nothing, reviews nothing and holds
 * nothing. It works on every plan; neither the help article nor the API
 * reference gates API access on a tier. Todoist also offers OAuth through an
 * App Management Console (client id and secret) — that would be model 2 and
 * is NOT used.
 *
 * Two custody facts the guide states and this file records so they are not
 * re-derived:
 *
 * * The token grants access to the WHOLE account. Personal tokens carry no
 *   scope narrowing; the box narrows itself, to one GET endpoint.
 * * Rotating it is `Issue a new API token`, and Todoist's own help article
 *   says that is also how you *"log out of Todoist on all your devices"* —
 *   so rotating the box's credential signs the owner out of every Todoist
 *   client they use.
 *
 * 🔴 **Do NOT validate the token's shape.** Todoist documents no token
 * format. The only token it shows is the forty-hex-character EXAMPLE in the
 * Authorization section, and an example is not a contract — the Brevo /
 * Square / Cal.com reasoning applies unchanged: a regex anchored on an
 * undocumented shape is a false rejection that blocks a paying owner for zero
 * security gain. Emptiness is the only thing refused; the probe is what proves
 * a token.
 *
 * ## One dataset, and a DECLARED full scan
 *
 * `GET /api/v1/tasks` on the unified v1 API accepts exactly `project_id`,
 * `section_id`, `parent_id`, `label`, `ids`, `cursor` and `limit` — verified
 * from the OpenAPI document embedded in the reference page. There is NO
 * last-modified filter of any spelling, so the dataset carries
 * `watermark: null`: the shape `profile.ts` prescribes for "this endpoint has
 * no watermark", swept as a full scan, honestly. A guessed `updated_since`
 * would either 400 or be ignored, and an ignored parameter is the GitHub
 * failure ADR-046 names — a full scan reported as an incremental read,
 * forever.
 *
 * The incremental read Todoist DOES offer is the Sync API (`POST /api/v1/sync`
 * with a `sync_token` form body). The GET-only, literal-query track cannot
 * express it. That is a possible future widening, recorded here so nobody
 * reads `null` as "nobody looked".
 *
 * ## 🔴 Active tasks ONLY — and what that does to two columns
 *
 * The endpoint's own description is *"Get all active tasks for the user."*
 * Consequences, each pinned by `todoist-profile.test.ts`:
 *
 * * **`status`** maps to the boolean `checked`, which is `false` on every row
 *   this endpoint can ever return. The canonical text coercion writes that as
 *   the string `"false"`, and `read-semantics.ts` compares `status` as text —
 *   so `get_tasks_by_status` with the documented example `{ status: "open" }`
 *   matches ZERO Todoist rows. Todoist has no status string; `checked` IS its
 *   vendor-supplied state, passed through verbatim. A value mapping
 *   (`checked=false` → `"open"`) is a profile widening ADR-046 §2 admits only
 *   against a verified failure, so it is flagged for review rather than
 *   smuggled in.
 * * **`closed_at`** maps to `completed_at`, which is `null` on every active
 *   task, so it lands `undefined`. A task the owner completes between two
 *   scans does not arrive with `closed_at` set — it VANISHES from the feed.
 *   Completed tasks live on `/api/v1/tasks/completed/by_completion_date`,
 *   whose `since` AND `until` are both REQUIRED (a rolling three-month range,
 *   rows at `items` not `results`), and `until` must be a moving "now" that a
 *   constant-query track cannot express; nor can a profile declare `task`
 *   twice. Completed tasks are therefore OUT of this profile, and the catalog
 *   card says so.
 *
 * ## Datasets Todoist could serve and does not
 *
 * * **`project`** is not a canonical dataset name, and Todoist's projects are
 *   containers rather than work items — nothing in the vocabulary is that
 *   shape. A vocabulary question, not a mapping one.
 * * **Comments, labels, sections** — no canonical home, and none is a row a
 *   question on the box would ask for on its own.
 * * **`engagement`** — a Todoist comment is not a CRM timeline activity; it
 *   has no contact to attach to.
 *
 * ## Other facts the profile relies on
 *
 * * IDs are opaque strings (`6XGgmFVcrG5RRjVr`) — never coerced to numbers.
 * * `priority` is an integer 1 (normal) to 4 (urgent), INVERTED from most
 *   trackers. Passed through verbatim; a remap would silently make every
 *   urgent task read as the least important.
 * * `added_at` and `updated_at` are nullable ("or null if unknown"); the
 *   projection tolerates that by landing `undefined`, never the epoch.
 * * Endpoints are case-sensitive lowercase since v1 (mixed case is a 404),
 *   and the retired `/rest/v2/` and `/sync/v9/` prefixes now 301 to
 *   `/api/v1/` — a redirect the shared connector REFUSES rather than follows.
 * * Todoist warns that data changing mid-pagination "can cause items to
 *   appear twice or be skipped". The track has no per-scan dedupe; the sync
 *   service reconciles on `task_id`, and an on-demand read may carry a
 *   duplicate across a page boundary. Recorded, not hidden.
 * * The probe's response body includes the user's own `token`. The shared
 *   connector never logs or persists a probe body; keep it that way.
 */
import type { RestVendorProfile } from "../profile.js";

export const TODOIST_PROVIDER = "todoist";

/**
 * Todoist's ONE API origin — `servers[0].url` in the embedded OpenAPI
 * document. No region, no per-account subdomain, no self-hosted edition. A
 * plain `kind: egress` allowlist entry the static scanner reads directly from
 * this literal.
 */
export const TODOIST_API_ORIGIN = "https://api.todoist.com";

/**
 * The page size, as a CONSTANT query parameter rather than a pagination field.
 *
 * The `cursor` arm of `RestPagination` carries exactly `nextCursorPath` and
 * `cursorParam` — the page size has no slot there, and the shared connector
 * re-uses the current URL when it appends the cursor, so `limit` set once on
 * the first page rides on every page after it. That is also what Todoist's
 * Pagination guide requires: the cursor *"must be used with the same
 * parameters from the previous request"*.
 *
 * `200` is the documented maximum (*"Default: 50, Maximum: 200. If you specify
 * a limit greater than 200, the API will return a validation error."*). The
 * maximum, because a full scan with no watermark is paid in pages.
 */
export const TODOIST_PAGE_SIZE = "200";

export const TODOIST_PROFILE: RestVendorProfile = {
  provider: TODOIST_PROVIDER,
  baseUrl: { kind: "static", origin: TODOIST_API_ORIGIN },
  // A genuine RFC-6750 Bearer scheme: the Authorization section's own example
  // is `Authorization: Bearer $token`, with the personal token from Settings →
  // Integrations → Developer.
  auth: { headerName: "Authorization", valueTemplate: "Bearer {{token}}" },
  // Nothing. v1 is versioned in the PATH, and the reference documents no
  // mandatory header beyond `Authorization`. An invented version header would
  // be a contract Todoist never stated.
  constantHeaders: {},
  // `GET /api/v1/user` returns the token's own user and nothing else — no
  // pagination, one row — so a 401 on it is unambiguous evidence about the
  // TOKEN. Todoist's guidance on a 401 is "do not wait and retry the same
  // invalid or expired token": that is a revoked credential, not a rate limit.
  //
  // ⚠ UNVERIFIED against a live personal token: the endpoint's description
  // reads as the OIDC userinfo endpoint and speaks of OAuth audiences. If a
  // good personal token gets 401/403 here, the fallback is
  // `/api/v1/projects?limit=1` — at the cost of a paginated collection as the
  // probe. Recorded in the ticket's open questions.
  probePath: "/api/v1/user",
  // NO `minRequestIntervalMs`. The Request-limits section publishes ceilings
  // ONLY for the Sync endpoint (1000 partial / 100 full sync requests per user
  // per 15 minutes) and nothing for `GET /api/v1/tasks`; the old REST v2
  // figure is unreachable, that page now redirects to v1. Like Square, the
  // connector reacts to a 429 (and Todoist's `retry_after`, which it says may
  // arrive on other errors too) rather than pacing against a guess.
  datasets: [
    {
      dataset: "task",
      path: "/api/v1/tasks",
      query: { limit: TODOIST_PAGE_SIZE },
      // Declared, never inferred. See the header: the verified parameter list
      // has no last-modified filter under any spelling.
      watermark: null,
      // Pagination guide: `results` is the array, `next_cursor` is "a string
      // token for fetching the next page, or null if there are no more
      // results", and it is echoed back as the `cursor` query parameter. The
      // 200 schema makes both REQUIRED, so `null` is the terminator and an
      // absent `results` is a contract error, not an empty page.
      pagination: { kind: "cursor", nextCursorPath: "next_cursor", cursorParam: "cursor" },
      rowsPath: "results",
      fieldMap: {
        // Opaque string ids since v1 — `6XGgmFVcrG5RRjVr` — never numeric.
        task_id: "id",
        project_id: "project_id",
        created_at: "added_at",
        // `null` on every row this endpoint returns; see the header.
        closed_at: "completed_at",
        title: "content",
        // The boolean `checked`, verbatim — `"false"` on every active task.
        // See the header for why this is not remapped here.
        status: "checked",
        // 1 (normal) … 4 (urgent). Inverted from most trackers; NOT remapped.
        priority: "priority",
        // The assignee. NOT `added_by_uid` (the creator) and NOT
        // `assigned_by_uid` (who did the assigning); `null` when nobody is
        // responsible, which lands as undefined.
        assignee_id: "responsible_uid",
        // A real last-modified instant on every row — the value a future Sync
        // API widening would key on. Nullable in the schema.
        updated_at: "updated_at",
      },
    },
  ],
};
