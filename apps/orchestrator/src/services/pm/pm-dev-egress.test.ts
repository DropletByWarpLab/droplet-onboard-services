/**
 * WARP-3535 — the fetch the GitHub / GitLab poll dials through.
 *
 * Two layers guard a development read and this file pins how they combine:
 *
 *   the connector's own guard   WHERE: an exact registered host, https, no
 *                               redirect, a `Link` URL re-checked. It has no
 *                               owner switch and does not pin the socket.
 *   this fetch                  WHETHER and HOW: the owner's `work_integrations`
 *                               switch immediately before the dial, the SSRF
 *                               guard, and a socket held to the vetted address.
 *
 * Every refusal asserts the socket was never opened (`get` called ZERO times).
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ConnectorBlockedError,
  RestProfileConnector,
  RestUnreachableError,
  UnsafeRestBaseUrlError,
  restProfileFor,
} from "@droplet/erp-connector";
import type { PinnedDestination } from "../../lib/outbound-url-guard.js";
import { OutboundUrlBlockedError } from "../../lib/outbound-url-guard.js";
import type { PinnedGetResponse } from "../../lib/outbound-pinned-fetch.js";
import { createDevelopmentFetch, DevelopmentEgressBlockedError } from "./pm-dev-egress.js";

const PUBLIC: PinnedDestination = {
  url: new URL("https://api.github.com/user"),
  hostname: "api.github.com",
  addresses: [{ address: "140.82.112.5", family: 4 }],
  scope: "public",
};
const LAN: PinnedDestination = {
  url: new URL("https://gitlab.lan/api/v4/user"),
  hostname: "gitlab.lan",
  addresses: [{ address: "192.168.1.40", family: 4 }],
  scope: "lan",
};

const ok = (body: string, status = 200, headers: Record<string, string> = {}): PinnedGetResponse => ({
  status,
  headers: new Headers(headers),
  body: new TextEncoder().encode(body),
});

function harness(over: { dest?: PinnedDestination; gate?: boolean | "throws"; reply?: PinnedGetResponse } = {}) {
  const get = vi.fn(async () => over.reply ?? ok("[]"));
  const resolveDestination = vi.fn(async (url: string) => ({
    ...(over.dest ?? PUBLIC),
    url: new URL(url),
  }));
  const gate = vi.fn(async () => {
    if (over.gate === "throws") throw new Error("db down");
    return over.gate !== false;
  });
  const handle = createDevelopmentFetch({} as never, { get: get as never, resolveDestination, gate });
  return { handle, get, resolveDestination, gate };
}

describe("the owner's switch applies to every off-LAN dial", () => {
  it("refuses an internet destination while work_integrations is off, and never opens a socket", async () => {
    const { handle, get, gate } = harness({ gate: false });
    await expect(handle.fetch("https://api.github.com/user")).rejects.toBeInstanceOf(DevelopmentEgressBlockedError);
    // Mutation: dial first and check after -> a request (and the token) goes out.
    expect(get).toHaveBeenCalledTimes(0);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(handle.blocked).toBe("egress_switch_off");
  });

  it("dials once the switch is on, passing the vetted destination and the caller's headers", async () => {
    const { handle, get } = harness({ gate: true, reply: ok('{"login":"octocat"}', 200, { etag: 'W/"1"' }) });
    const res = await handle.fetch("https://api.github.com/user", { headers: { authorization: "Bearer t" } });
    expect(get).toHaveBeenCalledTimes(1);
    const [dest, req] = get.mock.calls[0] as unknown as [PinnedDestination, { headers: Record<string, string> }];
    expect(dest.hostname).toBe("api.github.com");
    expect(dest.addresses).toEqual(PUBLIC.addresses);
    expect(req.headers).toEqual({ authorization: "Bearer t" });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('W/"1"');
    expect(await res.json()).toEqual({ login: "octocat" });
    expect(handle.blocked).toBeNull();
  });

  it("reads the switch before EVERY dial, so turning it off mid-sync stops the very next request", async () => {
    let on = true;
    const get = vi.fn(async () => ok("[]"));
    const handle = createDevelopmentFetch({} as never, {
      get: get as never,
      resolveDestination: async (u) => ({ ...PUBLIC, url: new URL(u) }),
      gate: async () => on,
    });
    await handle.fetch("https://api.github.com/a");
    on = false;
    await expect(handle.fetch("https://api.github.com/b")).rejects.toBeInstanceOf(DevelopmentEgressBlockedError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not ask the switch about a destination on the box's own LAN (a self-hosted host needs none)", async () => {
    const { handle, get, gate } = harness({ dest: LAN, gate: false });
    const res = await handle.fetch("https://gitlab.lan/api/v4/user");
    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
    expect(gate).not.toHaveBeenCalled();
  });

  it("fails closed when the switch cannot be read", async () => {
    // workIntegrationsGate itself never throws (a DB error reads as off); this
    // pins that a gate that DID throw still cannot open the dial.
    const { handle, get } = harness({ gate: "throws" });
    await expect(handle.fetch("https://api.github.com/user")).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(0);
  });

  it("reads the real channel by default: a missing row is off, an enabled row is on", async () => {
    const find = vi.fn();
    const prisma = { offLanAllowlistChannel: { findUnique: find } } as never;
    const get = vi.fn(async () => ok("[]"));
    const handle = createDevelopmentFetch(prisma, {
      get: get as never,
      resolveDestination: async (u) => ({ ...PUBLIC, url: new URL(u) }),
    });

    find.mockResolvedValueOnce(null);
    await expect(handle.fetch("https://api.github.com/x")).rejects.toBeInstanceOf(DevelopmentEgressBlockedError);
    expect(find).toHaveBeenLastCalledWith({ where: { key: "work_integrations" } });
    find.mockRejectedValueOnce(new Error("db down"));
    await expect(handle.fetch("https://api.github.com/x")).rejects.toBeInstanceOf(DevelopmentEgressBlockedError);
    find.mockResolvedValueOnce({ enabled: true });
    await expect(handle.fetch("https://api.github.com/x")).resolves.toBeInstanceOf(Response);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("the SSRF guard runs on every dial, and its refusal is fixed text", () => {
  it.each([
    ["private_host", "destination_not_allowed"],
    ["scheme", "destination_not_allowed"],
    ["userinfo", "destination_not_allowed"],
    ["unresolvable", "unresolvable"],
  ] as const)("a %s refusal blocks the dial as %s", async (reason, expected) => {
    const get = vi.fn(async () => ok("[]"));
    const handle = createDevelopmentFetch({} as never, {
      get: get as never,
      resolveDestination: async () => {
        throw new OutboundUrlBlockedError(reason, "10.0.0.5 (reserved)");
      },
      gate: async () => true,
    });
    const err = await handle.fetch("https://api.github.com/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevelopmentEgressBlockedError);
    expect(handle.blocked).toBe(expected);
    expect(get).toHaveBeenCalledTimes(0);
    // The operator detail never reaches the message a caller might surface.
    expect((err as Error).message).not.toContain("10.0.0.5");
  });

  it("treats a resolver that fails some other way as refused, not as 'go ahead'", async () => {
    const get = vi.fn();
    const handle = createDevelopmentFetch({} as never, {
      get: get as never,
      resolveDestination: async () => {
        throw new Error("interfaces unreadable");
      },
      gate: async () => true,
    });
    await expect(handle.fetch("https://api.github.com/x")).rejects.toBeInstanceOf(DevelopmentEgressBlockedError);
    expect(handle.blocked).toBe("destination_not_allowed");
    expect(get).toHaveBeenCalledTimes(0);
  });

  it("with the real guard, a name that is this box never reaches the socket", async () => {
    const get = vi.fn();
    const handle = createDevelopmentFetch({} as never, { get: get as never, gate: async () => true });
    await expect(handle.fetch("https://127.0.0.1/api")).rejects.toBeInstanceOf(DevelopmentEgressBlockedError);
    await expect(handle.fetch("https://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(
      DevelopmentEgressBlockedError,
    );
    expect(get).toHaveBeenCalledTimes(0);
  });
});

describe("what comes back", () => {
  it("is read-only: any method but GET is refused before anything else happens", async () => {
    const { handle, get, resolveDestination } = harness();
    await expect(handle.fetch("https://api.github.com/x", { method: "POST", body: "x" })).rejects.toThrow(/read-only/);
    expect(get).toHaveBeenCalledTimes(0);
    expect(resolveDestination).toHaveBeenCalledTimes(0);
  });

  it("returns a 304 with no body, because a Response may not carry one", async () => {
    const { handle } = harness({ reply: ok("", 304, { etag: 'W/"1"' }) });
    const res = await handle.fetch("https://api.github.com/x");
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe('W/"1"');
  });

  it("returns a 3xx as the answer, with its Location, for the connector to refuse", async () => {
    const { handle } = harness({ reply: ok("", 302, { location: "https://evil.example/" }) });
    const res = await handle.fetch("https://api.github.com/x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://evil.example/");
  });

  it("accepts headers as a Headers object or as pairs", async () => {
    const { handle, get } = harness();
    await handle.fetch("https://api.github.com/x", { headers: new Headers({ "X-A": "1" }) });
    await handle.fetch("https://api.github.com/x", { headers: [["X-B", "2"]] });
    const sent = get.mock.calls.map((c) => (c as unknown as [unknown, { headers: Record<string, string> }])[1].headers);
    expect(sent).toEqual([{ "x-a": "1" }, { "x-b": "2" }]);
  });

  it("passes the caller's abort signal through", async () => {
    const { handle, get } = harness();
    const controller = new AbortController();
    await handle.fetch("https://api.github.com/x", { signal: controller.signal });
    const req = (get.mock.calls[0] as unknown as [unknown, { signal?: AbortSignal }])[1];
    expect(req.signal).toBe(controller.signal);
  });
});

describe("through the real connector — the two guards combine, neither replaces the other", () => {
  function through(handle: ReturnType<typeof createDevelopmentFetch>) {
    const profile = restProfileFor("github")!;
    return new RestProfileConnector(
      profile,
      { provider: "github" },
      {
        fetchImpl: handle.fetch,
        resolveCredentials: async () => ({ token: "github_pat_test" }),
        sleep: async () => undefined,
      },
    );
  }

  const pr = {
    id: 1, number: 1, state: "open", draft: false, title: "WARP-1 x", body: null, user: { login: "o" },
    head: { ref: "warp-1" }, html_url: "https://github.com/acme/widgets/pull/1", updated_at: "2026-10-03T10:00:00Z",
    merged_at: null,
  };

  it("reads a repository's pull requests when the switch is on", async () => {
    const { handle, get } = harness({ gate: true, reply: ok(JSON.stringify([pr]), 200, { etag: 'W/"x"' }) });
    const res = await through(handle).readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" });
    expect(res.items).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
    const [dest, req] = get.mock.calls[0] as unknown as [PinnedDestination, { headers: Record<string, string> }];
    expect(dest.url.href).toContain("https://api.github.com/repos/acme/widgets/pulls");
    expect(req.headers.Authorization).toBe("Bearer github_pat_test");
  });

  it("with the switch off the credential is resolved but nothing is dialled, and the cause is on the handle", async () => {
    const { handle, get } = harness({ gate: false });
    const err = await through(handle)
      .readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" })
      .catch((e: unknown) => e);
    // The connector wraps the refusal as "could not be reached"; the handle is
    // how the caller learns it was the switch and not the network.
    expect(err).toBeInstanceOf(RestUnreachableError);
    expect(err).toBeInstanceOf(ConnectorBlockedError);
    expect(handle.blocked).toBe("egress_switch_off");
    expect(get).toHaveBeenCalledTimes(0);
  });

  it("a redirect from the host is refused by the connector — the pinned dial returned it, nothing followed it", async () => {
    const { handle, get } = harness({
      gate: true,
      reply: ok("", 302, { location: "https://evil.example/steal" }),
    });
    await expect(
      through(handle).readDevelopment({ feed: "pullRequestsOpen", repo: "acme/widgets" }),
    ).rejects.toBeInstanceOf(UnsafeRestBaseUrlError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("the connector's exact-host guard still runs first: a refused repo ref never reaches this fetch", async () => {
    const { handle, resolveDestination, gate } = harness({ gate: true });
    await expect(
      through(handle).readDevelopment({ feed: "pullRequestsOpen", repo: "acme/../../admin" }),
    ).rejects.toBeInstanceOf(UnsafeRestBaseUrlError);
    expect(resolveDestination).toHaveBeenCalledTimes(0);
    expect(gate).toHaveBeenCalledTimes(0);
  });

  it("a conditional poll that comes back 304 is read through the whole chain", async () => {
    const { handle } = harness({
      gate: true,
      reply: ok("", 304, { "x-ratelimit-remaining": "4990", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1791000000" }),
    });
    const res = await through(handle).readDevelopment({
      feed: "pullRequestsOpen",
      repo: "acme/widgets",
      etag: 'W/"x"',
    });
    expect(res.status).toBe("not_modified");
    expect(res.rateLimit?.remaining).toBe(4990);
  });
});
