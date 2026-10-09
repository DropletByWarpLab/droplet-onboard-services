/**
 * WARP-2409 (bridge half) — one bearer session per member connection, and the
 * kill switch that closes them all.
 *
 * NOTHING HERE OPENS A SOCKET: every session is a real `RemoteMcpSession`
 * over a per-session connection double. Credentials are obviously fake and the
 * connection ids are fixed UUIDs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATLASSIAN_MCP_OAUTH_URL,
  ATLASSIAN_MCP_URL,
  ATLASSIAN_REQUIRED_FIELDS,
  ATLASSIAN_REQUIRED_FIELD_SETS,
} from "../src/atlassian.js";
import { bearerCredential } from "../src/credentials.js";
import { BridgeSessionStore, handleBridgeRequest, type BridgeRequest } from "../src/http-api.js";
import { RemoteMcpSession, type RemoteMcpConnection } from "../src/remote-session.js";
import { SESSION_PROFILES, type OpenSessionInput, type SessionFactory } from "../src/session-profiles.js";

const TOKEN = "bridge-token-FAKE-0000000000000000";
const CLOUD = "00000000-0000-4000-8000-000000000000";
const CONN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FAKE_ACCESS = "FAKE-ACCESS-TOKEN-0000";
const TEST_URL = "https://mcp.example.test/v1/mcp";

interface Conn {
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  input: OpenSessionInput;
}

/** A store whose factory records every session it builds, one double each. */
function harness(connectImpl?: () => Promise<void>) {
  const conns: Conn[] = [];
  const factory: SessionFactory = (input) => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }], isError: false }));
    const close = vi.fn(async () => {});
    conns.push({ callTool, close, input });
    const connection = {
      listTools: vi.fn(async () => []),
      callTool,
      close,
      onClosed: () => {},
    } as unknown as RemoteMcpConnection;
    return new RemoteMcpSession({
      serverId: "atlassian",
      url: TEST_URL,
      credential: bearerCredential("FAKE"),
      connect: (async () => {
        await connectImpl?.();
        return connection;
      }) as never,
      scheduleRetry: () => undefined,
    });
  };
  return { conns, factory };
}

function storeOf(factory: SessionFactory, options?: ConstructorParameters<typeof BridgeSessionStore>[1]) {
  return new BridgeSessionStore(
    { atlassian: { requiredFields: ATLASSIAN_REQUIRED_FIELDS, requiredFieldSets: ATLASSIAN_REQUIRED_FIELD_SETS, factory } },
    options,
  );
}

const send = (store: BridgeSessionStore, method: string, path: string, body?: unknown) =>
  handleBridgeRequest({ method, path, authorization: `Bearer ${TOKEN}`, body } as BridgeRequest, {
    serviceToken: TOKEN,
    store,
  });

const API_BODY = { email: "ops@vendor.example", apiToken: "ATATT-FAKE-0000", cloudId: CLOUD };
const bearerBody = (connectionId?: string) => ({
  accessToken: FAKE_ACCESS,
  cloudId: CLOUD,
  ...(connectionId ? { connectionId } : {}),
});

afterEach(() => vi.useRealTimers());

describe("open: either field set, never a mix", () => {
  it("accepts the API-token set and the bearer set", async () => {
    const { factory, conns } = harness();
    const store = storeOf(factory);
    expect((await send(store, "POST", "/sessions/atlassian/open", API_BODY)).status).toBe(200);
    expect((await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_A))).status).toBe(200);
    expect(Object.keys(conns[0]!.input).sort()).toEqual(["apiToken", "cloudId", "email"]);
    expect(Object.keys(conns[1]!.input).sort()).toEqual(["accessToken", "cloudId"]);
  });

  it("refuses partial and mixed bodies, naming the field and building nothing", async () => {
    const { factory, conns } = harness();
    const store = storeOf(factory);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ accessToken: FAKE_ACCESS }, "Missing or empty: cloudId."],
      [{ email: "a@b.example", cloudId: CLOUD }, "Missing or empty: apiToken."],
      [{}, "Missing or empty: email, apiToken, cloudId."],
      [{ ...API_BODY, accessToken: FAKE_ACCESS }, "Not allowed with this credential: accessToken."],
      [{ accessToken: FAKE_ACCESS, cloudId: CLOUD, email: "a@b.example" }, "Not allowed with this credential: email."],
    ];
    for (const [body, message] of cases) {
      const res = await send(store, "POST", "/sessions/atlassian/open", body);
      expect(res.status).toBe(400);
      expect((res.body as { error: { message: string } }).error.message).toBe(message);
    }
    expect(conns).toHaveLength(0);
  });

  it("refuses a connectionId that is not a UUID", async () => {
    const { factory, conns } = harness();
    const res = await send(storeOf(factory), "POST", "/sessions/atlassian/open", bearerBody("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(conns).toHaveLength(0);
  });

  it("the production factory presents a bearer on the OAuth endpoint, and Basic on the old one", () => {
    const factory = SESSION_PROFILES.atlassian!.factory;
    const oauth = factory({ accessToken: FAKE_ACCESS, cloudId: CLOUD });
    expect(oauth.url).toBe(ATLASSIAN_MCP_OAUTH_URL);
    expect(oauth.describeCredential()).toBe("bearer");
    expect(oauth.describeCredential()).not.toContain(FAKE_ACCESS);
    const basic = factory({ email: "ops@vendor.example", apiToken: "ATATT-FAKE-0000", cloudId: CLOUD });
    expect(basic.url).toBe(ATLASSIAN_MCP_URL);
    expect(basic.describeCredential()).toBe("basic(ops@vendor.example)");
  });
});

describe("call routes to the member's own session", () => {
  async function two() {
    const h = harness();
    const store = storeOf(h.factory);
    await send(store, "POST", "/sessions/atlassian/open", API_BODY);
    await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_A));
    await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_B));
    return { ...h, store };
  }

  it("reaches exactly the named connection, or the base session when none is named", async () => {
    const { store, conns } = await two();
    await send(store, "POST", "/sessions/atlassian/call", { name: "getJiraIssue", connectionId: CONN_A });
    expect(conns.map((c) => c.callTool.mock.calls.length)).toEqual([0, 1, 0]);
    await send(store, "POST", "/sessions/atlassian/call", { name: "getJiraIssue" });
    expect(conns.map((c) => c.callTool.mock.calls.length)).toEqual([1, 1, 0]);
  });

  it("answers 409 NO_SESSION for an unknown connection and never falls back to another principal", async () => {
    const { store, conns } = await two();
    const res = await send(store, "POST", "/sessions/atlassian/call", {
      name: "getJiraIssue",
      connectionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("NO_SESSION");
    expect(conns.every((c) => c.callTool.mock.calls.length === 0)).toBe(true);
  });

  it("refuses a malformed connectionId on call and close", async () => {
    const { store } = await two();
    expect((await send(store, "POST", "/sessions/atlassian/call", { name: "x", connectionId: "nope" })).status).toBe(400);
    expect((await send(store, "POST", "/sessions/atlassian/close", {})).status).toBe(400);
    expect((await send(store, "POST", "/sessions/atlassian/close", { connectionId: "nope" })).status).toBe(400);
  });

  it("close { connectionId } closes that session only", async () => {
    const { store, conns } = await two();
    const res = await send(store, "POST", "/sessions/atlassian/close", { connectionId: CONN_A });
    expect(res.body).toEqual({ closed: true });
    expect(conns.map((c) => c.close.mock.calls.length)).toEqual([0, 1, 0]);
    expect(store.get("atlassian", CONN_A)).toBeUndefined();
    expect(store.get("atlassian", CONN_B)).toBeDefined();
    expect(store.get("atlassian")).toBeDefined();
  });
});

describe("the kill switch", () => {
  it("DELETE closes the base session and every member session", async () => {
    const h = harness();
    const store = storeOf(h.factory);
    await send(store, "POST", "/sessions/atlassian/open", API_BODY);
    await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_A));
    await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_B));
    const res = await send(store, "DELETE", "/sessions/atlassian");
    expect(res.body).toEqual({ closed: true });
    expect(h.conns.map((c) => c.close.mock.calls.length)).toEqual([1, 1, 1]);
    expect(store.connectionSessionCounts()).toEqual({});
    expect(store.get("atlassian")).toBeUndefined();
  });

  it("a kill switch that runs while a NEW connection is still connecting wins: nothing survives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(() => gate);
    const store = storeOf(h.factory);
    const opening = send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_A));
    await vi.waitFor(() => expect(h.conns).toHaveLength(1));
    const killing = send(store, "DELETE", "/sessions/atlassian");
    release();
    const [res] = await Promise.all([opening, killing]);
    expect(res.status).toBe(409);
    expect(store.get("atlassian", CONN_A)).toBeUndefined();
    expect(store.connectionSessionCounts()).toEqual({});
    expect(h.conns[0]!.close).toHaveBeenCalled();
  });

  it("an open that starts after the kill switch returned is allowed (an event, not a latch)", async () => {
    const h = harness();
    const store = storeOf(h.factory);
    await send(store, "DELETE", "/sessions/atlassian");
    expect((await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_A))).status).toBe(200);
    expect(store.get("atlassian", CONN_A)).toBeDefined();
  });

  it("GET /sessions reports a count per server and no connection id or member", async () => {
    const h = harness();
    const store = storeOf(h.factory);
    await send(store, "POST", "/sessions/atlassian/open", API_BODY);
    await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_A));
    await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_B));
    const res = await send(store, "GET", "/sessions");
    const body = res.body as { sessions: unknown[]; connectionSessions: Record<string, number> };
    expect(body.sessions).toHaveLength(1);
    expect(body.connectionSessions).toEqual({ atlassian: 2 });
    expect(JSON.stringify(res.body)).not.toContain(CONN_A);
  });
});

describe("idle eviction", () => {
  it("closes a member session untouched for 30 minutes, and a call resets the clock", async () => {
    vi.useFakeTimers();
    const h = harness();
    const store = storeOf(h.factory);
    await send(store, "POST", "/sessions/atlassian/open", API_BODY);
    await send(store, "POST", "/sessions/atlassian/open", bearerBody(CONN_A));

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    await send(store, "POST", "/sessions/atlassian/call", { name: "getJiraIssue", connectionId: CONN_A });
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(store.get("atlassian", CONN_A)).toBeDefined(); // touched at minute 29
    // (the get above touched it again at minute 58)
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(store.connectionSessionCounts()).toEqual({});
    expect(h.conns[1]!.close).toHaveBeenCalledTimes(1);
    // The server-level session is never evicted.
    expect(store.get("atlassian")).toBeDefined();
    expect(h.conns[0]!.close).not.toHaveBeenCalled();
  });
});
