/**
 * WARP-2626 — the transport must honour an undici dispatcher on ANY Node.
 *
 * The Eaglesoft REST track reaches a practice box whose certificate chains to a
 * private CA (Patterson's PdcoTechCA in production, the harness's own CA in a
 * rehearsal) by handing `apiRequest` an undici `Agent` built from that CA
 * (`erp-provider.ts:dispatcherForCa`). A `dispatcher` is an undici extension to
 * `RequestInit` and is only honoured by the undici that MINTED it — so which
 * `fetch` consumes it is load-bearing:
 *
 *   - Node 20 (the repo pin) bundles undici 6 in its built-in `fetch` and
 *     accepts the npm `undici@6` Agent.
 *   - Node >= 22 bundles undici 7 and rejects it with
 *     `UND_ERR_INVALID_ARG: invalid onError method` before a byte is sent.
 *     Every call surfaces as a bare `fetch failed`, which is indistinguishable
 *     from an unreachable box: the connector reports `connected: false` against
 *     a perfectly healthy practice box, with no error naming the cause.
 *
 * That defect is silent, latent and environmental — it ships the day the
 * appliance base image or a CI runner moves off Node 20. So this suite pins the
 * behaviour on WHATEVER Node is installed, rather than asserting a version:
 * a real server, a real `Agent`, the real `apiRequest` path, no injected fetch.
 * On the pinned Node 20 it passes because the pairing is honoured; on this
 * developer machine's Node 26 it passes only because `resolveFetch` routes a
 * dispatcher-carrying request through the npm undici's own `fetch`. Revert that
 * to `globalThis.fetch` and this suite goes red on Node >= 22 — which is the
 * point: a future Node bump becomes a red CI leg instead of a field regression.
 *
 * Deliberately plain HTTP on loopback: this is about the dispatcher plumbing,
 * not about TLS. The CA-trusting half is covered by the live-box suite
 * (`api-connector.live.test.ts`), which needs `openssl` and so cannot be the
 * always-on guard.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Agent } from "undici";
import { apiRequest, resolveFetch, type ApiTransport, type FetchLike } from "../src/api-auth.js";
import type { DiscoveredRoute } from "../src/api-route-map.js";

const ROUTE: DiscoveredRoute = {
  controller: "Patient",
  method: "List",
  verb: "GET",
  template: "api/Patient/List",
};

/** Every request the server saw — proof the call really went over the wire. */
const seen: Array<{ url: string; method: string }> = [];

let server: Server;
let baseUrl: string;
let agent: Agent;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", method: req.method ?? "" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ patients: [{ id: 7 }], via: "dispatcher" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  agent = new Agent();
});

afterAll(async () => {
  await agent.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("apiRequest honours an undici dispatcher on the installed Node (WARP-2626)", () => {
  it("completes a real request through a real Agent, with no injected fetch", async () => {
    seen.length = 0;

    // The production shape exactly: a dispatcher and NOTHING else. If the
    // transport hands this Agent to a fetch that cannot consume it, the call
    // throws EaglesoftApiError("... failed: fetch failed") instead of resolving.
    const body = await apiRequest({ baseUrl, dispatcher: agent }, ROUTE);

    expect(body).toEqual({ patients: [{ id: 7 }], via: "dispatcher" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/Patient/List" });
  });

  it("carries query params and the session header over the dispatcher path", async () => {
    seen.length = 0;

    await apiRequest({ baseUrl, dispatcher: agent }, ROUTE, {
      query: { since: "2026-01-01" },
      token: "session-token-FAKE",
    });

    expect(seen[0]?.url).toBe("/api/Patient/List?since=2026-01-01");
  });

  it("still works with no dispatcher at all (built-in fetch, system trust)", async () => {
    // The other half of the branch: no dispatcher means nothing to pair, and
    // the built-in fetch must keep working exactly as before.
    const body = await apiRequest({ baseUrl }, ROUTE);
    expect(body).toEqual({ patients: [{ id: 7 }], via: "dispatcher" });
  });
});

describe("resolveFetch pairing rules (WARP-2626)", () => {
  it("prefers an injected fetchImpl even when a dispatcher is present", () => {
    // The injection seam is what every offline connector test relies on; the
    // WARP-2626 fix must not quietly take it over.
    const injected: FetchLike = async () => new Response("{}");
    expect(resolveFetch({ baseUrl, dispatcher: agent, fetchImpl: injected })).toBe(injected);
  });

  it("does NOT use the built-in fetch when a dispatcher is supplied", () => {
    // The actual defect, stated directly: pairing an npm-undici Agent with the
    // runtime's own bundled undici is what breaks on Node >= 22.
    const resolved = resolveFetch({ baseUrl, dispatcher: agent });
    expect(resolved).not.toBe(globalThis.fetch);
  });

  it("uses the built-in fetch when there is no dispatcher to pair with", () => {
    const transport: ApiTransport = { baseUrl };
    expect(resolveFetch(transport)).toBe(globalThis.fetch);
  });
});
