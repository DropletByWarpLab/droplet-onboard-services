/**
 * WARP-2916 / ADR-046 — GitHub issues (and pull requests), as a declarative
 * REST profile.
 *
 * ## Custody: a clean ADR-042 model 3
 *
 * The account owner mints the credential entirely inside their own GitHub
 * settings — profile photo → *Settings* → *Developer settings* → *Personal
 * access tokens* → *Fine-grained tokens* → *Generate new token*. They pick the
 * resource owner (their user or an org), which repositories the token may see,
 * and grant *Issues: Read-only* (plus *Pull requests: Read-only* if PRs should
 * appear). Warp Lab registers nothing, reviews nothing and holds nothing. It
 * works on GitHub Free; there is no plan gate on fine-grained tokens or on the
 * REST API.
 *
 * Unlike Cal.com and Square, GitHub DOCUMENTS its token formats, so the
 * descriptor pins a `^github_pat_` pattern. That refuses the classic `ghp_`
 * shape on purpose: a classic token's `repo` scope is read AND write over
 * every repository the user can reach, with no read-only option, while a
 * fine-grained token is the only shape that can be minted `Issues: Read-only`
 * over a chosen set of repositories. It is the Stripe `sk_` reasoning, not the
 * Cal.com "don't guess a prefix" one.
 *
 * Octokit.js, the official SDK, is MIT — and not imported. REST only.
 *
 * ## Hosted only, deliberately
 *
 * `api.github.com` is ONE static host. GitHub Enterprise Server (a customer's
 * own hostname) and GHEC with data residency (`api.<sub>.ghe.com`) are other
 * hosts and are NOT served by this profile — they would be a `kind: dynamic`
 * profile with their own exact-host guard, not a widening of this one.
 *
 * ## 🔴 Pull requests land as tasks, and this profile cannot stop it
 *
 * GitHub's own endpoint note: *"GitHub's REST API considers every pull request
 * an issue"*, so `GET /issues` returns both. A PR is told apart only by the
 * presence of a `pull_request` key on the row. The declarative track has no
 * per-row filter, so every PR the token can see is a `task` row on this box.
 * The endpoint page lists a boolean `pulls` query parameter with NO description
 * — it is deliberately not sent, because GitHub silently ignores parameters
 * it does not recognise, and a filter the vendor does not document is a filter
 * this profile cannot claim. The ticket's own title — "issues (and PRs)" — is
 * the honest reading.
 *
 * A PR's `id` on `/issues` is the ISSUE id, not the pull-request id (endpoint
 * note, verbatim): `task_id` is consistent within this dataset but does not
 * join to `/pulls` ids.
 *
 * ## 🔴 The endpoint's defaults are wrong for a sync
 *
 * Without the constant query below, `GET /issues` answers with
 * `filter=assigned` (only issues assigned to the token's user), `state=open`
 * (closed work vanishes the moment it closes) and 30 rows a page. All three
 * are overridden — `filter=all`, `state=all`, `per_page=100` — and every one
 * is documented on the endpoint page. `sort=updated&direction=asc` keeps the
 * walk stable while pages are being fetched.
 *
 * ## What this profile could serve and does not
 *
 * GitHub's REST API reaches only ONE of the twenty-six canonical datasets
 * honestly, and that is the one shipped:
 *
 * * **`task`** ← `GET /issues` — shipped. One endpoint, a documented
 *   last-modified `since`, RFC-5988 `Link` pagination, a bare-array body.
 * * **`ticket`** — NOT served. An issue is a work item, not a customer-support
 *   conversation: `CANONICAL_COLUMNS.ticket` wants a `contact_id`, which an
 *   issue does not have. `task` and `ticket` are deliberately different
 *   datasets (see `export-drop/profiles.ts`), and one vendor row should not
 *   be projected onto both.
 * * **A repository or a pull-request dataset** — neither exists in the
 *   vocabulary. A vendor dataset with no canonical home is a vocabulary
 *   decision (ADR-046 §2), never a `string` widening here. Note also ADR-046's
 *   verified finding that `since` is ABSENT on `/pulls` and on
 *   `/orgs/{org}/repos`, so neither would have an incremental watermark even
 *   if a name existed.
 *
 * ## Scoping is on the OWNER's side, and the probe cannot see it
 *
 * Results are whatever repositories the token was minted for (plus read-only
 * access to public repositories, which every fine-grained token carries). Two
 * states read GREEN on the probe and then return fewer rows than the owner
 * expects: a token minted with NO Issues permission (`GET /issues` itself
 * "does not require any permissions"), and an org-owned token still PENDING
 * org approval (it "will only be able to read public resources until it is
 * approved"). The setup guide names both; nothing in the profile can.
 */
import type { RestVendorProfile } from "../profile.js";

export const GITHUB_PROVIDER = "github";

/**
 * GitHub's public REST API origin. One static host — a plain `kind: egress`
 * allowlist entry the static scanner reads directly from this literal.
 */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/**
 * 🔴 The API version every value in this profile was verified against.
 *
 * GitHub versions its REST API by date, sent as `X-GitHub-Api-Version`. A
 * request WITHOUT it is served the default version — whatever GitHub says
 * that is on the day — so an unpinned profile's row shape could change
 * underneath it. `2022-11-28` is supported until 2028-03-10 (then 410 Gone).
 *
 * The next version, `2026-03-10`, REMOVES the singular `assignee` field from
 * Issue and Pull Request responses. The field map below reads `assignees[0].id`
 * so it is correct under BOTH versions, and bumping this one constant is the
 * whole migration when the day comes — after re-verifying every other value
 * against that version's page, not before.
 */
export const GITHUB_API_VERSION = "2022-11-28";

/**
 * 🔴 GitHub REJECTS a request with no User-Agent (documented: "All API
 * requests must include a valid User-Agent header"; verified live as a 403
 * text/html). The shared connector never sets one, so without this constant
 * header the profile works ONLY because undici happens to send
 * `User-Agent: node` — a runtime default this profile should not lean on.
 * GitHub asks for the application's name so it can contact the operator.
 */
export const GITHUB_USER_AGENT = "droplet-erp-connector";

/**
 * 5,000 requests per hour per user for PAT-authenticated requests, verbatim
 * from GitHub's rate-limit page → one request per 720 ms.
 *
 * A published ceiling, so this profile paces against it. The budget belongs
 * to the USER, not to this connector: every other tool authenticating as the
 * same GitHub user shares it. Pacing at the floor is what keeps this
 * connector from being the one that exhausts it. GitHub Enterprise Cloud
 * users get 15,000, and the floor is what an owner on Free gets, so the floor
 * is what the box assumes.
 *
 * Exhaustion arrives as a 403 OR a 429, with `retry-after` (secondary limits)
 * or `x-ratelimit-remaining: 0` (primary). The shared connector classifies a
 * 403 carrying either header as a vendor error, NOT as a rejected credential
 * — GitHub is the verified failure that admitted that connector change
 * (`rest/connector.ts`, `rest-track.test.ts`).
 */
export const GITHUB_MIN_REQUEST_INTERVAL_MS = 720;

export const GITHUB_PROFILE: RestVendorProfile = {
  provider: GITHUB_PROVIDER,
  baseUrl: { kind: "static", origin: GITHUB_API_ORIGIN },
  // GitHub documents BOTH `Authorization: Bearer <token>` and
  // `Authorization: token <token>` for a PAT. Bearer is the RFC-6750 one and
  // the one every other Bearer vendor on this track uses.
  auth: { headerName: "Authorization", valueTemplate: "Bearer {{token}}" },
  // 🔴 NO `Accept` here, on purpose. GitHub recommends
  // `application/vnd.github+json`, but the shared connector sets
  // `accept: application/json` itself AFTER spreading these, and Node's
  // `Headers` merges the two case-variant keys into one combined value — so
  // an Accept declared here cannot pin GitHub's media type, it can only claim
  // to. GitHub answers 200 `application/json` to the connector's own value
  // (verified live), so nothing is lost and nothing is falsely claimed.
  constantHeaders: {
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
  },
  // `GET /user` "works with fine-grained personal access tokens" and "does
  // not require any permissions" — one object, no pagination, and a 401 on it
  // is unambiguous evidence about the token. ⚠ "No permissions" cuts both
  // ways: see the header comment on owner-side scoping.
  probePath: "/user",
  minRequestIntervalMs: GITHUB_MIN_REQUEST_INTERVAL_MS,
  datasets: [
    {
      dataset: "task",
      path: "/issues",
      // See "The endpoint's defaults are wrong for a sync" above. Every value
      // is a documented enum on the endpoint page. `pulls` is NOT here: it is
      // listed with no description, and GitHub silently ignores what it does
      // not recognise.
      query: {
        filter: "all",
        state: "all",
        sort: "updated",
        direction: "asc",
        per_page: "100",
      },
      watermark: {
        // Endpoint page: "Only show results that were last updated after the
        // given time. This is a timestamp in ISO 8601 format:
        // YYYY-MM-DDTHH:MM:SSZ." A genuine last-modified filter, so a close,
        // a reassignment or a retitle comes back on the next pass.
        //
        // Verified live 2026-09-18 (not stated on the page): `since` is
        // INCLUSIVE (>=), the `.000Z` millisecond form the `iso` format emits
        // is accepted and filters, and a malformed value is a 422 — not a
        // silently ignored full scan. The same-second-skip hazard a strict
        // "after" would carry does not apply.
        //
        // 🔴 GitHub SILENTLY IGNORES unknown query parameters, so a misspelling
        // of this one name would not fail — it would full-scan every issue the
        // token can see, on every tick, and report an incremental read.
        // Pinned by `github-profile.test.ts`.
        name: "since",
        location: "query",
        format: "iso",
        complete: true,
      },
      // RFC-5988 `Link: <url>; rel="next"`. The URL is taken VERBATIM from
      // the header and re-guarded against this connection's exact host by the
      // shared connector — a `Link` header is vendor-controlled input, and a
      // cross-host next page is the obvious credential exfiltration. The last
      // page carries no rel="next"; `per_page` max is 100.
      pagination: { kind: "link-header" },
      // The body IS the array — no envelope. (`/search/issues` wraps rows in
      // `items`; this endpoint does not.) `absentRowsMeansEmpty` stays UNSET
      // so a wrong path is a contract error, never "no issues this week".
      rowsPath: "",
      fieldMap: {
        // `id` is the issue's GLOBAL id. `number` is per-repository and
        // collides across the repositories one token can see, so it is not
        // an identifier for this dataset. On a PR row this is the ISSUE id.
        task_id: "id",
        // The repository's numeric id — the only stable project key on the
        // row. `repository` is present on every row of the endpoint's
        // documented 200 example (the shared Issue schema marks it optional,
        // which is why the projection leaves it undefined rather than
        // failing if a row ever omits it).
        project_id: "repository.id",
        created_at: "created_at",
        // `null` on an open issue — absent, never the epoch.
        closed_at: "closed_at",
        title: "title",
        // `open` | `closed`, verbatim. That is what `get_tasks_by_status`'s
        // `status` parameter compares against.
        status: "state",
        // 🔴 `priority` is deliberately ABSENT. The Issue object has no
        // priority property; labels are free text and the track has no
        // label→priority transform. A guessed ranking in a column the model
        // reads as fact is worse than an empty one.
        //
        // `assignees[0].id`, NOT the singular `assignee.id`: the 2026-03-10
        // API version removes `assignee` and keeps `assignees`, so the array
        // is right under both. LOSSY and knowingly so — an issue can have
        // several assignees and the column holds one; the first is GitHub's
        // own ordering. `[0]` bracket syntax, never `assignees.0.id`, which
        // the egress scanner reads as a hostname under the `.id` TLD.
        assignee_id: "assignees[0].id",
        // The watermark's own value, landing in the column that lets a
        // scheduled poll see edits.
        updated_at: "updated_at",
      },
    },
  ],
};
