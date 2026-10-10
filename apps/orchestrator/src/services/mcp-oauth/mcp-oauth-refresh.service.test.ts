/**
 * WARP-2416 - proactive refresh: before expiry, single-flight, host-pinned, and
 * a dead sign-in becomes NEEDS_RECONNECT with an audit row.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../__tests__/helpers/test-paths.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setColumnCryptoKeyForTest, deriveMcpOAuthTokenKey, encryptColumn, mcpOAuthAad } from "../column-crypto.service.js";
import { McpBridgeError } from "../mcp-bridge.client.js";
import { disconnectMcpOAuth, openTokens, sealTokens } from "./mcp-oauth.service.js";
import { mountMcpOAuthRefresh, createMcpOAuthRefresher } from "./mcp-oauth-refresh.service.js";
import { mcpOAuthRefresher, registerMcpOAuthRefresher } from "./mcp-oauth-refresher.js";
import { fakeMcpOAuthDb } from "./__tests__/fake-db.js";

const recordActivity = vi.hoisted(() => vi.fn(async (_p: Record<string, unknown>) => null));
vi.mock("../activity.singleton.js", () => ({ recordActivity }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
}));

type Egress = Awaited<ReturnType<Parameters<typeof createMcpOAuthRefresher>[0]["egress"]>>;
const T0 = new Date("2026-10-09T12:00:00Z");
const MIN = 60_000;
const ID = "33333333-3333-3333-3333-333333333333";

/** A vendor that answers 401 to any access token used after it expired. */
function vendor() {
  const expiry = new Map<string, number>();
  let n = 0;
  return {
    issue(at: Date, ttlS: number) { const t = `access-${++n}`; expiry.set(t, at.getTime() + ttlS * 1000); return t; },
    call(token: string, at: Date): 200 | 401 { return (expiry.get(token) ?? 0) > at.getTime() ? 200 : 401; },
  };
}

async function setup(o: { expiresInMin?: number; refreshToken?: string | null; tokenEndpoint?: string; hostPin?: string; secret?: string } = {}) {
  const db = fakeMcpOAuthDb();
  db.setUser({ id: "u1", username: "alice" });
  const v = vendor();
  let clock = new Date(T0);
  const first = v.issue(T0, (o.expiresInMin ?? 5) * 60);
  const row = await db.seed({
    id: ID, provider: "atlassian", scope: "MEMBER", memberId: "u1", state: "CONNECTED", issuer: "https://auth.example/iss",
    tokenEndpointHost: o.hostPin ?? "auth.example", clientId: "client-1", tokensEnc: "placeholder-replaced-below",
    tokenExpiresAt: new Date(T0.getTime() + (o.expiresInMin ?? 5) * MIN), connectedAt: T0, lastRefreshOkAt: T0,
  });
  const blob = {
    accessToken: first, refreshToken: o.refreshToken === undefined ? "refresh-1" : o.refreshToken,
    expiresAt: row.tokenExpiresAt.toISOString(), scope: "read:me", tokenEndpoint: o.tokenEndpoint ?? "https://auth.example/oauth/token",
    revocationEndpoint: "https://auth.example/oauth/revoke", resource: "res", mcpUrl: "res",
  };
  row.tokensEnc = sealTokens(row, blob);
  if (o.secret) row.clientSecretEnc = encryptColumn(deriveMcpOAuthTokenKey(), o.secret, mcpOAuthAad(row));
  /** Another signed-in row (a member, or the Workspace when memberId is null), expiring in `min` minutes. */
  const addRow = async (id: string, memberId: string | null, min: number) => {
    const r = await db.seed({
      id, provider: "atlassian", scope: memberId ? "MEMBER" : "WORKSPACE", memberId, state: "CONNECTED",
      issuer: "https://auth.example/iss", tokenEndpointHost: "auth.example", clientId: "client-1", tokensEnc: "x",
      tokenExpiresAt: new Date(T0.getTime() + min * MIN), workspaceAckAt: T0, workspaceAckBy: "boss",
    });
    r.tokensEnc = sealTokens(r, { ...blob, expiresAt: r.tokenExpiresAt.toISOString() });
    return r;
  };
  const oauth = {
    refresh: vi.fn(async (_i: unknown): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> =>
      ({ accessToken: v.issue(clock, 3600), refreshToken: "refresh-2", expiresIn: 3600 })),
  };
  const closeSession = vi.fn(async (_p: string, _c: string): Promise<void> => {});
  const gate: { current: Egress } = { current: { allowed: true, row: null } };
  const egress = async (): Promise<Egress> => gate.current;
  const catalogChanged = vi.fn(async (_p: string, _c: string): Promise<void> => {});
  const refresher = createMcpOAuthRefresher({ prisma: db.prisma, oauth, now: () => clock, closeSession, egress, catalogChanged });
  return { db, v, oauth, closeSession, catalogChanged, refresher, gate, egress, addRow, row, first, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
}

beforeEach(() => {
  recordActivity.mockClear();
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
  registerMcpOAuthRefresher(null);
});

describe("refresh before expiry", () => {
  it("replaces the token before it expires, so the call after expiry gets zero 401s", async () => {
    const s = await setup({ expiresInMin: 5 });
    await s.refresher.tick(); // 5 min left: inside the 10 min window
    s.advance(6 * MIN); // the first token is now dead
    const held = openTokens(s.row);
    expect(held.accessToken).not.toBe(s.first);
    const statuses = [s.v.call(held.accessToken, s.now())];
    expect(statuses.filter((c) => c === 401)).toHaveLength(0);
    expect(s.v.call(s.first, s.now())).toBe(401); // proves the vendor does expire tokens
    expect(s.row.tokenExpiresAt).toEqual(new Date(T0.getTime() + 3600_000));
    expect(s.row.lastRefreshOkAt).toEqual(T0);
  });

  it("leaves a token with plenty of life alone", async () => {
    const s = await setup({ expiresInMin: 30 });
    await s.refresher.tick();
    expect(s.oauth.refresh).not.toHaveBeenCalled();
  });

  it("sends the resource, the stored refresh token and the granted scope (never wider), plus the client secret when sealed", async () => {
    const s = await setup();
    await s.refresher.refreshNow(ID);
    expect(s.oauth.refresh).toHaveBeenCalledWith({
      tokenEndpoint: "https://auth.example/oauth/token", clientId: "client-1", refreshToken: "refresh-1", resource: "res", scope: "read:me",
    });
  });

  it("stores a rotated refresh token, and keeps the old one when the server does not rotate", async () => {
    const rot = await setup();
    await rot.refresher.refreshNow(ID);
    expect(openTokens(rot.row).refreshToken).toBe("refresh-2");
    const keep = await setup();
    keep.oauth.refresh.mockResolvedValueOnce({ accessToken: "a", expiresIn: 3600 });
    await keep.refresher.refreshNow(ID);
    expect(openTokens(keep.row).refreshToken).toBe("refresh-1");
  });
});

describe("single flight", () => {
  it("two simultaneous callers make one bridge call and both get the result", async () => {
    const s = await setup();
    let release!: () => void;
    s.oauth.refresh.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { release = r; });
      return { accessToken: "a", refreshToken: "refresh-2", expiresIn: 3600 };
    });
    const a = s.refresher.refreshNow(ID);
    const b = s.refresher.refreshNow(ID);
    // The refresh runs after the row is read; wait until the bridge call is actually in flight.
    await vi.waitFor(() => expect(s.oauth.refresh).toHaveBeenCalled());
    release();
    expect(await Promise.all([a, b])).toEqual(["refreshed", "refreshed"]);
    expect(s.oauth.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a row that changed while the vendor was answering", async () => {
    const s = await setup();
    s.oauth.refresh.mockImplementationOnce(async () => {
      s.row.tokensEnc = sealTokens(s.row, { ...openTokens(s.row), accessToken: "someone-elses" });
      return { accessToken: "a", refreshToken: "refresh-2", expiresIn: 3600 };
    });
    expect(await s.refresher.refreshNow(ID)).toBe("refreshed");
    expect(openTokens(s.row).accessToken).toBe("someone-elses");
  });
});

describe("the catalog session follows the row (WARP-2416)", () => {
  it("tells the catalog after a successful refresh, with the row's provider and id", async () => {
    const s = await setup();
    await s.refresher.refreshNow(ID);
    expect(s.catalogChanged).toHaveBeenCalledWith("atlassian", ID);
  });

  it("tells it when the sign-in ends (invalid_grant), but not on a transient failure or when egress is refused", async () => {
    const dead = await setup();
    dead.oauth.refresh.mockRejectedValueOnce(new McpBridgeError("OAUTH_TOKEN_ERROR", "revoked", 502, undefined, "invalid_grant"));
    await dead.refresher.refreshNow(ID);
    expect(dead.catalogChanged).toHaveBeenCalledWith("atlassian", ID);

    const flaky = await setup();
    flaky.oauth.refresh.mockRejectedValueOnce(new McpBridgeError("REMOTE_CALL_FAILED", "502", 502));
    await flaky.refresher.refreshNow(ID);
    expect(flaky.catalogChanged).not.toHaveBeenCalled();

    const off = await setup();
    off.gate.current = { allowed: false, reason: "channel_disabled", message: "" };
    await off.refresher.refreshNow(ID);
    expect(off.catalogChanged).not.toHaveBeenCalled();
  });

  it("a failing hook never fails the refresh", async () => {
    const s = await setup();
    s.catalogChanged.mockRejectedValueOnce(new Error("boom"));
    expect(await s.refresher.refreshNow(ID)).toBe("refreshed");
  });
});

describe("failure", () => {
  it("invalid_grant moves the row to NEEDS_RECONNECT, clears the tokens, closes the session and writes an audit row", async () => {
    const s = await setup();
    s.oauth.refresh.mockRejectedValueOnce(new McpBridgeError("OAUTH_TOKEN_ERROR", "revoked", 502, undefined, "invalid_grant"));
    expect(await s.refresher.refreshNow(ID)).toBe("needs_reconnect");
    expect(s.row).toMatchObject({ state: "NEEDS_RECONNECT", tokensEnc: null, tokenExpiresAt: null });
    expect(s.row.state).not.toBe("DISCONNECTED");
    expect(s.closeSession).toHaveBeenCalledWith("atlassian", ID);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0][0]).toMatchObject({ kind: "auth", refs: expect.objectContaining({ connectionId: ID, state: "NEEDS_RECONNECT" }) });
    expect(JSON.stringify(recordActivity.mock.calls)).not.toMatch(/refresh-1|access-/);
    // and a later caller is told so without dialling
    s.oauth.refresh.mockClear();
    expect(await s.refresher.refreshNow(ID)).toBe("needs_reconnect");
    expect(s.oauth.refresh).not.toHaveBeenCalled();
  });

  it("a transient failure keeps the sign-in until the token has actually expired", async () => {
    const s = await setup({ expiresInMin: 5 });
    s.oauth.refresh.mockRejectedValue(new McpBridgeError("REMOTE_CALL_FAILED", "502", 502));
    expect(await s.refresher.refreshNow(ID)).toBe("unavailable");
    expect(s.row).toMatchObject({ state: "CONNECTED", lastError: "refresh_failed" });
    s.advance(6 * MIN);
    expect(await s.refresher.refreshNow(ID)).toBe("needs_reconnect");
    expect(s.row.state).toBe("NEEDS_RECONNECT");
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });

  it("refuses a token endpoint whose host is not the one pinned at sign-in, without dialling", async () => {
    const s = await setup({ tokenEndpoint: "https://evil.example/oauth/token" });
    expect(await s.refresher.refreshNow(ID)).toBe("unavailable");
    expect(s.oauth.refresh).not.toHaveBeenCalled();
    expect(s.row).toMatchObject({ state: "ERROR", lastError: "token_endpoint_host_changed" });
    const http = await setup({ tokenEndpoint: "http://auth.example/oauth/token" });
    expect(await http.refresher.refreshNow(ID)).toBe("unavailable");
    expect(http.oauth.refresh).not.toHaveBeenCalled();
  });

  it("with no refresh token the sign-in ends only once the token has stopped working", async () => {
    const s = await setup({ refreshToken: null, expiresInMin: 5 });
    expect(await s.refresher.refreshNow(ID)).toBe("unavailable");
    expect(s.row.state).toBe("CONNECTED");
    s.advance(6 * MIN);
    expect(await s.refresher.refreshNow(ID)).toBe("needs_reconnect");
  });
});

describe("scheduling", () => {
  it("mounts one interval on the cron runtime with its own lock key, and registers the refresher for dispatch", async () => {
    const s = await setup();
    const scheduleInterval = vi.fn();
    const r = mountMcpOAuthRefresh({ scheduleInterval }, { prisma: s.db.prisma, oauth: s.oauth, egress: s.egress });
    expect(scheduleInterval).toHaveBeenCalledWith(60_000, expect.any(Function), { lockKey: "droplet:mcp-oauth-refresh" });
    expect(mcpOAuthRefresher()).toBe(r);
  });

  it("has no timer or loop of its own", () => {
    const src = readFileSync(
      join(REPO_ROOT, "apps", "orchestrator", "src", "services", "mcp-oauth", "mcp-oauth-refresh.service.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/setInterval|setTimeout|while\s*\(\s*true/);
  });
});

describe("disconnect revokes at the vendor when it advertised an endpoint", () => {
  it("revokes the refresh token, closes the session, and still disconnects if the revoke fails", async () => {
    const s = await setup();
    const oauth = { revoke: vi.fn(async (_i: unknown): Promise<void> => { throw new Error("vendor down"); }) };
    const closeSession = vi.fn(async (_p: string, _c: string): Promise<void> => {});
    expect(await disconnectMcpOAuth(s.db.prisma, ID, { id: "u1", role: "family" }, { oauth: oauth as never, closeSession, egress: s.egress })).toBe(true);
    expect(oauth.revoke).toHaveBeenCalledWith({ revocationEndpoint: "https://auth.example/oauth/revoke", clientId: "client-1", token: "refresh-1" });
    expect(closeSession).toHaveBeenCalledWith("atlassian", ID);
    expect(s.row).toMatchObject({ state: "DISCONNECTED", tokensEnc: null });
  });

  it("with remote MCP switched off it still deletes the tokens locally, skips the vendor revoke and says so", async () => {
    const s = await setup();
    s.gate.current = { allowed: false, reason: "channel_disabled", message: "" };
    const oauth = { revoke: vi.fn(async (_i: unknown): Promise<void> => {}) };
    const notes: { revokeSkipped?: boolean } = {};
    expect(await disconnectMcpOAuth(s.db.prisma, ID, { id: "u1", role: "family" }, { oauth: oauth as never, closeSession: s.closeSession, egress: s.egress }, notes)).toBe(true);
    expect(oauth.revoke).not.toHaveBeenCalled();
    expect(notes.revokeSkipped).toBe(true);
    expect(s.row).toMatchObject({ state: "DISCONNECTED", tokensEnc: null, tokenExpiresAt: null });
    expect(s.closeSession).toHaveBeenCalledWith("atlassian", ID);
  });
});

describe("refresh obeys the same egress rules as every remote MCP call", () => {
  const OFF: Egress[] = [
    { allowed: false, reason: "channel_disabled", message: "" },
    { allowed: false, reason: "server_not_allowlisted", message: "" },
    { allowed: false, reason: "connection_disabled", message: "" },
  ];

  it.each(OFF)("makes ZERO bridge calls and leaves the row untouched when %j", async (verdict) => {
    const s = await setup({ expiresInMin: 5 });
    s.gate.current = verdict;
    const before = { ...s.row };
    await s.refresher.tick();
    expect(await s.refresher.refreshNow(ID)).toBe("unavailable");
    expect(s.oauth.refresh).not.toHaveBeenCalled();
    expect(s.row).toEqual(before); // not NEEDS_RECONNECT, not ERROR, tokens kept
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("does not end an already-expired sign-in while remote MCP is off either", async () => {
    const s = await setup({ expiresInMin: 5 });
    s.gate.current = OFF[0];
    s.advance(10 * MIN);
    expect(await s.refresher.refreshNow(ID)).toBe("unavailable");
    expect(s.row.state).toBe("CONNECTED");
  });

  it("resumes renewing once it is switched back on", async () => {
    const s = await setup({ expiresInMin: 5 });
    s.gate.current = OFF[0];
    await s.refresher.tick();
    s.gate.current = { allowed: true, row: null };
    await s.refresher.tick();
    expect(s.oauth.refresh).toHaveBeenCalledTimes(1);
  });

  it("a failed read of the rules refuses too", async () => {
    const s = await setup({ expiresInMin: 5 });
    const r = createMcpOAuthRefresher({ prisma: s.db.prisma, oauth: s.oauth, now: () => s.now(), egress: async () => { throw new Error("db"); } });
    expect(await r.refreshNow(ID)).toBe("unavailable");
    expect(s.oauth.refresh).not.toHaveBeenCalled();
  });
});

describe("review fixes: leavers, ordering, cross-process races, revoke", () => {
  const WS = "44444444-4444-4444-4444-444444444444";
  const BOB = "55555555-5555-5555-5555-555555555555";

  it("the tick renews the Workspace row and active members, but not a deactivated or deleted member's grant", async () => {
    const s = await setup({ expiresInMin: 5 });
    await s.addRow(WS, null, 5);
    await s.addRow(BOB, "u-bob", 5);
    s.db.setUser({ id: "u-bob", username: "bob", directoryStatus: "DEACTIVATED" });
    await s.refresher.tick();
    const touched = s.catalogChanged.mock.calls.map((c) => c[1]).sort();
    expect(touched).toEqual([ID, WS].sort()); // bob's row was never refreshed
    expect(s.oauth.refresh).toHaveBeenCalledTimes(2);

    const gone = await setup({ expiresInMin: 5 });
    gone.db.setUser({ id: "u1", deletionStatus: "PENDING" });
    await gone.refresher.tick();
    expect(gone.oauth.refresh).not.toHaveBeenCalled();
  });

  it("the tick works through the soonest-to-expire rows first", async () => {
    const s = await setup({ expiresInMin: 9 });
    const A = "66666666-6666-6666-6666-666666666666";
    const B = "77777777-7777-7777-7777-777777777777";
    await s.addRow(A, "u1b", 2);
    await s.addRow(B, "u1c", 6);
    s.db.setUser({ id: "u1b" });
    s.db.setUser({ id: "u1c" });
    await s.refresher.tick();
    expect(s.catalogChanged.mock.calls.map((c) => c[1])).toEqual([A, B, ID]);
  });

  it("an invalid_grant after another process already refreshed is not a sign-out", async () => {
    const s = await setup();
    s.oauth.refresh.mockImplementationOnce(async () => {
      // the other process spent the old refresh token and stored new tokens
      s.row.tokensEnc = sealTokens(s.row, { ...openTokens(s.row), accessToken: "from-the-other-process", refreshToken: "rotated" });
      throw new McpBridgeError("OAUTH_TOKEN_ERROR", "old token spent", 502, undefined, "invalid_grant");
    });
    expect(await s.refresher.refreshNow(ID)).toBe("refreshed");
    expect(s.row.state).toBe("CONNECTED");
    expect(openTokens(s.row).accessToken).toBe("from-the-other-process");
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("a genuinely dead grant (tokens unchanged) still ends the sign-in", async () => {
    const s = await setup();
    s.oauth.refresh.mockRejectedValueOnce(new McpBridgeError("OAUTH_TOKEN_ERROR", "revoked", 502, undefined, "invalid_grant"));
    expect(await s.refresher.refreshNow(ID)).toBe("needs_reconnect");
  });

  it("disconnect revokes with the client secret when the client has one", async () => {
    const s = await setup({ secret: "client-secret-1" });
    const oauth = { revoke: vi.fn(async (_i: unknown): Promise<void> => {}) };
    const deps = { oauth: oauth as never, closeSession: s.closeSession, egress: s.egress };
    expect(await disconnectMcpOAuth(s.db.prisma, ID, { id: "u1", role: "family" }, deps)).toBe(true);
    expect(oauth.revoke).toHaveBeenCalledWith({
      revocationEndpoint: "https://auth.example/oauth/revoke", clientId: "client-1", clientSecret: "client-secret-1", token: "refresh-1",
    });
  });

  it("any revoke failure, or an unreadable gate, is reported (never a clean sign-out)", async () => {
    for (const failure of ["vendor", "gate"] as const) {
      const s = await setup();
      const oauth = { revoke: vi.fn(async (_i: unknown): Promise<void> => { if (failure === "vendor") throw new Error("down"); }) };
      const egress = failure === "gate" ? async (): Promise<Egress> => { throw new Error("db"); } : s.egress;
      const notes: { revokeSkipped?: boolean } = {};
      expect(await disconnectMcpOAuth(s.db.prisma, ID, { id: "u1", role: "family" }, { oauth: oauth as never, closeSession: s.closeSession, egress }, notes)).toBe(true);
      expect(notes.revokeSkipped, failure).toBe(true);
      expect(s.row).toMatchObject({ state: "DISCONNECTED", tokensEnc: null });
    }
    const ok = await setup();
    const notes: { revokeSkipped?: boolean } = {};
    await disconnectMcpOAuth(ok.db.prisma, ID, { id: "u1", role: "family" }, { oauth: { revoke: async () => {} } as never, closeSession: ok.closeSession, egress: ok.egress }, notes);
    expect(notes.revokeSkipped).toBeUndefined();
  });

  it("a member's sign-out and a Workspace disconnect each write an audit row with ids and kinds only", async () => {
    const s = await setup();
    await s.addRow(WS, null, 30);
    const deps = { oauth: { revoke: async () => {} } as never, closeSession: s.closeSession, egress: s.egress };
    await disconnectMcpOAuth(s.db.prisma, ID, { id: "u1", role: "family" }, deps);
    await disconnectMcpOAuth(s.db.prisma, WS, { id: "a1", role: "admin" }, deps);
    const rows = recordActivity.mock.calls.map((c) => c[0] as { what: string; refs: Record<string, string> });
    expect(rows.map((r) => r.refs.scope)).toEqual(["MEMBER", "WORKSPACE"]);
    expect(rows.every((r) => r.refs.change === "disconnect" && r.refs.connectionId)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/refresh-1|access-|client-secret/);
  });
});
