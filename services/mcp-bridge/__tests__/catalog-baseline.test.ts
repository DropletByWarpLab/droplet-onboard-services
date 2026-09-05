/**
 * WARP-2651 — the fourth failure state survives a restart of THIS container.
 *
 * `catalog_changed` is detected by comparing one `listTools()` against the
 * previous one, and both live in this process's memory. That is correct while
 * the process lives and useless the moment it does not: after a restart the
 * orchestrator re-opens, the first listing has nothing to compare against, and a
 * surface that moved while we were down is absorbed as if it had always looked
 * that way. ADR-043 §1's rule — *"a tool that vanished between two
 * `listTools()` calls must not surface as 'there is nothing to do'"* — would be
 * defeated by a `docker restart` rather than by a bug.
 *
 * So the baseline is an INPUT (`knownToolNames` / the wire's `knownTools`), and
 * these tests are what stop it being quietly dropped on any of the three hops
 * between the orchestrator and the session.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ATLASSIAN_MCP_PROTOCOL_VERSION, ATLASSIAN_MCP_URL } from "../src/atlassian.js";
import { RemoteMcpSession, type RemoteMcpConnection } from "../src/remote-session.js";
import { handleBridgeRequest, BridgeSessionStore } from "../src/http-api.js";
import {
  createAtlassianSessionFactory,
  type OpenSessionInput,
  type SessionFactory,
} from "../src/session-profiles.js";

const TOKEN = "bridge-token-FAKE-0000000000000000";
const AUTH = `Bearer ${TOKEN}`;

function connectionServing(names: string[]): RemoteMcpConnection {
  return {
    listTools: async () =>
      names.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    callTool: async () => ({ content: [], isError: false }),
    close: async () => undefined,
    onClosed: () => undefined,
  };
}

function session(names: string[], knownToolNames?: readonly string[]): RemoteMcpSession {
  return new RemoteMcpSession({
    serverId: "atlassian",
    url: "https://mcp.atlassian.com/v1/sse",
    connect: async () => connectionServing(names),
    ...(knownToolNames !== undefined ? { knownToolNames } : {}),
  });
}

describe("a seeded baseline makes the FIRST listing able to detect drift", () => {
  it("flips to catalog_changed when the re-opened surface differs", async () => {
    const s = session(["getJiraIssue", "deleteJiraIssue"], [
      "getJiraIssue",
      "getConfluencePage",
    ]);
    await s.connect();
    expect(s.state).toBe("ready");

    const tools = await s.listTools();

    expect(s.state).toBe("catalog_changed");
    expect(s.catalogDrift()).toEqual({
      removed: ["getConfluencePage"],
      added: ["deleteJiraIssue"],
    });
    // The tools are STILL returned. "There is nothing to do" is the rendering
    // the ADR forbids; the refusal is a state, not an empty list.
    expect(tools.map((t) => t.name)).toEqual(["getJiraIssue", "deleteJiraIssue"]);
  });

  it("stays ready when the re-opened surface is identical", async () => {
    const s = session(["a", "b"], ["a", "b"]);
    await s.connect();
    await s.listTools();
    expect(s.state).toBe("ready");
    expect(s.catalogDrift()).toBeNull();
  });

  it("blocks dispatch until acknowledgeCatalog, exactly as an in-process drift does", async () => {
    const s = session(["a"], ["a", "b"]);
    await s.connect();
    await s.listTools();
    await expect(s.callTool("a", {})).rejects.toMatchObject({
      code: "REMOTE_MCP_SESSION_NOT_READY",
    });

    expect(s.acknowledgeCatalog().state).toBe("ready");
    await expect(s.callTool("a", {})).resolves.toMatchObject({ isError: false });
  });

  it("WITHOUT a baseline the first listing sets one and never flags drift", async () => {
    // The boot case, and the reason the option is optional rather than `[]`: an
    // empty baseline would make every tool on a brand-new box read as `added`.
    const s = session(["a", "b"]);
    await s.connect();
    await s.listTools();
    expect(s.state).toBe("ready");
  });

  it("does not claim a tool count for a listing that has not happened", async () => {
    const s = session(["a", "b"], ["a", "b"]);
    await s.connect();
    // Seeding the drift baseline must not seed the SERVED catalog: `toolCount`
    // is what this session actually returned, not what we expect it to.
    expect(s.health().toolCount).toBe(0);
    await s.listTools();
    expect(s.health().toolCount).toBe(2);
  });
});

describe("the wire carries the baseline to the session", () => {
  function storeServing(names: string[]) {
    const seen: (readonly string[] | undefined)[] = [];
    const factory: SessionFactory = (input: OpenSessionInput) => {
      seen.push(input.knownTools);
      return session(names, input.knownTools);
    };
    return { seen, store: new BridgeSessionStore({ atlassian: factory }) };
  }

  const openBody = (extra: Record<string, unknown> = {}) => ({
    email: "ops@vendor.example",
    apiToken: "ATATT-FAKE-000000000000",
    cloudId: "00000000-0000-4000-8000-000000000000",
    ...extra,
  });

  it("passes knownTools through open and drift is reported on the first listing", async () => {
    const { seen, store } = storeServing(["getJiraIssue", "deleteJiraIssue"]);
    const opts = { serviceToken: TOKEN, store };

    const opened = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: ["getJiraIssue", "getConfluencePage"] }),
      },
      opts,
    );
    expect(opened.status).toBe(200);
    expect(seen).toEqual([["getJiraIssue", "getConfluencePage"]]);

    const listed = await handleBridgeRequest(
      { method: "GET", path: "/sessions/atlassian/tools", authorization: AUTH },
      opts,
    );
    expect(listed.status).toBe(200);
    expect((listed.body as { state: { state: string } }).state.state).toBe("catalog_changed");
  });

  it("an absent knownTools stays ABSENT rather than becoming an empty baseline", async () => {
    const { seen, store } = storeServing(["a"]);
    await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody(),
      },
      { serviceToken: TOKEN, store },
    );
    expect(seen).toEqual([undefined]);
  });

  it("refuses a malformed knownTools instead of silently dropping it", async () => {
    // Dropping it would disable drift detection for that session — the exact
    // failure this field exists to prevent, arriving as a typo.
    const { store } = storeServing(["a"]);
    const res = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: "getJiraIssue" }),
      },
      { serviceToken: TOKEN, store },
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
  });

  it("refuses an array with a non-string entry", async () => {
    const { store } = storeServing(["a"]);
    const res = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: ["a", 7] }),
      },
      { serviceToken: TOKEN, store },
    );
    expect(res.status).toBe(400);
  });

  it("never echoes the credential back, baseline or not (rule 19)", async () => {
    const { store } = storeServing(["a"]);
    const res = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: ["a"] }),
      },
      { serviceToken: TOKEN, store },
    );
    expect(JSON.stringify(res.body)).not.toContain("ATATT-FAKE-000000000000");
  });
});

describe("the PRODUCTION factory hands the baseline to the session", () => {
  /**
   * `createAtlassianSessionFactory` is what `SESSION_FACTORIES` serves, and it
   * has been a builder rather than a literal since the WARP-2300 rate-limit
   * seam — which is where this branch's `knownTools` → `knownToolNames`
   * hand-over had to be re-homed on the merge to `stage`. The tests above
   * prove the wire carries the field to A factory; this one proves the SHIPPED
   * factory does not drop it on the floor, which `http-api.ts`'s 400 guard
   * cannot see (it validates the field and hands it on; what the factory then
   * does with it is invisible to the route).
   *
   * Same socket stub as `rate-limit-seam.test.ts`: the SDK, the transport, the
   * guard stack, the scheduler and the session are all real, and
   * `globalThis.fetch` throws on any URL or method it was not given.
   */
  function stubVendorServing(names: string[]): void {
    const impl = async (url: unknown, init: unknown): Promise<Response> => {
      if (String(url) !== ATLASSIAN_MCP_URL) {
        throw new Error(`the stub was asked for an unexpected URL: ${String(url)}`);
      }
      const raw = (init as { body?: string }).body;
      // The SDK's GET for the SSE stream; a POST-only server answers 405.
      if (raw === undefined) return new Response(null, { status: 405 });
      const message = JSON.parse(raw) as { id?: number; method: string };
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      switch (message.method) {
        case "initialize":
          return reply({
            protocolVersion: ATLASSIAN_MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "atlassian-mcp-server", version: "1.0.0" },
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return reply({
            tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
          });
        default:
          throw new Error(`the stub was asked for an unexpected method: ${message.method}`);
      }
    };
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a session built by createAtlassianSessionFactory flips to catalog_changed on its FIRST listing", async () => {
    stubVendorServing(["getJiraIssue", "deleteJiraIssue"]);
    const factory = createAtlassianSessionFactory();
    const s = factory({
      email: "ops@vendor.example",
      apiToken: "ATATT-FAKE-000000000000",
      cloudId: "00000000-0000-4000-8000-000000000000",
      knownTools: ["getJiraIssue", "getConfluencePage"],
    });
    expect((await s.connect()).state).toBe("ready");

    await s.listTools();

    // THE assertion behind the merge resolution: the builder handed
    // `knownTools` to the session. Drop the spread inside
    // `createAtlassianSessionFactory` and this reads "ready" — the moved
    // surface silently absorbed on the first re-open after a bridge restart.
    expect(s.state).toBe("catalog_changed");
    expect(s.catalogDrift()).toEqual({
      removed: ["getConfluencePage"],
      added: ["deleteJiraIssue"],
    });
    await s.close();
  });

  it("and stays ready when the shipped factory is handed the surface it then sees", async () => {
    stubVendorServing(["getJiraIssue", "getConfluencePage"]);
    const s = createAtlassianSessionFactory()({
      email: "ops@vendor.example",
      apiToken: "ATATT-FAKE-000000000000",
      cloudId: "00000000-0000-4000-8000-000000000000",
      knownTools: ["getJiraIssue", "getConfluencePage"],
    });
    await s.connect();
    await s.listTools();
    expect(s.state).toBe("ready");
    expect(s.catalogDrift()).toBeNull();
    await s.close();
  });
});
