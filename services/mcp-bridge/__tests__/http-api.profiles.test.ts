/**
 * WARP-3703 (ADR-043 TC-1.1) — `POST /sessions/:serverId/open` validates the
 * body against the PROFILE it names, not against a contract every server shares.
 *
 * The existing `http-api.test.ts` stays as it was: it drives the Atlassian-shaped
 * bare-factory form and is the regression net for "Atlassian is unchanged".
 * This file adds what that suite cannot say — a server whose contract is NOT
 * `email` + `apiToken` + `cloudId`, and two servers answering to different
 * contracts in one store.
 *
 * NOTHING HERE OPENS OR LISTENS ON A SOCKET, and both vendors are TEST-ONLY
 * fixtures: each is built inside this file, handed to a `BridgeSessionStore`
 * constructed for the test, and registered nowhere else. Neither may ever be an
 * entry of the production `SESSION_PROFILES` (`session-profiles.test.ts` pins
 * that registry closed). Credential fixtures are obviously fake and the one
 * host is RFC 2606 reserved.
 */
import { describe, it, expect, vi } from "vitest";
import {
  BridgeSessionStore,
  handleBridgeRequest,
  type BridgeApiOptions,
  type BridgeRequest,
} from "../src/http-api.js";
import { bearerCredential } from "../src/credentials.js";
import { RemoteMcpSession, type RemoteMcpConnection } from "../src/remote-session.js";
import type { OpenSessionInput, SessionProfile } from "../src/session-profiles.js";

const TOKEN = "bridge-token-FAKE-0000000000000000";
const FAKE_API_TOKEN = "FIXTURE-FAKE-TOKEN-000000";
const FAKE_EMAIL = "ops@vendor.example";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";
const TEST_URL = "https://mcp.example.test/v1/mcp";

const BEARER_ID = "fixture-bearer";
const TRIO_ID = "fixture-trio";

interface FixtureVendor {
  profile: SessionProfile;
  factory: ReturnType<typeof vi.fn>;
  /** What the factory was handed — the route's output, which is the subject. */
  inputs: OpenSessionInput[];
  close: ReturnType<typeof vi.fn>;
}

/** A vendor double: a REAL `RemoteMcpSession` over an injected connection, so
 *  the credential closure and the session lifecycle under test are the shipped
 *  ones. Only the vendor on the far side of the connection is a double. */
function fixtureVendor(serverId: string, requiredFields: readonly string[]): FixtureVendor {
  const inputs: OpenSessionInput[] = [];
  const close = vi.fn(async () => {});
  const connection = {
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
    close,
    onClosed: () => {},
  } as unknown as RemoteMcpConnection;
  const factory = vi.fn((input: OpenSessionInput) => {
    inputs.push(input);
    return new RemoteMcpSession({
      serverId,
      url: TEST_URL,
      credential: bearerCredential(String(input.apiToken ?? "x")),
      connect: (async () => connection) as never,
      scheduleRetry: () => undefined,
      ...(input.knownTools !== undefined ? { knownToolNames: input.knownTools } : {}),
    });
  });
  return { profile: { requiredFields, factory }, factory, inputs, close };
}

interface Harness {
  opts: BridgeApiOptions;
  store: BridgeSessionStore;
  bearer: FixtureVendor;
  trio: FixtureVendor;
  logLines: Record<string, unknown>[];
}

/** One store, two vendors with DIFFERENT contracts: one Bearer token, and the
 *  Atlassian-shaped trio. */
function harness(): Harness {
  const bearer = fixtureVendor(BEARER_ID, ["apiToken"]);
  const trio = fixtureVendor(TRIO_ID, ["email", "apiToken", "cloudId"]);
  const store = new BridgeSessionStore({
    [BEARER_ID]: bearer.profile,
    [TRIO_ID]: trio.profile,
  });
  const logLines: Record<string, unknown>[] = [];
  return {
    opts: { serviceToken: TOKEN, store, log: (line) => logLines.push(line) },
    store,
    bearer,
    trio,
    logLines,
  };
}

function req(over: Partial<BridgeRequest> & Pick<BridgeRequest, "method" | "path">): BridgeRequest {
  return { authorization: `Bearer ${TOKEN}`, ...over };
}

function open(h: Harness, id: string, body: Record<string, unknown>) {
  return handleBridgeRequest(req({ method: "POST", path: `/sessions/${id}/open`, body }), h.opts);
}

const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; message: string } }).error;

describe("a bearer-only profile opens with its one field (TC-1.1)", () => {
  it("opens with {apiToken} alone and hands the factory that field and nothing Atlassian-shaped", async () => {
    const h = harness();
    const res = await open(h, BEARER_ID, { apiToken: FAKE_API_TOKEN, url: TEST_URL });
    expect(res.status).toBe(200);
    expect((res.body as { state: { state: string } }).state.state).toBe("ready");
    expect(h.bearer.factory).toHaveBeenCalledTimes(1);
    expect(h.bearer.inputs[0]).toEqual({ apiToken: FAKE_API_TOKEN, url: TEST_URL });
    expect(h.bearer.inputs[0]).not.toHaveProperty("email");
    expect(h.bearer.inputs[0]).not.toHaveProperty("cloudId");
  });

  it("refuses an EMPTY apiToken with a 400 that names only the field — never the value", async () => {
    const h = harness();
    const res = await open(h, BEARER_ID, { apiToken: "   " });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toEqual({ code: "INVALID_REQUEST", message: "Missing or empty: apiToken." });
    expect(h.bearer.factory).not.toHaveBeenCalled();
  });

  it("refuses an ABSENT apiToken the same way", async () => {
    const h = harness();
    const res = await open(h, BEARER_ID, {});
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Missing or empty: apiToken.");
    expect(h.bearer.factory).not.toHaveBeenCalled();
  });

  it("does not echo a value it WAS given when it refuses for a different field", async () => {
    // The vendor's contract is {apiToken}; a caller that sends a secret under
    // the wrong name gets the right name back, and its secret is not returned.
    const h = harness();
    const res = await open(h, BEARER_ID, { token: FAKE_API_TOKEN });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_API_TOKEN);
    expect(errorOf(res).message).toBe("Missing or empty: apiToken.");
  });

  it("ignores Atlassian-shaped fields it was not asked for: they are neither required nor forwarded", async () => {
    const h = harness();
    const res = await open(h, BEARER_ID, {
      apiToken: FAKE_API_TOKEN,
      email: FAKE_EMAIL,
      cloudId: FAKE_CLOUD_ID,
      url: TEST_URL,
    });
    expect(res.status).toBe(200);
    expect(h.bearer.inputs[0]).toEqual({ apiToken: FAKE_API_TOKEN, url: TEST_URL });
  });
});

describe("each id answers to ITS OWN contract (TC-1.1)", () => {
  it("names every missing field, in the order the profile declares them", async () => {
    const h = harness();
    const res = await open(h, TRIO_ID, {});
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Missing or empty: email, apiToken, cloudId.");
  });

  it("does not let a bearer-only body satisfy the trio, and names what is still missing", async () => {
    const h = harness();
    const res = await open(h, TRIO_ID, { apiToken: FAKE_API_TOKEN });
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Missing or empty: email, cloudId.");
    expect(h.trio.factory).not.toHaveBeenCalled();
  });

  it("opens the trio with all three, handing the factory exactly those three", async () => {
    const h = harness();
    const res = await open(h, TRIO_ID, {
      email: FAKE_EMAIL,
      apiToken: FAKE_API_TOKEN,
      cloudId: FAKE_CLOUD_ID,
      url: TEST_URL,
    });
    expect(res.status).toBe(200);
    expect(h.trio.inputs[0]).toEqual({
      email: FAKE_EMAIL,
      apiToken: FAKE_API_TOKEN,
      cloudId: FAKE_CLOUD_ID,
      url: TEST_URL,
    });
  });

  it("carries the vetted-catalog baseline for a bearer-only profile too, and still refuses a malformed one", async () => {
    const h = harness();
    const ok = await open(h, BEARER_ID, { apiToken: FAKE_API_TOKEN, knownTools: ["a", "b"] });
    expect(ok.status).toBe(200);
    expect(h.bearer.inputs[0]?.knownTools).toEqual(["a", "b"]);

    const bad = await open(h, BEARER_ID, { apiToken: FAKE_API_TOKEN, knownTools: "a" });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).message).toBe("knownTools must be an array of strings.");
    expect(h.bearer.factory).toHaveBeenCalledTimes(1);
  });
});

describe("the registry is still closed (TC-1.1)", () => {
  it("answers UNKNOWN_SERVER_ID for an id no profile serves, builds nothing, and lists the ids THIS store serves", async () => {
    const h = harness();
    const res = await open(h, "notion", { apiToken: FAKE_API_TOKEN });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("UNKNOWN_SERVER_ID");
    expect(errorOf(res).message).toContain(`${BEARER_ID}, ${TRIO_ID}`);
    expect(h.bearer.factory).not.toHaveBeenCalled();
    expect(h.trio.factory).not.toHaveBeenCalled();
  });

  it("does not let an inherited property name stand in for a profile", async () => {
    const h = harness();
    const res = await open(h, "constructor", { apiToken: FAKE_API_TOKEN });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("UNKNOWN_SERVER_ID");
  });

  it("lists every profile's id on the bearer-gated inventory", async () => {
    const h = harness();
    const res = await handleBridgeRequest(req({ method: "GET", path: "/sessions" }), h.opts);
    expect(res.status).toBe(200);
    expect((res.body as { knownServers: string[] }).knownServers).toEqual([BEARER_ID, TRIO_ID]);
  });
});

describe("two servers in one store do not share a fate (TC-1.1)", () => {
  it("closing one leaves the other open and answering", async () => {
    const h = harness();
    await open(h, BEARER_ID, { apiToken: FAKE_API_TOKEN, url: TEST_URL });
    await open(h, TRIO_ID, {
      email: FAKE_EMAIL,
      apiToken: FAKE_API_TOKEN,
      cloudId: FAKE_CLOUD_ID,
      url: TEST_URL,
    });
    expect(h.store.healthAll().map((s) => s.serverId)).toEqual([BEARER_ID, TRIO_ID]);

    const closed = await handleBridgeRequest(
      req({ method: "DELETE", path: `/sessions/${BEARER_ID}` }),
      h.opts,
    );
    expect(closed.body).toEqual({ closed: true });
    expect(h.bearer.close).toHaveBeenCalledTimes(1);
    expect(h.trio.close).not.toHaveBeenCalled();

    expect(h.store.healthAll().map((s) => s.serverId)).toEqual([TRIO_ID]);
    const state = await handleBridgeRequest(
      req({ method: "GET", path: `/sessions/${TRIO_ID}/state` }),
      h.opts,
    );
    expect(state.status).toBe(200);
    expect((state.body as { state: { state: string } }).state.state).toBe("ready");
  });
});

describe("a bare factory keeps the contract every factory had before profiles (TC-1.1)", () => {
  it("is held to email, apiToken and cloudId, so a pre-profile harness behaves as it did", async () => {
    const factory = vi.fn();
    const store = new BridgeSessionStore({ legacy: factory as never });
    const res = await handleBridgeRequest(
      req({ method: "POST", path: "/sessions/legacy/open", body: { apiToken: FAKE_API_TOKEN } }),
      { serviceToken: TOKEN, store },
    );
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Missing or empty: email, cloudId.");
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("rule 19 — the bearer-only credential never comes back out (TC-1.1)", () => {
  it("appears in no response body and no log line across a full sequence", async () => {
    const h = harness();
    const responses = [
      await open(h, BEARER_ID, { apiToken: FAKE_API_TOKEN, url: TEST_URL }),
      await open(h, BEARER_ID, { apiToken: "" }),
      await handleBridgeRequest(req({ method: "GET", path: `/sessions/${BEARER_ID}/tools` }), h.opts),
      await handleBridgeRequest(req({ method: "GET", path: `/sessions/${BEARER_ID}/state` }), h.opts),
      await handleBridgeRequest(req({ method: "GET", path: "/sessions" }), h.opts),
    ];
    const serialised = JSON.stringify(responses) + JSON.stringify(h.logLines);
    expect(serialised).not.toContain(FAKE_API_TOKEN);
    expect(serialised).not.toContain(TOKEN);
    expect(
      h.logLines.every((l) => Object.keys(l).every((k) => ["method", "path", "status"].includes(k))),
    ).toBe(true);
  });
});
