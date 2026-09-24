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
 *
 * WARP-2704 + WARP-2705 add the authorization-code sign-in (the primary path
 * now that new tenants block device code) and move the app registration onto
 * the connection itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { __setColumnCryptoKeyForTest } from "../column-crypto.service.js";
import { createHash } from "node:crypto";

import { sealPendingFlow, sealTokenCache, unsealPendingFlow } from "./token-cache.js";
import {
  beginAuthCodeConnect,
  beginDeviceCodeConnect,
  completeAuthCodeConnect,
  disconnect,
  getConnectionView,
  getAccessToken,
  purgeM365ForUser,
  M365AppRequiredError,
  M365NotConnectedError,
  type EntraClient,
  type EntraAuthResult,
} from "./m365-auth.service.js";

const TEST_KEY = Buffer.alloc(32, 5).toString("base64");
const USER = "user-1";
const CACHE = JSON.stringify({ RefreshToken: { x: { secret: "0.AXoA-secret-rt" } } });
const APP = {
  clientId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
  tenantId: "9a8b7c6d-5e4f-4321-8fed-cba987654321",
};
/** Row fields a connection made through APP carries. */
const APP_COLUMNS = { appClientId: APP.clientId, appTenantId: APP.tenantId };
const REDIRECT = "https://droplet-ai.local/api/m365/callback";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Minimal in-memory stand-in for prisma.m365Connection. */
function fakePrisma(seed: Record<string, unknown> | null = null) {
  let row: Record<string, unknown> | null = seed ? { ...seed } : null;
  return {
    __row: () => row,
    m365Connection: {
      // Honours `where` — the callback finds its row by `pendingStateHash`,
      // so a fake that ignored the key would pass a lookup that should miss.
      findUnique: vi.fn(async ({ where }: any) => {
        if (!row) return null;
        const matches = Object.entries(where ?? {}).every(([k, v]) => (row as any)[k] === v);
        return matches ? { ...row } : null;
      }),
      upsert: vi.fn(async ({ create, update }: any) => {
        row = row ? { ...row, ...update } : { id: "row-1", userId: USER, ...create };
        return { ...row };
      }),
      update: vi.fn(async ({ data }: any) => {
        row = { ...(row ?? { id: "row-1", userId: USER }), ...data };
        return { ...row };
      }),
      // Conditional write: only applies when the row matches every scalar in
      // `where`. This is what makes the disconnect-race guard real, so the
      // fake must honour it rather than always writing.
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!row) return { count: 0 };
        const matches = Object.entries(where).every(
          ([k, v]) => (row as any)[k] === v,
        );
        if (!matches) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        if (!row || (where.userId && (row as any).userId !== where.userId)) {
          return { count: 0 };
        }
        row = null;
        return { count: 1 };
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
    getAuthCodeUrl: vi.fn(async (_app, { state }) => `https://login.example/authorize?state=${state}`),
    acquireByAuthorizationCode: vi.fn(async () => authResult()),
    acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
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
    // Hold Microsoft's side of the flow open: PENDING_CONSENT is the state
    // BETWEEN the code being handed back and the person approving, so the
    // fake must not complete until the test says so. (Until Vitest 2 this
    // passed by accident — `vi.fn(async impl)` returned a `.then`-chained
    // promise, which delayed the fire-and-forget persistConnected by one
    // microtask; tinyspy 4 returns the implementation's own promise, so an
    // instantly-resolving fake now writes CONNECTED before the caller's
    // await resumes.)
    let approve!: () => void;
    const approved = new Promise<void>((resolve) => (approve = resolve));
    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
        onCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000),
          message: "enter the code",
        });
        await approved;
        return authResult();
      }),
    });

    const started = await beginDeviceCodeConnect(prisma as never, entra, USER, { app: APP });

    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.verificationUri).toContain("microsoft.com");
    expect((prisma.__row() as any).state).toBe("PENDING_CONSENT");

    approve();
    await vi.waitFor(() => expect((prisma.__row() as any).state).toBe("CONNECTED"));
  });

  it("stores the token sealed, not in the clear, once the person approves", async () => {
    const prisma = fakePrisma(null);
    await beginDeviceCodeConnect(prisma as never, fakeEntra(), USER, { app: APP });
    await vi.waitFor(() => expect((prisma.__row() as any).state).toBe("CONNECTED"));

    const row = prisma.__row() as any;
    expect(row.tokenCacheEnc).toBeTruthy();
    expect(row.tokenCacheEnc).not.toContain("0.AXoA-secret-rt");
    expect(row.accountUpn).toBe("sam@practice.com");
    expect(row.grantedScopes).toContain("Mail.ReadWrite");
  });

  // --- review #1658 finding 3 --------------------------------------------
  it("returns to DISCONNECTED when the person abandons the sign-in", async () => {
    // Drives the REAL abandoned path (the code lapses after the UI already has
    // it) rather than seeding an expired row. Previously this landed in ERROR,
    // which also defeated the read-time expiry downgrade: the background
    // .catch had already overwritten the state by the time it would apply.
    const prisma = fakePrisma(null);
    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
        onCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000),
          message: "enter the code",
        });
        throw { errorCode: "expired_token", errorMessage: "the code expired" };
      }),
    });

    await beginDeviceCodeConnect(prisma as never, entra, USER, { app: APP });
    await vi.waitFor(() => expect((prisma.__row() as any).state).toBe("DISCONNECTED"));

    const row = prisma.__row() as any;
    expect(row.lastError).toBeNull(); // nothing went wrong; say nothing
    expect(await getConnectionView(prisma as never, USER)).toMatchObject({
      state: "DISCONNECTED",
    });
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

    await expect(beginDeviceCodeConnect(prisma as never, entra, USER, { app: APP })).rejects.toBeTruthy();
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

  // --- review #1658 finding 4 --------------------------------------------
  it("cannot be undone by a device-code flow that resolves after it", async () => {
    // The race that reversed ADR-041's purge guarantee: connect → disconnect
    // (token purged) → the still-in-flight poll resolves → the row was
    // rewritten to CONNECTED with a fresh sealed token nobody asked for.
    const prisma = fakePrisma(null);
    let finish!: (r: EntraAuthResult) => void;

    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
        onCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000),
          message: "enter the code",
        });
        return await new Promise<EntraAuthResult>((resolve) => {
          finish = resolve;
        });
      }),
    });

    await beginDeviceCodeConnect(prisma as never, entra, USER, { app: APP });
    await disconnect(prisma as never, USER); // person changes their mind
    finish(authResult()); // Microsoft answers late
    await vi.waitFor(() => expect(prisma.m365Connection.updateMany).toHaveBeenCalled());

    const row = prisma.__row() as any;
    expect(row.state).toBe("DISCONNECTED");
    expect(row.tokenCacheEnc).toBeNull();
  });
});

// --- review #1658 finding 5 ----------------------------------------------
describe("purgeM365ForUser", () => {
  it("removes the row so a deleted user's refresh token cannot survive", async () => {
    // userId is not an FK, so nothing cascades; and the API scopes to the
    // requester's OWN connection, so an orphaned row could never be
    // disconnected by anyone — it would hold a live mailbox credential forever.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
    });

    expect(await purgeM365ForUser(prisma as never, USER)).toBe(1);
    expect(prisma.__row()).toBeNull();
  });

  it("is a no-op for a user who never connected", async () => {
    const prisma = fakePrisma(null);
    expect(await purgeM365ForUser(prisma as never, USER)).toBe(0);
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
      ...APP_COLUMNS,
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
      ...APP_COLUMNS,
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
      ...APP_COLUMNS,
    });

    await expect(getAccessToken(prisma as never, fakeEntra(), USER)).rejects.toBeTruthy();
    expect((prisma.__row() as any).state).toBe("NEEDS_RECONNECT");
  });

  // --- review #1658 finding 2 --------------------------------------------
  it("leaves a healthy connection CONNECTED when the network wobbles", async () => {
    // ERROR is terminal and the sync engine skips rows in it, so downgrading
    // on a transient failure would stop syncing permanently and silently.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      accountUpn: "sam@practice.com",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      ...APP_COLUMNS,
    });
    const entra = fakeEntra({
      acquireSilent: vi.fn(async () => {
        throw { errorCode: "network_error", errorMessage: "socket hang up" };
      }),
    });

    await expect(getAccessToken(prisma as never, entra, USER)).rejects.toBeTruthy();

    const row = prisma.__row() as any;
    expect(row.state).toBe("CONNECTED");
    expect(row.tokenCacheEnc).toBeTruthy(); // token not discarded either
  });

  it("returns a token and records the refresh on the happy path", async () => {
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      ...APP_COLUMNS,
    });

    const token = await getAccessToken(prisma as never, fakeEntra(), USER);
    expect(token).toBe("tok");
    expect((prisma.__row() as any).lastRefreshOkAt).toBeInstanceOf(Date);
  });
});

// --- WARP-2705: the connection's own app registration ----------------------

describe("the app registration a connection signs in through (WARP-2705)", () => {
  it("refuses to start a sign-in with no app, rather than falling back to a shared one", async () => {
    const prisma = fakePrisma(null);
    await expect(
      beginAuthCodeConnect(prisma as never, fakeEntra(), USER, { redirectUri: REDIRECT }),
    ).rejects.toBeInstanceOf(M365AppRequiredError);
    await expect(beginDeviceCodeConnect(prisma as never, fakeEntra(), USER)).rejects.toBeInstanceOf(
      M365AppRequiredError,
    );
    // Nothing was dirtied on the way to refusing.
    expect(prisma.__row()).toBeNull();
  });

  it("stores the app on the connection and reuses it for the next sign-in", async () => {
    const prisma = fakePrisma(null);
    const entra = fakeEntra();
    await beginAuthCodeConnect(prisma as never, entra, USER, { app: APP, redirectUri: REDIRECT });
    expect(prisma.__row()).toMatchObject(APP_COLUMNS);

    // Second attempt names no app: it must reuse the stored one.
    await beginAuthCodeConnect(prisma as never, entra, USER, { redirectUri: REDIRECT });
    expect(vi.mocked(entra.getAuthCodeUrl).mock.calls[1]![0]).toEqual(APP);
  });

  it("keeps the app registration across a disconnect, so reconnecting is one click", async () => {
    // It is configuration, not a credential: ADR-041's purge is about tokens.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      ...APP_COLUMNS,
    });
    await disconnect(prisma as never, USER);
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", tokenCacheEnc: null, ...APP_COLUMNS });
  });

  it("shows which app the connection uses, and never the token or the pending flow", async () => {
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      pendingFlowEnc: "dcv1:should-never-leave",
      pendingStateHash: "should-never-leave",
      ...APP_COLUMNS,
    });
    const view = await getConnectionView(prisma as never, USER);
    expect(view.app).toEqual(APP);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("should-never-leave");
    expect(serialized).not.toContain("0.AXoA-secret-rt");
  });

  it("refreshes through the connection's own app", async () => {
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      ...APP_COLUMNS,
    });
    const entra = fakeEntra();
    await getAccessToken(prisma as never, entra, USER);
    expect(vi.mocked(entra.acquireSilent).mock.calls[0]![0]).toEqual(APP);
  });

  it("asks a link with no app registration to reconnect instead of refreshing through nothing", async () => {
    // Only a link made before WARP-2705 can look like this. It cannot refresh
    // (its tokens belong to an app the box no longer names), so it is a
    // reconnect, stated plainly, not an ERROR and not a crash.
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
    });
    const entra = fakeEntra();
    await expect(getAccessToken(prisma as never, entra, USER)).rejects.toBeInstanceOf(
      M365NotConnectedError,
    );
    expect(entra.acquireSilent).not.toHaveBeenCalled();
    expect(prisma.__row()).toMatchObject({ state: "NEEDS_RECONNECT" });
    expect((prisma.__row() as any).lastError).toMatch(/connect again/i);
  });
});

// --- WARP-2704: authorization code + PKCE ---------------------------------

/** Start a sign-in and hand back what the browser would carry to the callback. */
async function started(prisma: ReturnType<typeof fakePrisma>, entra = fakeEntra()) {
  const begun = await beginAuthCodeConnect(prisma as never, entra, USER, {
    app: APP,
    redirectUri: REDIRECT,
  });
  return { ...begun, entra };
}

describe("beginAuthCodeConnect (WARP-2704)", () => {
  it("parks the row in PENDING_CONSENT and returns Microsoft's sign-in URL", async () => {
    const prisma = fakePrisma(null);
    const { authorizeUrl, state, expiresAt } = await started(prisma);

    expect(authorizeUrl).toContain("login.example/authorize");
    expect(state.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(prisma.__row()).toMatchObject({ state: "PENDING_CONSENT", lastError: null });
  });

  it("stores only a HASH of the state, and the verifier sealed", async () => {
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);
    const row = prisma.__row() as any;

    expect(row.pendingStateHash).toBe(sha256(state));
    expect(JSON.stringify(row)).not.toContain(state);

    // The challenge Microsoft received is the S256 of the verifier we kept.
    const flow = unsealPendingFlow(USER, row.pendingFlowEnc);
    const { codeChallenge, nonce, redirectUri } = vi.mocked(entra.getAuthCodeUrl).mock.calls[0]![1];
    expect(codeChallenge).toBe(createHash("sha256").update(flow.codeVerifier).digest("base64url"));
    expect(nonce).toBe(flow.nonce);
    expect(redirectUri).toBe(REDIRECT);
    expect(flow.redirectUri).toBe(REDIRECT);
    expect(JSON.stringify(row)).not.toContain(flow.codeVerifier);
  });

  it("mints fresh state, nonce and verifier every time", async () => {
    const prisma = fakePrisma(null);
    const a = await started(prisma);
    const firstFlow = unsealPendingFlow(USER, (prisma.__row() as any).pendingFlowEnc);
    const b = await started(prisma);
    const secondFlow = unsealPendingFlow(USER, (prisma.__row() as any).pendingFlowEnc);

    expect(a.state).not.toBe(b.state);
    expect(firstFlow.codeVerifier).not.toBe(secondFlow.codeVerifier);
    expect(firstFlow.nonce).not.toBe(secondFlow.nonce);
  });

  it("leaves the row untouched when Microsoft cannot be reached to build the URL", async () => {
    const prisma = fakePrisma(null);
    const entra = fakeEntra({
      getAuthCodeUrl: vi.fn(async () => {
        throw { errorCode: "endpoints_resolution_error", errorMessage: "offline" };
      }),
    });
    await expect(
      beginAuthCodeConnect(prisma as never, entra, USER, { app: APP, redirectUri: REDIRECT }),
    ).rejects.toBeTruthy();
    expect(prisma.__row()).toBeNull();
  });
});

describe("completeAuthCodeConnect (WARP-2704)", () => {
  it("connects when the callback carries the state this browser started with", async () => {
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);
    const flow = unsealPendingFlow(USER, (prisma.__row() as any).pendingFlowEnc);

    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "the-code",
    });

    expect(outcome).toBe("connected");
    // Redeemed through the stored app, with the stored verifier, nonce and
    // redirect: none of them taken from the browser.
    expect(entra.acquireByAuthorizationCode).toHaveBeenCalledWith(APP, {
      code: "the-code",
      redirectUri: REDIRECT,
      codeVerifier: flow.codeVerifier,
      nonce: flow.nonce,
    });
    const row = prisma.__row() as any;
    expect(row).toMatchObject({ state: "CONNECTED", accountUpn: "sam@practice.com", ...APP_COLUMNS });
    expect(row.tokenCacheEnc).toBeTruthy();
    expect(row.tokenCacheEnc).not.toContain("0.AXoA-secret-rt");
    expect(row.pendingStateHash).toBeNull();
    expect(row.pendingFlowEnc).toBeNull();
  });

  it("refuses a callback whose state this browser did not start (login CSRF)", async () => {
    // An attacker who lures the owner's browser to a callback carrying the
    // ATTACKER'S code and state would otherwise link the attacker's mailbox
    // to the owner's account. The cookie is what ties the callback to the
    // browser that pressed Connect.
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);

    for (const browserState of [null, "", "someone-elses-state"]) {
      expect(
        await completeAuthCodeConnect(prisma as never, entra, { state, browserState, code: "c" }),
      ).toBe("invalid");
    }
    expect(entra.acquireByAuthorizationCode).not.toHaveBeenCalled();
    // And the genuine sign-in is still completable afterwards.
    expect(prisma.__row()).toMatchObject({ state: "PENDING_CONSENT", pendingStateHash: sha256(state) });
  });

  it("refuses an unknown state without touching any row", async () => {
    const prisma = fakePrisma(null);
    const { entra } = await started(prisma);
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state: "forged",
      browserState: "forged",
      code: "c",
    });
    expect(outcome).toBe("invalid");
    expect(entra.acquireByAuthorizationCode).not.toHaveBeenCalled();
  });

  it("is single-use: a replayed callback redeems nothing", async () => {
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);
    await completeAuthCodeConnect(prisma as never, entra, { state, browserState: state, code: "c" });
    const replay = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });
    expect(replay).toBe("invalid");
    expect(entra.acquireByAuthorizationCode).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two racing callbacks claim the flow", async () => {
    // Simulates losing the conditional claim: the row matched at read time,
    // but its hash was gone by write time.
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);
    prisma.m365Connection.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });
    expect(outcome).toBe("invalid");
    expect(entra.acquireByAuthorizationCode).not.toHaveBeenCalled();
  });

  it("expires a sign-in left open past its window", async () => {
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);
    (prisma.__row() as any).pendingFlowExpiresAt = new Date(Date.now() - 1000);

    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });
    expect(outcome).toBe("expired");
    expect(entra.acquireByAuthorizationCode).not.toHaveBeenCalled();
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", pendingFlowEnc: null });
  });

  it("treats Cancel on Microsoft's page as the person changing their mind, not a failure", async () => {
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      error: "access_denied",
      errorDescription: "AADSTS65004: User declined to consent to access the app.",
    });
    expect(outcome).toBe("cancelled");
    expect(entra.acquireByAuthorizationCode).not.toHaveBeenCalled();
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", lastError: null });
  });

  it("records a mis-registered app as ERROR with Entra's reason, so the owner can fix it", async () => {
    // The expected first-run failure: the redirect URI was added to the app
    // registration under the wrong platform.
    const prisma = fakePrisma(null);
    const { state } = await started(prisma);
    const entra = fakeEntra({
      acquireByAuthorizationCode: vi.fn(async () => {
        throw {
          errorCode: "invalid_client",
          errorMessage: "AADSTS7000218: The request body must contain client_assertion or client_secret.",
        };
      }),
    });
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });
    expect(outcome).toBe("failed");
    expect(prisma.__row()).toMatchObject({ state: "ERROR" });
    expect((prisma.__row() as any).lastError).toContain("AADSTS7000218");
  });

  it("returns a sign-in that hit a network wobble to DISCONNECTED, so the person can retry", async () => {
    // Not left PENDING_CONSENT: the flow was already claimed, so nothing could
    // ever complete it and the row would read "signing in" for 15 minutes.
    const prisma = fakePrisma(null);
    const { state } = await started(prisma);
    const entra = fakeEntra({
      acquireByAuthorizationCode: vi.fn(async () => {
        throw { errorCode: "network_error", errorMessage: "socket hang up" };
      }),
    });
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });
    expect(outcome).toBe("failed");
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED" });
    expect((prisma.__row() as any).lastError).toContain("network_error");
  });

  it("cannot be undone into CONNECTED by a callback that lands after a disconnect", async () => {
    // The auth-code twin of the device-code race above: the person presses
    // Disconnect while Microsoft is still redeeming the code.
    const prisma = fakePrisma(null);
    const { state } = await started(prisma);
    const entra = fakeEntra({
      acquireByAuthorizationCode: vi.fn(async () => {
        await disconnect(prisma as never, USER);
        return authResult();
      }),
    });
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });
    expect(outcome).toBe("cancelled");
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", tokenCacheEnc: null });
  });

  it("fails closed when the sealed flow cannot be opened (e.g. after a key rotation)", async () => {
    const prisma = fakePrisma(null);
    const { state, entra } = await started(prisma);
    (prisma.__row() as any).pendingFlowEnc = sealPendingFlow("someone-else", {
      codeVerifier: "v",
      nonce: "n",
      redirectUri: REDIRECT,
    });
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });
    expect(outcome).toBe("failed");
    expect(entra.acquireByAuthorizationCode).not.toHaveBeenCalled();
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED" });
  });
});
