/**
 * WARP-2316 / WARP-2326 / WARP-2332 — the Atlassian profile.
 *
 * NOTHING HERE DIALS. Every connection is an injected double, every credential
 * fixture is obviously fake (`ATATT-FAKE-…`), and the one host that is NOT
 * `mcp.atlassian.com` is RFC 2606 reserved.
 *
 * The centrepiece is the #213 A/B: one fixture server, two client names, and
 * an assertion that the difference is legible rather than silent.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ATLASSIAN_ALLOWED_MCP_HOSTS,
  ATLASSIAN_CLOUD_ID_ARG,
  ATLASSIAN_MCP_CLIENT_INFO,
  ATLASSIAN_MCP_CLIENT_NAME,
  ATLASSIAN_MCP_HOST,
  ATLASSIAN_MCP_PROTOCOL_VERSION,
  ATLASSIAN_MCP_URL,
  ATLASSIAN_SERVER_ID,
  ATLASSIAN_STRUCTURED_CONTENT_TOOLS,
  AtlassianStructuredContentUnavailableError,
  assertStructuredContentPresent,
  createAtlassianMcpSession,
  withAtlassianCloudId,
} from "../src/atlassian.js";
import { RemoteCallScheduler } from "../src/call-scheduler.js";
import { UnsafeMcpUrlError } from "../src/safe-url.js";
import { TruncatedResultError } from "../src/truncation.js";
import type {
  RemoteMcpConnection,
  RemoteMcpConnectInput,
  RemoteToolCallOutcome,
} from "../src/remote-session.js";

const FAKE_EMAIL = "ops@vendor.example";
const FAKE_TOKEN = "ATATT-FAKE-000000000000";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";
const OTHER_CLOUD_ID = "11111111-1111-4111-8111-111111111111";

interface Recorder {
  connect: (input: RemoteMcpConnectInput) => Promise<RemoteMcpConnection>;
  calls: { name: string; args: Record<string, unknown> }[];
  inputs: RemoteMcpConnectInput[];
}

/** A connection double whose `callTool` result the test supplies. */
function recorder(
  result: RemoteToolCallOutcome = { content: [], isError: false, structuredContent: {} },
): Recorder {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const inputs: RemoteMcpConnectInput[] = [];
  return {
    calls,
    inputs,
    connect: async (input) => {
      inputs.push(input);
      return {
        listTools: async () => [],
        callTool: async (name, args) => {
          calls.push({ name, args });
          return result;
        },
        close: async () => {},
        onClosed: () => {},
      };
    },
  };
}

function session(rec: Recorder, over: Partial<Parameters<typeof createAtlassianMcpSession>[0]> = {}) {
  return createAtlassianMcpSession({
    email: FAKE_EMAIL,
    apiToken: FAKE_TOKEN,
    cloudId: FAKE_CLOUD_ID,
    connect: rec.connect,
    ...over,
  });
}

describe("the constants a security reviewer reads", () => {
  it("names one fixed host, as a whole-string literal", () => {
    // The egress gate backs `atlassian-mcp` with the literal in atlassian.ts;
    // a host assembled from parts would not count (WARP-2452).
    expect(ATLASSIAN_MCP_HOST).toBe("mcp.atlassian.com");
    expect(ATLASSIAN_MCP_URL).toBe("https://mcp.atlassian.com/v1/mcp");
    expect([...ATLASSIAN_ALLOWED_MCP_HOSTS]).toEqual([ATLASSIAN_MCP_HOST]);
  });

  it("dials NO OAuth host — auth.atlassian.com is an explicit v1 non-goal", () => {
    expect(ATLASSIAN_ALLOWED_MCP_HOSTS.has("auth.atlassian.com")).toBe(false);
    expect(ATLASSIAN_ALLOWED_MCP_HOSTS.has("api.atlassian.com")).toBe(false);
  });

  it("uses the Streamable-HTTP path, not the deprecated /v1/sse one", () => {
    expect(ATLASSIAN_MCP_URL.endsWith("/v1/mcp")).toBe(true);
    expect(ATLASSIAN_MCP_URL).not.toContain("/sse");
    expect(ATLASSIAN_MCP_URL).not.toContain("authv2");
  });

  it("pins the protocol version and the client name as named constants", () => {
    expect(ATLASSIAN_MCP_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(ATLASSIAN_MCP_CLIENT_INFO.name).toBe(ATLASSIAN_MCP_CLIENT_NAME);
  });

  it("uses a server id the multiplexer's namespace pattern accepts", () => {
    // lowercase, no underscore — otherwise `<serverId>__<wireName>` is ambiguous.
    expect(ATLASSIAN_SERVER_ID).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });
});

describe("the host guard runs at construction", () => {
  it("builds against the shipped URL", () => {
    expect(() => session(recorder())).not.toThrow();
  });

  it("refuses an off-host override, even one the caller passes deliberately", () => {
    expect(() =>
      session(recorder(), { url: "https://mcp.atlassian.example/v1/mcp" }),
    ).toThrow(UnsafeMcpUrlError);
  });

  it("refuses http, so a Basic credential is never sent in the clear", () => {
    expect(() => session(recorder(), { url: "http://mcp.atlassian.com/v1/mcp" })).toThrow(
      UnsafeMcpUrlError,
    );
  });

  it("refuses a URL carrying userinfo", () => {
    expect(() =>
      session(recorder(), { url: "https://evil@mcp.atlassian.com/v1/mcp" }),
    ).toThrow(UnsafeMcpUrlError);
  });
});

describe("the credential", () => {
  it("presents Basic auth on the connect headers and nothing else", async () => {
    const rec = recorder();
    await session(rec).connect();
    const headers = rec.inputs[0]!.headers;
    expect(Object.keys(headers)).toEqual(["Authorization"]);
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`, "utf8").toString("base64")}`,
    );
  });

  it("describes itself by the PRINCIPAL — rule 19, never the token", () => {
    const s = session(recorder());
    expect(s.describeCredential()).toBe(`basic(${FAKE_EMAIL})`);
    expect(JSON.stringify(s.health())).not.toContain("ATATT");
    expect(s.describeCredential()).not.toContain(FAKE_TOKEN);
  });
});

describe("cloudId is forced, not defaulted", () => {
  it("rides on every call", async () => {
    const rec = recorder();
    const s = session(rec);
    await s.connect();
    await s.callTool("getJiraIssue", { issueIdOrKey: "FAKE-1" });
    expect(rec.calls[0]!.args).toEqual({
      issueIdOrKey: "FAKE-1",
      [ATLASSIAN_CLOUD_ID_ARG]: FAKE_CLOUD_ID,
    });
  });

  it("OVERWRITES a cloudId the model supplied", async () => {
    // The API token is not site-bound: one token reaches every site the
    // account can see. If the model's argument won, a prompt injection could
    // read a different Atlassian site than the operator connected.
    const rec = recorder();
    const s = session(rec);
    await s.connect();
    await s.callTool("getJiraIssue", { cloudId: OTHER_CLOUD_ID, issueIdOrKey: "FAKE-1" });
    expect(rec.calls[0]!.args[ATLASSIAN_CLOUD_ID_ARG]).toBe(FAKE_CLOUD_ID);
  });

  it("refuses to build a session with no cloudId at all", () => {
    const inner: RemoteMcpConnection = {
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
      onClosed: () => {},
    };
    expect(() => withAtlassianCloudId(inner, "")).toThrow(/not site-bound/);
  });
});

describe("upstream #213 — structuredContent presence, A/B", () => {
  /**
   * ONE fixture server, two client names. It models the defect exactly: it
   * enriches the response only for a name on its recognised list.
   *
   * The recognised list is the SERVER's, and Atlassian does not publish theirs
   * — see ATLASSIAN_MCP_CLIENT_NAME's comment. What this A/B pins is that the
   * enrichment DEPENDS on the name and that the difference reaches the caller
   * as a typed error rather than as a quietly poorer result.
   */
  function fixtureServer(recognised: readonly string[]) {
    return (clientName: string): RemoteToolCallOutcome =>
      recognised.includes(clientName)
        ? {
            content: [{ type: "text", text: "FAKE-1" }],
            isError: false,
            structuredContent: {
              key: "FAKE-1",
              webUrl: "https://example.test/browse/FAKE-1",
            },
          }
        : { content: [{ type: "text", text: "FAKE-1" }], isError: false };
  }

  const server = fixtureServer(["cursor", "recognised-client"]);

  it("A — a RECOGNISED client name gets structuredContent, so webUrl survives", () => {
    const enriched = server("recognised-client");
    expect(enriched.structuredContent).toBeDefined();
    expect(() => assertStructuredContentPresent("getJiraIssue", enriched)).not.toThrow();
  });

  it("B — an UNRECOGNISED client name gets none, and that is raised, not swallowed", () => {
    const bare = server(ATLASSIAN_MCP_CLIENT_NAME);
    expect(bare.structuredContent).toBeUndefined();
    const err = catchError(() => assertStructuredContentPresent("getJiraIssue", bare));
    expect(err).toBeInstanceOf(AtlassianStructuredContentUnavailableError);
    expect((err as Error).message).toContain("#213");
    expect((err as Error).message).toContain(ATLASSIAN_MCP_CLIENT_NAME);
  });

  it("the guard only fires for tools whose value depends on the structured half", () => {
    // Plenty of Atlassian tools answer in prose. Flagging those would make the
    // guard noise and get it deleted.
    expect(ATLASSIAN_STRUCTURED_CONTENT_TOOLS.has("getJiraIssue")).toBe(true);
    expect(ATLASSIAN_STRUCTURED_CONTENT_TOOLS.has("atlassianUserInfo")).toBe(false);
    expect(() =>
      assertStructuredContentPresent("atlassianUserInfo", {
        content: [{ type: "text", text: "Ada Fake" }],
        isError: false,
      }),
    ).not.toThrow();
  });

  it("exempts an isError result — a failure has no structured half to miss", () => {
    expect(() =>
      assertStructuredContentPresent("getJiraIssue", {
        content: [{ type: "text", text: "not found" }],
        isError: true,
      }),
    ).not.toThrow();
  });

  it("fires end to end through the session's guard stack", async () => {
    const rec = recorder({ content: [{ type: "text", text: "FAKE-1" }], isError: false });
    const s = session(rec);
    await s.connect();
    await expect(s.callTool("getJiraIssue", { issueIdOrKey: "FAKE-1" })).rejects.toBeInstanceOf(
      AtlassianStructuredContentUnavailableError,
    );
  });
});

describe("the guard stack composes", () => {
  it("raises TruncatedResultError through a live session (#221)", async () => {
    const rec = recorder({
      content: [],
      isError: false,
      structuredContent: {
        nodes: [1, 2, 3, 4, 5],
        pageInfo: { hasNextPage: false, endCursor: null },
        remainingCount: 240,
      },
    });
    const s = session(rec);
    await s.connect();
    await expect(s.callTool("searchJiraIssuesUsingJql", { jql: "project = FAKE" })).rejects.toBeInstanceOf(
      TruncatedResultError,
    );
    // The call DID reach the server — this is a response guard, not a refusal.
    expect(rec.calls).toHaveLength(1);
  });

  it("puts every call through the shared scheduler", async () => {
    const scheduler = new RemoteCallScheduler({ maxConcurrent: 1 });
    const rec = recorder();
    const s = session(rec, { scheduler });
    await s.connect();
    await Promise.all([
      s.callTool("atlassianUserInfo", {}),
      s.callTool("atlassianUserInfo", {}),
      s.callTool("atlassianUserInfo", {}),
    ]);
    expect(rec.calls).toHaveLength(3);
    expect(scheduler.stats().peakInFlight).toBe(1);
  });

  it("makes no call at all when the session is not ready", async () => {
    const rec = recorder();
    const s = session(rec);
    // Never connected: a refusal must not reach the wire.
    await expect(s.callTool("getJiraIssue", {})).rejects.toThrow();
    expect(rec.calls).toHaveLength(0);
  });
});

describe("the session identifies itself as the allowlisted server", () => {
  it("carries the atlassian server id and the screened url", () => {
    const s = session(recorder());
    expect(s.serverId).toBe(ATLASSIAN_SERVER_ID);
    expect(s.url).toBe(ATLASSIAN_MCP_URL);
    expect(s.health().state).toBe("idle");
  });

  it("reports ready only after a successful connect", async () => {
    const s = session(recorder());
    expect(s.isStarted).toBe(false);
    await s.connect();
    expect(s.isStarted).toBe(true);
  });

  it("classifies a 401 as auth_rejected, never as an empty tool list", async () => {
    const failing = {
      connect: vi.fn(async () => {
        throw Object.assign(new Error("HTTP 401"), { code: 401 });
      }),
      calls: [],
      inputs: [],
    } as unknown as Recorder;
    const s = session(failing);
    const health = await s.connect();
    expect(health.state).toBe("auth_rejected");
    expect(health.reason).toBe("credential_rejected");
  });
});

function catchError(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}
