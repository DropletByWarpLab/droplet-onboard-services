import { describe, it, expect, vi } from "vitest";
import { FAIL_CLOSED_MODULE_VERDICT } from "@droplet/tools-core";
import type { HttpClient } from "@droplet/tools-core";
import { createModuleVerdictSource } from "../src/module-verdict.js";

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
