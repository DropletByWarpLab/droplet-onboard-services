/**
 * WARP-2917 / ADR-046 — GitLab's VENDOR FACTS, pinned against GitLab's own
 * documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page, exactly as
 * `graph-resources.test.ts` does for Microsoft Graph."* This is that file for
 * GitLab. `rest-track.test.ts` proves the connector does what a profile SAYS —
 * which is exactly the question that stays green when the profile says the wrong
 * thing — and `introspect()`'s fingerprint hashes the datasets and their
 * canonical columns, not the paths, headers or parameter spellings. Only this
 * file can catch those.
 *
 * GitLab's version of the silent failure is a DEFAULT, not an ignored parameter.
 * `GET /api/v4/issues` documents `scope` as *"Defaults to created_by_me"* — so a
 * profile that forgot the constant `scope=all` would read only the issues the
 * token's owner personally authored, page cleanly, and report a COMPLETE
 * incremental sync over a fraction of the team's work.
 *
 * ## The sources every claim below was checked against (2026-09-18)
 *
 *  • List all issues     https://docs.gitlab.com/api/issues/#list-all-issues
 *  • Retrieve the current user
 *                        https://docs.gitlab.com/api/users/#retrieve-the-current-user
 *  • REST API authentication (PRIVATE-TOKEN header)
 *                        https://docs.gitlab.com/api/rest/authentication/
 *  • Pagination (offset + Link header; keyset scope)
 *                        https://docs.gitlab.com/api/rest/#pagination
 *                        https://docs.gitlab.com/api/rest/#keyset-based-pagination
 *  • Personal access tokens (custody, required expiry, 365-day default)
 *                        https://docs.gitlab.com/user/profile/personal_access_tokens/
 *  • Token prefixes (`glpat-` — the PAT page only says "all access tokens
 *    inherit the default prefix setting"; the prefix itself is in this
 *    page's table: "Personal access token | `glpat-`")
 *                        https://docs.gitlab.com/security/tokens/
 *  • Token scopes (`read_api`)
 *                        https://docs.gitlab.com/security/tokens/access_token_scopes/
 *  • Fine-grained tokens (the second token kind the help text names; this
 *    page names only the boundaries, not the permissions)
 *                        https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens/
 *  • Fine-grained permissions for the REST API (the permission NAMES the help
 *    text pins: "Work Item | Read | User | GET /issues" and
 *    "User | Read | User | GET /user")
 *                        https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/
 *  • gitlab.com rate limits (5,000/h sustained on Free)
 *                        https://docs.gitlab.com/user/gitlab_com/rate_limits/
 *  • Max offset (applies ONLY to keyset-capable endpoints — not global /issues)
 *                        https://docs.gitlab.com/administration/instance_limits/#max-offset-allowed-by-the-rest-api-for-offset-based-pagination
 *
 * ## The rule every test here obeys
 *
 * 🔴 **Facts are asserted from the OUTGOING REQUEST, not from the profile
 * object.** These tests run the REAL profile through a REAL
 * `RestProfileConnector` with an injected fetch, so a connector that drops the
 * scope parameter, forgets the watermark or pages on the wrong thing goes red
 * here even though the profile is untouched.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import { providerDescriptor } from "@droplet/shared-types";

import {
  RestPaginationContractError,
  RestProfileConnector,
  UnsafeBaseUrlError,
} from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { authPlaceholders } from "../src/rest/profile.js";
import { restProfileFor } from "../src/rest/profiles.js";
import {
  GITLAB_API_ORIGIN,
  GITLAB_MIN_REQUEST_INTERVAL_MS,
  GITLAB_PROFILE,
  GITLAB_PROVIDER,
} from "../src/rest/vendors/gitlab.js";
import { CANONICAL_COLUMNS } from "../src/export-drop/profiles.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A recording fetch stub — the same shape `rest-track.test.ts` uses, and
 * duplicated rather than imported ON PURPOSE: importing it from that file would
 * execute that file's whole suite as a side effect of loading this one, and a
 * suite that runs another suite reports failures against the wrong file.
 */
function stubFetch(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const page = pages[Math.min(n, pages.length - 1)]!;
    n += 1;
    const status = page.status ?? 200;
    const headers = page.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } as unknown as Headers,
      json: async () => page.body,
      text: async () => JSON.stringify(page.body),
    } as unknown as Response;
  };
  return { impl: impl as never, calls };
}

/**
 * A token's stand-in, deliberately in NEITHER documented shape — not the
 * legacy 20-character `glpat-…` and not the routable dotted
 * `glpat-<27..300>.<2>.<9>` form. It works because nothing validates the shape,
 * which is the property the descriptor test below pins.
 */
const TOKEN = "test-personal-access-token";

/**
 * The REAL profile, through the REAL connector.
 *
 * The clock and `sleep` are injected because this profile paces at 720 ms
 * between requests: with the default `setTimeout` a two-page read would make the
 * suite actually pay GitLab's rate ceiling. The recorded sleeps are asserted in
 * the pacing test rather than discarded.
 */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const slept: number[] = [];
  let clock = 0;
  const connector = new RestProfileConnector(
    GITLAB_PROFILE,
    { provider: GITLAB_PROVIDER },
    {
      fetchImpl: impl,
      resolveCredentials: async () => ({ token: TOKEN }),
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    },
  );
  return { connector, calls, slept };
}

/** The watermark instant every read below passes, and what it must appear as. */
const SINCE = "2026-09-01T00:00:00Z";
const SINCE_ISO = "2026-09-01T00:00:00.000Z";

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;
const rowsOf = (rows: unknown[]) => rows as Record<string, unknown>[];

/** The `Link` header GitLab returns on every page but the last of an offset walk. */
const LINK_PAGE_2 =
  '<https://gitlab.com/api/v4/issues?scope=all&state=all&per_page=100&page=2>; rel="next", ' +
  '<https://gitlab.com/api/v4/issues?scope=all&state=all&per_page=100&page=1>; rel="first", ' +
  '<https://gitlab.com/api/v4/issues?scope=all&state=all&per_page=100&page=7>; rel="last"';

/** The last page's `Link`: `prev`/`first`/`last` only — no `next`. */
const LINK_LAST =
  '<https://gitlab.com/api/v4/issues?scope=all&state=all&per_page=100&page=1>; rel="prev", ' +
  '<https://gitlab.com/api/v4/issues?scope=all&state=all&per_page=100&page=1>; rel="first", ' +
  '<https://gitlab.com/api/v4/issues?scope=all&state=all&per_page=100&page=2>; rel="last"';

/**
 * One GitLab issue, shaped as the "List all issues" response documents it —
 * the docs' own sample row, with the fields this profile pins carried at the
 * documented values, plus every value a later pass would be tempted to put in
 * a column this profile leaves undefined.
 *
 * TWO assignees, because that is the Premium/Ultimate multi-assignee shape the
 * `assignee_id` projection is knowingly lossy about — and a DECOY singular
 * `assignee` whose id differs, so the test can tell `assignees[0].id` from
 * the deprecated `assignee.id`. (On a live row the two agree: GitLab documents
 * `assignee` as a mirror of `assignees[0]`. The decoy exists to make the path
 * distinguishable, not to describe a real response.)
 */
const ISSUE = {
  state: "opened",
  description: "Ratione dolores corrupti mollitia soluta quia.",
  project_id: 1,
  milestone: {
    id: 17,
    iid: 2,
    project_id: 1,
    title: "v4.0",
    state: "closed",
    due_date: null,
    created_at: "2016-01-04T15:31:39.996Z",
    updated_at: "2016-01-04T15:31:39.996Z",
  },
  assignees: [
    { id: 1, username: "root", name: "Administrator", state: "active", avatar_url: null, web_url: "https://gitlab.example.com/root" },
    { id: 2, username: "second", name: "Second Assignee", state: "active", avatar_url: null, web_url: "https://gitlab.example.com/second" },
  ],
  // DECOY — see the fixture comment.
  assignee: { id: 99, username: "decoy", name: "Decoy", state: "active", avatar_url: null, web_url: "https://gitlab.example.com/decoy" },
  type: "ISSUE",
  updated_at: "2016-01-04T15:31:51.081Z",
  closed_at: null,
  closed_by: null,
  id: 76,
  title: "Consequatur vero maxime deserunt laboriosam est voluptas dolorem.",
  created_at: "2016-01-04T15:31:51.081Z",
  moved_to_id: null,
  iid: 6,
  // `priority::high` is the scoped-label CONVENTION some projects use for
  // priority. It is a per-project label, not a row field, and it is here so
  // the `priority` pin can prove nothing reads it.
  labels: ["foo", "bar", "priority::high"],
  upvotes: 4,
  downvotes: 0,
  merge_requests_count: 0,
  user_notes_count: 1,
  due_date: "2016-07-22",
  web_url: "http://gitlab.example.com/my-group/my-project/issues/6",
  has_tasks: true,
  task_status: "10 of 15 tasks completed",
  confidential: false,
  discussion_locked: false,
  issue_type: "issue",
  severity: "UNKNOWN",
  weight: null,
};

// ── identity, custody and the descriptor ────────────────────────────────────

describe("GitLab — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('gitlab') returns, not a copy", () => {
    // Mutation: register a second GitLab profile in `profiles.ts` and this whole
    // file starts testing a file nothing ships.
    expect(restProfileFor(GITLAB_PROVIDER)).toBe(GITLAB_PROFILE);
  });

  it("🔴 dials gitlab.com only, and it is the host the descriptor registers for egress", () => {
    // GitLab ships two things under one name: the hosted service at gitlab.com
    // and a self-managed product a customer runs on any hostname they like.
    // Self-managed is OUT of this profile on purpose — an arbitrary customer
    // host cannot satisfy the dynamic arm's allowlist (`assertValidRestProfile`
    // requires at least one allowed host or suffix), and a `kind: dynamic`
    // egress entry contributes zero hosts to the static scanner. It is a
    // separate provider question, not a variable host on this one.
    // Mutation: turn this into a `kind: dynamic` base URL "so self-managed
    // works" -> the static egress scanner stops seeing any host for this
    // provider, and `assertSafeRestBaseUrl` becomes the only control over a
    // destination nothing in CI checks.
    expect(GITLAB_PROFILE.baseUrl).toEqual({ kind: "static", origin: GITLAB_API_ORIGIN });
    expect(GITLAB_API_ORIGIN).toBe("https://gitlab.com");
    expect(providerDescriptor(GITLAB_PROVIDER)!.egressHosts).toEqual(["gitlab.com"]);
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises", () => {
    // The descriptor is what the hub, the scheduler (`entityServedBy`) and the
    // dashboard read; the profile is what the connector reads. A drift between
    // them is the class of bug the descriptor exists to prevent — a hub tile
    // offering a dataset the connection will refuse the first time it is asked.
    // Compared as SETS: ordering carries no meaning in either place.
    const served = GITLAB_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(GITLAB_PROVIDER)!.datasets].sort());
    expect(served).toEqual(["task"]);
  });

  it("🔴 declares NO credential-field pattern — the token's shape has ALREADY changed once", () => {
    // The build spec proposed `^glpat-[A-Za-z0-9_-]+$`, and the refutation
    // found it rejects EVERY token gitlab.com mints today: personal access
    // tokens are now ROUTABLE, `glpat-<base64url 27..300>.<2 chars>.<9 chars>`,
    // with two DOTS the character class did not admit. A REQUIRED field whose
    // value fails its `pattern` is treated as absent and rejects the config, so
    // that one literal would have made the connection unreachable for every
    // real token — at the paste box, with a message about the token being
    // wrong when it was not.
    //
    // That is the Cal.com/Brevo reasoning with the counter-example already in
    // hand: a token's shape is a vendor implementation detail that drifts
    // (legacy 20-char -> routable dotted, within one product generation), the
    // `glpat-` prefix is admin-configurable on self-managed, and the only
    // thing that proves a token is GitLab answering `GET /api/v4/user` with
    // it, which `connect()` already does. Emptiness is the only thing refused;
    // the prefix lives in the HELP text, where it guides instead of rejecting.
    // Mutation: add `pattern: "^glpat-[A-Za-z0-9_-]+$"` -> red, and every
    // routable token is locked out.
    const fields = providerDescriptor(GITLAB_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["token"]);
    for (const field of fields) expect(field.pattern).toBeUndefined();
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.storage).toBe("encrypted");
    // The help text carries BOTH token kinds the console now offers, because
    // scopes exist only on one of them: `read_api` on a Legacy token, and the
    // permission pair on a Fine-grained token. A top-level-group Owner on
    // gitlab.com can enforce fine-grained tokens after a date, after which a
    // legacy token is refused for that group's resources — so help naming only
    // the legacy path would send some owners to a token that stops working.
    expect(fields[0]!.help).toMatch(/read_api/);
    expect(fields[0]!.help).toMatch(/Legacy token/);
    expect(fields[0]!.help).toMatch(/Fine-grained token/);
    expect(fields[0]!.help).toMatch(/Work Item: Read/);
    expect(fields[0]!.help).toMatch(/User: Read/);
    expect(fields[0]!.help).toMatch(/glpat-/);
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // These two are wired together at runtime by nothing but this string: the
    // orchestrator stores the field under the descriptor's name, the connector
    // looks it up by the template's placeholder. Rename either alone and every
    // GitLab connection refuses with "the stored credential has no token" — at
    // first read, on a schedule, where nobody is watching.
    expect(authPlaceholders(GITLAB_PROFILE.auth)).toEqual(["token"]);
    expect(providerDescriptor(GITLAB_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(GITLAB_PROFILE.auth),
    );
  });

  it("paces at the Free tier's SUSTAINED ceiling, and the descriptor says the same thing twice", async () => {
    // GitLab's rate-limit page: authenticated API traffic is capped today at
    // 2,000 requests a minute, and the ANNOUNCED plan-aware limits give Free
    // "5,000 each hour" sustained with "100 each minute" as a burst ceiling —
    // and say the hourly figure takes precedence, the per-minute one being "a
    // ceiling on short spikes rather than a rate you can maintain". 5,000/h is
    // one request per 720 ms. Pacing against the announced Free floor rather
    // than today's 2,000/min means the profile does not need re-deriving when
    // the announced limits land, and a first full scan (at most 500 pages) is
    // six minutes rather than a 429.
    // Mutation: derive from the 100/min BURST figure (600 ms) -> red; 600 ms
    // is 6,000 an hour, which exceeds the sustained limit the page says wins.
    const rateLimit = providerDescriptor(GITLAB_PROVIDER)!.rateLimit!;
    expect(rateLimit).toEqual({ callCeiling: 5_000, periodMs: 3_600_000 });
    expect(rateLimit.periodMs / rateLimit.callCeiling).toBe(GITLAB_MIN_REQUEST_INTERVAL_MS);
    expect(GITLAB_PROFILE.minRequestIntervalMs).toBe(720);

    // And it is a WAIT between requests, not a refusal: a refusal would make a
    // slow sync incomplete, which is worse than making it slow.
    const { connector, slept } = connectorWith([
      { body: [ISSUE], headers: { link: LINK_PAGE_2 } },
      { body: [], headers: { link: LINK_LAST } },
    ]);
    await connector.runRead("get_tasks_by_status", { since: SINCE });
    expect(slept).toEqual([GITLAB_MIN_REQUEST_INTERVAL_MS]);
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("GitLab — auth, read off the wire", () => {
  it("🔴 sends PRIVATE-TOKEN: <token> — a bare token, no scheme, no Authorization header", async () => {
    // GitLab's authentication page documents three ways to present a personal
    // access token: the `PRIVATE-TOKEN` header, `Authorization: Bearer`, and a
    // `private_token` QUERY parameter. The profile uses the first and ONLY the
    // first: the query form puts the credential in the URL, where it lands in
    // the customer's proxy logs and in ours; and a `Bearer` scheme would be a
    // second working spelling with nothing pinning which one goes out. Pinned
    // because five of the six shapes on ADR-046 §2's table are NOT this one.
    // Mutation: switch to `Authorization: Bearer {{token}}`, or "help" by also
    // sending `private_token` on the query -> red.
    const { connector, calls } = connectorWith([{ body: [], headers: { link: LINK_LAST } }]);
    await connector.runRead("get_tasks_by_status", { since: SINCE });

    expect(GITLAB_PROFILE.auth).toEqual({
      headerName: "PRIVATE-TOKEN",
      valueTemplate: "{{token}}",
    });
    const headers = headersOf(calls[0]!.init);
    expect(headers["PRIVATE-TOKEN"]).toBe(TOKEN);
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has("private_token")).toBe(false);
    expect(url.searchParams.has("access_token")).toBe(false);
  });

  it("sends NO constant headers — GitLab versions in the PATH (`/api/v4`), not in a header", async () => {
    // Unlike Cal.com (`cal-api-version`), Square (`Square-Version`) and GitHub
    // (`X-GitHub-Api-Version`), GitLab's REST API is versioned by the `/api/v4`
    // path segment and documents no version header at all. An empty
    // `constantHeaders` is therefore the honest declaration, and this pin is
    // what stops a "for symmetry" copy of some other vendor's header landing
    // on every GitLab request.
    // Mutation: add any constant header -> red.
    const { connector, calls } = connectorWith([{ body: { id: 1, username: "root" } }]);
    await connector.connect();

    expect(GITLAB_PROFILE.constantHeaders).toEqual({});
    const sent = Object.keys(headersOf(calls[0]!.init)).map((k) => k.toLowerCase()).sort();
    expect(sent).toEqual(["accept", "private-token"]);
  });

  it("probes GET /api/v4/user on BOTH connect() and health()", async () => {
    // 🔴 Resolving the credential locally is not a connection: a token the
    // owner revoked in their profile — or one that hit its REQUIRED expiry
    // (default and default-maximum 365 days) — resolves perfectly and fails on
    // the first scheduled read, hours later. `/api/v4/user` returns the
    // token's own user and nothing else — no pagination, one row — so a 401
    // on it is unambiguous evidence about the TOKEN, which is what lets the
    // card say "paste a new token" instead of "can't connect".
    // Mutation: point probePath at `/api/v4/issues` -> the health check pages
    // the customer's whole tracker every time, and an account with no issues
    // still "connects" for reasons unrelated to the token.
    const { connector, calls } = connectorWith([{ body: { id: 1, username: "root" } }]);
    await connector.connect();
    await connector.health();

    expect(GITLAB_PROFILE.probePath).toBe("/api/v4/user");
    expect(calls.map((c) => c.url)).toEqual(["https://gitlab.com/api/v4/user", "https://gitlab.com/api/v4/user"]);
    // The probe carries no watermark and no paging parameter: this endpoint
    // documents none, and sending one would be inventing a contract.
    for (const call of calls) expect(new URL(call.url).search).toBe("");
  });
});

// ── the one dataset, read off the wire ──────────────────────────────────────

describe("GitLab task — GET /api/v4/issues", () => {
  it("🔴 pins scope=all, state=all, per_page=100 on the first request", async () => {
    // THE most load-bearing constant in this profile. GitLab's "List all
    // issues" page: `scope` — "Return issues for the given scope: created_by_me,
    // assigned_to_me or all. Defaults to created_by_me". Omit it and the read
    // returns only the issues the token's owner personally AUTHORED — pages
    // cleanly, terminates cleanly, and reports a complete sync over a fraction
    // of the team's tracker. `state=all` for the same reason in the other
    // direction (the docs do not state the default, so it is pinned rather than
    // assumed), and `per_page=100` is the documented maximum, so a full scan
    // costs the fewest requests against the rate budget.
    // Mutation: drop `scope` -> red; change `per_page` to 20 (the API default)
    // -> red, and every full scan costs five times the requests.
    const { connector, calls } = connectorWith([{ body: [], headers: { link: LINK_LAST } }]);
    await connector.runRead("get_tasks_by_status", { since: SINCE });

    const first = new URL(calls[0]!.url);
    expect(first.host).toBe("gitlab.com");
    expect(first.pathname).toBe("/api/v4/issues");
    expect(first.searchParams.get("scope")).toBe("all");
    expect(first.searchParams.get("state")).toBe("all");
    expect(first.searchParams.get("per_page")).toBe("100");
  });

  it("🔴 filters on updated_after (ISO 8601, Z-suffixed) and NEVER on order_by/sort or pagination=keyset", async () => {
    const { connector, calls } = connectorWith([
      { body: [{ ...ISSUE, id: 76 }], headers: { link: LINK_PAGE_2 } },
      { body: [{ ...ISSUE, id: 77 }], headers: { link: LINK_LAST } },
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }));

    // The watermark. GitLab: `updated_after` — "Return issues updated on or
    // after the given time. Expected in ISO 8601 format." A genuine
    // last-modified filter (it moves on any edit, because `updated_at` is the
    // row's own last-modified stamp), which is what makes `complete: true`
    // below honest. The value is `toISOString()` output — Z-suffixed, so the
    // docs' caveat about `+` offsets needing `%2B` never bites.
    // Mutation: spell it `updated_since` (GitHub's word), or reach for the
    // sibling `created_after` -> the read either full-scans or freezes every
    // edit out of view, and the sync still reports success.
    const first = new URL(calls[0]!.url);
    expect(first.searchParams.get("updated_after")).toBe(SINCE_ISO);
    expect(first.searchParams.has("created_after")).toBe(false);
    expect(first.searchParams.has("updated_before")).toBe(false);

    for (const call of calls) {
      const url = new URL(call.url);
      // 🔴 NO `order_by=updated_at&sort=asc` "for stability". With OFFSET
      // pagination an edit mid-walk moves that row to the END of an ascending
      // updated_at ordering and shifts the next page's first row back into a
      // page already fetched — a MISSED row. The default ordering
      // (`created_at` desc) is edit-stable; new issues only produce harmless
      // duplicates on a page boundary, which dedup absorbs.
      expect(url.searchParams.has("order_by")).toBe(false);
      expect(url.searchParams.has("sort")).toBe(false);
      // 🔴 NO `pagination=keyset`. Keyset is documented for
      // `GET /projects/:id/issues` (GitLab 18.3+) — NOT for the global
      // `GET /issues` used here — and its end-of-collection signal differs
      // (Link ABSENT rather than Link without rel=next). Sending it here is
      // unverified behaviour dressed as an optimisation.
      expect(url.searchParams.has("pagination")).toBe(false);
    }
    expect(rows.map((r) => r.task_id)).toEqual(["76", "77"]);
  });

  it("🔴 pages on the Link header's rel=\"next\" URL VERBATIM, and stops when the header stops offering one", async () => {
    // GitLab: "Link headers are returned with each response. They have rel set
    // to prev, next, first, or last and contain the relevant URL." Past
    // 10,000 records GitLab drops `x-total`, `x-total-pages` and the
    // rel="last" link — but rel="next" stays, and nothing in this track reads
    // the totals, so the walk is unaffected. The next URL is GitLab's own,
    // taken from the header as-is (it carries the watermark and the constant
    // query with it), and re-run through the exact-host guard before it is
    // dialled.
    // Mutation: switch to `page-number` with a has-more path -> red (no such
    // body field exists; the body IS the array); add a total-based
    // short-circuit -> the >10,000 walk truncates silently.
    const { connector, calls } = connectorWith([
      { body: [{ ...ISSUE, id: 1 }], headers: { link: LINK_PAGE_2 } },
      // Page 2 carries only prev/first/last — a real last page's header.
      { body: [{ ...ISSUE, id: 2 }], headers: { link: LINK_LAST } },
      // Never reached; a third call would mean the walk did not stop.
      { body: [{ ...ISSUE, id: 3 }], headers: { link: LINK_LAST } },
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://gitlab.com/api/v4/issues?scope=all&state=all&per_page=100&page=2");
    expect(rows.map((r) => r.task_id)).toEqual(["1", "2"]);

    const task = GITLAB_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.pagination).toEqual({ kind: "link-header" });
  });

  it("🔴 refuses a Link rel=\"next\" that points OFF gitlab.com — page one only, credential never leaves", async () => {
    // A `Link` header is VENDOR-controlled input, and the link-header arm is
    // the ONLY pagination arm that can produce a cross-host URL. The follow URL
    // is refused BEFORE the second request, so the count stays at 1 and the
    // token never reaches the other host.
    // Mutation: drop the `assertSafeFollowUrl` call from `request()` -> the
    // second call goes out and the count is 2 -> red.
    const { connector, calls } = connectorWith([
      {
        body: [ISSUE],
        headers: { link: '<https://evil.example.net/api/v4/issues?page=2>; rel="next"' },
      },
      { body: [{ ...ISSUE, id: 999 }] },
    ]);
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      UnsafeBaseUrlError,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("gitlab.com");
  });

  it("declares the watermark COMPLETE, link-header paging, and the body as the rows", () => {
    // `updated_after` filters on the issue's own modification time, so a
    // state change (opened -> closed) or a reassignment comes back on the next
    // pass. That is the vendor fact `complete: true` records — and `task` HAS
    // an `ERP_SYNC_ENTITIES` row, so a GitLab connection registers a cursor
    // and is ticked and swept like any other.
    // Mutation: flip it to false -> red here, and
    // `erp-provider.descriptor.test.ts` refuses to schedule it.
    const task = GITLAB_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.path).toBe("/api/v4/issues");
    expect(task.query).toEqual({ scope: "all", state: "all", per_page: "100" });
    expect(task.watermark).toEqual({
      name: "updated_after",
      location: "query",
      format: "iso",
      complete: true,
    });
    expect(task.pagination).toEqual({ kind: "link-header" });
    // The body IS the array — GitLab wraps nothing.
    expect(task.rowsPath).toBe("");
  });

  it("🔴 takes task_id from `id` (global), NOT from `iid` (per-project)", async () => {
    // Every issue carries both. `iid` is the number a person sees in the URL
    // (`my-project/issues/6`) and it is unique only WITHIN a project — two
    // projects each have an issue 6. `id` is the instance-wide identifier,
    // and the global `/issues` endpoint spans every project the token can see,
    // so `iid` would collide the moment a second project appears and the
    // sync's dedup would silently merge unrelated work items.
    // Mutation: map `task_id: "iid"` -> nothing fails, rows land, and every
    // second project's issues overwrite the first's.
    const { connector } = connectorWith([{ body: [ISSUE], headers: { link: LINK_LAST } }]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }))[0]!;
    // A numeric vendor id, stringified by the canonical text coercion — ids
    // arrive as JSON numbers and a canonical identifier column is text.
    expect(row.task_id).toBe("76");
    expect(row.task_id).not.toBe("6");
    expect(row.project_id).toBe("1");
    expect(row.title).toBe("Consequatur vero maxime deserunt laboriosam est voluptas dolorem.");
    expect(row.created_at).toBe("2016-01-04T15:31:51.081Z");
    expect(row.updated_at).toBe("2016-01-04T15:31:51.081Z");
  });

  it("🔴 takes status from `state` — opened / closed — not from issue_type or severity", async () => {
    // `state` is the lifecycle field (`opened`, `closed`) and it is what
    // `get_tasks_by_status` filters on. `issue_type` (`issue`, `incident`,
    // `test_case`, `task`) is a KIND, and `severity` is an incident-only field
    // that reads `UNKNOWN` on a plain issue. The values are passed through as
    // GitLab spells them, because the read query's `status` parameter is
    // vendor-supplied text and a translation table here would be a second
    // vocabulary nothing else knows.
    // Mutation: map `status: "issue_type"` -> the filter for "opened" returns
    // nothing, forever, with a green card.
    const { connector } = connectorWith([
      {
        body: [
          { ...ISSUE, id: 10, state: "opened", closed_at: null },
          { ...ISSUE, id: 11, state: "closed", closed_at: "2026-09-10T08:00:00.000Z" },
        ],
        headers: { link: LINK_LAST },
      },
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE, status: "closed" }));
    expect(rows.map((r) => r.task_id)).toEqual(["11"]);
    expect(rows[0]!.status).toBe("closed");
    expect(rows[0]!.closed_at).toBe("2026-09-10T08:00:00.000Z");
  });

  it("🔴 takes assignee_id from `assignees[0].id` — the deprecated singular `assignee` is NOT read", async () => {
    // GitLab's own note on every issue-list response: "The assignee column is
    // deprecated. GitLab returns it as a single-sized array assignees". So the
    // array is the contract and the singular is a courtesy that can go. The
    // fixture's decoy `assignee.id` (99) differs from `assignees[0].id` (1) so
    // this test can tell the two paths apart.
    //
    // Knowingly LOSSY: Premium and Ultimate allow multiple assignees and the
    // canonical column holds one. The first assignee in GitLab's own ordering
    // is kept, and the fact that assignee 2 was also on it is NOT
    // representable here — recorded rather than hidden. A text column holding
    // "1,2" is not an identifier anything can join on.
    // Mutation: read `assignee.id` -> 99 -> red; read the whole array -> red.
    const { connector } = connectorWith([{ body: [ISSUE], headers: { link: LINK_LAST } }]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }))[0]!;
    expect(row.assignee_id).toBe("1");
    expect(row.assignee_id).not.toBe("99");

    // And an UNASSIGNED issue — `assignees: []` and `assignee: null` on a live
    // row — projects undefined rather than throwing on the index.
    const { connector: unassigned } = connectorWith([
      { body: [{ ...ISSUE, assignees: [], assignee: null }], headers: { link: LINK_LAST } },
    ]);
    const bare = rowsOf(await unassigned.runRead("get_tasks_by_status", { since: SINCE }))[0]!;
    expect("assignee_id" in bare).toBe(true);
    expect(bare.assignee_id).toBeUndefined();
  });

  it("🔴 leaves priority UNDEFINED — GitLab issues carry no priority field", async () => {
    // Three candidates, each wrong for its own reason, and the fixture carries
    // all three so this pin proves none is read:
    //  - `severity` is INCIDENT-only and reads `UNKNOWN` on a plain issue;
    //  - `weight` is Premium/Ultimate-only and is EFFORT, not priority — and
    //    it is `null` on Free, so mapping it would make the column tier-gated;
    //  - `labels` may carry a `priority::high` scoped label, but that is a
    //    per-project CONVENTION with no row field, and reading the label list
    //    for a prefix is a policy, not a projection.
    // Present as a KEY (the projection writes every canonical column) and
    // undefined as a VALUE — the honest representation of "this vendor does
    // not carry that fact".
    // Mutation: map `priority: "severity"` -> "UNKNOWN" lands in a priority
    // column on every row -> red.
    const { connector } = connectorWith([{ body: [ISSUE], headers: { link: LINK_LAST } }]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }))[0]!;
    expect("priority" in row).toBe(true);
    expect(row.priority).toBeUndefined();
    expect(Object.values(row)).not.toContain("UNKNOWN");
    expect(Object.values(row)).not.toContain("priority::high");

    // Every other canonical column IS mapped — eight of nine.
    const task = GITLAB_PROFILE.datasets.find((d) => d.dataset === "task")!;
    const mapped = Object.keys(task.fieldMap).sort();
    expect(mapped).toEqual(
      [...CANONICAL_COLUMNS.task].filter((c) => c !== "priority").sort(),
    );
  });

  it("🔴 does NOT tolerate a non-array body — that is a Square fact, not a GitLab one", async () => {
    // Square omits the array on an empty result, so its specs declare
    // `absentRowsMeansEmpty`. GitLab's `/issues` body IS the array, and an
    // empty result is `[]`, so this profile does not — and the difference is
    // load-bearing: with the flag set, a WRONG rowsPath would read as "no
    // issues this week" on every page of every sync, which is a confident
    // false statement about a team's backlog. A GitLab ERROR body is an object
    // (`{"message": "401 Unauthorized"}`), so an object where the array should
    // be is a contract violation, never an empty page.
    // Mutation: copy `absentRowsMeansEmpty: true` across from the Square
    // profile "for symmetry" -> this goes red, and it should.
    const task = GITLAB_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.absentRowsMeansEmpty).toBeUndefined();

    const { connector } = connectorWith([{ body: { issues: [ISSUE] } }]);
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      RestPaginationContractError,
    );

    // And a genuinely empty tracker is `[]`: zero rows, no error.
    const { connector: empty } = connectorWith([{ body: [] }]);
    expect(await empty.runRead("get_tasks_by_status", { since: SINCE })).toEqual([]);
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a
 * refusal asserts `fetch` was called ZERO times**, never merely that an error
 * was thrown. A test that inspected only the returned error would still pass if
 * the request had already gone out carrying the owner's token.
 */
describe("GitLab — the refusals, each costing ZERO fetch calls", () => {
  /** The real profile with a resolver that yields exactly what is passed. */
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([{ body: [], headers: { link: LINK_LAST } }]);
    const connector = new RestProfileConnector(
      GITLAB_PROFILE,
      { provider: GITLAB_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no token — ZERO fetch calls", async () => {
    // The shape a real connection reaches this in: the descriptor's field was
    // renamed, or the owner's secret was purged on disconnect and the row
    // survived. Sending the literal `{{token}}` would land in GitLab's logs as
    // a failed auth nobody can explain.
    // Mutation: fall back to "" instead of refusing an empty placeholder ->
    // the request goes out and the call count goes to 1.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      /has no "token"/,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank token as firmly as a missing one — ZERO fetch calls", async () => {
    // Whitespace is what a paste box produces. An empty PRIVATE-TOKEN header
    // is a request that cannot succeed, and GitLab paces at 720 ms, so
    // spending a call to learn that costs the owner's budget as well as the
    // round trip.
    const { connector, calls } = connectorWithCredentials({ token: "\t \n" });
    await expect(connector.connect()).rejects.toThrow(/has no "token"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a dataset GitLab does not serve — ZERO fetch calls, and NOT an empty array", async () => {
    // This profile serves `task` and nothing else. Asked for money, a
    // customer or a booking, the connection refuses by NAME. `[]` would be a
    // confident false statement no caller can tell from a genuinely empty
    // result — and on `get_ar_summary` that statement is about money.
    // Mutation: make `runRead` fall through to an empty array -> red.
    for (const name of ["get_ar_summary", "get_bookings", "get_recent_charges", "find_employee"]) {
      const { connector, calls } = connectorWithCredentials({ token: TOKEN });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(
        DatasetNotServedError,
      );
      expect(calls, name).toHaveLength(0);
    }
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // ADR-046 §4. GitLab HAS a full issue-write API (create, edit, close,
    // reassign) and `read_api` is the scope precisely so the token cannot use
    // it — but the refusal here is the TRACK's, not the scope's, and it costs
    // no request. A Legacy token minted with `api` instead of `read_api` by
    // mistake is still safe on this box.
    const { connector, calls } = connectorWithCredentials({ token: TOKEN });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not GitLab's — ZERO fetch calls", async () => {
    // A self-managed GitLab will be its own provider id with its own profile
    // and its own dynamic-host guard. A row naming one and dispatched to the
    // other must fail at CONSTRUCTION, before a credential is resolved — not
    // silently read a self-hoster's tracker through the gitlab.com contract.
    const { impl, calls } = stubFetch([{ body: [] }]);
    expect(
      () =>
        new RestProfileConnector(
          GITLAB_PROFILE,
          { provider: "gitlab-selfmanaged" },
          { fetchImpl: impl, resolveCredentials: async () => ({ token: TOKEN }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a 302 rather than following it off gitlab.com", async () => {
    // `fetch` defaults to following redirects, so without `redirect: "error"`
    // the guard would be checking a URL while the answer chose the destination
    // — with the owner's token attached, and with an issue body that carries
    // titles, descriptions and, for confidential issues, things the project
    // hid from most of its own members.
    // EXACTLY ONE call: the redirect was not followed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/api/v4/issues" } },
    ]);
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      UnsafeBaseUrlError,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("gitlab.com");
  });
});
