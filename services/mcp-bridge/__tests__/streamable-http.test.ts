/**
 * WARP-2300 review follow-up + WARP-3914 — the transport's fetch.
 *
 * `assertSafeMcpUrl` screens the NAME once, at construction. Two things keep
 * that true for the life of the session, and both live in the transport's
 * fetch (`pinned-fetch.ts`): redirects are refused (a 302 would deliver the
 * credentialed request to an authority nothing re-screens), and the host is
 * resolved, vetted and dialed at the vetted address (WARP-3914).
 *
 * NOTHING HERE OPENS A SOCKET: the guard's resolver and sender are stubbed, so
 * the assertions are about the request the transport would have made. The
 * address table itself is covered in `pinned-fetch.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { createStreamableHttpConnection } from "../src/streamable-http.js";
import { createGuardedFetch } from "../src/pinned-fetch.js";

/** Obviously fake — this is a header shape, not a credential. */
const FAKE_AUTHORIZATION = "Basic FAKE-000000000000";
/** TEST-NET-3: documentation-only, but public as far as the table goes. */
const PUBLIC = [{ address: "203.0.113.7", family: 4 }];
const noLocal = () => ({ addresses: [], cidrs: [] });

type SendCall = [{ url: URL; addresses: { address: string }[] }, RequestInit];

describe("the guarded fetch", () => {
  it("keeps everything the caller set — it adds the pin, not a rewrite of the init", async () => {
    const send = vi.fn(async () => new Response("{}", { status: 200 }));
    const f = createGuardedFetch({ resolve: async () => PUBLIC, local: noLocal, send });

    await f("https://mcp.vendor.example/v1/mcp", {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      headers: { authorization: FAKE_AUTHORIZATION },
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [dest, init] = send.mock.calls[0] as unknown as SendCall;
    expect(dest.url.hostname).toBe("mcp.vendor.example");
    expect(dest.addresses.map((a) => a.address)).toEqual(["203.0.113.7"]);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"jsonrpc":"2.0"}');
    expect(init.headers).toMatchObject({ authorization: FAKE_AUTHORIZATION });
  });
});

describe("the transport is wired to it", () => {
  /**
   * MUTATION: remove `fetch: createObservingFetch(...)` from the
   * `StreamableHTTPClientTransport` options → this test goes red (the SDK
   * falls back to the bare global fetch and `send` is never called).
   */
  it("every request createStreamableHttpConnection makes goes through the pinned sender", async () => {
    const send = vi.fn(async () => new Response("upstream is down", { status: 500 }));
    await expect(
      createStreamableHttpConnection(
        {
          serverId: "vendor",
          url: "https://mcp.vendor.example/v1/mcp",
          headers: { authorization: FAKE_AUTHORIZATION },
        },
        { guard: { resolve: async () => PUBLIC, local: noLocal, send } },
      ),
    ).rejects.toThrow();

    expect(send.mock.calls.length).toBeGreaterThan(0);
    for (const call of send.mock.calls as unknown as SendCall[]) {
      expect(call[0].addresses.map((a) => a.address)).toEqual(["203.0.113.7"]);
    }
  });

  it("a host that resolves to a private address never gets a request", async () => {
    const send = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(
      createStreamableHttpConnection(
        { serverId: "vendor", url: "https://mcp.vendor.example/v1/mcp", headers: {} },
        { guard: { resolve: async () => [{ address: "10.0.0.5", family: 4 }], local: noLocal, send } },
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
