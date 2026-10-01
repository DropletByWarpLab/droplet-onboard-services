import { describe, it, expect, vi } from "vitest";
import { FAIL_CLOSED_MODULE_VERDICT, MODULE_OWNED_TOOL_DOMAINS } from "@droplet/tools-core";
import type { HttpClient } from "@droplet/tools-core";
import {
  FAIL_CLOSED_MODULE_SOURCE,
  NO_MODULE_GATING,
  createModuleVerdictSource,
} from "../src/module-verdict.js";

/**
 * WARP-2972 — the mcp-server's side of the module verdict: ask the orchestrator
 * (the only process that knows the module registry and the box's availability
 * signals) which tool domains are withheld for a person, and FAIL CLOSED when
 * that cannot be answered.
 */

const ok = (domains: string[]) =>
  new Response(JSON.stringify({ withheldDomains: domains }), { status: 200 });

function client(get: HttpClient["get"]): HttpClient {
  return { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
}

describe("createModuleVerdictSource", () => {
  it("asks the orchestrator's verdict route and parses the withheld domains", async () => {
    const get = vi.fn().mockResolvedValue(ok(["cameras", "email"]));
    const verdict = await createModuleVerdictSource({ http: client(get) })(undefined);
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]![0]).toBe("/api/modules/tool-verdict");
    expect([...verdict.withheldDomains].sort()).toEqual(["cameras", "email"]);
  });

  it("names the person in X-Nextcloud-User, and names nobody for the box", async () => {
    const get = vi.fn().mockImplementation(async () => ok([]));
    const source = createModuleVerdictSource({ http: client(get) });
    await source("carol");
    await source(undefined);
    expect(get.mock.calls[0]![1].headers).toEqual({ "X-Nextcloud-User": "carol" });
    expect(get.mock.calls[1]![1].headers).toEqual({});
  });

  describe("fails CLOSED", () => {
    it.each([
      ["a non-200", () => Promise.resolve(new Response("nope", { status: 500 }))],
      ["a 401 (no service token)", () => Promise.resolve(new Response("{}", { status: 401 }))],
      ["a 403", () => Promise.resolve(new Response("{}", { status: 403 }))],
      ["a network error", () => Promise.reject(new Error("ECONNREFUSED"))],
      ["a body that is not JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
      ["a body of the wrong shape", () => Promise.resolve(new Response('{"withheld":[]}', { status: 200 }))],
      ["a body whose domains are not strings", () => Promise.resolve(new Response('{"withheldDomains":[1]}', { status: 200 }))],
    ])("on %s", async (_label, respond) => {
      const source = createModuleVerdictSource({ http: client(vi.fn().mockImplementation(respond)) });
      expect(await source("carol")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    });

    it("on a request that outlives its deadline", async () => {
      const get: HttpClient["get"] = (_path, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const source = createModuleVerdictSource({ http: client(get), timeoutMs: 20 });
      expect(await source("carol")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    });

    it("and does NOT remember the failure: the next call asks again", async () => {
      const get = vi
        .fn()
        .mockRejectedValueOnce(new Error("blip"))
        .mockResolvedValueOnce(ok(["cameras"]));
      const source = createModuleVerdictSource({ http: client(get) });
      expect(await source("carol")).toBe(FAIL_CLOSED_MODULE_VERDICT);
      expect([...(await source("carol")).withheldDomains]).toEqual(["cameras"]);
    });
  });

  describe("caching", () => {
    it("asks once per person per TTL", async () => {
      let t = 0;
      const get = vi.fn().mockImplementation(async () => ok([]));
      const source = createModuleVerdictSource({ http: client(get), ttlMs: 5_000, now: () => t });
      await source("carol");
      await source("carol");
      await source("dave");
      expect(get).toHaveBeenCalledTimes(2);
      t = 5_001;
      await source("carol");
      expect(get).toHaveBeenCalledTimes(3);
    });

    it("does NOT cache the orchestrator's own fail-closed answer (a 200 withholding every module domain)", async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce(ok([...MODULE_OWNED_TOOL_DOMAINS]))
        .mockResolvedValueOnce(ok(["cameras"]));
      const source = createModuleVerdictSource({ http: client(get) });
      expect((await source("carol")).withheldDomains).toEqual(new Set(MODULE_OWNED_TOOL_DOMAINS));
      expect([...(await source("carol")).withheldDomains]).toEqual(["cameras"]);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("shares one in-flight request between concurrent callers", async () => {
      let release!: (r: Response) => void;
      const get = vi.fn().mockImplementation(
        () => new Promise<Response>((resolve) => (release = resolve)),
      );
      const source = createModuleVerdictSource({ http: client(get) });
      const both = Promise.all([source("carol"), source("carol")]);
      await Promise.resolve();
      release(ok(["email"]));
      const [a, b] = await both;
      expect(get).toHaveBeenCalledOnce();
      expect(a).toBe(b);
    });
  });
});

describe("the fail-closed branch says why (and only why)", () => {
  const source = (get: HttpClient["get"], warn = vi.fn(), over: { timeoutMs?: number; now?: () => number } = {}) => ({
    warn,
    ask: createModuleVerdictSource({ http: client(get), warn, ...over }),
  });

  it.each([
    ["a refusal", () => Promise.resolve(new Response("{}", { status: 403 })), "http_403"],
    ["a server error", () => Promise.resolve(new Response("nope", { status: 500 })), "http_500"],
    ["a network error", () => Promise.reject(new Error("ECONNREFUSED")), "network"],
    ["a non-JSON body", () => Promise.resolve(new Response("<html>", { status: 200 })), "malformed"],
    ["a body of the wrong shape", () => Promise.resolve(new Response('{"x":1}', { status: 200 })), "malformed"],
  ])("%s → %s", async (_label, respond, reason) => {
    const { ask, warn } = source(vi.fn().mockImplementation(respond));
    expect(await ask("carol")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe(reason);
  });

  it("a deadline → timeout", async () => {
    const get: HttpClient["get"] = (_path, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason));
      });
    const { ask, warn } = source(get, vi.fn(), { timeoutMs: 20 });
    await ask("carol");
    expect(warn.mock.calls[0]![0]).toBe("timeout");
  });

  it("never carries the person, a URL, a header or an error message", async () => {
    // The reason is a closed vocabulary. An error message can hold a URL with
    // a token in it, and the asserted user is a person's identifier.
    const { ask, warn } = source(
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED http://orchestrator:3000 Bearer sekrit")),
    );
    await ask("carol@example.com");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/carol|sekrit|orchestrator|Bearer/);
  });

  it("is throttled: a dead orchestrator does not write a line per tool call", async () => {
    let t = 0;
    const { ask, warn } = source(vi.fn().mockRejectedValue(new Error("down")), vi.fn(), { now: () => t });
    for (let i = 0; i < 5; i++) await ask("carol");
    expect(warn).toHaveBeenCalledOnce();
    t += 60_001;
    await ask("carol");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("logs nothing on a good answer", async () => {
    const { ask, warn } = source(vi.fn().mockImplementation(async () => ok([])));
    await ask("carol");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the two named sources", () => {
  it("FAIL_CLOSED_MODULE_SOURCE always answers the fail-closed verdict", async () => {
    expect(await FAIL_CLOSED_MODULE_SOURCE("anyone")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    expect(await FAIL_CLOSED_MODULE_SOURCE(undefined)).toBe(FAIL_CLOSED_MODULE_VERDICT);
  });

  it("NO_MODULE_GATING withholds nothing — it exists for tests and is never wired in src/", async () => {
    expect((await NO_MODULE_GATING("anyone")).withheldDomains.size).toBe(0);
  });
});
