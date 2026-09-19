/**
 * WARP-2916 / ADR-046 — GitHub's VENDOR FACTS, pinned against GitHub's own
 * documentation.
 *
 * ## Why this file is mandatory rather than nice to have
 *
 * ADR-046's Consequences section: *"A declarative profile is easier to get wrong
 * quietly than code is. A wrong watermark parameter is one string. Mitigation:
 * the parameter names are pinned by tests that cite the vendor page."* This is
 * that file for GitHub. `rest-track.test.ts` proves the connector does what a
 * profile SAYS — which is exactly the question that stays green when the
 * profile says the wrong thing — and `introspect()`'s fingerprint hashes the
 * datasets and their canonical columns, not the paths, headers or parameter
 * spellings. Only this file can catch those.
 *
 * GitHub's version of the silent failure is the one `profile.ts` names in its
 * `RestWatermark` docstring: GitHub SILENTLY IGNORES unknown query parameters.
 * A misspelt `since` does not 4xx — it produces a full scan of every issue the
 * token can see, on every tick, that the box reports as an incremental read.
 * The same is true of `filter`, `state` and `per_page`: drop them and GitHub
 * answers with its DEFAULTS (`filter=assigned`, `state=open`, 30 rows a page),
 * which is a confident, green, wrong sync over a fraction of the data.
 *
 * ## The sources every claim below was checked against (2026-09-18)
 *
 *  • List issues assigned to the authenticated user
 *      https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28#list-issues-assigned-to-the-authenticated-user
 *  • Get the authenticated user
 *      https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28#get-the-authenticated-user
 *  • Authenticating to the REST API
 *      https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2022-11-28
 *  • Permissions required for fine-grained personal access tokens
 *      https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28
 *  • Using pagination in the REST API
 *      https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28
 *  • Rate limits for the REST API
 *      https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28
 *  • Getting started (User-Agent, Accept)
 *      https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api?apiVersion=2022-11-28
 *  • API versions
 *      https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2022-11-28
 *  • Breaking changes (2026-03-10)
 *      https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10
 *  • Managing your personal access tokens
 *      https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
 *  • About authentication to GitHub (token-formats table)
 *      https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github
 *
 * Two facts below are NOT on any documentation page and were verified LIVE
 * against the public `octocat/Hello-World` repository on 2026-09-18, with
 * read-only unauthenticated GETs:
 *
 *  • `since` is INCLUSIVE (`>=`): `since=<updated_at of a row>` returns that
 *    row; one second later drops it. The endpoint page says only "last updated
 *    after the given time".
 *  • A malformed `since` is a 422 ("The since parameter needs to be in ISO
 *    8601 format"), NOT a silently ignored full scan — and the `.000Z`
 *    millisecond form `Date.toISOString()` produces is accepted and filters.
 *
 * Every test below drives the REAL `GITHUB_PROFILE` through the REAL
 * `RestProfileConnector` with an injected fetch, so a connector that drops the
 * version header, forgets the watermark or follows a Link off-host goes red
 * here even though the profile is untouched. Every test names the mutation
 * that must turn it red.
 */
import { describe, expect, it } from "vitest";

import { providerDescriptor } from "@droplet/shared-types";

import {
  RestPaginationContractError,
  RestProfileConnector,
  RestVendorError,
  UnsafeBaseUrlError,
} from "../src/rest/connector.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { authPlaceholders } from "../src/rest/profile.js";
import { restProfileFor } from "../src/rest/profiles.js";
import {
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GITHUB_MIN_REQUEST_INTERVAL_MS,
  GITHUB_PROFILE,
  GITHUB_PROVIDER,
  GITHUB_USER_AGENT,
} from "../src/rest/vendors/github.js";
import { readRepoFile } from "./helpers/test-paths.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A recording fetch stub — the same shape `rest-track.test.ts` uses, and
 * duplicated rather than imported ON PURPOSE: importing it from that file would
 * execute that file's whole suite as a side effect of loading this one.
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
 * A fine-grained PAT's stand-in. It carries the documented `github_pat_`
 * prefix because — unlike Cal.com and Square — GitHub DOES document its token
 * formats, and the descriptor pins a pattern on it (see the custody test).
 * Nothing in the CONNECTOR validates the shape; that is the paste box's job.
 */
const TOKEN = "github_pat_11ABCDEFG_testtoken";

/**
 * The REAL profile, through the REAL connector.
 *
 * The clock and `sleep` are injected because this profile paces at 720 ms
 * between requests: with the default `setTimeout` a two-page read would make
 * the suite actually pay GitHub's rate ceiling.
 */
function connectorWith(pages: { body: unknown; status?: number; headers?: Record<string, string> }[]) {
  const { impl, calls } = stubFetch(pages);
  const slept: number[] = [];
  let clock = 0;
  const connector = new RestProfileConnector(
    GITHUB_PROFILE,
    { provider: GITHUB_PROVIDER },
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

/**
 * The documented 200 example for `GET /issues`, verbatim from the endpoint
 * page (trimmed of fields no test reads). Two things about it are
 * load-bearing:
 *
 *  • it carries a `pull_request` key — GitHub's own example row IS a pull
 *    request, which is the hazard the PR test below records;
 *  • it carries BOTH the singular `assignee` (removed 2026-03-10) and the
 *    `assignees` array, so the profile's choice of `assignees[0].id` can be
 *    proven correct under both API versions.
 */
const ISSUE = {
  id: 1,
  node_id: "MDU6SXNzdWUx",
  url: "https://api.github.com/repos/octocat/Hello-World/issues/1347",
  repository_url: "https://api.github.com/repos/octocat/Hello-World",
  html_url: "https://github.com/octocat/Hello-World/issues/1347",
  number: 1347,
  state: "open",
  title: "Found a bug",
  body: "I'm having a problem with this.",
  user: { login: "octocat", id: 1, node_id: "MDQ6VXNlcjE=", type: "User", site_admin: false },
  labels: [
    {
      id: 208045946,
      node_id: "MDU6TGFiZWwyMDgwNDU5NDY=",
      name: "bug",
      description: "Something isn't working",
      color: "f29513",
      default: true,
    },
  ],
  assignee: { login: "octocat", id: 1, node_id: "MDQ6VXNlcjE=", type: "User", site_admin: false },
  assignees: [{ login: "octocat", id: 1, node_id: "MDQ6VXNlcjE=", type: "User", site_admin: false }],
  milestone: {
    id: 1002604,
    number: 1,
    state: "open",
    title: "v1.0",
    open_issues: 4,
    closed_issues: 8,
    created_at: "2011-04-10T20:09:31Z",
    updated_at: "2014-03-03T18:58:10Z",
    closed_at: "2013-02-12T13:22:01Z",
    due_on: "2012-10-09T23:39:01Z",
  },
  locked: true,
  active_lock_reason: "too heated",
  comments: 0,
  pull_request: {
    url: "https://api.github.com/repos/octocat/Hello-World/pulls/1347",
    html_url: "https://github.com/octocat/Hello-World/pull/1347",
    diff_url: "https://github.com/octocat/Hello-World/pull/1347.diff",
    patch_url: "https://github.com/octocat/Hello-World/pull/1347.patch",
  },
  closed_at: null,
  created_at: "2011-04-22T13:33:48Z",
  updated_at: "2011-04-22T13:33:48Z",
  repository: {
    id: 1296269,
    node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
    name: "Hello-World",
    full_name: "octocat/Hello-World",
    owner: { login: "octocat", id: 1, type: "User", site_admin: false },
    private: false,
    html_url: "https://github.com/octocat/Hello-World",
    default_branch: "master",
    open_issues_count: 0,
  },
};

/** The documented `GET /user` 200 — the probe's answer, one object, no rows. */
const ME = { login: "octocat", id: 1, type: "User", site_admin: false };

// ── identity, custody and the descriptor ────────────────────────────────────

describe("GitHub — the profile the track actually dispatches", () => {
  it("is the profile restProfileFor('github') returns, not a copy", () => {
    // Mutation: register a second GitHub profile in `profiles.ts` and this
    // whole file starts testing a file nothing ships.
    expect(restProfileFor(GITHUB_PROVIDER)).toBe(GITHUB_PROFILE);
  });

  it("🔴 dials api.github.com only, and it is the host the descriptor registers for egress", () => {
    // GitHub Enterprise Server and GHEC data-residency customers live on OTHER
    // hosts (`<sub>.ghe.com`, a customer's own domain). Those are a SECOND
    // profile with a `kind: dynamic` base URL and their own exact-host guard —
    // not a variable host on this one.
    // Mutation: turn this into a `kind: dynamic` base URL "so GHES works" ->
    // the static egress scanner stops seeing any host for this provider.
    expect(GITHUB_PROFILE.baseUrl).toEqual({ kind: "static", origin: GITHUB_API_ORIGIN });
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
    expect(providerDescriptor(GITHUB_PROVIDER)!.egressHosts).toEqual(["api.github.com"]);
  });

  it("🔴 has its OWN egress entry — the scanner cannot notice this one going missing", () => {
    // `api.github.com` is ALSO registered under `ota-github-releases` (the
    // orchestrator's release-manifest fetch, data class `none`). So the
    // egress gate's DENIAL pass is satisfied whether or not the connector's
    // entry exists — verified by mutation on 2026-09-18: delete `github-api`
    // and `check-egress-allowlist.py` stays green. This file is therefore the
    // only thing that pins the connector's registration, which is the one
    // that says customer content leaves through this host on request.
    // Mutation: delete the `github-api` entry from allowed-egress.yaml -> red.
    const yaml = readRepoFile("docs", "security", "allowed-egress.yaml");
    const start = yaml.indexOf("  - id: github-api\n");
    expect(start, "an entry with id github-api").toBeGreaterThan(-1);
    const entry = yaml.slice(start, yaml.indexOf("\n  - id: ", start + 1));
    expect(entry).toContain("kind: egress");
    expect(entry).toContain("service: erp-connector");
    expect(entry).toContain("hosts: [api.github.com]");
    expect(entry).toContain("data_class: user-content-on-request");
    expect(entry).toContain("ticket: WARP-2916");
    expect(entry).toContain("code_refs: [services/erp-connector/src/rest/vendors/github.ts]");
  });

  it("🔴 serves EXACTLY the datasets the descriptor advertises", () => {
    // The descriptor is what the hub, the scheduler (`entityServedBy`) and the
    // dashboard read; the profile is what the connector reads. A drift between
    // them is a hub tile offering a dataset the connection will refuse.
    const served = GITHUB_PROFILE.datasets.map((d) => d.dataset);
    expect([...served].sort()).toEqual([...providerDescriptor(GITHUB_PROVIDER)!.datasets].sort());
    expect(served).toEqual(["task"]);
  });

  it("🔴 accepts ONLY a fine-grained token by shape — `github_pat_` — and that is the Stripe reasoning, not the Cal.com one", () => {
    // Cal.com and Square declare NO pattern because their prefixes are
    // undocumented or operator-configurable. GitHub is the opposite case:
    // the "GitHub's token formats" table on about-authentication-to-github
    // DOCUMENTS `github_pat_` for fine-grained PATs and `ghp_` for classic
    // ones, and the two are not interchangeable in what they can grant.
    //
    // A classic `ghp_` token's `repo` scope is READ AND WRITE over every
    // repository the user can reach — there is no read-only repository scope
    // on a classic token. A fine-grained token is the only shape that can be
    // minted with `Issues: Read-only` over a chosen set of repositories, which
    // is the least privilege this read-only connector asks for. Refusing the
    // classic shape at the paste box is the same call ADR-042 §4 makes for
    // Stripe's `sk_`: the box will not hold a credential that can do far
    // more than it needs when the vendor offers one that cannot.
    // Mutation: drop the pattern -> red, and a `ghp_` token with write over
    // the owner's every repo is accepted for a connector that reads issues.
    const fields = providerDescriptor(GITHUB_PROVIDER)!.credentialFields;
    expect(fields.map((f) => f.name)).toEqual(["token"]);
    expect(fields[0]!.pattern).toBe("^github_pat_");
    expect(fields[0]!.secret).toBe(true);
    expect(fields[0]!.required).toBe(true);
    expect(fields[0]!.storage).toBe("encrypted");
    expect(new RegExp(fields[0]!.pattern!).test(TOKEN)).toBe(true);
    expect(new RegExp(fields[0]!.pattern!).test("ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe(false);
  });

  it("names its credential placeholder EXACTLY as the descriptor names the field", () => {
    // Wired together at runtime by nothing but this string: the orchestrator
    // stores the field under the descriptor's name, the connector looks it up
    // by the template's placeholder. Rename either alone and every GitHub
    // connection refuses with "the stored credential has no token".
    expect(authPlaceholders(GITHUB_PROFILE.auth)).toEqual(["token"]);
    expect(providerDescriptor(GITHUB_PROVIDER)!.credentialFields.map((f) => f.name)).toEqual(
      authPlaceholders(GITHUB_PROFILE.auth),
    );
  });

  it("paces at the DOCUMENTED floor — 5,000 an hour — and the descriptor's ceiling says the same thing twice", async () => {
    // rate-limits-for-the-rest-api: "All of these requests count towards your
    // personal rate limit of 5,000 requests per hour" for a PAT. 3,600,000 ms
    // / 5,000 = 720 ms. The descriptor states the same fact in
    // `ProviderRateLimit`'s hourly shape; these are the only two places it is
    // written down.
    //
    // ⚠ That budget is the USER's, not this connector's: every other tool
    // authenticating as the same GitHub user shares it. Pacing at the floor
    // is what keeps this connector from being the one that exhausts it.
    // Mutation: raise the ceiling "because Enterprise Cloud gets 15,000" ->
    // red. The floor is what an owner on Free gets.
    const rateLimit = providerDescriptor(GITHUB_PROVIDER)!.rateLimit!;
    expect(rateLimit).toEqual({ callCeiling: 5_000, periodMs: 3_600_000 });
    expect(rateLimit.periodMs / rateLimit.callCeiling).toBe(GITHUB_MIN_REQUEST_INTERVAL_MS);
    expect(GITHUB_PROFILE.minRequestIntervalMs).toBe(720);

    // And it is a WAIT between requests, not a refusal.
    const { connector, slept } = connectorWith([
      { body: [ISSUE], headers: { link: '<https://api.github.com/issues?page=2>; rel="next"' } },
      { body: [] },
    ]);
    await connector.runRead("get_tasks_by_status", { since: SINCE });
    expect(slept).toEqual([GITHUB_MIN_REQUEST_INTERVAL_MS]);
  });
});

// ── the headers that actually leave the box ─────────────────────────────────

describe("GitHub — auth, the version header and the User-Agent, read off the wire", () => {
  it("sends Authorization: Bearer <token> — the literal name and the literal template", async () => {
    // authenticating-to-the-rest-api: "you can use Authorization: Bearer or
    // Authorization: token" — both schemes are documented for a PAT. Bearer is
    // the RFC-6750 one and the one every other Bearer vendor on this track
    // uses, so it is the one pinned.
    const { connector, calls } = connectorWith([{ body: [] }]);
    await connector.runRead("get_tasks_by_status", { since: SINCE });

    expect(GITHUB_PROFILE.auth).toEqual({
      headerName: "Authorization",
      valueTemplate: "Bearer {{token}}",
    });
    expect(headersOf(calls[0]!.init).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("🔴 sends X-GitHub-Api-Version: 2022-11-28 on EVERY request", async () => {
    // api-versions: a request with no version header is served the DEFAULT
    // version, which is whatever GitHub says it is on the day — so an
    // unpinned profile's row shape can change underneath a stable profile.
    // 2022-11-28 is the version every value in this profile was verified
    // against, and it is supported until 2028-03-10 (then 410 Gone).
    //
    // The 2026-03-10 version REMOVES the singular `assignee` field from Issue
    // responses (breaking-changes page). The field map reads `assignees[0].id`
    // so it is right under both versions, and bumping this one constant is
    // the whole migration when the day comes.
    // Mutation: drop the header, or bump it to `2026-03-10` without
    // re-verifying every value -> red on both calls below.
    const { connector, calls } = connectorWith([{ body: [] }]);
    await connector.connect();
    await connector.runRead("get_tasks_by_status", { since: SINCE });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(headersOf(call.init)["X-GitHub-Api-Version"]).toBe(GITHUB_API_VERSION);
    }
    expect(GITHUB_API_VERSION).toBe("2022-11-28");
  });

  it("🔴 sends a User-Agent naming this connector on EVERY request — GitHub refuses a request without one", async () => {
    // getting-started-with-the-rest-api: "All API requests must include a
    // valid User-Agent header. Requests with no User-Agent header will be
    // rejected" — verified live: an empty UA is a 403 text/html. The track's
    // shared connector never sets one, so without this constant header the
    // profile works ONLY because undici happens to send `User-Agent: node`.
    // A runtime that stopped doing that would turn every GitHub read into a
    // 403 that the connector reads as "the vendor rejected the credential".
    // GitHub asks for the application's name so it can contact the operator.
    // Mutation: drop it from `constantHeaders` -> red.
    const { connector, calls } = connectorWith([{ body: [] }]);
    await connector.connect();
    await connector.runRead("get_tasks_by_status", { since: SINCE });

    for (const call of calls) {
      expect(headersOf(call.init)["User-Agent"]).toBe(GITHUB_USER_AGENT);
    }
    expect(GITHUB_USER_AGENT).toBe("droplet-erp-connector");
  });

  it("declares EXACTLY two constant headers, and Accept is NOT one of them", () => {
    // GitHub recommends `Accept: application/vnd.github+json`. It is
    // deliberately NOT declared here because the shared connector sets
    // `accept: application/json` itself AFTER spreading `constantHeaders`, and
    // Node's `Headers` merges the two case-variant keys into one combined
    // value — so a profile-level Accept cannot pin GitHub's media type, it
    // can only claim to. GitHub answers 200 `application/json` to the
    // connector's own value (verified live), so nothing is lost by leaving it
    // out, and nothing is falsely claimed.
    // Mutation: add `Accept` "to be correct" -> red, and the comment on the
    // profile explains why the claim would be inert.
    expect(GITHUB_PROFILE.constantHeaders).toEqual({
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": GITHUB_USER_AGENT,
    });
    expect(Object.keys(GITHUB_PROFILE.constantHeaders).map((k) => k.toLowerCase())).not.toContain("accept");
  });

  it("probes GET /user on BOTH connect() and health()", async () => {
    // users#get-the-authenticated-user: "works with fine-grained personal
    // access tokens" and "does not require any permissions" — one object, no
    // pagination, and a 401 on it is unambiguous evidence about the TOKEN.
    //
    // ⚠ "No permissions" cuts both ways: a token minted with NO Issues
    // permission, or an org-owned token still PENDING org approval, probes
    // green here and then reads fewer rows than the owner expects. The guide
    // says so; the probe cannot.
    // Mutation: point probePath at `/issues` -> the health poll pages the
    // owner's whole issue list every time.
    const { connector, calls } = connectorWith([{ body: ME }]);
    await connector.connect();
    await connector.health();

    expect(GITHUB_PROFILE.probePath).toBe("/user");
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/user", "https://api.github.com/user"]);
    // The probe carries no watermark and no paging parameter.
    for (const call of calls) expect(new URL(call.url).search).toBe("");
  });
});

// ── the one dataset, read off the wire ──────────────────────────────────────

describe("GitHub task — GET /issues", () => {
  it("🔴 filters on `since`, overrides every default the endpoint gets wrong for a sync, and pages on Link rel=\"next\"", async () => {
    const { connector, calls } = connectorWith([
      {
        body: [{ ...ISSUE, id: 11 }],
        headers: {
          // The documented shape, verbatim from the pagination guide: a
          // comma-separated list of `<url>; rel="…"` parts, and the next page
          // is the one with rel="next". The URL is taken VERBATIM.
          link:
            '<https://api.github.com/issues?filter=all&state=all&page=1>; rel="prev", ' +
            '<https://api.github.com/issues?filter=all&state=all&page=2>; rel="next", ' +
            '<https://api.github.com/issues?filter=all&state=all&page=9>; rel="last"',
        },
      },
      // The last page carries no rel="next" — that is the stop condition.
      { body: [{ ...ISSUE, id: 12 }], headers: { link: '<https://api.github.com/issues?page=1>; rel="prev"' } },
    ]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }));

    const first = new URL(calls[0]!.url);
    expect(first.host).toBe("api.github.com");
    expect(first.pathname).toBe("/issues");

    // The watermark. Endpoint page, `since`: "Only show results that were
    // last updated after the given time. This is a timestamp in ISO 8601
    // format: YYYY-MM-DDTHH:MM:SSZ." A genuine last-modified filter.
    //
    // 🔴 GitHub silently IGNORES an unknown parameter, so a misspelling here
    // would not 4xx — it would full-scan and report an incremental read.
    // Verified live 2026-09-18: `since` is INCLUSIVE (>=), the `.000Z`
    // millisecond form below is accepted and filters, and a malformed value
    // is a 422 — not a silent scan.
    // Mutation: spell it `updated_since` or `after` -> red.
    expect(first.searchParams.get("since")).toBe(SINCE_ISO);

    // 🔴 The defaults are wrong for a sync and every one is overridden:
    // `filter` defaults to `assigned` (only issues assigned to the user),
    // `state` to `open` (closed work vanishes), `per_page` to 30. All three
    // are documented on the endpoint page; `sort=updated&direction=asc` keeps
    // the walk stable while pages are being fetched.
    // Mutation: drop `filter=all` -> nothing fails, and every issue the owner
    // is not personally assigned to is silently absent from the box.
    expect(first.searchParams.get("filter")).toBe("all");
    expect(first.searchParams.get("state")).toBe("all");
    expect(first.searchParams.get("sort")).toBe("updated");
    expect(first.searchParams.get("direction")).toBe("asc");
    expect(first.searchParams.get("per_page")).toBe("100");

    // 🔴 `pulls` is listed on the endpoint page as a boolean with NO
    // description. It is deliberately NOT sent: a parameter whose behaviour
    // the vendor does not document is a filter the profile cannot claim.
    expect(first.searchParams.has("pulls")).toBe(false);

    // Page two: the URL GitHub returned under rel="next", verbatim.
    expect(calls[1]!.url).toBe("https://api.github.com/issues?filter=all&state=all&page=2");
    expect(calls).toHaveLength(2);

    expect(rows.map((r) => r.task_id)).toEqual(["11", "12"]);
  });

  it("declares the watermark COMPLETE, link-header pagination, and the root rows path", () => {
    // `since` filters on the issue's own modification time, so a close, a
    // reassignment or a retitle comes back on the next pass. That is the
    // vendor fact `complete: true` records — and it is what lets `task` be
    // scheduled in `ERP_SYNC_ENTITIES` without tripping the descriptor
    // test's "no scheduled dataset with an incomplete watermark" pin.
    // Mutation: flip it to false -> red here AND in
    // erp-provider.descriptor.test.ts, because `task` IS scheduled.
    const task = GITHUB_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.path).toBe("/issues");
    expect(task.watermark).toEqual({
      name: "since",
      location: "query",
      format: "iso",
      complete: true,
    });
    expect(task.pagination).toEqual({ kind: "link-header" });
    // The body IS the array — no envelope.
    expect(task.rowsPath).toBe("");
  });

  it("🔴 refuses a Link rel=\"next\" that points off api.github.com — with the owner's token never sent there", async () => {
    // A `Link` header is VENDOR-controlled input, and the connector takes the
    // URL verbatim. Without the per-request exact-host re-guard, a next-page
    // URL on another host would be fetched WITH the Authorization header.
    // EXACTLY ONE call: the second was refused before it left.
    const { connector, calls } = connectorWith([
      { body: [ISSUE], headers: { link: '<https://evil.example.net/issues?page=2>; rel="next"' } },
    ]);
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      UnsafeBaseUrlError,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.github.com");
  });

  it("🔴 reads the rows from the ROOT of the body — an envelope is a contract error, not an empty read", async () => {
    // GitHub answers `GET /issues` with a bare JSON array. A profile that
    // reached for `issues` or `items` (the SEARCH endpoint's envelope) would
    // find no array and report… nothing. The connector refuses instead, and
    // `absentRowsMeansEmpty` stays UNSET so that refusal survives: with it
    // set, a wrong `rowsPath` would read as "no issues" on every sync.
    // Mutation: set `rowsPath: "items"` or `absentRowsMeansEmpty: true` -> red.
    const task = GITHUB_PROFILE.datasets.find((d) => d.dataset === "task")!;
    expect(task.absentRowsMeansEmpty).toBeUndefined();

    const { connector } = connectorWith([{ body: { items: [ISSUE], total_count: 1 } }]);
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      RestPaginationContractError,
    );

    // And a genuinely empty page IS a bare empty array, and reads as zero rows.
    const empty = connectorWith([{ body: [] }]);
    expect(await empty.connector.runRead("get_tasks_by_status", { since: SINCE })).toEqual([]);
  });

  it("🔴 projects the documented example row onto every column it can fill, from the paths the docs show", async () => {
    // Each path below is present in the endpoint page's 200 example. The
    // fixture is that example.
    // Mutation: map `task_id: "number"` (the per-repo issue number, NOT
    // unique across repos) -> red on the first line; `project_id:
    // "repository_url"` -> red on the second.
    const { connector } = connectorWith([{ body: [ISSUE] }]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }))[0]!;

    // `id` is the issue's GLOBAL id; `number` is per-repository and collides
    // across the repos one token can see. Numeric vendor ids are stringified
    // by the canonical text coercion.
    expect(row.task_id).toBe("1");
    expect(row.task_id).not.toBe("1347");
    // The repository's numeric id — the only stable project key on the row.
    expect(row.project_id).toBe("1296269");
    expect(row.title).toBe("Found a bug");
    // `state` is `open` | `closed`, verbatim. That is what
    // `get_tasks_by_status`'s `status` parameter compares against.
    expect(row.status).toBe("open");
    expect(row.created_at).toBe("2011-04-22T13:33:48.000Z");
    expect(row.updated_at).toBe("2011-04-22T13:33:48.000Z");
    // `closed_at` is `null` on an open issue — absent, not the epoch.
    expect("closed_at" in row).toBe(true);
    expect(row.closed_at).toBeUndefined();
  });

  it("🔴 takes assignee_id from `assignees[0].id`, NOT from the singular `assignee` — which the 2026-03-10 API version removes", async () => {
    // breaking-changes (2026-03-10): the singular `assignee` field is removed
    // from Issue and Pull Request responses; `assignees` stays. Reading the
    // array is right under BOTH versions. The fixture below carries NO
    // singular `assignee` at all, so a "helpful" `assignee.id ?? …` fallback
    // cannot pass it either.
    //
    // LOSSY and knowingly so: an issue can have several assignees and the
    // canonical column holds one. The first is GitHub's own ordering.
    // Mutation: read `assignee.id` -> red here; read `assignees.0.id` -> red
    // in rest-track.test.ts's egress-shaped-path pin AND here.
    const { connector } = connectorWith([
      {
        body: [
          {
            ...ISSUE,
            assignee: undefined,
            assignees: [
              { login: "hubot", id: 42, type: "Bot" },
              { login: "octocat", id: 1, type: "User" },
            ],
          },
        ],
      },
    ]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }))[0]!;
    expect(row.assignee_id).toBe("42");

    // An unassigned issue has `assignees: []` — undefined, never a fabricated id.
    const none = connectorWith([{ body: [{ ...ISSUE, assignee: null, assignees: [] }] }]);
    const unassigned = rowsOf(await none.connector.runRead("get_tasks_by_status", { since: SINCE }))[0]!;
    expect("assignee_id" in unassigned).toBe(true);
    expect(unassigned.assignee_id).toBeUndefined();
  });

  it("🔴 leaves `priority` UNDEFINED — GitHub issues have no priority, and a label is not one", async () => {
    // The Issue object has no priority property. Labels are free text (`bug`,
    // `P1`, `urgent`, `wontfix`…) and the track has no label→priority
    // transform; guessing one would put a made-up ranking in a column
    // `get_tasks_by_status` returns to the model as fact.
    // Mutation: `priority: "labels[0].name"` -> red.
    const { connector } = connectorWith([{ body: [ISSUE] }]);
    const row = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }))[0]!;
    expect("priority" in row).toBe(true);
    expect(row.priority).toBeUndefined();
    expect(Object.values(row)).not.toContain("bug");
  });

  it("🔴 lands a PULL REQUEST as a `task` row too — recorded, because the track cannot filter it out", async () => {
    // Endpoint page: "GitHub's REST API considers every pull request an
    // issue", so `GET /issues` returns both, and a PR is told apart only by
    // the presence of the `pull_request` key. The declarative track has no
    // per-row filter, and the undocumented `pulls` parameter is not sent (see
    // above), so a PR is a `task` on this box. Its `id` is the ISSUE id, not
    // the pull-request id — consistent within this dataset, but it does not
    // join to `/pulls` ids.
    //
    // This is the honest reading of what the owner asked for: "issues (and
    // PRs) across every repo the token can see" — the ticket's own title.
    // Mutation: a "clever" filter on `pull_request` in the connector ->
    // this goes red, and the change belongs on the track, not hidden here.
    const { connector } = connectorWith([{ body: [ISSUE] }]);
    const rows = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE }));
    expect(ISSUE.pull_request).toBeDefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_id).toBe("1");
  });

  it("narrows by `status` the way get_tasks_by_status documents — on GitHub's own `open`/`closed`", async () => {
    // The read query's filter is `equals` on `status`. GitHub's `state` is
    // exactly `open` or `closed`, so those are the two values a caller can
    // ask for; anything else matches nothing rather than everything.
    const { connector } = connectorWith([
      {
        body: [
          { ...ISSUE, id: 1, state: "open" },
          { ...ISSUE, id: 2, state: "closed", closed_at: "2026-09-02T10:00:00Z" },
        ],
      },
    ]);
    const closed = rowsOf(await connector.runRead("get_tasks_by_status", { since: SINCE, status: "closed" }));
    expect(closed.map((r) => r.task_id)).toEqual(["2"]);
    expect(closed[0]!.closed_at).toBe("2026-09-02T10:00:00.000Z");
  });
});

// ── rate limiting is not a bad key ──────────────────────────────────────────

describe("GitHub — a 403 that is a rate limit is NOT a rejected credential", () => {
  it("🔴 classifies 403 + retry-after as a vendor error and keeps the credential", async () => {
    // rate-limits-for-the-rest-api#exceeding-the-rate-limit: exhausting the
    // primary OR a secondary limit answers "a 403 or 429 response", with
    // `retry-after` on secondary limits and `x-ratelimit-remaining: 0` on the
    // primary. The shared connector used to read EVERY 403 as "the vendor
    // rejected the credential" — evicting the cached token and telling the
    // owner to paste a new key for a condition that clears itself in an hour.
    // GitHub is the verified failure that admitted the connector change
    // (rest-track.test.ts pins the generic rule; this is the vendor's face
    // of it).
    // Mutation: revert the 403 classification in connector.ts -> red.
    let resolves = 0;
    const { impl } = stubFetch([
      { body: { message: "API rate limit exceeded" }, status: 403, headers: { "retry-after": "60" } },
    ]);
    const connector = new RestProfileConnector(
      GITHUB_PROFILE,
      { provider: GITHUB_PROVIDER },
      {
        fetchImpl: impl,
        resolveCredentials: async () => {
          resolves += 1;
          return { token: TOKEN };
        },
      },
    );
    const err = (await connector.runRead("get_tasks_by_status", { since: SINCE }).catch((e: unknown) => e)) as RestVendorError;
    expect(err).toBeInstanceOf(RestVendorError);
    expect(err).not.toBeInstanceOf(ConnectorBlockedError);
    expect(err.status).toBe(403);
    // Not evicted: the next attempt does not go back to the sealed store.
    await connector.runRead("get_tasks_by_status", { since: SINCE }).catch(() => undefined);
    expect(resolves).toBe(1);
  });

  it("🔴 classifies 403 + x-ratelimit-remaining: 0 the same way", async () => {
    const { impl } = stubFetch([
      {
        body: { message: "API rate limit exceeded for user" },
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1758200000" },
      },
    ]);
    const connector = new RestProfileConnector(
      GITHUB_PROFILE,
      { provider: GITHUB_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => ({ token: TOKEN }) },
    );
    await expect(connector.connect()).rejects.toThrow(RestVendorError);
  });

  it("still reads a PLAIN 403 as a rejected credential — the lockout GitHub documents after repeated bad auth", async () => {
    // authenticating-to-the-rest-api: repeated invalid credentials make
    // GitHub "temporarily reject all authentication attempts for that user
    // (including ones with valid credentials) with a 403". That 403 carries
    // no rate-limit header, and it IS about the credential — so it keeps the
    // "paste a new key" path, and the eviction that stops the connector
    // replaying the token GitHub is refusing.
    const { impl } = stubFetch([{ body: { message: "Bad credentials" }, status: 403 }]);
    const connector = new RestProfileConnector(
      GITHUB_PROFILE,
      { provider: GITHUB_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => ({ token: TOKEN }) },
    );
    await expect(connector.connect()).rejects.toThrow(ConnectorBlockedError);
  });
});

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * 🔴 ADR-046 §3 and `rest-track.test.ts`'s own header state the rule: **a
 * refusal asserts `fetch` was called ZERO times**, never merely that an error
 * was thrown. A test that inspected only the returned error would still pass
 * if the request had already gone out carrying the owner's token.
 */
describe("GitHub — the refusals, each costing ZERO fetch calls", () => {
  function connectorWithCredentials(creds: Record<string, string>) {
    const { impl, calls } = stubFetch([{ body: [] }]);
    const connector = new RestProfileConnector(
      GITHUB_PROFILE,
      { provider: GITHUB_PROVIDER },
      { fetchImpl: impl, resolveCredentials: async () => creds },
    );
    return { connector, calls };
  }

  it("🔴 refuses a read when the stored credential has no token — ZERO fetch calls", async () => {
    // Sending the literal `{{token}}` would land in GitHub's logs as a failed
    // auth — and GitHub counts failed auths toward the lockout above.
    const { connector, calls } = connectorWithCredentials({});
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      /has no "token"/,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a blank token as firmly as a missing one — ZERO fetch calls", async () => {
    const { connector, calls } = connectorWithCredentials({ token: "\t \n" });
    await expect(connector.connect()).rejects.toThrow(/has no "token"/);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a dataset GitHub does not serve — ZERO fetch calls, and NOT an empty array", async () => {
    // This profile serves `task` and nothing else. Asked for bookings, money
    // or a patient record, the connection refuses by NAME.
    for (const name of ["get_bookings", "get_recent_charges", "get_ar_summary", "get_tickets_by_status"]) {
      const { connector, calls } = connectorWithCredentials({ token: TOKEN });
      await expect(connector.runRead(name, { since: SINCE }), name).rejects.toThrow(
        DatasetNotServedError,
      );
      expect(calls, name).toHaveLength(0);
    }
  });

  it("🔴 refuses every write, and spends no call finding out — the track is read-only", async () => {
    // ADR-046 §4. GitHub HAS a full write API for issues; the refusal is the
    // track's, not the vendor's, and it costs no request.
    const { connector, calls } = connectorWithCredentials({ token: TOKEN });
    await expect(connector.applyWrite("reschedule_appointment", {})).rejects.toThrow(
      ConnectorBlockedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses to build against a provider id that is not GitHub's — ZERO fetch calls", async () => {
    // A GHES profile will be its own provider id with its own profile. A row
    // naming one and dispatched to the other must fail at CONSTRUCTION.
    const { impl, calls } = stubFetch([{ body: [] }]);
    expect(
      () =>
        new RestProfileConnector(
          GITHUB_PROFILE,
          { provider: "github-enterprise" },
          { fetchImpl: impl, resolveCredentials: async () => ({ token: TOKEN }) },
        ),
    ).toThrow(ConnectorBlockedError);
    expect(calls).toHaveLength(0);
  });

  it("🔴 refuses a 302 rather than following it off api.github.com", async () => {
    // EXACTLY ONE call: the redirect was not followed, and the token did not
    // go where the Location header pointed.
    const { connector, calls } = connectorWith([
      { body: {}, status: 302, headers: { location: "https://evil.example.net/issues" } },
    ]);
    await expect(connector.runRead("get_tasks_by_status", { since: SINCE })).rejects.toThrow(
      UnsafeBaseUrlError,
    );
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).host).toBe("api.github.com");
  });
});
