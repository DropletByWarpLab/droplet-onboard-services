/**
 * WARP-2115 / ADR-041 — the Microsoft 365 connection lifecycle.
 *
 * Prisma is injected (the repo's service style), so these run with an
 * in-memory fake row store and no database. What they pin is the behaviour
 * ADR-041 actually promises a customer:
 *
 *   - connecting is the consent event, and it starts from OFF;
 *   - disconnecting PURGES the token rather than flipping a flag;
 *   - a dead grant becomes NEEDS_RECONNECT — a first-class, actionable state —
 *     while a broken app registration becomes ERROR;
 *   - nothing the API returns ever carries token material;
 *   - a sign-in abandoned mid-flow cannot wedge the connection forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { sealTokenCache } from "./token-cache.js";
import {
  beginDeviceCodeConnect,
  disconnect,
  getConnectionView,
  getAccessToken,
  M365NotConnectedError,
  type EntraClient,
  type EntraAuthResult,
} from "./m365-auth.service.js";

const TEST_KEY = Buffer.alloc(32, 5).toString("base64");
const USER = "user-1";
const CACHE = JSON.stringify({ RefreshToken: { x: { secret: "0.AXoA-secret-rt" } } });

/** Minimal in-memory stand-in for prisma.m365Connection. */
function fakePrisma(seed: Record<string, unknown> | null = null) {
  let row: Record<string, unknown> | null = seed ? { ...seed } : null;
  return {
    __row: () => row,
    m365Connection: {
      findUnique: vi.fn(async () => (row ? { ...row } : null)),
      upsert: vi.fn(async ({ create, update }: any) => {
        row = row ? { ...row, ...update } : { id: "row-1", userId: USER, ...create };
        return { ...row };
      }),
      update: vi.fn(async ({ data }: any) => {
        row = { ...(row ?? { id: "row-1", userId: USER }), ...data };
        return { ...row };
      }),
    },
  };
}

function authResult(over: Partial<EntraAuthResult> = {}): EntraAuthResult {
  return {
    homeAccountId: "uid.utid",
    tenantId: "tenant-abc",
    accountUpn: "sam@practice.com",
    grantedScopes: "Mail.ReadWrite Calendars.ReadWrite",
    serializedCache: CACHE,
    ...over,
  };
}

/** An EntraClient whose behaviour each test sets explicitly. */
function fakeEntra(over: Partial<EntraClient> = {}): EntraClient {
  return {
    acquireByDeviceCode: vi.fn(async ({ onCode }) => {
      onCode({
        userCode: "ABCD-EFGH",
        verificationUri: "https://microsoft.com/devicelogin",
        expiresAt: new Date(Date.now() + 900_000),
        message: "enter the code",
      });
      return authResult();
    }),
    acquireSilent: vi.fn(async () => ({ ...authResult(), accessToken: "tok" })),
    ...over,
  } as EntraClient;
}

beforeEach(() => __setColumnCryptoKeyForTest(TEST_KEY));
afterEach(() => {
  __setColumnCryptoKeyForTest(null);
  vi.useRealTimers();
});

describe("getConnectionView", () => {
  it("reports DISCONNECTED when the owner has never connected an account", async () => {
    const prisma = fakePrisma(null);
    const view = await getConnectionView(prisma as never, USER);
    expect(view.state).toBe("DISCONNECTED");
    expect(view.accountUpn).toBeNull();
  });

  it("never exposes token material", async () => {
    // The whole point of encrypting the cache is defeated if the view leaks it.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      accountUpn: "sam@practice.com",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
    });
    const view = await getConnectionView(prisma as never, USER);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("tokenCacheEnc");
    expect(serialized).not.toContain("0.AXoA-secret-rt");
    expect(Object.keys(view)).not.toContain("tokenCacheEnc");
  });

  it("reports an abandoned sign-in as DISCONNECTED once its code has expired", async () => {
    // The device-code flow lives in memory; an orchestrator restart drops it.
    // Without this the row reads PENDING_CONSENT forever and the person can
    // never start a new sign-in.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "PENDING_CONSENT",
      pendingFlowExpiresAt: new Date(Date.now() - 1000),
    });
    const view = await getConnectionView(prisma as never, USER);
    expect(view.state).toBe("DISCONNECTED");
  });

  it("still reports PENDING_CONSENT while the code is live", async () => {
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "PENDING_CONSENT",
      pendingFlowExpiresAt: new Date(Date.now() + 60_000),
    });
    expect((await getConnectionView(prisma as never, USER)).state).toBe("PENDING_CONSENT");
  });
});

describe("beginDeviceCodeConnect", () => {
  it("returns the code for the person to enter and parks the row in PENDING_CONSENT", async () => {
    const prisma = fakePrisma(null);
    const started = await beginDeviceCodeConnect(prisma as never, fakeEntra(), USER);

    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.verificationUri).toContain("microsoft.com");
    expect((prisma.__row() as any).state).toBe("PENDING_CONSENT");
  });

  it("stores the token sealed, not in the clear, once the person approves", async () => {
    const prisma = fakePrisma(null);
    await beginDeviceCodeConnect(prisma as never, fakeEntra(), USER);
    await vi.waitFor(() => expect((prisma.__row() as any).state).toBe("CONNECTED"));

    const row = prisma.__row() as any;
    expect(row.tokenCacheEnc).toBeTruthy();
    expect(row.tokenCacheEnc).not.toContain("0.AXoA-secret-rt");
    expect(row.accountUpn).toBe("sam@practice.com");
    expect(row.grantedScopes).toContain("Mail.ReadWrite");
  });

  it("records a tenant that blocks device code as ERROR, so the UI can offer the fallback", async () => {
    // Microsoft recommends tenants block this flow, so it is an expected path
    // — and it must NOT read as "reconnect", which would loop the person.
    const prisma = fakePrisma(null);
    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async () => {
        throw {
          errorCode: "invalid_grant",
          errorMessage: "AADSTS50199: device code flow is blocked by Conditional Access",
        };
      }),
    });

    await expect(beginDeviceCodeConnect(prisma as never, entra, USER)).rejects.toBeTruthy();
    await vi.waitFor(() => expect((prisma.__row() as any).state).toBe("ERROR"));
    expect((prisma.__row() as any).lastError).toContain("AADSTS50199");
  });
});

describe("disconnect", () => {
  it("purges the stored token rather than only flipping the state", async () => {
    // ADR-041: "Disconnecting must be equally real: it revokes and PURGES the
    // stored tokens, not merely flips a flag."
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      accountUpn: "sam@practice.com",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      homeAccountId: "uid.utid",
    });

    await disconnect(prisma as never, USER);

    const row = prisma.__row() as any;
    expect(row.state).toBe("DISCONNECTED");
    expect(row.tokenCacheEnc).toBeNull();
    expect(row.homeAccountId).toBeNull();
    expect(row.accountUpn).toBeNull();
  });

  it("is safe to call when nothing is connected", async () => {
    const prisma = fakePrisma(null);
    await expect(disconnect(prisma as never, USER)).resolves.not.toThrow();
  });
});

describe("getAccessToken", () => {
  it("refuses when no account is linked", async () => {
    const prisma = fakePrisma(null);
    await expect(getAccessToken(prisma as never, fakeEntra(), USER)).rejects.toBeInstanceOf(
      M365NotConnectedError,
    );
  });

  it("moves a revoked grant to NEEDS_RECONNECT and keeps the account label for the UI", async () => {
    // The routine case: an admin reset the password. The person should see
    // "reconnect Microsoft 365" against their own account name, not an error.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      accountUpn: "sam@practice.com",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
    });
    const entra = fakeEntra({
      acquireSilent: vi.fn(async () => {
        throw {
          errorCode: "invalid_grant",
          errorMessage: "AADSTS50173: The provided grant has expired due to it being revoked.",
        };
      }),
    });

    await expect(getAccessToken(prisma as never, entra, USER)).rejects.toBeTruthy();

    const row = prisma.__row() as any;
    expect(row.state).toBe("NEEDS_RECONNECT");
    expect(row.accountUpn).toBe("sam@practice.com");
    expect(row.lastError).not.toContain("0.AXoA-secret-rt");
  });

  it("moves a rejected app registration to ERROR, because reconnecting cannot fix it", async () => {
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
    });
    const entra = fakeEntra({
      acquireSilent: vi.fn(async () => {
        throw { errorCode: "unauthorized_client", errorMessage: "AADSTS700016: app not found" };
      }),
    });

    await expect(getAccessToken(prisma as never, entra, USER)).rejects.toBeTruthy();
    expect((prisma.__row() as any).state).toBe("ERROR");
  });

  it("treats an unreadable token cache as NEEDS_RECONNECT, not a crash", async () => {
    // Happens after a factory reset regenerates DEVICE_SECRET_KEY: the rows
    // survive, the key does not. The person simply signs in again.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache("someone-else", CACHE),
    });

    await expect(getAccessToken(prisma as never, fakeEntra(), USER)).rejects.toBeTruthy();
    expect((prisma.__row() as any).state).toBe("NEEDS_RECONNECT");
  });

  it("returns a token and records the refresh on the happy path", async () => {
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
    });

    const token = await getAccessToken(prisma as never, fakeEntra(), USER);
    expect(token).toBe("tok");
    expect((prisma.__row() as any).lastRefreshOkAt).toBeInstanceOf(Date);
  });
});
