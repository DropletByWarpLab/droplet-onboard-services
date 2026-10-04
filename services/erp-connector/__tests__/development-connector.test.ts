/**
 * WARP-3535 — `RestProfileConnector.readDevelopment`, through the SAME choke
 * point every dataset read uses.
 *
 * The rule of the track holds here too: a refusal asserts `fetch` was called
 * ZERO times, never merely that an error was thrown. What is new is the
 * conditional first page (a 304 is an answer, but only to a request that asked)
 * and the early stop for a host with no `since` filter.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, expect, it } from "vitest";

import {
  RestCredentialRejectedError,
  RestPaginationContractError,
  RestProfileConnector,
  RestRateLimitedError,
  RestUnreachableError,
  RestVendorError,
} from "../src/rest/connector.js";
import { UnsafeBaseUrlError } from "../src/rest/host-guard.js";
import { ConnectorBlockedError, DatasetNotServedError } from "../src/connector.js";
import { GITHUB_PROFILE } from "../src/rest/vendors/github.js";
import { GITLAB_PROFILE } from "../src/rest/vendors/gitlab.js";
import { CALCOM_PROFILE } from "../src/rest/vendors/calcom.js";

interface Reply {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/** Recording fetch. A reply with no `body` and status 304 makes `json()` THROW,
 *  so a test that reaches for the body of a 304 fails loudly. */
function stubFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let n = 0;
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const reply = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    const status = reply.status ?? 200;
    const headers = reply.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } as unknown as Headers,
      json: async () => {
        if (reply.body === undefined) throw new Error("the body of this reply must not be read");
        return reply.body;
      },
      text: async () => JSON.stringify(reply.body ?? {}),
    } as unknown as Response;
  };
  return { impl: impl as never, calls };
}

const GH_TOKEN = "github_pat_test";
const never = async () => undefined;

function connector(
  replies: Reply[],
  opts: { profile?: typeof GITHUB_PROFILE; sleeps?: number[]; resolved?: { n: number } } = {},
) {
  const stub = stubFetch(replies);
  const profile = opts.profile ?? GITHUB_PROFILE;
  const c = new RestProfileConnector(
    profile,
    { provider: profile.provider },
    {
      fetchImpl: stub.impl,
      resolveCredentials: async () => {
        if (opts.resolved) opts.resolved.n += 1;
        return { token: GH_TOKEN };
      },
      sleep: opts.sleeps ? async (ms) => void opts.sleeps!.push(ms) : never,
      now: () => 1_000_000,
    },
  );
  return { c, ...stub };
}

const pull = (id: number, updated: string, over: Record<string, unknown> = {}) => ({
  id,
  number: id,
  state: "open",
  draft: false,
  title: `WARP-${id} work`,
  body: null,
  user: { login: "octocat" },
  head: { ref: `warp-${id}` },
  html_url: `https://github.com/acme/widgets/pull/${id}`,
  updated_at: updated,
  merged_at: null,
  ...over,
});

const LINK_NEXT = (url: string) => ({ link: `<${url}>; rel="next"` });

describe("readDevelopment — through the one choke point", () => {
  it("asks the host's own path, with the credential, the pinned API version and the declared query", async () => {
    const { c, calls } = connector([{ body: [pull(1, "2026-10-03T10:00:00Z")], headers: { etag: 'W/"abc"' } }]);
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/acme/widgets/pulls?state=open&sort=updated&direction=desc&per_page=100",
    );
    expect(calls[0]!.headers).toMatchObject({
      Authorization: `Bearer ${GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    });
    expect(calls[0]!.headers["If-None-Match"]).toBeUndefined();
    expect(res.status).toBe("ok");
    expect(res.etag).toBe('W/"abc"');
    expect(res.items).toHaveLength(1);
  });

  it("works for GitLab with its own header, path and numeric project id", async () => {
    const { c, calls } = connector(
      [
        {
          body: [
            {
              id: 5005, iid: 7, state: "opened", draft: false, title: "WARP-7 x", description: "",
              author: { username: "tanuki" }, source_branch: "warp-7",
              web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7", updated_at: "2026-10-03T09:30:00.000Z",
            },
          ],
          headers: { "ratelimit-limit": "2000", "ratelimit-remaining": "1999", "ratelimit-reset": "1791000000" },
        },
      ],
      { profile: GITLAB_PROFILE },
    );
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "4242" });
    expect(calls[0]!.url).toBe(
      "https://gitlab.com/api/v4/projects/4242/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=100",
    );
    expect(calls[0]!.headers["PRIVATE-TOKEN"]).toBe(GH_TOKEN);
    expect(res.items[0]).toMatchObject({ number: 7, branch: "warp-7", state: "OPEN" });
    expect(res.rateLimit).toEqual({ limit: 2000, remaining: 1999, resetAt: new Date(1791000000 * 1000) });
  });

  it("paces against the profile's ceiling like any other read", async () => {
    const sleeps: number[] = [];
    const { c } = connector([{ body: [] }, { body: [] }], { sleeps });
    await c.readDevelopment({ feed: "commits", repo: "acme/widgets" });
    await c.readDevelopment({ feed: "branches", repo: "acme/widgets", repoWebUrl: "https://github.com/acme/widgets" });
    // Mutation: bypass `request()` for development reads -> no pacing, red.
    expect(sleeps).toEqual([720]);
  });

  it("reads one repository as an object, and the repository list as a page", async () => {
    const one = connector([
      { body: { id: 77, full_name: "acme/widgets", html_url: "https://github.com/acme/widgets", default_branch: "main" } },
    ]);
    const r = await one.c.readDevelopment({ feed: "repository", repo: "acme/widgets" });
    expect(one.calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets");
    expect(r.items).toEqual([
      {
        type: "repository", externalId: "77", apiRef: "acme/widgets", fullName: "acme/widgets",
        webUrl: "https://github.com/acme/widgets", defaultBranch: "main",
      },
    ]);

    const many = connector([
      { body: [{ id: 1, full_name: "acme/a", html_url: "https://github.com/acme/a" }, { id: 2, full_name: "acme/b", html_url: "https://github.com/acme/b" }] },
    ]);
    expect((await many.c.readDevelopment({ feed: "repositories" })).items.map((i) => i.type === "repository" && i.fullName)).toEqual([
      "acme/a",
      "acme/b",
    ]);
    expect(many.calls[0]!.url).toContain("https://api.github.com/user/repos?per_page=100");
  });

  it("builds a branch's URL from the repository web URL the caller passes", async () => {
    const { c } = connector([{ body: [{ name: "warp-12-login" }] }]);
    const res = await c.readDevelopment({
      feed: "branches", repo: "acme/widgets", repoWebUrl: "https://github.com/acme/widgets/",
    });
    expect(res.items).toEqual([{ type: "branch", name: "warp-12-login", url: "https://github.com/acme/widgets/tree/warp-12-login" }]);
  });

  it("counts a row that is not an item instead of dropping it silently or half-filling it", async () => {
    const { c } = connector([
      {
        body: [
          pull(1, "2026-10-03T10:00:00Z"),
          pull(2, "2026-10-03T10:00:00Z", { html_url: "javascript:alert(1)" }),
          pull(3, "2026-10-03T10:00:00Z", { html_url: "https://evil.example/pull/3" }),
        ],
      },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" });
    expect(res.items).toHaveLength(1);
    expect(res.skipped).toBe(2);
  });

  it("refuses a profile with no development spec by name, not with an empty list", async () => {
    const { c, calls } = connector([{ body: [] }], { profile: CALCOM_PROFILE });
    await expect(c.readDevelopment({ feed: "commits", repo: "a/b" })).rejects.toBeInstanceOf(DatasetNotServedError);
    expect(calls).toHaveLength(0);
  });

  it("refuses a body that is not an array rather than reading it as 'nothing happened'", async () => {
    const { c } = connector([{ body: { message: "Not Found" } }]);
    await expect(c.readDevelopment({ feed: "commits", repo: "acme/widgets" })).rejects.toBeInstanceOf(
      RestPaginationContractError,
    );
  });
});

describe("a repository reference that could leave its path costs ZERO fetch calls", () => {
  it.each([
    ["a parent segment", "acme/../../admin"],
    ["an encoded traversal", "acme/%2e%2e"],
    ["a query", "acme/widgets?per_page=1"],
    ["three segments", "acme/widgets/extra"],
    ["a numeric id on GitHub", "1234"],
    ["an empty ref", ""],
  ])("refuses %s", async (_label, repo) => {
    const { c, calls } = connector([{ body: [] }]);
    await expect(c.readDevelopment({ feed: "pullRequestsOpen", repo })).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    // Mutation: build the URL first and validate after -> a request is sent.
    expect(calls).toHaveLength(0);
  });

  it("refuses a repo feed with no repository", async () => {
    const { c, calls } = connector([{ body: [] }]);
    await expect(c.readDevelopment({ feed: "commits" })).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    expect(calls).toHaveLength(0);
  });

  it("takes only a numeric project id on GitLab", async () => {
    const { c, calls } = connector([{ body: [] }], { profile: GITLAB_PROFILE });
    await expect(c.readDevelopment({ feed: "commits", repo: "acme/widgets" })).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    expect(calls).toHaveLength(0);
  });
});

describe("the conditional first page", () => {
  it("sends If-None-Match on the first request and treats a 304 as the answer", async () => {
    const { c, calls } = connector([
      {
        status: 304,
        headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1791000000" },
      },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets", etag: 'W/"abc"' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["If-None-Match"]).toBe('W/"abc"');
    expect(res).toMatchObject({ status: "not_modified", items: [], etag: 'W/"abc"', truncated: false, skipped: 0 });
    // A 304 still carries the allowance, which is how a quiet poll is free AND informed.
    expect(res.rateLimit?.remaining).toBe(4999);
  });

  it("puts the ETag on the FIRST page only: a page that changed is followed by plain requests", async () => {
    const { c, calls } = connector([
      { body: [pull(1, "2026-10-03T10:00:00Z")], headers: { ...LINK_NEXT("https://api.github.com/page2"), etag: 'W/"new"' } },
      { body: [pull(2, "2026-10-03T09:00:00Z")] },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets", etag: 'W/"old"' });
    expect(calls.map((x) => x.headers["If-None-Match"])).toEqual(['W/"old"', undefined]);
    // The tag handed back is the first page's, which is the one the next pass sends.
    expect(res.etag).toBe('W/"new"');
    expect(res.items).toHaveLength(2);
  });

  it("sends no If-None-Match for an empty etag", async () => {
    const { c, calls } = connector([{ body: [] }]);
    await c.readDevelopment({ feed: "commits", repo: "acme/widgets", etag: "" });
    expect(calls[0]!.headers["If-None-Match"]).toBeUndefined();
  });

  it("still REFUSES a 304 to a request that asked no conditional question", async () => {
    // The 3xx refusal is the redirect guard. Mutation: let 304 through for every
    // request -> a vendor (or anything answering as the host) gets a way past it.
    const { c, calls } = connector([{ status: 304 }]);
    await expect(c.health()).rejects.toBeInstanceOf(UnsafeBaseUrlError);
    expect(calls).toHaveLength(1);
  });

  it("still refuses a 302, conditional or not", async () => {
    const { c } = connector([{ status: 302, headers: { location: "https://evil.example/" } }]);
    await expect(
      c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets", etag: 'W/"abc"' }),
    ).rejects.toBeInstanceOf(UnsafeBaseUrlError);
  });
});

describe("paging", () => {
  it("follows Link until there is no next page", async () => {
    const { c, calls } = connector([
      { body: [pull(1, "2026-10-03T10:00:00Z")], headers: LINK_NEXT("https://api.github.com/repos/acme/widgets/pulls?page=2") },
      { body: [pull(2, "2026-10-03T09:00:00Z")] },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls?page=2");
    expect(res.items.map((i) => i.type === "pull_request" && i.number)).toEqual([1, 2]);
    expect(res.truncated).toBe(false);
  });

  it("stops at the page ceiling and SAYS so, with the next page still on offer", async () => {
    const more = LINK_NEXT("https://api.github.com/more");
    const { c, calls } = connector([
      { body: [pull(1, "2026-10-03T10:00:00Z")], headers: more },
      { body: [pull(2, "2026-10-03T09:00:00Z")], headers: more },
      { body: [pull(3, "2026-10-03T08:00:00Z")], headers: more },
      { body: [pull(4, "2026-10-03T07:00:00Z")], headers: more },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" });
    // Mutation: ignore maxPages -> a fourth request goes out and `truncated` stays false.
    expect(calls).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(res.items).toHaveLength(3);
  });

  it("re-guards a next-page URL against this connection's host and never dials it", async () => {
    const { c, calls } = connector([
      { body: [pull(1, "2026-10-03T10:00:00Z")], headers: LINK_NEXT("https://evil.example/steal?token=1") },
    ]);
    await expect(c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" })).rejects.toBeInstanceOf(
      UnsafeBaseUrlError,
    );
    // Mutation: skip the follow-URL guard -> the credential goes to evil.example.
    expect(calls.map((x) => x.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/pulls?state=open&sort=updated&direction=desc&per_page=100",
    ]);
  });
});

describe("newest-first feeds stop at the caller's cutoff", () => {
  const cutoff = new Date("2026-10-02T00:00:00Z");

  it("drops rows older than the cutoff and requests no further page", async () => {
    const { c, calls } = connector([
      {
        body: [pull(3, "2026-10-04T10:00:00Z"), pull(2, "2026-10-03T10:00:00Z"), pull(1, "2026-10-01T10:00:00Z")],
        headers: LINK_NEXT("https://api.github.com/page2"),
      },
      { body: [pull(0, "2026-09-01T10:00:00Z")] },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsRecent", repo: "acme/widgets", cutoff });
    // Mutation: ignore the cutoff -> page 2 is fetched and #1 is returned.
    expect(calls).toHaveLength(1);
    expect(res.items.map((i) => i.type === "pull_request" && i.number)).toEqual([3, 2]);
    expect(res.truncated).toBe(false);
  });

  it("keeps walking while every row is newer than the cutoff", async () => {
    const { c, calls } = connector([
      { body: [pull(3, "2026-10-04T10:00:00Z")], headers: LINK_NEXT("https://api.github.com/page2") },
      { body: [pull(2, "2026-10-03T10:00:00Z")] },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsRecent", repo: "acme/widgets", cutoff });
    expect(calls).toHaveLength(2);
    expect(res.items).toHaveLength(2);
  });

  it("keeps a newer row that turns up after an older one on the same page (a host that ignored its sort)", async () => {
    const { c } = connector([
      { body: [pull(3, "2026-10-04T10:00:00Z"), pull(1, "2026-10-01T10:00:00Z"), pull(2, "2026-10-03T10:00:00Z")] },
    ]);
    const res = await c.readDevelopment({ feed: "pullRequestsRecent", repo: "acme/widgets", cutoff });
    expect(res.items.map((i) => i.type === "pull_request" && i.number)).toEqual([3, 2]);
  });

  it("applies no cutoff to a feed that is not newest-first (the open list is every open pull request)", async () => {
    const { c } = connector([{ body: [pull(1, "2025-01-01T00:00:00Z")] }]);
    const res = await c.readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets", cutoff });
    expect(res.items).toHaveLength(1);
  });

  it("cuts commits on the committer date", async () => {
    const commit = (sha: string, date: string) => ({
      sha, html_url: `https://github.com/acme/widgets/commit/${sha}`,
      commit: { message: "WARP-1 x", author: { name: "a" }, committer: { date } },
    });
    const { c } = connector([
      { body: [commit("aaaaaaa1", "2026-10-03T00:00:00Z"), commit("bbbbbbb2", "2026-09-01T00:00:00Z")] },
    ]);
    const res = await c.readDevelopment({ feed: "commits", repo: "acme/widgets", cutoff });
    expect(res.items.map((i) => i.type === "commit" && i.externalId)).toEqual(["aaaaaaa1"]);
  });
});

describe("what a refusal means — the error says which, so the caller never has to guess", () => {
  const run = (reply: Reply, resolved?: { n: number }) => {
    const x = connector([reply], { resolved });
    return { ...x, result: x.c.readDevelopment({ feed: "commits", repo: "acme/widgets" }) };
  };

  it("401 is the credential: a ConnectorBlockedError that carries 401", async () => {
    const { result } = run({ status: 401, body: { message: "Bad credentials" } });
    const err = await result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestCredentialRejectedError);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect((err as RestCredentialRejectedError).status).toBe(401);
    expect((err as Error).message).toContain("the vendor rejected the credential (401)");
  });

  it("403 without a rate-limit header is a PERMISSION: same class, status 403", async () => {
    const err = await run({ status: 403, body: { message: "Resource not accessible by personal access token" } }).result.catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RestCredentialRejectedError);
    expect((err as RestCredentialRejectedError).status).toBe(403);
  });

  it("evicts the cached credential on a 401, so a re-pasted token is picked up and a refused one is not replayed", async () => {
    const resolved = { n: 0 };
    const { c } = connector([{ status: 401 }, { status: 401 }], { resolved });
    await c.readDevelopment({ feed: "commits", repo: "acme/widgets" }).catch(() => undefined);
    await c.readDevelopment({ feed: "commits", repo: "acme/widgets" }).catch(() => undefined);
    expect(resolved.n).toBe(2);
  });

  it("403 carrying remaining: 0 is the allowance, not the credential — and says when it refills", async () => {
    const resolved = { n: 0 };
    const err = await run(
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791000000" }, body: { message: "API rate limit exceeded" } },
      resolved,
    ).result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestRateLimitedError);
    expect((err as RestRateLimitedError).resetAt).toEqual(new Date(1791000000 * 1000));
    expect((err as RestRateLimitedError).retryAfter).toBeUndefined();
  });

  it("a secondary limit's Retry-After rides along untouched", async () => {
    const err = await run({ status: 429, headers: { "retry-after": "30" } }).result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestRateLimitedError);
    expect((err as RestRateLimitedError).retryAfter).toBe("30");
  });

  it("404 is a vendor answer about THIS repository, with its status", async () => {
    const err = await run({ status: 404, body: { message: "Not Found" } }).result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestVendorError);
    expect((err as RestVendorError).status).toBe(404);
  });

  it("no answer at all is a RestUnreachableError — still a ConnectorBlockedError for everything that catches that", async () => {
    const c = new RestProfileConnector(
      GITHUB_PROFILE,
      { provider: "github" },
      {
        fetchImpl: (async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        }) as never,
        resolveCredentials: async () => ({ token: GH_TOKEN }),
        sleep: never,
      },
    );
    const err = await c.readDevelopment({ feed: "commits", repo: "acme/widgets" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestUnreachableError);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect((err as Error).message).toContain("ENOTFOUND");
  });

  it("a missing credential is a plain ConnectorBlockedError, neither rejected nor unreachable", async () => {
    const c = new RestProfileConnector(GITHUB_PROFILE, { provider: "github" }, { fetchImpl: stubFetch([{ body: [] }]).impl });
    const err = await c.readDevelopment({ feed: "commits", repo: "acme/widgets" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(err).not.toBeInstanceOf(RestCredentialRejectedError);
    expect(err).not.toBeInstanceOf(RestUnreachableError);
  });
});
