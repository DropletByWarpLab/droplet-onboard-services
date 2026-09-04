/**
 * WARP-2627 — the bridge's HTTP surface: the bearer, the closed server-id
 * registry, the session lifecycle on the wire, and rule 19.
 *
 * NOTHING HERE OPENS OR LISTENS ON A SOCKET. `handleBridgeRequest` is a
 * function from a parsed request to a status and a body, and every session is a
 * real `RemoteMcpSession` driven by an injected connection double — so the
 * routing, the auth and the refusals under test are the shipped ones, not
 * stand-ins.
 *
 * Credential fixtures are obviously fake (`ATATT-FAKE-000000000000`) and every
 * host fixture is RFC 2606 reserved.
 */
import { describe, it, expect, vi } from "vitest";
import {
  BridgeSessionStore,
  handleBridgeRequest,
  type BridgeApiOptions,
  type BridgeRequest,
} from "../src/http-api.js";
import { RemoteMcpSession, type RemoteMcpConnection, type RemoteToolDescriptor } from "../src/remote-session.js";
import type { SessionFactory } from "../src/session-profiles.js";
import { basicCredential } from "../src/credentials.js";

const TOKEN = "bridge-token-FAKE-0000000000000000";
const FAKE_EMAIL = "ops@vendor.example";
const FAKE_API_TOKEN = "ATATT-FAKE-000000000000";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";
const TEST_URL = "https://mcp.example.test/v1/mcp";

function tool(name: string): RemoteToolDescriptor {
  return { name, description: `${name} description`, inputSchema: { type: "object" } };
}

interface Harness {
  opts: BridgeApiOptions;
  store: BridgeSessionStore;
  connect: ReturnType<typeof vi.fn>;
  factory: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  logLines: Record<string, unknown>[];
  /** Fire the transport's close handler, so a test can drive a session into a
   *  failure state without reaching into its privates. */
  drop: (err?: unknown) => void;
}

function harness(
  over: {
    serviceToken?: string;
    tools?: RemoteToolDescriptor[];
    callToolImpl?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    connectImpl?: () => Promise<RemoteMcpConnection>;
  } = {},
): Harness {
  const tools = over.tools ?? [tool("getJiraIssue")];
  let onClosed: (err?: unknown) => void = () => {};
  const listTools = vi.fn(async () => tools);
  const callTool = vi.fn(
    over.callToolImpl ??
      (async () => ({ content: [{ type: "text", text: "{}" }], isError: false })),
  );
  const close = vi.fn(async () => {});
  const connection = {
    listTools,
    callTool,
    close,
    onClosed: (h: (err?: unknown) => void) => {
      onClosed = h;
    },
  } as unknown as RemoteMcpConnection;

  const connect = vi.fn(over.connectImpl ?? (async () => connection));
  const factory = vi.fn((input: { email: string; apiToken: string; cloudId: string; url?: string }) => {
    // A real session, with a real credential closure — so the rule-19
    // assertions below are about the shipped object graph.
    return new RemoteMcpSession({
      serverId: "atlassian",
      url: input.url ?? TEST_URL,
      credential: basicCredential(input.email, input.apiToken),
      connect: connect as never,
      scheduleRetry: () => undefined,
    });
  });

  const store = new BridgeSessionStore({ atlassian: factory as unknown as SessionFactory });
  const logLines: Record<string, unknown>[] = [];
  return {
    opts: {
      serviceToken: over.serviceToken ?? TOKEN,
      store,
      log: (line) => logLines.push(line),
    },
    store,
    connect,
    factory,
    listTools,
    callTool,
    close,
    logLines,
    drop: (err?: unknown) => onClosed(err),
  };
}

function req(over: Partial<BridgeRequest> & Pick<BridgeRequest, "method" | "path">): BridgeRequest {
  return { authorization: `Bearer ${TOKEN}`, ...over };
}

async function openSession(h: Harness, body?: Record<string, unknown>) {
  return handleBridgeRequest(
    req({
      method: "POST",
      path: "/sessions/atlassian/open",
      body: body ?? {
        email: FAKE_EMAIL,
        apiToken: FAKE_API_TOKEN,
        cloudId: FAKE_CLOUD_ID,
        url: TEST_URL,
      },
    }),
    h.opts,
  );
}

describe("bridge bearer (WARP-2627)", () => {
  it("fails CLOSED with 503 when no token is configured, and dials nothing", async () => {
    const h = harness({ serviceToken: "" });
    const res = await openSession(h);
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe("AUTH_NOT_CONFIGURED");
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("refuses a wrong bearer with 401 and dials nothing", async () => {
    const h = harness();
    const res = await handleBridgeRequest(
      req({ method: "GET", path: "/sessions/atlassian/tools", authorization: "Bearer wrong" }),
      h.opts,
    );
    expect(res.status).toBe(401);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("refuses a missing Authorization header", async () => {
    const h = harness();
    const res = await handleBridgeRequest(
      { method: "GET", path: "/sessions/atlassian/state", authorization: null },
      h.opts,
    );
    expect(res.status).toBe(401);
  });

  it("refuses a non-bearer scheme carrying the right value", async () => {
    const h = harness();
    const res = await handleBridgeRequest(
      req({ method: "GET", path: "/sessions/atlassian/state", authorization: `Basic ${TOKEN}` }),
      h.opts,
    );
    expect(res.status).toBe(401);
  });

  it("serves /health WITHOUT a bearer, so the compose healthcheck needs no secret", async () => {
    const h = harness({ serviceToken: "" });
    const res = await handleBridgeRequest({ method: "GET", path: "/health" }, h.opts);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

/**
 * The exempt route answers a CONSTANT, and everything that describes this box
 * is behind the bearer.
 *
 * `/health` is reachable by every container on the compose bridge network —
 * Nextcloud, Frigate, Redis, mosquitto and any third-party image among them —
 * with no credential at all, because the compose healthcheck has no secret to
 * present. So whatever it returns is PUBLIC to the box's own service mesh.
 *
 * It used to return `knownServerIds()` and `store.healthAll()`, which is the
 * WARP-2111 shape one layer down: an unauthenticated reader learned which
 * vendors this box knows, whether the customer has connected Atlassian, and —
 * from `state`/`reason`/`consecutiveFailures` — whether their credential is
 * being REJECTED. None of that is liveness.
 */
describe("unauthenticated /health leaks nothing about this box (WARP-2300)", () => {
  it("carries neither knownServers nor sessions, open session or not", async () => {
    const h = harness();
    await openSession(h);
    const res = await handleBridgeRequest({ method: "GET", path: "/health" }, h.opts);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.body).not.toHaveProperty("knownServers");
    expect(res.body).not.toHaveProperty("sessions");
    // Nothing about the vendor, the session state or the credential verdict
    // survives into the unauthenticated body.
    expect(JSON.stringify(res.body)).not.toContain("atlassian");
    expect(JSON.stringify(res.body)).not.toContain("ready");
  });

  it("still answers 200 with no token provisioned, so the probe keeps working", async () => {
    const h = harness({ serviceToken: "" });
    const res = await handleBridgeRequest({ method: "GET", path: "/health" }, h.opts);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /sessions — the inventory, behind the bearer (WARP-2300)", () => {
  it("serves knownServers and every open session's health to an authorised caller", async () => {
    const h = harness();
    await openSession(h);
    const res = await handleBridgeRequest(req({ method: "GET", path: "/sessions" }), h.opts);
    expect(res.status).toBe(200);
    const body = res.body as { knownServers: string[]; sessions: { serverId: string; state: string }[] };
    expect(body.knownServers).toEqual(["atlassian"]);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.serverId).toBe("atlassian");
    expect(body.sessions[0]!.state).toBe("ready");
  });

  it("serves the inventory with no session open — an empty list, not a 409", async () => {
    const h = harness();
    const res = await handleBridgeRequest(req({ method: "GET", path: "/sessions" }), h.opts);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ knownServers: ["atlassian"], sessions: [] });
  });

  it("401s an unauthenticated reader — this is the route the leak moved to", async () => {
    const h = harness();
    await openSession(h);
    const res = await handleBridgeRequest({ method: "GET", path: "/sessions" }, h.opts);
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(res.body)).not.toContain("atlassian");
  });

  it("401s a wrong bearer", async () => {
    const h = harness();
    const res = await handleBridgeRequest(
      req({ method: "GET", path: "/sessions", authorization: "Bearer wrong" }),
      h.opts,
    );
    expect(res.status).toBe(401);
  });

  it("503s when no token is provisioned — fails CLOSED like every other route", async () => {
    const h = harness({ serviceToken: "" });
    const res = await handleBridgeRequest(req({ method: "GET", path: "/sessions" }), h.opts);
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  it("405s a write method rather than routing it to the close handler", async () => {
    const h = harness();
    const res = await handleBridgeRequest(req({ method: "DELETE", path: "/sessions" }), h.opts);
    expect(res.status).toBe(405);
    expect((res.body as { error: { code: string } }).error.code).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("closed server-id registry", () => {
  it("refuses an id this bridge does not implement, and builds no session", async () => {
    const h = harness();
    const res = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/notion/open", body: { email: FAKE_EMAIL, apiToken: FAKE_API_TOKEN, cloudId: FAKE_CLOUD_ID } }),
      h.opts,
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe("UNKNOWN_SERVER_ID");
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("refuses a syntactically illegal id without touching the store", async () => {
    const h = harness();
    const res = await handleBridgeRequest(
      req({ method: "GET", path: "/sessions/Atlassian_X/state" }),
      h.opts,
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe("UNKNOWN_SERVER_ID");
  });

  it("404s an unknown action on a known server", async () => {
    const h = harness();
    const res = await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/dance" }), h.opts);
    expect(res.status).toBe(404);
  });

  it("405s a wrong method rather than silently routing it", async () => {
    const h = harness();
    const res = await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/open" }), h.opts);
    expect(res.status).toBe(405);
  });
});

describe("session lifecycle on the wire", () => {
  it("opens, lists, calls and closes", async () => {
    const h = harness();

    const opened = await openSession(h);
    expect(opened.status).toBe(200);
    expect((opened.body as { state: { state: string } }).state.state).toBe("ready");

    const listed = await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/tools" }), h.opts);
    expect(listed.status).toBe(200);
    expect((listed.body as { tools: RemoteToolDescriptor[] }).tools.map((t) => t.name)).toEqual([
      "getJiraIssue",
    ]);

    const called = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/atlassian/call", body: { name: "getJiraIssue", args: { issueKey: "WARP-1" } } }),
      h.opts,
    );
    expect(called.status).toBe(200);
    expect(h.callTool).toHaveBeenCalledWith("getJiraIssue", { issueKey: "WARP-1" });

    const deleted = await handleBridgeRequest(req({ method: "DELETE", path: "/sessions/atlassian" }), h.opts);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ closed: true });
    expect(h.close).toHaveBeenCalled();
  });

  it("re-opening REPLACES: the previous session is closed first", async () => {
    const h = harness();
    await openSession(h);
    await openSession(h);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.factory).toHaveBeenCalledTimes(2);
  });

  it("distinguishes 'no session open' from 'session not ready'", async () => {
    const h = harness();
    const noSession = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/atlassian/call", body: { name: "getJiraIssue" } }),
      h.opts,
    );
    expect(noSession.status).toBe(409);
    expect((noSession.body as { error: { code: string } }).error.code).toBe("SESSION_NOT_OPEN");
    expect(h.callTool).not.toHaveBeenCalled();

    await openSession(h);
    h.drop(Object.assign(new Error("HTTP 401"), { code: 401 }));
    const notReady = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/atlassian/call", body: { name: "getJiraIssue" } }),
      h.opts,
    );
    expect(notReady.status).toBe(409);
    const body = notReady.body as { error: { code: string }; state: { state: string; reason: string } };
    expect(body.error.code).toBe("SESSION_NOT_READY");
    // The state travels WITH the refusal — ADR-041's remedy rule: a caller must
    // never have to make a second request to learn what to do about it.
    expect(body.state.state).toBe("auth_rejected");
    expect(body.state.reason).toBe("credential_rejected");
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it("acknowledge-catalog clears the fourth failure state", async () => {
    const tools = [tool("getJiraIssue"), tool("searchJiraIssuesUsingJql")];
    const h = harness({ tools });
    await openSession(h);
    await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/tools" }), h.opts);
    tools.pop();
    const drifted = await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/tools" }), h.opts);
    expect((drifted.body as { state: { state: string } }).state.state).toBe("catalog_changed");

    const acked = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/atlassian/acknowledge-catalog" }),
      h.opts,
    );
    expect((acked.body as { state: { state: string } }).state.state).toBe("ready");
  });

  it("reports state without dialling", async () => {
    const h = harness();
    await openSession(h);
    h.listTools.mockClear();
    const res = await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/state" }), h.opts);
    expect(res.status).toBe(200);
    expect((res.body as { state: { serverId: string } }).state.serverId).toBe("atlassian");
    expect(h.listTools).not.toHaveBeenCalled();
  });
});

describe("request validation", () => {
  it("names the MISSING field and never echoes a value", async () => {
    const h = harness();
    const res = await openSession(h, { email: FAKE_EMAIL, apiToken: FAKE_API_TOKEN });
    expect(res.status).toBe(400);
    const message = (res.body as { error: { message: string } }).error.message;
    expect(message).toContain("cloudId");
    expect(message).not.toContain(FAKE_API_TOKEN);
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("refuses a non-object body", async () => {
    const h = harness();
    const res = await openSession(h, ["nope"] as unknown as Record<string, unknown>);
    expect(res.status).toBe(400);
  });

  it("refuses non-object call args rather than forwarding them", async () => {
    const h = harness();
    await openSession(h);
    const res = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/atlassian/call", body: { name: "getJiraIssue", args: "oops" } }),
      h.opts,
    );
    expect(res.status).toBe(400);
    expect(h.callTool).not.toHaveBeenCalled();
  });

  it("refuses a URL outside the profile's allowed-host set at OPEN time", async () => {
    // The real Atlassian factory, so the refusal under test is
    // `assertSafeMcpUrl` against the shipped one-host set.
    const store = new BridgeSessionStore();
    const res = await handleBridgeRequest(
      req({
        method: "POST",
        path: "/sessions/atlassian/open",
        body: {
          email: FAKE_EMAIL,
          apiToken: FAKE_API_TOKEN,
          cloudId: FAKE_CLOUD_ID,
          url: "https://auth.atlassian.com/v1/mcp",
        },
      }),
      { serviceToken: TOKEN, store },
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
  });
});

describe("upstream failures", () => {
  it("relays OUR typed error message, with the classified state", async () => {
    const h = harness({
      callToolImpl: async () => {
        throw Object.assign(new Error("Atlassian returned no structuredContent for 'getJiraIssue'"), {
          code: "ATLASSIAN_STRUCTURED_CONTENT_UNAVAILABLE",
        });
      },
    });
    await openSession(h);
    const res = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/atlassian/call", body: { name: "getJiraIssue" } }),
      h.opts,
    );
    expect(res.status).toBe(502);
    expect((res.body as { error: { message: string } }).error.message).toContain("structuredContent");
  });

  it("REPLACES an uncoded error's text — a vendor's error body never crosses", async () => {
    const h = harness({
      callToolImpl: async () => {
        throw new Error("upstream said: token sk_live_LEAKED belongs to acme.example");
      },
    });
    await openSession(h);
    const res = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/atlassian/call", body: { name: "getJiraIssue" } }),
      h.opts,
    );
    expect(res.status).toBe(502);
    const message = (res.body as { error: { message: string } }).error.message;
    expect(message).not.toContain("sk_live_LEAKED");
    expect(message).toContain("classified reason");
  });
});

describe("rule 19 — the credential never comes back out", () => {
  it("appears in no response body and no log line across a full sequence", async () => {
    const h = harness({
      callToolImpl: async () => {
        throw new Error("boom");
      },
    });
    const responses = [
      await openSession(h),
      await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/tools" }), h.opts),
      await handleBridgeRequest(
        req({ method: "POST", path: "/sessions/atlassian/call", body: { name: "getJiraIssue" } }),
        h.opts,
      ),
      await handleBridgeRequest(req({ method: "GET", path: "/sessions/atlassian/state" }), h.opts),
      await handleBridgeRequest({ method: "GET", path: "/health" }, h.opts),
    ];
    const serialised = JSON.stringify(responses) + JSON.stringify(h.logLines);
    expect(serialised).not.toContain(FAKE_API_TOKEN);
    expect(serialised).not.toContain(FAKE_EMAIL);
    expect(serialised).not.toContain(TOKEN);
    // The log carries the shape of a request and nothing from it.
    expect(h.logLines.every((l) => Object.keys(l).every((k) => ["method", "path", "status"].includes(k)))).toBe(true);
  });
});
