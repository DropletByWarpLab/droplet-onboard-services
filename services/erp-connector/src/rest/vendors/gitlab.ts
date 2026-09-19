/**
 * WARP-2917 / ADR-046 — GitLab (gitlab.com hosted) issues, as a declarative
 * REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The account owner mints a Personal Access Token entirely inside their own
 * GitLab profile — avatar (upper right) → *Edit profile* → *Access* →
 * *Personal access tokens* → *Generate token*. Warp Lab registers nothing,
 * reviews nothing and holds nothing; the token lives only in the box's sealed
 * credential field. Personal access tokens and the REST API are on every tier,
 * Free included. (Project access tokens would be the alternative, but on
 * gitlab.com they are Premium/Ultimate-only, so the PAT is the free-tier path.)
 *
 * *Generate token* is now a DROPDOWN with two kinds, and the help text names
 * both because scopes exist on only one of them:
 *
 * * **Legacy token** — scoped; the owner picks `read_api` (read-only API).
 *   `read_user` alone covers only `/user` and `/users`, not `/issues`.
 * * **Fine-grained token** — no scopes; the owner grants the User-boundary
 *   permissions *Work Item: Read* (covers `GET /issues`) and *User: Read*
 *   (covers `GET /user`). A gitlab.com top-level-group Owner can ENFORCE
 *   fine-grained tokens after a date, after which legacy tokens are refused for
 *   that group's resources — so help naming only the legacy path would send
 *   some owners to a token that stops working.
 *
 * Expiry is REQUIRED on a PAT (default and default-maximum 365 days), so every
 * GitLab connection has an end date the owner chose. `health()` will start
 * answering 401 on that day, and the card must say "paste a new token".
 *
 * 🔴 **Do NOT validate the token's shape.** The build spec proposed
 * `^glpat-[A-Za-z0-9_-]+$` and the refutation found it rejects EVERY token
 * gitlab.com mints today: PATs are now ROUTABLE —
 * `glpat-<base64url 27..300>.<2 chars>.<9 chars>` — with two dots that class
 * does not admit, and a required field whose value fails its `pattern` is
 * treated as absent and rejects the whole config. The token's shape has
 * already changed once within one product generation, and the `glpat-` prefix
 * is admin-configurable on self-managed. The only thing that proves a token is
 * GitLab answering `GET /api/v4/user` with it, which `connect()` does.
 * Emptiness is the only thing refused; the prefix lives in the help text.
 *
 * ## gitlab.com only, deliberately
 *
 * Self-managed GitLab runs the same API on any hostname the customer chooses.
 * That is a SEPARATE provider question: an arbitrary customer hostname cannot
 * satisfy the dynamic arm (`assertValidRestProfile` requires at least one
 * allowed host or suffix), and a `kind: dynamic` egress entry contributes zero
 * hosts to the static scanner. It is not folded into this profile as a variable
 * host.
 *
 * ## The one dataset, and the ones GitLab could serve and does not
 *
 * * **`task` ← `GET /api/v4/issues`** — shipped. Every issue the token's user
 *   can see, across every project and group they belong to — INCLUDING
 *   confidential issues where they have access. The owner should mint the
 *   token on an account whose visibility matches what the business wants on
 *   the box.
 * * **`ticket`** — not served. A GitLab issue is a work item with a
 *   `project_id` and an assignee, which is what `task` means; `ticket` is a
 *   customer-support conversation with a `contact_id`, and GitLab's Service
 *   Desk issues have no contact identifier on the row — only an
 *   `external_author` e-mail, which is a contact detail, not an id.
 * * **`employee`** — not served. `GET /users` is admin-only on gitlab.com for
 *   anything beyond the public profile, and a group's member list is a
 *   per-group fan-out this track cannot express (one endpoint per dataset).
 * * **`engagement`** — not served. `GET /events` is documented, but its
 *   `after` filter takes a DATE, not an instant, and a CREATION-time one at
 *   that (events are immutable, so "complete" is moot). A candidate for a
 *   later ticket with `format: "date"`; not this one.
 * * **Merge requests, pipelines, projects, groups, epics** — no canonical
 *   dataset carries them. `epic` and issue `weight`/`health_status` are
 *   Premium/Ultimate-only besides, and this profile stays complete on Free.
 *
 * ## 🔴 The two hazards a "tidier" profile would introduce
 *
 * 1. **`scope=all` is not optional.** `GET /issues` defaults to
 *    `created_by_me`. Without the constant, the read returns only issues the
 *    token's owner personally AUTHORED — pages cleanly, terminates cleanly, and
 *    the sync reports COMPLETE over a fraction of the team's tracker.
 * 2. **No `order_by=updated_at&sort=asc` "for stability".** With OFFSET
 *    pagination, an edit mid-walk moves that row to the END of an ascending
 *    `updated_at` ordering and shifts the next page's first row back into a
 *    page already fetched — a MISSED row. The default ordering (`created_at`
 *    desc) is edit-stable; a new issue only causes a harmless duplicate on a
 *    page boundary, which dedup absorbs.
 *
 * And one non-hazard, recorded so it is not re-derived: the self-managed
 * "max offset for offset-based pagination" limit (50,000) applies ONLY to
 * endpoints that also support keyset pagination, and keyset is documented for
 * `GET /projects/:id/issues` (18.3+), not for the global `GET /issues` used
 * here. `REST_MAX_PAGES` (500 pages × 100 rows) is therefore the only ceiling
 * on a first full scan, and it is REPORTED when hit, never silently applied.
 */
import type { RestVendorProfile } from "../profile.js";

export const GITLAB_PROVIDER = "gitlab";

/**
 * gitlab.com's origin. One static host — the API is under `/api/v4` on the
 * same host as the product — so this is a plain `kind: egress` allowlist entry
 * the static scanner reads directly from this literal.
 */
export const GITLAB_API_ORIGIN = "https://gitlab.com";

/**
 * 5,000 requests per hour — the ANNOUNCED plan-aware sustained limit for the
 * Free tier on gitlab.com — → one request per 720 ms.
 *
 * Today's in-effect ceiling is 2,000 authenticated requests per minute per
 * user (30 ms), and the announced limits also give Free a 100-per-minute BURST
 * figure (600 ms). GitLab's rate-limit page says the hourly sustained limit
 * takes precedence and describes the per-minute one as "a ceiling on short
 * spikes rather than a rate you can maintain" — so 5,000/h is the number to
 * derive from, and pacing against the announced Free floor now means this
 * profile does not need re-deriving when those limits land. A first full scan
 * of at most `REST_MAX_PAGES` (500) requests is six minutes at this pace.
 *
 * A 429 carries `Retry-After` (seconds) and `RateLimit-*` headers; the shared
 * connector reacts to those where they arrive.
 */
export const GITLAB_MIN_REQUEST_INTERVAL_MS = 720;

export const GITLAB_PROFILE: RestVendorProfile = {
  provider: GITLAB_PROVIDER,
  baseUrl: { kind: "static", origin: GITLAB_API_ORIGIN },
  // The bare token in GitLab's own `PRIVATE-TOKEN` header — no scheme. The
  // docs also accept `Authorization: Bearer` and a `private_token` QUERY
  // parameter; the profile uses the header and ONLY the header. The query form
  // puts the credential in the URL, where it lands in the customer's proxy logs
  // and in ours.
  auth: { headerName: "PRIVATE-TOKEN", valueTemplate: "{{token}}" },
  // GitLab versions in the PATH (`/api/v4`) and documents no version header.
  // Empty is the honest declaration; `gitlab-profile.test.ts` pins it so a
  // "for symmetry" copy of another vendor's header cannot land here.
  constantHeaders: {},
  // `GET /api/v4/user` returns the token's own user and nothing else — no
  // pagination, one row, and a 401 on it is unambiguous evidence about the
  // token (revoked, or past its required expiry).
  probePath: "/api/v4/user",
  minRequestIntervalMs: GITLAB_MIN_REQUEST_INTERVAL_MS,
  datasets: [
    {
      dataset: "task",
      path: "/api/v4/issues",
      query: {
        // 🔴 Defaults to `created_by_me`. See the header: without this the
        // sync is complete over the wrong set.
        scope: "all",
        // The docs do not state the default, so it is pinned, not assumed.
        // Closed issues are part of the answer to "what happened this week".
        state: "all",
        // The documented maximum; the API default is 20.
        per_page: "100",
      },
      watermark: {
        // "Return issues updated on or after the given time. Expected in ISO
        // 8601 format." The `iso` formatter emits `toISOString()` — a
        // Z-suffixed instant, so the docs' caveat about `+` offsets needing
        // `%2B` never bites.
        name: "updated_after",
        location: "query",
        format: "iso",
        // A genuine last-modified filter: `updated_at` is the row's own
        // modification stamp and moves on any edit — a state change, a
        // reassignment, a title edit — so an incremental pass sees them all.
        complete: true,
      },
      // RFC-5988 `Link` with `rel="next"`, returned on every page but the
      // last. Past 10,000 matching rows GitLab drops `x-total`,
      // `x-total-pages` and the `rel="last"` link; `rel="next"` stays, and
      // nothing here reads the totals. Keyset (`pagination=keyset`) is
      // documented only for `GET /projects/:id/issues`, not for this global
      // endpoint, so offset + Link is the mode.
      pagination: { kind: "link-header" },
      // The body IS the array.
      rowsPath: "",
      fieldMap: {
        // `id`, NOT `iid`. `iid` is the per-project number a person sees in
        // the URL and it is unique only WITHIN a project; this endpoint spans
        // every project the token can see, so `iid` would collide the moment a
        // second project appears and dedup would merge unrelated work items.
        task_id: "id",
        project_id: "project_id",
        created_at: "created_at",
        // `null` on an open issue → projected `undefined`, never a fake date.
        closed_at: "closed_at",
        title: "title",
        // The lifecycle field (`opened` / `closed`), passed through as GitLab
        // spells it. NOT `issue_type` (a kind) and NOT `severity`
        // (incident-only; `UNKNOWN` on a plain issue).
        status: "state",
        // 🔴 `priority` is deliberately ABSENT. GitLab issues carry no
        // priority field: `severity` is incident-only, `weight` is
        // Premium/Ultimate-only and is effort not priority, and a
        // `priority::high` label is a per-project convention with no row
        // field. `projectCanonicalRow` writes it `undefined`, and the test
        // pins it that way.
        //
        // LOSSY and knowingly so: Premium/Ultimate allow MULTIPLE assignees
        // and this column holds one. The first in GitLab's own ordering is
        // kept. `assignees[0]` rather than the singular `assignee` because
        // GitLab documents the latter as deprecated ("GitLab returns it as a
        // single-sized array assignees"). Bracket syntax, never `assignees.0.id`
        // — `.id` is a real TLD and the egress scanner would read it as a host.
        assignee_id: "assignees[0].id",
        // The watermark's own value, landing in its column: `task` carries
        // `updated_at` precisely so a complete last-modified filter has
        // somewhere to go.
        updated_at: "updated_at",
      },
    },
  ],
};
