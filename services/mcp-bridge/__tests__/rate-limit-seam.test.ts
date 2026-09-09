/**
 * WARP-2300 — the seam between a vendor's 429 and the #171 rate-limit pause.
 *
 * ## Why this file exists
 *
 * `call-scheduler.test.ts` proves the scheduler PAUSES correctly, but every one
 * of its rate-limit tests calls `noteRateLimitHeaders({...})` directly with a
 * hand-built map. Nothing exercised the only thing that feeds it in production,
 * so the mitigation could be — and was — completely inert while its unit tests
 * stayed green.
 *
 * `atlassian.ts` fed the scheduler by reading `err.headers` off whatever
 * `client.callTool` rejected with. The pinned SDK (`@modelcontextprotocol/sdk`
 * 1.30.0) throws `StreamableHTTPError`, which is built from a code and a
 * message and DISCARDS the `Response`:
 *
 *     export class StreamableHTTPError extends Error {
 *       constructor(code, message) { super(...); this.code = code; }
 *     }
 *
 * There is no `headers` on it, so `rateLimitHeadersOf` returned `null` for
 * every real 429 and the pause never happened on a box. The headers are now
 * read where the response actually exists: the transport's own `fetch`.
 *
 * ## Nothing dials
 *
 * `globalThis.fetch` is stubbed for every test here and THROWS on any URL it
 * was not given, so a fall-through to the network is loud rather than silent.
 * The SDK, its transport, the shipped fetch wrapper and the shipped scheduler
 * are all real — only the socket is not.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ATLASSIAN_MCP_CLIENT_INFO,
  ATLASSIAN_MCP_PROTOCOL_VERSION,
  ATLASSIAN_MCP_URL,
} from "../src/atlassian.js";
import { RemoteCallScheduler } from "../src/call-scheduler.js";
import { createAtlassianSessionFactory } from "../src/session-profiles.js";
import { createStreamableHttpConnection } from "../src/streamable-http.js";

const FAKE_EMAIL = "ops@vendor.example";
const FAKE_TOKEN = "ATATT-FAKE-000000000000";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";
const CONNECT_INPUT = {
  serverId: "atlassian",
  url: ATLASSIAN_MCP_URL,
  headers: { authorization: "Basic FAKE" },
};
const PRODUCTION_OPTS = {
  clientInfo: ATLASSIAN_MCP_CLIENT_INFO,
  pinnedProtocolVersion: ATLASSIAN_MCP_PROTOCOL_VERSION,
};

/**
 * A stub for `globalThis.fetch` that speaks just enough MCP to get a real
 * `Client` through `initialize`, then answers the tool call with whatever the
 * test asked for.
 */
function stubTransport(toolCallResponse: (id: number | undefined) => Response): {
  calls: string[];
} {
  const calls: string[] = [];
  const impl = async (url: unknown, init: unknown): Promise<Response> => {
    const target = String(url);
    if (target !== ATLASSIAN_MCP_URL) {
      throw new Error(`the stub was asked for an unexpected URL: ${target}`);
    }
    const raw = (init as { body?: string }).body;
    if (raw === undefined) {
      // The SDK's GET for the SSE stream. Decline it — this integration does
      // not need it, and 405 is what a POST-only server answers.
      return new Response(null, { status: 405 });
    }
    const message = JSON.parse(raw) as { id?: number; method: string };
    calls.push(message.method);
    if (message.method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: ATLASSIAN_MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "atlassian-mcp-server", version: "1.0.0" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return toolCallResponse(message.id);
  };
  vi.stubGlobal("fetch", vi.fn(impl));
  return { calls };
}

/** What a rate-limited vendor answers: 429, and the headers #171 is about. */
function rateLimited(_id?: number): Response {
  return new Response("Too Many Requests", {
    status: 429,
    headers: {
      "retry-after": "7",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "60",
      // Present on purpose: rule 19 says only the rate-limit headers may be
      // read, and a fixture that supplies no others proves nothing.
      "x-secret-echo": "SHOULD-NEVER-BE-READ",
      "www-authenticate": "Basic realm=SHOULD-NEVER-BE-READ",
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what the pinned SDK actually throws (WARP-2300)", () => {
  it("carries a code and a message and NO headers — so err.headers can never feed the pause", () => {
    const err = new StreamableHTTPError(429, "Error POSTing to endpoint: Too Many Requests");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(429);
    expect(Object.getOwnPropertyNames(err)).not.toContain("headers");
    expect((err as unknown as { headers?: unknown }).headers).toBeUndefined();
    // If an SDK bump ever attaches the response headers to the error, this
    // assertion goes red and the second source in `atlassian.ts` becomes live.
  });

  it("is what a real Client rejects with on a 429, the response discarded", async () => {
    stubTransport(rateLimited);
    const connection = await createStreamableHttpConnection(CONNECT_INPUT, PRODUCTION_OPTS);
    const thrown = await connection.callTool("getJiraIssue", {}).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: unknown }).code).toBe(429);
    expect((thrown as { headers?: unknown }).headers).toBeUndefined();
  });
});

describe("the response headers reach the scheduler (WARP-2300)", () => {
  it("pauses on a real 429 driven through the shipped transport", async () => {
    stubTransport(rateLimited);
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });
    expect(scheduler.stats().pauses).toBe(0);

    const connection = await createStreamableHttpConnection(CONNECT_INPUT, {
      ...PRODUCTION_OPTS,
      onRateLimitHeaders: (h) => scheduler.noteRateLimitHeaders(h),
    });
    await connection.callTool("getJiraIssue", {}).catch(() => undefined);

    // THE assertion. Before this fix it was 0: the mitigation never fired.
    expect(scheduler.stats().pauses).toBe(1);

    // And the pause is HONOURED, not merely counted. `#pauseFor` records a
    // deadline; the sleep happens when the next call asks for a slot, which is
    // why asserting on `sleep` at the moment of the 429 would prove nothing.
    expect(sleep).not.toHaveBeenCalled();
    await scheduler.run(async () => "next");
    expect(sleep).toHaveBeenCalledWith(7_000);
  });

  it("hands over ONLY the rate-limit headers — rule 19", async () => {
    stubTransport(rateLimited);
    const seen: Record<string, string>[] = [];
    const connection = await createStreamableHttpConnection(CONNECT_INPUT, {
      ...PRODUCTION_OPTS,
      onRateLimitHeaders: (h) => seen.push(h),
    });
    await connection.callTool("getJiraIssue", {}).catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    const allowed = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"];
    for (const map of seen) {
      for (const key of Object.keys(map)) expect(allowed).toContain(key);
    }
    expect(JSON.stringify(seen)).not.toContain("SHOULD-NEVER-BE-READ");
  });

  it("does not pause on a healthy response that still has budget", async () => {
    stubTransport(
      (id) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "{}" }], isError: false },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": "480",
              "x-ratelimit-reset": "60",
            },
          },
        ),
    );
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });
    const connection = await createStreamableHttpConnection(CONNECT_INPUT, {
      ...PRODUCTION_OPTS,
      onRateLimitHeaders: (h) => scheduler.noteRateLimitHeaders(h),
    });
    await connection.callTool("getJiraIssue", {}).catch(() => undefined);
    expect(scheduler.stats().pauses).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("the PRODUCTION factory wires it, not just this test (WARP-2300)", () => {
  it("pauses a session built by the factory SESSION_FACTORIES itself uses", async () => {
    // A 429 once, then a healthy answer — so the test can drive the whole
    // production path rather than stopping at the first refusal.
    let served429 = false;
    stubTransport((id) => {
      if (!served429) {
        served429 = true;
        return rateLimited();
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: "{}" }],
            isError: false,
            // `getJiraIssue` is in ATLASSIAN_STRUCTURED_CONTENT_TOOLS, so the
            // #213 guard in the shipped stack rejects a result without it. The
            // fixture supplies one because this test drives the REAL guard
            // stack, not a stripped-down version of it.
            structuredContent: { webUrl: "https://example.test/browse/FAKE-1" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });

    // The shipped factory, with only the scheduler's CONSTRUCTION injected so
    // the test can read its counters. Every other part — the transport, the
    // client info, the protocol pin, the guard stack — is production.
    const factory = createAtlassianSessionFactory(() => scheduler);
    const session = factory({
      email: FAKE_EMAIL,
      apiToken: FAKE_TOKEN,
      cloudId: FAKE_CLOUD_ID,
    });
    expect((await session.connect()).state).toBe("ready");

    await session.callTool("getJiraIssue", {}).catch(() => undefined);
    // The seam, on the production path: the vendor's `Retry-After` reached the
    // scheduler. This was 0 before the fix.
    expect(scheduler.stats().pauses).toBe(1);

    // SEPARATE, PRE-EXISTING BEHAVIOUR, recorded here because it is what a
    // reader of the assertion above will otherwise get wrong: the same 429
    // reaches the SDK transport's `onerror`, so `RemoteMcpSession` classifies
    // it as `endpoint_unreachable` and drops the session out of `ready`. A rate
    // limit therefore TEARS THE SESSION DOWN as well as pausing it, and the
    // pause cannot govern the next call on this connection because there is no
    // next call on this connection. Whether a 429 should be a session-killing
    // transport failure at all is a design question this change does not
    // answer — see the WARP-2300 handoff notes.
    expect(session.health()).toMatchObject({
      state: "unreachable",
      reason: "endpoint_unreachable",
    });
    expect(sleep).not.toHaveBeenCalled();

    // What the pause DOES buy: the scheduler is per SESSION, not per transport,
    // so it outlives the drop. The reconnected connection still owes the vendor
    // the wait it asked for, and pays it before the next call goes out.
    expect((await session.connect()).state).toBe("ready");
    await session.callTool("getJiraIssue", {});
    expect(sleep).toHaveBeenCalledWith(7_000);

    await session.close();
  });
});
