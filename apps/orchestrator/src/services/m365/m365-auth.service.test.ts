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
  purgeM365ForUser,
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
      acquireByDeviceCode: vi.fn(async ({ onCode }) => {
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

    const started = await beginDeviceCodeConnect(prisma as never, entra, USER);

    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.verificationUri).toContain("microsoft.com");
    expect((prisma.__row() as any).state).toBe("PENDING_CONSENT");

    approve();
    await vi.waitFor(() => expect((prisma.__row() as any).state).toBe("CONNECTED"));
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

  // --- review #1658 finding 3 --------------------------------------------
  it("returns to DISCONNECTED when the person abandons the sign-in", async () => {
    // Drives the REAL abandoned path (the code lapses after the UI already has
    // it) rather than seeding an expired row. Previously this landed in ERROR,
    // which also defeated the read-time expiry downgrade: the background
    // .catch had already overwritten the state by the time it would apply.
    const prisma = fakePrisma(null);
    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async ({ onCode }) => {
        onCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000),
          message: "enter the code",
        });
        throw { errorCode: "expired_token", errorMessage: "the code expired" };
      }),
    });

    await beginDeviceCodeConnect(prisma as never, entra, USER);
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

  // --- review #1658 finding 4 --------------------------------------------
  it("cannot be undone by a device-code flow that resolves after it", async () => {
    // The race that reversed ADR-041's purge guarantee: connect → disconnect
    // (token purged) → the still-in-flight poll resolves → the row was
    // rewritten to CONNECTED with a fresh sealed token nobody asked for.
    const prisma = fakePrisma(null);
    let finish!: (r: EntraAuthResult) => void;

    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async ({ onCode }) => {
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

    await beginDeviceCodeConnect(prisma as never, entra, USER);
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
    });

    const token = await getAccessToken(prisma as never, fakeEntra(), USER);
    expect(token).toBe("tok");
    expect((prisma.__row() as any).lastRefreshOkAt).toBeInstanceOf(Date);
  });
});
