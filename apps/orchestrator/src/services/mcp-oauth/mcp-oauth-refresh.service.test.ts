/**
 * WARP-2416 - proactive refresh: before expiry, single-flight, host-pinned, and
 * a dead sign-in becomes NEEDS_RECONNECT with an audit row.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
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
  const v = vendor();
  let clock = new Date(T0);
  const first = v.issue(T0, (o.expiresInMin ?? 5) * 60);
  const row = await db.seed({
    id: ID, provider: "atlassian", scope: "MEMBER", memberId: "u1", state: "CONNECTED", issuer: "https://auth.example/iss",
    tokenEndpointHost: o.hostPin ?? "auth.example", clientId: "client-1",
    tokenExpiresAt: new Date(T0.getTime() + (o.expiresInMin ?? 5) * MIN), connectedAt: T0, lastRefreshOkAt: T0,
  });
  const blob = {
    accessToken: first, refreshToken: o.refreshToken === undefined ? "refresh-1" : o.refreshToken,
    expiresAt: row.tokenExpiresAt.toISOString(), scope: "read:me", tokenEndpoint: o.tokenEndpoint ?? "https://auth.example/oauth/token",
    revocationEndpoint: "https://auth.example/oauth/revoke", resource: "res", mcpUrl: "res",
  };
  row.tokensEnc = sealTokens(row, blob);
  const oauth = {
    refresh: vi.fn(async (_i: Record<string, unknown>): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scope?: string }> =>
      ({ accessToken: v.issue(clock, 3600), refreshToken: "refresh-2", expiresIn: 3600 })),
  };
  const closeSession = vi.fn(async (_p: string, _c: string): Promise<void> => {});
  const refresher = createMcpOAuthRefresher({ prisma: db.prisma, oauth, now: () => clock, closeSession });
  return { db, v, oauth, closeSession, refresher, row, first, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
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
    await Promise.resolve();
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

describe("failure", () => {
  it("invalid_grant moves the row to NEEDS_RECONNECT, clears the tokens, closes the session and writes an audit row", async () => {
    const s = await setup();
    s.oauth.refresh.mockRejectedValueOnce(new McpBridgeError("INVALID_GRANT", "revoked", 400));
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
    const r = mountMcpOAuthRefresh({ scheduleInterval }, { prisma: s.db.prisma, oauth: s.oauth });
    expect(scheduleInterval).toHaveBeenCalledWith(60_000, expect.any(Function), { lockKey: "droplet:mcp-oauth-refresh" });
    expect(mcpOAuthRefresher()).toBe(r);
  });

  it("has no timer or loop of its own", () => {
    const src = readFileSync(new URL("./mcp-oauth-refresh.service.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/setInterval|setTimeout|while\s*\(\s*true/);
  });
});

describe("disconnect revokes at the vendor when it advertised an endpoint", () => {
  it("revokes the refresh token, closes the session, and still disconnects if the revoke fails", async () => {
    const s = await setup();
    const oauth = { revoke: vi.fn(async (_i: unknown): Promise<void> => { throw new Error("vendor down"); }) };
    const closeSession = vi.fn(async (_p: string, _c: string): Promise<void> => {});
    expect(await disconnectMcpOAuth(s.db.prisma, ID, { id: "u1", role: "family" }, { oauth: oauth as never, closeSession })).toBe(true);
    expect(oauth.revoke).toHaveBeenCalledWith({ revocationEndpoint: "https://auth.example/oauth/revoke", clientId: "client-1", token: "refresh-1" });
    expect(closeSession).toHaveBeenCalledWith("atlassian", ID);
    expect(s.row).toMatchObject({ state: "DISCONNECTED", tokensEnc: null });
  });
});
