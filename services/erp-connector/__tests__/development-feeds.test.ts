/**
 * WARP-3535 — the development feeds of a REST profile, as pure functions.
 *
 * What is pinned here is what a copy pass or a "tidy" would round off:
 *   - a merged GitHub pull request is `state: closed` + `merged_at`, and rule
 *     ORDER is the semantics;
 *   - a URL a host sends is checked against the host's own web hosts, so a
 *     `javascript:` link or a link elsewhere never reaches an <a href>;
 *   - a repository reference can never carry a traversal into a path;
 *   - text a host sends is made safe for Postgres (no NUL, no lone surrogate)
 *     before it is stored, so one odd title cannot wedge a repository's sync.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_FEED_NAMES,
  FEED_FIELDS,
  cleanBlock,
  cleanLine,
  developmentSpecProblems,
  isSafeRepoRef,
  mapFeedRow,
  parseRateLimit,
  safeWebUrl,
  stateOf,
  type MapContext,
  type RestDevelopmentSpec,
} from "../src/rest/development.js";
import { GITHUB_DEVELOPMENT, GITHUB_PROFILE } from "../src/rest/vendors/github.js";
import { GITLAB_DEVELOPMENT, GITLAB_PROFILE } from "../src/rest/vendors/gitlab.js";
import { assertValidRestProfile, InvalidRestProfileError } from "../src/rest/profile.js";
import { REST_VENDOR_PROFILES } from "../src/rest/profiles.js";

const gh: MapContext = {
  webHosts: GITHUB_DEVELOPMENT.webHosts,
  repoRefPattern: GITHUB_DEVELOPMENT.repoRef.pattern,
  repoWebUrl: "https://github.com/acme/widgets",
};
const gl: MapContext = {
  webHosts: GITLAB_DEVELOPMENT.webHosts,
  repoRefPattern: GITLAB_DEVELOPMENT.repoRef.pattern,
  repoWebUrl: "https://gitlab.com/acme/widgets",
};

/** A GitHub `GET /repos/{o}/{r}/pulls` row, trimmed to what the API sends. */
function ghPull(over: Record<string, unknown> = {}) {
  return {
    id: 1001,
    number: 42,
    state: "open",
    draft: false,
    title: "WARP-12 fix the login redirect",
    body: "Closes WARP-12",
    user: { login: "octocat" },
    head: { ref: "warp-12-login-redirect", sha: "abc" },
    html_url: "https://github.com/acme/widgets/pull/42",
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-03T09:30:00Z",
    merged_at: null,
    ...over,
  };
}

/** A GitLab `GET /projects/:id/merge_requests` row. */
function glMr(over: Record<string, unknown> = {}) {
  return {
    id: 5005,
    iid: 7,
    state: "opened",
    draft: false,
    title: "WARP-12 fix the login redirect",
    description: "Closes WARP-12",
    author: { username: "tanuki" },
    source_branch: "warp-12-login-redirect",
    web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
    updated_at: "2026-10-03T09:30:00.000Z",
    merged_at: null,
    ...over,
  };
}

describe("pull-request state — rule order is the semantics", () => {
  const ghState = (over: Record<string, unknown>) =>
    mapFeedRow("pullRequestsRecent", GITHUB_DEVELOPMENT.pullRequestsRecent, ghPull(over), gh);

  it.each([
    ["open", { state: "open", draft: false, merged_at: null }, "OPEN"],
    ["open draft", { state: "open", draft: true, merged_at: null }, "DRAFT"],
    ["closed unmerged", { state: "closed", draft: false, merged_at: null }, "CLOSED"],
    // The case a naive `state` read gets wrong: GitHub has no "merged" state.
    // Mutation: read `state` alone -> MERGED comes out CLOSED and this goes red.
    ["merged", { state: "closed", draft: false, merged_at: "2026-10-03T09:00:00Z" }, "MERGED"],
    // A draft that was closed is CLOSED, not DRAFT. Mutation: move the draft rule
    // above the closed rule -> red.
    ["closed draft", { state: "closed", draft: true, merged_at: null }, "CLOSED"],
    ["merged draft", { state: "closed", draft: true, merged_at: "2026-10-03T09:00:00Z" }, "MERGED"],
  ])("GitHub %s -> %s", (_label, over, expected) => {
    expect(ghState(over)).toMatchObject({ type: "pull_request", state: expected });
  });

  it.each([
    ["opened", { state: "opened", draft: false }, "OPEN"],
    ["opened draft", { state: "opened", draft: true }, "DRAFT"],
    ["closed", { state: "closed", draft: false }, "CLOSED"],
    ["merged", { state: "merged", draft: false }, "MERGED"],
    ["merged but once a draft", { state: "merged", draft: true }, "MERGED"],
    ["closed but once a draft", { state: "closed", draft: true }, "CLOSED"],
    ["locked (a merge in flight) reads as closed", { state: "locked", draft: false }, "CLOSED"],
  ])("GitLab %s -> %s", (_label, over, expected) => {
    expect(
      mapFeedRow("pullRequestsRecent", GITLAB_DEVELOPMENT.pullRequestsRecent, glMr(over), gl),
    ).toMatchObject({ state: expected });
  });

  it("skips a row whose state no rule names, rather than guessing OPEN", () => {
    // Mutation: add a catch-all `OPEN` rule -> this row appears and the test goes red.
    expect(ghState({ state: "teleported" })).toBeNull();
    expect(stateOf({ state: "x" }, [])).toBeNull();
  });

  it("evaluates equals, oneOf and present conditions", () => {
    expect(stateOf({ a: "x" }, [{ when: { path: "a", equals: "x" }, state: "OPEN" }])).toBe("OPEN");
    expect(stateOf({ a: "y" }, [{ when: { path: "a", oneOf: ["x", "y"] }, state: "CLOSED" }])).toBe("CLOSED");
    expect(stateOf({ a: "" }, [{ when: { path: "a", present: true }, state: "MERGED" }])).toBeNull();
    expect(stateOf({ a: null }, [{ when: { path: "a", present: false }, state: "MERGED" }])).toBe("MERGED");
    expect(stateOf({ a: { b: true } }, [{ when: { path: "a.b", equals: true }, state: "DRAFT" }])).toBe("DRAFT");
  });
});

describe("mapping a pull request", () => {
  it("carries what the panel shows and what matching reads", () => {
    expect(mapFeedRow("pullRequestsOpen", GITHUB_DEVELOPMENT.pullRequestsOpen, ghPull(), gh)).toEqual({
      type: "pull_request",
      externalId: "1001", // the issue-independent GLOBAL id, as text
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      title: "WARP-12 fix the login redirect",
      body: "Closes WARP-12",
      author: "octocat",
      branch: "warp-12-login-redirect",
      state: "OPEN",
      updatedAt: new Date("2026-10-03T09:30:00Z"),
    });
  });

  it("maps a GitLab merge request, with `!iid` as the number and the global id as identity", () => {
    expect(mapFeedRow("pullRequestsOpen", GITLAB_DEVELOPMENT.pullRequestsOpen, glMr(), gl)).toMatchObject({
      externalId: "5005", // `id`, never `iid`: iid is unique only inside a project
      number: 7,
      branch: "warp-12-login-redirect",
      author: "tanuki",
      url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
    });
  });

  it.each([
    ["no id", { id: undefined }],
    ["no title", { title: "   " }],
    ["no update time", { updated_at: undefined }],
    ["an unparseable update time", { updated_at: "last tuesday" }],
    ["no url", { html_url: undefined }],
  ])("skips a row with %s", (_label, over) => {
    expect(mapFeedRow("pullRequestsOpen", GITHUB_DEVELOPMENT.pullRequestsOpen, ghPull(over), gh)).toBeNull();
  });

  it("keeps a row with no body, branch or author (all optional) and a non-positive number as null", () => {
    const item = mapFeedRow(
      "pullRequestsOpen",
      GITHUB_DEVELOPMENT.pullRequestsOpen,
      ghPull({ body: null, user: null, head: null, number: 0 }),
      gh,
    );
    expect(item).toMatchObject({ body: null, author: null, branch: null, number: null });
  });
});

describe("URLs — only https on the host's own web hosts ever become a link", () => {
  const pr = (html_url: unknown) =>
    mapFeedRow("pullRequestsOpen", GITHUB_DEVELOPMENT.pullRequestsOpen, ghPull({ html_url }), gh);

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<script>1</script>"],
    ["http://github.com/acme/widgets/pull/42"], // https only
    ["https://evil.example/acme/widgets/pull/42"],
    ["https://github.com.evil.example/acme/widgets/pull/42"],
    ["https://github.com@evil.example/pull/1"],
    ["https://user:pw@github.com/acme/widgets/pull/42"],
    ["https://github.com:8443/acme/widgets/pull/42"],
    ["//github.com/acme/widgets/pull/42"],
    ["/acme/widgets/pull/42"],
    [""],
    [42],
    [null],
  ])("refuses %s", (value) => {
    // Mutation: drop the host check, or accept any https URL -> red.
    expect(pr(value)).toBeNull();
  });

  it("accepts the host in any case and normalises it", () => {
    expect(pr("HTTPS://GitHub.com/acme/widgets/pull/42")).toMatchObject({
      url: "https://github.com/acme/widgets/pull/42",
    });
  });

  it("does not follow a host's subdomain unless it is listed", () => {
    expect(safeWebUrl("https://gist.github.com/x", ["github.com"])).toBeNull();
    expect(safeWebUrl("https://gist.github.com/x", ["github.com", "gist.github.com"])).toBe("https://gist.github.com/x");
  });

  it("refuses a URL over 2000 characters", () => {
    expect(safeWebUrl(`https://github.com/${"a".repeat(2000)}`, ["github.com"])).toBeNull();
  });
});

describe("text a host sends is made safe before it is stored", () => {
  it("drops control characters, including NUL, which Postgres cannot store", () => {
    const nul = String.fromCharCode(0);
    const bel = String.fromCharCode(7);
    expect(cleanLine(`fix${nul} the${bel} thing`, 300)).toBe("fix the thing");
    // The two Unicode line separators are not a newline to a JS regex literal or
    // to most renderers; they go with the controls.
    expect(cleanLine(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`, 300)).toBe("abc");
  });

  it("collapses whitespace in a line and keeps newlines in a block", () => {
    expect(cleanLine("  fix \n the \t thing  ", 300)).toBe("fix the thing");
    expect(cleanBlock("line one\nline two\n", 1000)).toBe("line one\nline two");
  });

  it("replaces a lone surrogate, which a JSON escape can produce and Postgres refuses", () => {
    // Mutation: remove the replacement -> the string below keeps a lone half and
    // `encodeURIComponent` throws on it, which is exactly what the database does.
    const out = cleanLine(`bad ${String.fromCharCode(0xd800)} title`, 300) ?? "";
    expect(out).toBe("bad � title");
    expect(() => encodeURIComponent(out)).not.toThrow();
    const trailing = cleanLine(`x${String.fromCharCode(0xdc00)}`, 300) ?? "";
    expect(() => encodeURIComponent(trailing)).not.toThrow();
  });

  it("keeps a well-formed pair", () => {
    expect(cleanLine("ship it 🚀", 300)).toBe("ship it 🚀");
  });

  it("never cuts a surrogate pair in half when it truncates", () => {
    const text = `${"a".repeat(4)}🚀`; // 4 + a 2-unit pair
    const cut = cleanLine(text, 5) ?? "";
    expect(cut).toBe("aaaa");
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });

  it("bounds a title at 300 and a match body at 64 KiB", () => {
    expect(cleanLine("x".repeat(1000), 300)).toHaveLength(300);
    const pr = mapFeedRow(
      "pullRequestsOpen",
      GITHUB_DEVELOPMENT.pullRequestsOpen,
      ghPull({ body: "b".repeat(200_000) }),
      gh,
    );
    expect(pr && pr.type === "pull_request" && pr.body?.length).toBe(65_536);
  });

  it("returns null for non-strings and for text that is empty once cleaned", () => {
    expect(cleanLine(12, 10)).toBeNull();
    expect(cleanLine("   ", 10)).toBeNull();
    expect(cleanLine(String.fromCharCode(0), 10)).toBeNull();
  });
});

describe("mapping a commit", () => {
  const row = {
    sha: "3F9A1C2D4E5B6A7988776655443322110FEDCBA9",
    html_url: "https://github.com/acme/widgets/commit/3f9a1c2",
    commit: {
      message: "WARP-12 fix the redirect\n\nRefs: WARP-12\nAlso touches WARP-13",
      author: { name: "Octo Cat", date: "2026-10-03T08:00:00Z" },
      committer: { date: "2026-10-03T08:05:00Z" },
    },
  };

  it("keeps the whole message for matching and its first line as the title", () => {
    expect(mapFeedRow("commits", GITHUB_DEVELOPMENT.commits, row, gh)).toEqual({
      type: "commit",
      externalId: "3f9a1c2d4e5b6a7988776655443322110fedcba9", // lowercased
      url: "https://github.com/acme/widgets/commit/3f9a1c2",
      message: "WARP-12 fix the redirect\n\nRefs: WARP-12\nAlso touches WARP-13",
      title: "WARP-12 fix the redirect",
      author: "Octo Cat",
      committedAt: new Date("2026-10-03T08:05:00Z"),
    });
  });

  it("orders on the COMMITTER date: an author date survives a rebase, the committer's does not", () => {
    const item = mapFeedRow("commits", GITHUB_DEVELOPMENT.commits, row, gh);
    expect(item && item.type === "commit" && item.committedAt.toISOString()).toBe("2026-10-03T08:05:00.000Z");
  });

  it("maps a GitLab commit", () => {
    expect(
      mapFeedRow(
        "commits",
        GITLAB_DEVELOPMENT.commits,
        {
          id: "3f9a1c2d4e5b6a7988776655443322110fedcba9",
          web_url: "https://gitlab.com/acme/widgets/-/commit/3f9a1c2d",
          message: "WARP-12 fix\n",
          author_name: "Tanuki",
          committed_date: "2026-10-03T08:05:00.000+00:00",
        },
        gl,
      ),
    ).toMatchObject({ title: "WARP-12 fix", message: "WARP-12 fix", author: "Tanuki" });
  });

  it.each([
    ["a sha that is not hex", { sha: "not-a-sha-at-all" }],
    ["a short sha under 7 characters", { sha: "abc12" }],
    ["no message", { commit: { message: "  ", committer: { date: "2026-10-03T08:05:00Z" } } }],
    ["no committed date", { commit: { message: "x", committer: {} } }],
  ])("skips a commit with %s", (_label, over) => {
    expect(mapFeedRow("commits", GITHUB_DEVELOPMENT.commits, { ...row, ...over }, gh)).toBeNull();
  });
});

describe("mapping a branch", () => {
  it("rejects an oversized repository URL before trimming its trailing slashes", () => {
    expect(mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "main" }, {
      ...gh, repoWebUrl: `${gh.repoWebUrl}${"/".repeat(10_000)}`,
    })).toBeNull();
  });

  it("trims repository URL suffix slashes while preserving branch path segments", () => {
    expect(mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "feature/fix" }, {
      ...gh, repoWebUrl: `${gh.repoWebUrl}///`,
    })).toMatchObject({ url: "https://github.com/acme/widgets/tree/feature/fix" });
  });

  it("builds GitHub's branch URL from the repository's web URL, encoding each segment but not the slashes", () => {
    expect(mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "feature/warp-12 login#1" }, gh)).toBeNull();
    expect(mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "feature/warp-12-login" }, gh)).toEqual({
      type: "branch",
      name: "feature/warp-12-login",
      url: "https://github.com/acme/widgets/tree/feature/warp-12-login",
    });
  });

  it("encodes characters that would end the path", () => {
    expect(mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "fix#12?x" }, gh)).toMatchObject({
      url: "https://github.com/acme/widgets/tree/fix%2312%3Fx",
    });
  });

  it("uses GitLab's own web_url and still checks its host", () => {
    expect(
      mapFeedRow(
        "branches",
        GITLAB_DEVELOPMENT.branches,
        { name: "warp-12", web_url: "https://gitlab.com/acme/widgets/-/tree/warp-12" },
        gl,
      ),
    ).toMatchObject({ url: "https://gitlab.com/acme/widgets/-/tree/warp-12" });
    expect(
      mapFeedRow("branches", GITLAB_DEVELOPMENT.branches, { name: "x", web_url: "https://evil.example/x" }, gl),
    ).toBeNull();
  });

  it("skips a name that changed under cleaning (a branch cannot hold what cleaning removes)", () => {
    expect(mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "a  b" }, gh)).toBeNull();
    expect(mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "" }, gh)).toBeNull();
  });

  it("builds nothing without a repository web URL to hang the template on", () => {
    expect(
      mapFeedRow("branches", GITHUB_DEVELOPMENT.branches, { name: "x" }, { ...gh, repoWebUrl: undefined }),
    ).toBeNull();
  });
});

describe("mapping a repository", () => {
  it("maps GitHub's list row, taking full_name as the API reference", () => {
    expect(
      mapFeedRow(
        "repositories",
        GITHUB_DEVELOPMENT.repositories,
        { id: 77, full_name: "acme/widgets", html_url: "https://github.com/acme/widgets", default_branch: "main" },
        gh,
      ),
    ).toEqual({
      type: "repository",
      externalId: "77",
      apiRef: "acme/widgets",
      fullName: "acme/widgets",
      webUrl: "https://github.com/acme/widgets",
      defaultBranch: "main",
    });
  });

  it("maps GitLab's project row, addressing it by NUMERIC id in a path", () => {
    expect(
      mapFeedRow(
        "repositories",
        GITLAB_DEVELOPMENT.repositories,
        { id: 4242, path_with_namespace: "acme/widgets", web_url: "https://gitlab.com/acme/widgets", default_branch: "trunk" },
        gl,
      ),
    ).toMatchObject({ externalId: "4242", apiRef: "4242", fullName: "acme/widgets", defaultBranch: "trunk" });
  });

  it("refuses a repository whose reference is not one a path may carry", () => {
    // Mutation: skip `isSafeRepoRef` in the mapper -> this lands in the picker.
    for (const full_name of ["acme/../admin", "../acme", "acme", "acme/widgets/extra", "acme/wid gets"]) {
      expect(
        mapFeedRow(
          "repositories",
          GITHUB_DEVELOPMENT.repositories,
          { id: 1, full_name, html_url: "https://github.com/acme/widgets" },
          gh,
        ),
        full_name,
      ).toBeNull();
    }
    expect(
      mapFeedRow(
        "repositories",
        GITLAB_DEVELOPMENT.repositories,
        { id: "9; DROP", path_with_namespace: "a/b", web_url: "https://gitlab.com/a/b" },
        gl,
      ),
    ).toBeNull();
  });
});

describe("isSafeRepoRef", () => {
  const ghPattern = GITHUB_DEVELOPMENT.repoRef.pattern;
  it.each(["acme/widgets", "acme/.github", "my-org/my.repo_v2", "a/b"])("accepts %s", (ref) => {
    expect(isSafeRepoRef(ref, ghPattern)).toBe(true);
  });

  it.each([
    ["a parent segment", "acme/../admin"],
    ["a trailing parent segment", "acme/.."],
    ["a leading parent segment", "../widgets"],
    ["a dot segment", "acme/."],
    ["an encoded traversal", "acme/%2e%2e"],
    ["a query", "acme/widgets?x=1"],
    ["a fragment", "acme/widgets#x"],
    ["a space", "acme/wid gets"],
    ["a backslash", "acme\\widgets"],
    ["three segments", "acme/widgets/extra"],
    ["one segment", "widgets"],
    ["empty", ""],
    ["over 200 characters", `${"a".repeat(100)}/${"b".repeat(101)}`],
  ])("refuses %s", (_label, ref) => {
    // Mutation: drop the segment rule -> `acme/..` passes the pattern and goes red.
    expect(isSafeRepoRef(ref, ghPattern)).toBe(false);
  });

  it("holds the segment rule whatever the pattern says", () => {
    expect(isSafeRepoRef("acme/..", "^.+$")).toBe(false);
  });

  it("takes GitLab's numeric ids only", () => {
    const p = GITLAB_DEVELOPMENT.repoRef.pattern;
    expect(isSafeRepoRef("1234567", p)).toBe(true);
    for (const ref of ["acme/widgets", "12a", "-1", "1e5", ""]) expect(isSafeRepoRef(ref, p), ref).toBe(false);
  });
});

describe("parseRateLimit — each host spells it its own way", () => {
  const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

  it("reads GitHub's x-ratelimit-* and GitLab's ratelimit-*", () => {
    expect(
      parseRateLimit(
        headers({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "1791000000" }),
        GITHUB_DEVELOPMENT.rateLimit,
      ),
    ).toEqual({ limit: 5000, remaining: 4990, resetAt: new Date(1791000000 * 1000) });
    expect(
      parseRateLimit(
        headers({ "ratelimit-limit": "2000", "ratelimit-remaining": "3", "ratelimit-reset": "1791000300" }),
        GITLAB_DEVELOPMENT.rateLimit,
      ),
    ).toEqual({ limit: 2000, remaining: 3, resetAt: new Date(1791000300 * 1000) });
  });

  it("does not read one host's spelling off the other's headers (silent zero reading is the failure)", () => {
    // Mutation: share one header spelling -> GitLab's headers read as null and the
    // box never sees its allowance fall, so it spends the whole hour.
    expect(
      parseRateLimit(headers({ "ratelimit-remaining": "3" }), GITHUB_DEVELOPMENT.rateLimit),
    ).toBeNull();
  });

  it("answers null when the response says nothing, and null per field when a value is not a whole number", () => {
    expect(parseRateLimit(headers({}), GITHUB_DEVELOPMENT.rateLimit)).toBeNull();
    // Nothing usable in any of the three is the same as nothing said.
    expect(
      parseRateLimit(
        headers({ "x-ratelimit-limit": "lots", "x-ratelimit-remaining": "-4", "x-ratelimit-reset": "1.5" }),
        GITHUB_DEVELOPMENT.rateLimit,
      ),
    ).toBeNull();
    // One usable value among the garbage is kept, the rest are null.
    expect(
      parseRateLimit(
        headers({ "x-ratelimit-limit": "lots", "x-ratelimit-remaining": "12", "x-ratelimit-reset": "soon" }),
        GITHUB_DEVELOPMENT.rateLimit,
      ),
    ).toEqual({ limit: null, remaining: 12, resetAt: null });
  });

  it("keeps a remaining of exactly 0, which is the case that matters", () => {
    expect(parseRateLimit(headers({ "x-ratelimit-remaining": "0" }), GITHUB_DEVELOPMENT.rateLimit)?.remaining).toBe(0);
  });
});

describe("the spec validator — a malformed spec fails to BUILD", () => {
  const clone = (): { -readonly [K in keyof RestDevelopmentSpec]: RestDevelopmentSpec[K] } =>
    JSON.parse(JSON.stringify(GITHUB_DEVELOPMENT));

  it("accepts both shipped specs", () => {
    expect(developmentSpecProblems(GITHUB_DEVELOPMENT)).toEqual([]);
    expect(developmentSpecProblems(GITLAB_DEVELOPMENT)).toEqual([]);
  });

  it.each([
    ["a feed path with no {repo}", (s: ReturnType<typeof clone>) => void (s.commits = { ...s.commits, path: "/commits" }), /exactly one \{repo\}/],
    ["an unknown placeholder", (s: ReturnType<typeof clone>) => void (s.commits = { ...s.commits, path: "/r/{repo}/{owner}" }), /exactly one \{repo\}/],
    ["a placeholder on the repository list", (s: ReturnType<typeof clone>) => void (s.repositories = { ...s.repositories, path: "/{repo}" }), /takes no placeholder/],
    ["a page ceiling of zero", (s: ReturnType<typeof clone>) => void (s.commits = { ...s.commits, maxPages: 0 }), /maxPages/],
    ["a page ceiling over ten", (s: ReturnType<typeof clone>) => void (s.commits = { ...s.commits, maxPages: 11 }), /maxPages/],
    ["a pull-request feed with no state rules", (s: ReturnType<typeof clone>) => void (s.pullRequestsOpen = { ...s.pullRequestsOpen, stateRules: [] }), /stateRules/],
    ["state rules on commits", (s: ReturnType<typeof clone>) => void (s.commits = { ...s.commits, stateRules: [{ when: { path: "a", present: true }, state: "OPEN" }] }), /only pull-request feeds/],
    ["a missing required field", (s: ReturnType<typeof clone>) => void delete (s.commits.fieldMap as Record<string, string>).committedAt, /does not map "committedAt"/],
    ["a field nothing reads", (s: ReturnType<typeof clone>) => void ((s.commits.fieldMap as Record<string, string>).color = "x"), /never reads/],
    ["a branch with no url and no template", (s: ReturnType<typeof clone>) => void (s.branches = { ...s.branches, urlTemplate: undefined }), /needs a url/],
    ["a template with an unknown hole", (s: ReturnType<typeof clone>) => void (s.branches = { ...s.branches, urlTemplate: "{webUrl}/{sha}" }), /unknown/],
    ["newestFirst on branches", (s: ReturnType<typeof clone>) => void (s.branches = { ...s.branches, newestFirst: true }), /sort key/],
    ["single on a list", (s: ReturnType<typeof clone>) => void (s.commits = { ...s.commits, single: true }), /single/],
    ["a repository feed that is not single", (s: ReturnType<typeof clone>) => void (s.repository = { ...s.repository, single: false }), /single/],
    ["an invalid repo pattern", (s: ReturnType<typeof clone>) => void (s.repoRef = { pattern: "(" }), /regular expression/],
    ["no web hosts", (s: ReturnType<typeof clone>) => void (s.webHosts = []), /webHosts is empty/],
    ["a web host that is a URL", (s: ReturnType<typeof clone>) => void (s.webHosts = ["https://github.com"]), /bare lowercase host/],
    ["an upper-case header name", (s: ReturnType<typeof clone>) => void (s.rateLimit = { ...s.rateLimit, reset: "X-RateLimit-Reset" }), /lowercase header/],
  ])("reports %s", (_label, mutate, expected) => {
    const spec = clone();
    mutate(spec);
    expect(developmentSpecProblems(spec as RestDevelopmentSpec).join(" | ")).toMatch(expected);
  });

  it("is run by assertValidRestProfile, so a bad spec cannot register", () => {
    const bad = { ...GITHUB_PROFILE, development: { ...GITHUB_DEVELOPMENT, webHosts: [] } };
    expect(() => assertValidRestProfile(bad)).toThrow(InvalidRestProfileError);
    expect(() => assertValidRestProfile(bad)).toThrow(/development: webHosts is empty/);
  });

  it("every FEED_FIELDS key is a feed the spec has, and every feed has a FEED_FIELDS row", () => {
    expect(Object.keys(FEED_FIELDS).sort()).toEqual([...DEVELOPMENT_FEED_NAMES].sort());
    for (const feed of DEVELOPMENT_FEED_NAMES) expect(GITHUB_DEVELOPMENT[feed], feed).toBeDefined();
  });
});

describe("the shipped specs say what the profile's own comments claim", () => {
  it("only GitHub and GitLab declare a development spec", () => {
    expect(REST_VENDOR_PROFILES.filter((p) => p.development).map((p) => p.provider).sort()).toEqual([
      "github",
      "gitlab",
    ]);
  });

  it("keeps the existing `task` dataset untouched beside it", () => {
    expect(GITHUB_PROFILE.datasets.map((d) => d.dataset)).toEqual(["task"]);
    expect(GITLAB_PROFILE.datasets.map((d) => d.dataset)).toEqual(["task"]);
  });

  it("polls with a URL that stays still: no watermark in any feed's query (an ETag only holds if it does)", () => {
    // Mutation: add `since` / `updated_after` to a feed's query -> every poll is
    // a 200 and the conditional request buys nothing.
    for (const spec of [GITHUB_DEVELOPMENT, GITLAB_DEVELOPMENT]) {
      for (const feed of DEVELOPMENT_FEED_NAMES) {
        const keys = Object.keys(spec[feed].query ?? {});
        expect(keys, feed).not.toContain("since");
        expect(keys, feed).not.toContain("updated_after");
      }
    }
  });

  it("walks the two recent lists newest first and the open list unordered by cutoff", () => {
    for (const spec of [GITHUB_DEVELOPMENT, GITLAB_DEVELOPMENT]) {
      expect(spec.pullRequestsRecent.newestFirst).toBe(true);
      expect(spec.commits.newestFirst).toBe(true);
      expect(spec.pullRequestsOpen.newestFirst).toBeUndefined();
    }
  });

  it("addresses a GitLab project by numeric id and a GitHub repository by owner/name", () => {
    expect(GITLAB_DEVELOPMENT.repository.path).toBe("/api/v4/projects/{repo}");
    expect(GITHUB_DEVELOPMENT.repository.path).toBe("/repos/{repo}");
  });

  it("asks for no more than the hosts return per page", () => {
    for (const spec of [GITHUB_DEVELOPMENT, GITLAB_DEVELOPMENT]) {
      for (const feed of DEVELOPMENT_FEED_NAMES) {
        const perPage = spec[feed].query?.per_page;
        if (perPage !== undefined) expect(Number(perPage), feed).toBeLessThanOrEqual(100);
      }
    }
  });
});
