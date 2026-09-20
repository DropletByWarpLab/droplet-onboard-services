/**
 * WARP-2300 review follow-up — the transport's redirect policy.
 *
 * `assertSafeMcpUrl` screens the host ONCE, at construction. The SDK sets no
 * `redirect` option, so Node's default (`follow`) let the screened host answer
 * 302 and have the credentialed request delivered to some other authority that
 * nothing re-screens — a one-time exact-host guard turned into a suggestion.
 *
 * NOTHING HERE OPENS A SOCKET: `globalThis.fetch` is stubbed for the duration
 * of each test, so the assertions are about the request the transport would
 * have made.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createStreamableHttpConnection,
  noRedirectFetch,
} from "../src/streamable-http.js";

/** Obviously fake — this is a header shape, not a credential. */
const FAKE_AUTHORIZATION = "Basic FAKE-000000000000";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("noRedirectFetch", () => {
  /**
   * MUTATION: drop `redirect: "error"` from `noRedirectFetch` → this test
   * goes red.
   */
  it("refuses redirects rather than following them", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response("{}", { status: 200 });
      }),
    );

    await noRedirectFetch("https://mcp.vendor.example/v1/mcp", {
      method: "POST",
      headers: { authorization: FAKE_AUTHORIZATION },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("error");
  });

  it("keeps everything the caller set — it overrides one field, not the init", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response("{}", { status: 200 });
      }),
    );

    await noRedirectFetch("https://mcp.vendor.example/v1/mcp", {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      headers: { authorization: FAKE_AUTHORIZATION },
    });

    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBe('{"jsonrpc":"2.0"}');
    expect(seen[0]!.headers).toMatchObject({ authorization: FAKE_AUTHORIZATION });
  });
});

describe("the transport is wired to it", () => {
  /**
   * The unit test above proves the function; this proves the option reaches
   * the SDK. Every request the transport makes goes through the stub, and
   * every one of them must carry the policy.
   *
   * MUTATION: remove `fetch: noRedirectFetch` from the
   * `StreamableHTTPClientTransport` options → this test goes red (the SDK
   * falls back to the bare global fetch and no init carries `redirect`).
   */
  it("every request createStreamableHttpConnection makes carries redirect: error", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        seen.push(init ?? {});
        // A 500 ends the handshake; we are asserting on the request, not
        // exercising the protocol.
        return new Response("upstream is down", { status: 500 });
      }),
    );

    await expect(
      createStreamableHttpConnection({
        serverId: "vendor",
        url: "https://mcp.vendor.example/v1/mcp",
        headers: { authorization: FAKE_AUTHORIZATION },
      }),
    ).rejects.toThrow();

    expect(seen.length).toBeGreaterThan(0);
    for (const init of seen) expect(init.redirect).toBe("error");
  });
});
