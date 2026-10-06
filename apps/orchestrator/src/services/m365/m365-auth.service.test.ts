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

import { makeFakeCloudFileDb } from "../../__tests__/helpers/fake-cloud-files.js";
import { sealPendingFlow, sealTokenCache, unsealPendingFlow } from "./token-cache.js";
import { M365_BASE_SCOPES } from "./scopes.js";
import {
  beginAuthCodeConnect,
  beginDeviceCodeConnect,
  completeAuthCodeConnect,
  disconnect,
  getConnectionView,
  getAccessToken,
  markNeedsReconnect,
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
  const person = { username: "sam", directoryStatus: "ACTIVE", deletionStatus: "NONE" };
  const matches = (where: any) => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "user") return Object.entries(value.is).every(([field, expected]) => person[field as keyof typeof person] === expected);
    return row?.[key] === value;
  });
  // WARP-3059 — the person's delta cursors, so a purge shows as rows gone
  // rather than only as a call made.
  let cursors: Array<{ id: string; userId: string; resourceId: string }> = [];
  // WARP-3538 — and the files LANDED from them: disconnect, a leaver's deletion
  // and a reconnect as somebody else must remove those too, and the evaluating
  // tables make "gone" a thing the tests can see.
  const cloud = makeFakeCloudFileDb();
  const db = {
    __row: () => row,
    __person: () => person,
    user: { findFirst: vi.fn(async ({ where }: any) => Object.entries(where).every(([field, value]) => field === "id" || person[field as keyof typeof person] === value) ? { ...person } : null) },
    cloudOAuthApp: { findUnique: vi.fn(async () => null) },
    __cloud: cloud,
    cloudFileItem: cloud.cloudFileItem,
    cloudFileSource: cloud.cloudFileSource,
    calendarSource: { findFirst: vi.fn(async () => null) },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(db),
    __cursors: () => cursors,
    __addCursors: (...resourceIds: string[]) => {
      for (const resourceId of resourceIds) {
        cursors.push({ id: `c${cursors.length + 1}`, userId: USER, resourceId });
      }
    },
    m365Connection: {
      // Honours `where` — the callback finds its row by `pendingStateHash`,
      // so a fake that ignored the key would pass a lookup that should miss.
      findUnique: vi.fn(async ({ where }: any) => {
        if (!row) return null;
        return matches(where) ? { ...row } : null;
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
        if (!matches(where)) return { count: 0 };
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
    // WARP-3059 — disconnect and user deletion purge the person's cursors.
    m365DeltaCursor: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = cursors.length;
        cursors = cursors.filter((c) => c.userId !== where.userId);
        return { count: before - cursors.length };
      }),
    },
  };
  return db;
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

  describe("sharePoint (WARP-3538)", () => {
    const BASE = "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All";
    const viewOf = async (over: Record<string, unknown>) =>
      (
        await getConnectionView(
          fakePrisma({ id: "row-1", userId: USER, state: "CONNECTED", grantedScopes: BASE, ...over }) as never,
          USER,
        )
      ).sharePoint;

    it("says nothing is on, granted or needed for a person who never connected", async () => {
      const view = await getConnectionView(fakePrisma(null) as never, USER);
      expect(view.sharePoint).toEqual({ enabled: false, granted: false, needsConsent: false });
    });

    it("is off, not granted and needs nothing for an existing connection that never asked for it", async () => {
      expect(await viewOf({})).toEqual({ enabled: false, granted: false, needsConsent: false });
    });

    it("needs consent when the person switched it on and the grant lacks Sites.Read.All", async () => {
      // 🔴 This is what an EXISTING connection looks like the moment its owner
      // flips the switch: the base grant reads drives but cannot find one.
      expect(await viewOf({ sharePointEnabled: true })).toEqual({ enabled: true, granted: false, needsConsent: true });
    });

    it("needs nothing once the grant holds Sites.Read.All", async () => {
      expect(await viewOf({ sharePointEnabled: true, grantedScopes: `${BASE} Sites.Read.All` })).toEqual({
        enabled: true,
        granted: true,
        needsConsent: false,
      });
    });

    it("judges the grant exactly as discovery does — a broader Sites grant and a resource-qualified one count, Sites.Selected does not", async () => {
      // The view and the engine must agree about whether a person has to act:
      // a card that says "needs consent" while discovery reads their libraries
      // (or the reverse) is worse than either alone.
      const granted = (grantedScopes: string) => viewOf({ sharePointEnabled: true, grantedScopes }).then((v) => v.granted);
      expect(await granted("Sites.ReadWrite.All")).toBe(true);
      expect(await granted("https://graph.microsoft.com/Sites.Read.All")).toBe(true);
      expect(await granted("sites.read.all")).toBe(true);
      expect(await granted("Sites.Selected")).toBe(false);
      expect(await granted("Files.ReadWrite.All")).toBe(false);
    });

    it("reports a held grant even while the switch is off — `granted` is about Microsoft, `enabled` is about the person", async () => {
      expect(await viewOf({ sharePointEnabled: false, grantedScopes: `${BASE} Sites.Read.All` })).toEqual({
        enabled: false,
        granted: true,
        needsConsent: false,
      });
    });

    it("reads an absent or non-boolean switch as OFF — explicit state, never inferred", async () => {
      for (const sharePointEnabled of [undefined, null, "true", 1, "yes"]) {
        expect((await viewOf({ sharePointEnabled })).enabled, String(sharePointEnabled)).toBe(false);
      }
    });

    it("reads a legacy row with no recorded grant as not granted", async () => {
      expect(await viewOf({ sharePointEnabled: true, grantedScopes: null })).toEqual({
        enabled: true,
        granted: false,
        needsConsent: true,
      });
    });
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
    // WARP-3059 — and the person's sync positions, scoped to them alone.
    expect(prisma.m365DeltaCursor.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it("is safe to call when nothing is connected", async () => {
    const prisma = fakePrisma(null);
    await expect(disconnect(prisma as never, USER)).resolves.not.toThrow();
  });

  describe("and the files that were landed (WARP-3538)", () => {
    const OTHER = "user-2";
    function landed(prisma: ReturnType<typeof fakePrisma>) {
      const c = prisma.__cloud;
      for (const user of [USER, OTHER]) {
        c.seedSource({ userId: user, provider: "M365", kind: "ONEDRIVE", sourceId: `od-${user}`, nameEnc: "dcv1:x" });
        c.seedSource({ userId: user, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId: `lib-${user}`, nameEnc: "dcv1:x" });
        c.seedItem({ userId: user, provider: "M365", sourceId: `od-${user}`, externalId: "f1", isFolder: false, nameEnc: "dcv1:x" });
        c.seedItem({ userId: user, provider: "M365", sourceId: `lib-${user}`, externalId: "f2", isFolder: false, nameEnc: "dcv1:x" });
      }
      // The same person's files in ANOTHER cloud: Google Drive and Dropbox land into the same tables.
      c.seedItem({ userId: USER, provider: "GOOGLE", sourceId: "g1", externalId: "g-f", isFolder: false, nameEnc: "dcv1:x" });
    }
    const connected = () => ({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      homeAccountId: "uid.utid",
      sharePointEnabled: true,
      sharePointLibrariesCapped: 7,
      ...APP_COLUMNS,
    });
    const mineLeft = (prisma: ReturnType<typeof fakePrisma>) =>
      prisma.__cloud.items.filter((r) => r.userId === USER).map((r) => `${r.provider}:${r.externalId}`).sort();

    it("deletes every landed item and source the person has from Microsoft 365 — ADR-041: deletion is a real operation", async () => {
      // A file name in a practice carries a patient's. A disconnect that left the
      // list behind would keep copies of those names for a person who asked
      // Droplet to let go.
      const prisma = fakePrisma(connected());
      landed(prisma);

      await disconnect(prisma as never, USER);

      expect(prisma.__cloud.sources.filter((r) => r.userId === USER && r.provider === "M365")).toEqual([]);
      expect(mineLeft(prisma)).toEqual(["GOOGLE:g-f"]);
    });

    it("never touches another person's files", async () => {
      // Mutation: drop `userId` from the purge and one person's disconnect
      // empties the whole box's file lists.
      const prisma = fakePrisma(connected());
      landed(prisma);
      await disconnect(prisma as never, USER);
      expect(prisma.__cloud.items.filter((r) => r.userId === OTHER)).toHaveLength(2);
      expect(prisma.__cloud.sources.filter((r) => r.userId === OTHER)).toHaveLength(2);
    });

    it("removes the cursors BEFORE the files, so a failure between them leaves residue and never a reader", async () => {
      // If the file purge throws, what is left is rows nothing refreshes — not a
      // cursor still reading Microsoft for a person who has disconnected.
      const prisma = fakePrisma(connected());
      landed(prisma);
      prisma.__addCursors("inbox");
      prisma.__cloud.cloudFileItem.deleteMany.mockRejectedValueOnce(new Error("disk full"));

      await expect(disconnect(prisma as never, USER)).rejects.toThrow("disk full");
      expect(prisma.__cursors()).toEqual([]);
    });

    it("resets the SharePoint opt-in and the cap count — a disconnect is a clean slate", async () => {
      // A person who reconnects next month must be asked for the base set only
      // until they say otherwise: a scope they did not ask for can fail the whole
      // sign-in. The app registration stays (reconnecting is one click).
      const prisma = fakePrisma(connected());
      await disconnect(prisma as never, USER);
      expect(prisma.__row()).toMatchObject({ sharePointEnabled: false, sharePointLibrariesCapped: 0, ...APP_COLUMNS });
    });

    it("does NOT reset the opt-in when a sign-in is merely cancelled", async () => {
      // A cancelled sign-in also lands in DISCONNECTED (it shares the UNLINKED
      // state), but nothing was disconnected: the person's choice stands.
      const prisma = fakePrisma({ ...connected(), state: "CONNECTED" });
      const { state, entra } = await started(prisma);
      await completeAuthCodeConnect(prisma as never, entra, { state, browserState: state, error: "access_denied" });
      expect(prisma.__row()).toMatchObject({ sharePointEnabled: true });
    });
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
    // WARP-3059 — the deleted person's cursors go too.
    expect(prisma.m365DeltaCursor.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it("removes the file names landed from the deleted person's Microsoft 365 (WARP-3538)", async () => {
    // A leaver's OneDrive and SharePoint file list must not outlive them in a
    // table nobody can reach through the API.
    const prisma = fakePrisma({ id: "row-1", userId: USER, state: "CONNECTED", tokenCacheEnc: sealTokenCache(USER, CACHE) });
    const c = prisma.__cloud;
    c.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "od", nameEnc: "dcv1:x" });
    c.seedItem({ userId: USER, provider: "M365", sourceId: "od", externalId: "f1", isFolder: false, nameEnc: "dcv1:x" });
    c.seedItem({ userId: "user-2", provider: "M365", sourceId: "od2", externalId: "f9", isFolder: false, nameEnc: "dcv1:x" });

    await purgeM365ForUser(prisma as never, USER);

    expect(c.items.map((r) => r.externalId)).toEqual(["f9"]);
    expect(c.sources).toEqual([]);
  });

  it("is a no-op for a user who never connected", async () => {
    const prisma = fakePrisma(null);
    expect(await purgeM365ForUser(prisma as never, USER)).toBe(0);
  });
});

describe("getAccessToken", () => {
  it("passes the acquired mail ownership and selection in the grant generation", async () => {
    const prisma = await connectedAsAWithCursors();
    Object.assign(prisma.__row()!, { mailEnabled: true, emailAccountId: "mailbox", mailSyncState: "CONNECTED" });
    const onGrant = vi.fn();
    await getAccessToken(prisma as never, fakeEntra(), USER, new Date(), onGrant);
    expect(onGrant).toHaveBeenCalledWith(expect.objectContaining({ mailEnabled: true, emailAccountId: "mailbox", tokenCacheEnc: prisma.__row()!.tokenCacheEnc }));
  });

  it("an old Graph refusal cannot downgrade a newly consented grant", async () => {
    const prisma = await connectedAsAWithCursors();
    let generation: any;
    await getAccessToken(prisma as never, fakeEntra(), USER, new Date(), (current) => { generation = current; });
    await connectAs(prisma, A);
    const newer = structuredClone(prisma.__row());
    await markNeedsReconnect(prisma as never, USER, "Old Graph request failed", generation);
    expect(prisma.__row()).toEqual(newer);
  });

  it.each(["disconnect", "same-account-reconnect", "different-account-reconnect", "calendar-off", "mail-off"])("a late successful refresh cannot overwrite %s or return its bearer", async (action) => {
    const prisma = await connectedAsAWithCursors();
    if (action === "calendar-off") Object.assign(prisma.__row()!, { calendarEnabled: true, calendarSourceId: "s1", calendarSyncState: "CONNECTED" });
    let release!: (result: EntraAuthResult) => void;
    const entra = fakeEntra({ acquireSilent: vi.fn(() => new Promise<EntraAuthResult>((resolve) => { release = resolve; })) });
    const pending = getAccessToken(prisma as never, entra, USER).catch((error: unknown) => error);
    await vi.waitFor(() => expect(entra.acquireSilent).toHaveBeenCalledTimes(1));
    if (action === "calendar-off") Object.assign(prisma.__row()!, { calendarEnabled: false, calendarSourceId: null, calendarSyncState: "DISCONNECTED" });
    else {
      await disconnect(prisma as never, USER);
      if (action !== "disconnect") await connectAs(prisma, action === "same-account-reconnect" ? A : B);
    }
    const current = structuredClone(prisma.__row());
    release(authResult({ accessToken: "STALE_SECRET_BEARER" }));
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("STALE_SECRET_BEARER");
    expect(prisma.__row()).toEqual(current);
  });

  it.each(["same-account-reconnect", "calendar-off", "mail-off"])("a failed old refresh cannot downgrade %s", async (action) => {
    const prisma = await connectedAsAWithCursors();
    if (action === "calendar-off") Object.assign(prisma.__row()!, { calendarEnabled: true, calendarSourceId: "s1", calendarSyncState: "CONNECTED" });
    let reject!: (error: unknown) => void;
    const entra = fakeEntra({ acquireSilent: vi.fn(() => new Promise<EntraAuthResult>((_resolve, fail) => { reject = fail; })) });
    const pending = getAccessToken(prisma as never, entra, USER).catch((error: unknown) => error);
    await vi.waitFor(() => expect(entra.acquireSilent).toHaveBeenCalledTimes(1));
    if (action === "calendar-off") Object.assign(prisma.__row()!, { calendarEnabled: false, calendarSourceId: null, calendarSyncState: "DISCONNECTED" });
    else { await disconnect(prisma as never, USER); await connectAs(prisma, A); }
    const current = structuredClone(prisma.__row());
    reject({ errorCode: "invalid_grant", errorMessage: "expired" });
    await pending;
    expect(prisma.__row()).toEqual(current);
  });

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

  it("an unreadable cache makes the reconnect RE-LAND everything: the file names are sealed under the key that is gone (WARP-3538)", async () => {
    // The key that sealed the landed file names is the one that just failed to
    // open the token. The rows survive and can never be read again, and the
    // cursors would carry on landing only what changes from here — an empty
    // search for everything that already existed. Forgetting the link hash makes
    // the same person's reconnect count as "a different account", which purges
    // the cursors and the unreadable files and starts from nothing. This is what
    // makes "a factory reset crypto-shreds the landed metadata" safe: the data
    // re-syncs. (Mutation: drop `cursorLinkHash: null` from the unreadable-cache
    // branch and the files survive the reconnect.)
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "CONNECTED",
      homeAccountId: "uid.utid",
      tokenCacheEnc: sealTokenCache("someone-else", CACHE), // sealed under a key we no longer have
      cursorLinkHash: "hash-of-the-link-the-cursors-were-built-under",
      ...APP_COLUMNS,
    });
    prisma.__addCursors("inbox");
    prisma.__cloud.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "od", nameEnc: "dcv1:sealed-under-the-old-key" });
    prisma.__cloud.seedItem({ userId: USER, provider: "M365", sourceId: "od", externalId: "f1", isFolder: false, nameEnc: "dcv1:sealed-under-the-old-key" });

    await expect(getAccessToken(prisma as never, fakeEntra(), USER)).rejects.toBeTruthy();
    expect(prisma.__row()).toMatchObject({ state: "NEEDS_RECONNECT", cursorLinkHash: null });

    // The person signs in again — as the SAME account.
    const entra = fakeEntra({ acquireByAuthorizationCode: vi.fn(async () => authResult()) });
    const begun = await beginAuthCodeConnect(prisma as never, entra, USER, { app: APP, redirectUri: REDIRECT });
    await completeAuthCodeConnect(prisma as never, entra, { state: begun.state, browserState: begun.state, code: "c" });

    expect((prisma.__row() as any).state).toBe("CONNECTED");
    expect(prisma.__cursors()).toEqual([]);
    expect(prisma.__cloud.items).toEqual([]);
    expect(prisma.__cloud.sources).toEqual([]);
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
  it.each(["success", "failure"])("an old device-code %s cannot settle a newer browser flow", async (outcome) => {
    const prisma = fakePrisma(null);
    let release!: (result: EntraAuthResult) => void;
    let reject!: (error: unknown) => void;
    const old = fakeEntra({ acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
      onCode({ userCode: "OLD", verificationUri: "https://microsoft.com/devicelogin", expiresAt: new Date(Date.now() + 60_000), message: "old" });
      return new Promise<EntraAuthResult>((resolve, fail) => { release = resolve; reject = fail; });
    }) });
    await beginDeviceCodeConnect(prisma as never, old, USER, { app: APP });
    const oldFlow = prisma.__row()!.pendingFlowEnc;
    await disconnect(prisma as never, USER);
    const next = await started(prisma);
    const current = structuredClone(prisma.__row());
    if (outcome === "success") release(authResult());
    else reject({ errorCode: "invalid_grant", errorMessage: "expired old poll" });
    await vi.waitFor(() => expect(prisma.m365Connection.updateMany.mock.calls.some(([args]) => args.where.pendingFlowEnc === oldFlow)).toBe(true));
    expect(prisma.__row()).toEqual(current);
    expect(await completeAuthCodeConnect(prisma as never, next.entra, { state: next.state, browserState: next.state, code: "new" })).toBe("connected");
  });

  it.each(["success", "failure"])("an old exchange %s cannot overwrite or cancel a newer pending flow", async (outcome) => {
    const prisma = fakePrisma(null);
    let release!: (result: EntraAuthResult) => void;
    let reject!: (error: unknown) => void;
    const old = await started(prisma, fakeEntra({ acquireByAuthorizationCode: vi.fn(() => new Promise<EntraAuthResult>((resolve, fail) => { release = resolve; reject = fail; })) }));
    const completion = completeAuthCodeConnect(prisma as never, old.entra, { state: old.state, browserState: old.state, code: "old" });
    await vi.waitFor(() => expect(old.entra.acquireByAuthorizationCode).toHaveBeenCalledTimes(1));
    await disconnect(prisma as never, USER);
    const next = await started(prisma);
    const current = structuredClone(prisma.__row());
    if (outcome === "success") release(authResult());
    else reject({ errorCode: "invalid_grant", errorMessage: "expired old exchange" });
    await completion;
    expect(prisma.__row()).toEqual(current);
    expect(await completeAuthCodeConnect(prisma as never, next.entra, { state: next.state, browserState: next.state, code: "new" })).toBe("connected");
  });

  it("a callback cannot retain a grant for a deactivated person", async () => {
    const prisma = fakePrisma(null);
    const begun = await started(prisma);
    prisma.__person().directoryStatus = "DEACTIVATED";
    expect(await completeAuthCodeConnect(prisma as never, begun.entra, { state: begun.state, browserState: begun.state, code: "c" })).toBe("cancelled");
    expect(prisma.__row()!.tokenCacheEnc).toBeNull();
  });

  it("calendar OFF during the exchange remains OFF after the same-account callback", async () => {
    const prisma = await connectedAsAWithCursors();
    Object.assign(prisma.__row()!, { calendarEnabled: true, calendarSourceId: "calendar-a", calendarSyncState: "CONNECTED" });
    const begun = await started(prisma, fakeEntra({ acquireByAuthorizationCode: vi.fn(async () => {
      Object.assign(prisma.__row()!, { calendarEnabled: false, calendarSourceId: null, calendarSyncState: "DISCONNECTED" });
      return authResult(A);
    }) }));
    expect(await completeAuthCodeConnect(prisma as never, begun.entra, { state: begun.state, browserState: begun.state, code: "c" })).toBe("connected");
    expect(prisma.__row()).toMatchObject({ calendarEnabled: false, calendarSourceId: null, calendarSyncState: "DISCONNECTED" });
  });

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
      scopes: [...M365_BASE_SCOPES],
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
      scopes: [...M365_BASE_SCOPES],
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

// --- #2344 review: no credential outlives the link it belonged to ----------
//
// DISCONNECTED means "no Microsoft account linked" (schema docstring), and
// `disconnect()` purges accordingly. A CONNECTED person who presses Connect
// again (a new app, say) and then cancels, lets it lapse, or hits a network
// error also ends DISCONNECTED, and until this review the old account's
// sealed refresh token stayed on that row.

/** A live link through APP, holding a sealed refresh token. */
function connectedRow() {
  return {
    id: "row-1",
    userId: USER,
    state: "CONNECTED",
    accountUpn: "old@practice.com",
    homeAccountId: "old.uid.utid",
    tenantId: "tenant-old",
    grantedScopes: "Mail.ReadWrite",
    connectedAt: new Date("2026-09-01T00:00:00Z"),
    lastRefreshOkAt: new Date("2026-09-20T00:00:00Z"),
    tokenCacheEnc: sealTokenCache(USER, CACHE),
    ...APP_COLUMNS,
  };
}

/** What a row that names no Microsoft account must not hold. */
const NO_ACCOUNT = {
  tokenCacheEnc: null,
  homeAccountId: null,
  accountUpn: null,
  tenantId: null,
  grantedScopes: null,
  connectedAt: null,
};

describe("a reconnect leaves no credential of the old link behind (#2344 review)", () => {
  it("drops the old link's credential the moment a new browser sign-in starts", async () => {
    const prisma = fakePrisma(connectedRow());
    const { state } = await started(prisma);

    expect(prisma.__row()).toMatchObject({ state: "PENDING_CONSENT", ...NO_ACCOUNT, ...APP_COLUMNS });

    // So nothing can refresh the old grant while the person is at Microsoft's
    // page: a sync tick that asks for a token is refused without calling
    // Microsoft, and the sign-in in flight is left for its callback.
    const entra = fakeEntra();
    await expect(getAccessToken(prisma as never, entra, USER)).rejects.toBeInstanceOf(
      M365NotConnectedError,
    );
    expect(entra.acquireSilent).not.toHaveBeenCalled();
    expect(prisma.__row()).toMatchObject({ state: "PENDING_CONSENT", pendingStateHash: sha256(state) });
  });

  it("drops the old link's credential when a device-code sign-in starts", async () => {
    const prisma = fakePrisma(connectedRow());
    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
        onCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000),
          message: "enter the code",
        });
        return await new Promise<EntraAuthResult>(() => {});
      }),
    });

    await beginDeviceCodeConnect(prisma as never, entra, USER);
    expect(prisma.__row()).toMatchObject({ state: "PENDING_CONSENT", ...NO_ACCOUNT, ...APP_COLUMNS });
  });

  it("ends a cancelled reconnect DISCONNECTED with nothing of the old account on the row", async () => {
    const prisma = fakePrisma(connectedRow());
    const { state, entra } = await started(prisma);
    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      error: "access_denied",
    });

    expect(outcome).toBe("cancelled");
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", ...NO_ACCOUNT, ...APP_COLUMNS });
    expect(await getConnectionView(prisma as never, USER)).toMatchObject({
      state: "DISCONNECTED",
      accountUpn: null,
      app: APP,
    });
  });

  it("ends an expired reconnect DISCONNECTED with nothing of the old account on the row", async () => {
    const prisma = fakePrisma(connectedRow());
    const { state, entra } = await started(prisma);
    (prisma.__row() as any).pendingFlowExpiresAt = new Date(Date.now() - 1000);

    const outcome = await completeAuthCodeConnect(prisma as never, entra, {
      state,
      browserState: state,
      code: "c",
    });

    expect(outcome).toBe("expired");
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", ...NO_ACCOUNT, ...APP_COLUMNS });
  });

  it("ends a reconnect that hit a network wobble DISCONNECTED with nothing of the old account on the row", async () => {
    const prisma = fakePrisma(connectedRow());
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
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", ...NO_ACCOUNT, ...APP_COLUMNS });
  });

  it("clears a sign-in parked by an earlier build, still holding its old token, when it ends DISCONNECTED", async () => {
    // Rows that went PENDING_CONSENT before this change kept the old link's
    // token. Every way back to DISCONNECTED clears it, not only disconnect().
    const state = "parked-state";
    const prisma = fakePrisma({
      ...connectedRow(),
      state: "PENDING_CONSENT",
      pendingStateHash: sha256(state),
      pendingFlowEnc: sealPendingFlow(USER, { codeVerifier: "v", nonce: "n", redirectUri: REDIRECT, scopes: [...M365_BASE_SCOPES] }),
      pendingFlowExpiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await completeAuthCodeConnect(prisma as never, fakeEntra(), {
      state,
      browserState: state,
      error: "access_denied",
    });

    expect(outcome).toBe("cancelled");
    expect(prisma.__row()).toMatchObject({ state: "DISCONNECTED", ...NO_ACCOUNT, ...APP_COLUMNS });
  });

  it("does not let a device-code sign-in that lapses later undo a link made in the browser meanwhile", async () => {
    // The device-code poll outlives the person's interest in it: they start
    // it, switch to the browser sign-in and finish there. When the forgotten
    // code lapses, "put the connection back where it started" must apply only
    // to the sign-in in flight. It must not disconnect, or purge, the new link.
    const prisma = fakePrisma(null);
    let lapse!: (err: unknown) => void;
    const deviceEntra = fakeEntra({
      acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
        onCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000),
          message: "enter the code",
        });
        return await new Promise<EntraAuthResult>((_resolve, reject) => {
          lapse = reject;
        });
      }),
    });
    await beginDeviceCodeConnect(prisma as never, deviceEntra, USER, { app: APP });

    const { state, entra } = await started(prisma);
    expect(
      await completeAuthCodeConnect(prisma as never, entra, { state, browserState: state, code: "c" }),
    ).toBe("connected");

    lapse({ errorCode: "expired_token", errorMessage: "the code expired" });
    await vi.waitFor(() =>
      expect(prisma.m365Connection.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: "DISCONNECTED" }) }),
      ),
    );

    const row = prisma.__row() as any;
    expect(row).toMatchObject({ state: "CONNECTED", accountUpn: "sam@practice.com" });
    expect(row.tokenCacheEnc).toBeTruthy();
  });
});

// --- #2347 review, blocking 2 ------------------------------------------------
// Reconnecting is the ordinary recovery path (NEEDS_RECONNECT → Reconnect) and
// it never passes through disconnect(). A person who signs in as ANOTHER
// mailbox, or through another app, must not inherit the old link's cursors:
// their delta links would be replayed against the new mailbox, and folder ids
// that do not exist there 404, classify FATAL and park FAILED for good.

const A = { homeAccountId: "a-oid.home-tid", tenantId: "tenant-a", accountUpn: "a@practice.com" };
const B = { homeAccountId: "b-oid.home-tid", tenantId: "tenant-a", accountUpn: "b@practice.com" };
const OTHER_APP = { clientId: "7c6b5a49-3827-4165-9403-f2e1d0c9b8a7", tenantId: APP.tenantId };

/** Sign in through the browser flow, end to end, and land as `who`. */
async function connectAs(
  prisma: ReturnType<typeof fakePrisma>,
  who: Partial<EntraAuthResult>,
  app = APP,
): Promise<string> {
  const entra = fakeEntra({ acquireByAuthorizationCode: vi.fn(async () => authResult(who)) });
  const { state } = await beginAuthCodeConnect(prisma as never, entra, USER, { app, redirectUri: REDIRECT });
  return await completeAuthCodeConnect(prisma as never, entra, { state, browserState: state, code: "c" });
}

/** Connected as A through APP, with two cursors synced under that link. */
async function connectedAsAWithCursors() {
  const prisma = fakePrisma(null);
  expect(await connectAs(prisma, A)).toBe("connected");
  prisma.__addCursors("inbox-of-a", "archive-of-a");
  return prisma;
}

/** The grant died; the person is asked to reconnect. */
function grantDied(prisma: ReturnType<typeof fakePrisma>) {
  (prisma.__row() as any).state = "NEEDS_RECONNECT";
}

describe("a reconnect as someone else starts their sync from nothing (#2347 review)", () => {
  it("requires explicit disconnect before switching an identity with copied calendar events", async () => {
    const prisma = await connectedAsAWithCursors();
    Object.assign(prisma.__row()!, { calendarEnabled: true, calendarSourceId: "a-calendar", calendarSyncState: "CONNECTED" });
    prisma.m365DeltaCursor.deleteMany.mockClear();
    grantDied(prisma);

    expect(await connectAs(prisma, B)).toBe("different_account");

    expect(prisma.__row()).toMatchObject({ state: "ERROR", calendarEnabled: true,
      calendarSourceId: "a-calendar", calendarSyncState: "NEEDS_RECONNECT", tokenCacheEnc: null,
      lastError: "Your copied Outlook emails and calendar were kept. Disconnect Outlook before linking a different Microsoft account." });
    expect(prisma.__cursors().map((cursor) => cursor.resourceId)).toEqual(["inbox-of-a", "archive-of-a"]);
    expect(prisma.m365DeltaCursor.deleteMany).not.toHaveBeenCalled();
    expect(prisma.__row()!.pendingStateHash).toBeNull();
    expect(JSON.stringify(prisma.__row()!.lastError)).not.toContain(B.accountUpn);
  });

  it("preserves calendar opt-in and its source when the same identity reconnects", async () => {
    const prisma = await connectedAsAWithCursors();
    Object.assign(prisma.__row()!, { calendarEnabled: true, calendarSourceId: "a-calendar", calendarSyncState: "CONNECTED" });
    grantDied(prisma);

    expect(await connectAs(prisma, A)).toBe("connected");
    expect(prisma.__row()).toMatchObject({ state: "CONNECTED", calendarEnabled: true,
      calendarSourceId: "a-calendar", calendarSyncState: "WAITING" });
    expect(prisma.__cursors().map((cursor) => cursor.resourceId)).toEqual(["inbox-of-a", "archive-of-a"]);
  });

  it("purges the cursors when the sign-in that completes is a different mailbox", async () => {
    const prisma = await connectedAsAWithCursors();
    grantDied(prisma);

    expect(await connectAs(prisma, B)).toBe("connected");

    expect(prisma.__cursors()).toEqual([]);
    expect(prisma.__row()).toMatchObject({ state: "CONNECTED", accountUpn: B.accountUpn });
  });

  it("purges them BEFORE the row turns CONNECTED, so no tick can claim them in between", async () => {
    // CONNECTED is what makes a cursor claimable. Purging after the write
    // would leave a window for a tick to replay A's positions with B's token.
    const prisma = await connectedAsAWithCursors();
    grantDied(prisma);
    const stateAtPurge: unknown[] = [];
    const purge = prisma.m365DeltaCursor.deleteMany;
    const realPurge = purge.getMockImplementation()!;
    purge.mockImplementation(async (args: any) => {
      stateAtPurge.push((prisma.__row() as any).state);
      return realPurge(args);
    });

    expect(await connectAs(prisma, B)).toBe("connected");
    expect(stateAtPurge).toEqual(["PENDING_CONSENT"]);
  });

  it("keeps the cursors when the same account reconnects, so its sync carries on where it was", async () => {
    const prisma = await connectedAsAWithCursors();
    grantDied(prisma);

    expect(await connectAs(prisma, A)).toBe("connected");

    expect(prisma.__cursors().map((c) => c.resourceId)).toEqual(["inbox-of-a", "archive-of-a"]);
  });

  it("purges them when the same account signs in through a different app registration", async () => {
    // A delta token is issued to one app's reads; nothing documents it as
    // portable to another registration, so a new app starts from scratch.
    const prisma = await connectedAsAWithCursors();
    expect(await connectAs(prisma, A, OTHER_APP)).toBe("connected");
    expect(prisma.__cursors()).toEqual([]);
  });

  it("purges them when the same account signs in to a different tenant", async () => {
    const prisma = await connectedAsAWithCursors();
    expect(await connectAs(prisma, { ...A, tenantId: "tenant-elsewhere" })).toBe("connected");
    expect(prisma.__cursors()).toEqual([]);
  });

  it("purges them on the device-code path too", async () => {
    const prisma = await connectedAsAWithCursors();
    grantDied(prisma);
    const entra = fakeEntra({
      acquireByDeviceCode: vi.fn(async (_app, { onCode }) => {
        onCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 900_000),
          message: "enter the code",
        });
        return authResult(B);
      }),
    });

    await beginDeviceCodeConnect(prisma as never, entra, USER);
    await vi.waitFor(() => expect(prisma.__row()).toMatchObject({ state: "CONNECTED" }));

    expect(prisma.__cursors()).toEqual([]);
  });

  it("keeps a cancelled reconnect's cursors for the same account to pick up later", async () => {
    // Cancelling is not disconnecting: the cursors stay unclaimed (the row is
    // not CONNECTED) and hold no credential. Whoever connects next decides.
    const prisma = await connectedAsAWithCursors();
    const entra = fakeEntra();
    const { state } = await beginAuthCodeConnect(prisma as never, entra, USER, { app: APP, redirectUri: REDIRECT });
    expect(
      await completeAuthCodeConnect(prisma as never, entra, { state, browserState: state, error: "access_denied" }),
    ).toBe("cancelled");
    expect(prisma.__cursors()).toHaveLength(2);

    expect(await connectAs(prisma, A)).toBe("connected");
    expect(prisma.__cursors()).toHaveLength(2);
  });

  it("purges cursors a discovery already running re-created after a disconnect, even for the same account", async () => {
    // #2347 review, non-blocking: discovery that got its token before the
    // disconnect can upsert after the purge. Nothing on file says whose they
    // are any more, so the next sign-in does not adopt them.
    const prisma = await connectedAsAWithCursors();
    await disconnect(prisma as never, USER);
    expect(prisma.__cursors()).toEqual([]);
    prisma.__addCursors("inbox-of-a"); // the late upsert

    expect(await connectAs(prisma, A)).toBe("connected");
    expect(prisma.__cursors()).toEqual([]);
  });

  it("treats cursors from a link made before WARP-3059 as someone else's", async () => {
    const prisma = fakePrisma({
      id: "row-1",
      userId: USER,
      state: "NEEDS_RECONNECT",
      homeAccountId: A.homeAccountId,
      tenantId: A.tenantId,
      tokenCacheEnc: sealTokenCache(USER, CACHE),
      ...APP_COLUMNS,
    });
    prisma.__addCursors("inbox-of-a");

    expect(await connectAs(prisma, A)).toBe("connected");
    expect(prisma.__cursors()).toEqual([]);
  });

  it("purges nothing for a sign-in that lost its race to another", async () => {
    // A device-code poll left running while the person finished in the
    // browser as A: when it resolves (as B) the row is no longer waiting on
    // it, so it writes nothing, and must not purge A's cursors either.
    const prisma = await connectedAsAWithCursors();
    let finish!: (r: EntraAuthResult) => void;
    const deviceEntra = fakeEntra({
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
    await beginDeviceCodeConnect(prisma as never, deviceEntra, USER);
    expect(await connectAs(prisma, A)).toBe("connected");
    const writes = vi.mocked(prisma.m365Connection.updateMany).mock.calls.length;

    finish(authResult(B));
    await vi.waitFor(() =>
      expect(vi.mocked(prisma.m365Connection.updateMany).mock.calls.length).toBeGreaterThan(writes),
    );

    expect(prisma.__row()).toMatchObject({ state: "CONNECTED", accountUpn: A.accountUpn });
    expect(prisma.__cursors()).toHaveLength(2);
  });
});

// --- WARP-3538: which scopes a sign-in and a refresh ask for -----------------

describe("the scopes a sign-in asks for follow the person's SharePoint opt-in (WARP-3538)", () => {
  /** A connected person whose row carries the given opt-in value. */
  const rowWith = (sharePointEnabled: unknown) => ({
    id: "row-1",
    userId: USER,
    state: "DISCONNECTED",
    ...APP_COLUMNS,
    ...(sharePointEnabled === undefined ? {} : { sharePointEnabled }),
  });
  const authCodeScopes = (entra: EntraClient) => vi.mocked(entra.getAuthCodeUrl).mock.calls[0]![1].scopes;

  it.each([
    ["off", false],
    ["absent", undefined],
    ["not a boolean (explicit state — never inferred)", "true"],
  ])("asks for the base set only when the flag is %s", async (_label, flag) => {
    // 🔴 A tenant that has not approved Sites.Read.All fails the WHOLE sign-in
    // ("Need admin approval") for a scope the person never asked for — mail and
    // calendar included. (Mutation: always add the SharePoint scope and this
    // goes red.)
    const prisma = fakePrisma(rowWith(flag));
    const { entra } = await started(prisma);
    expect(authCodeScopes(entra)).toEqual([...M365_BASE_SCOPES]);
    expect(authCodeScopes(entra)).not.toContain("Sites.Read.All");
  });

  it("asks for Sites.Read.All too when the person has opted in", async () => {
    const prisma = fakePrisma(rowWith(true));
    const { entra } = await started(prisma);
    expect(authCodeScopes(entra)).toEqual([...M365_BASE_SCOPES, "Sites.Read.All"]);
  });

  it("a first-time connect has no row, and so asks for the base set", async () => {
    const prisma = fakePrisma(null);
    const { entra } = await started(prisma);
    expect(authCodeScopes(entra)).toEqual([...M365_BASE_SCOPES]);
  });

  it("the device-code fallback follows the same rule", async () => {
    for (const [flag, expected] of [
      [false, [...M365_BASE_SCOPES]],
      [true, [...M365_BASE_SCOPES, "Sites.Read.All"]],
    ] as const) {
      const prisma = fakePrisma(rowWith(flag));
      const entra = fakeEntra();
      await beginDeviceCodeConnect(prisma as never, entra, USER, { app: APP });
      expect(vi.mocked(entra.acquireByDeviceCode).mock.calls[0]![1].scopes).toEqual(expected);
      await vi.waitFor(() => expect((prisma.__row() as any).state).toBe("CONNECTED"));
    }
  });

  it("seals the scopes into the pending flow, so the callback redeems with the ones it was issued for", async () => {
    const prisma = fakePrisma(rowWith(true));
    await started(prisma);
    const flow = unsealPendingFlow(USER, (prisma.__row() as any).pendingFlowEnc);
    expect(flow.scopes).toEqual([...M365_BASE_SCOPES, "Sites.Read.All"]);
  });

  it.each([
    ["turned ON", false, true, [...M365_BASE_SCOPES]],
    ["turned OFF", true, false, [...M365_BASE_SCOPES, "Sites.Read.All"]],
  ])("redeems with the scopes the authorize leg used even if the person %s SharePoint while they were on Microsoft's page", async (_label, before, after, expected) => {
    // Entra wants the redemption's scopes equal to, or a subset of, the
    // authorize leg's. Re-reading the row at the callback would redeem a code
    // issued for one set with another. (Mutation: read the flag again in
    // completeAuthCodeConnect and both cases go red.)
    const prisma = fakePrisma(rowWith(before));
    const { state, entra } = await started(prisma);
    await prisma.m365Connection.update({ where: { userId: USER }, data: { sharePointEnabled: after } } as never);

    expect(await completeAuthCodeConnect(prisma as never, entra, { state, browserState: state, code: "c" })).toBe("connected");
    expect(vi.mocked(entra.acquireByAuthorizationCode).mock.calls[0]![1].scopes).toEqual(expected);
  });

  it("redeems a flow sealed by the build before this one with the base set — it asked for nothing else", async () => {
    // The person was on Microsoft's page when the box updated; their 15-minute
    // window is still open and the sealed flow has no `scopes`.
    const prisma = fakePrisma(rowWith(true));
    const { state, entra } = await started(prisma);
    const flow = unsealPendingFlow(USER, (prisma.__row() as any).pendingFlowEnc);
    const { scopes: _omitted, ...legacy } = flow;
    (prisma.__row() as any).pendingFlowEnc = sealPendingFlow(USER, legacy as never);

    expect(await completeAuthCodeConnect(prisma as never, entra, { state, browserState: state, code: "c" })).toBe("connected");
    expect(vi.mocked(entra.acquireByAuthorizationCode).mock.calls[0]![1].scopes).toEqual([...M365_BASE_SCOPES]);
  });
});

describe("a silent refresh asks only for what the connection already holds (WARP-3538)", () => {
  const BASE_GRANT = "Mail.ReadWrite Files.ReadWrite.All Calendars.ReadWrite Contacts.ReadWrite Mail.Send User.Read profile openid email";
  const connectedWith = (over: Record<string, unknown>) => ({
    id: "row-1",
    userId: USER,
    state: "CONNECTED",
    homeAccountId: "uid.utid",
    tokenCacheEnc: sealTokenCache(USER, CACHE),
    ...APP_COLUMNS,
    ...over,
  });
  const refreshScopes = (entra: EntraClient) => vi.mocked(entra.acquireSilent).mock.calls[0]![3];

  it("a connection granted only the base set refreshes with the base set, even after the person turned SharePoint on", async () => {
    // 🔴 They flipped the switch but have not signed in again, so Microsoft has
    // never been asked for Sites.Read.All. A refresh that asked for it now would
    // fail with a consent error and push a healthy connection into
    // NEEDS_RECONNECT. (Mutation: pass [...M365_BASE_SCOPES, "Sites.Read.All"]
    // whenever the flag is on and this goes red.)
    const prisma = fakePrisma(connectedWith({ sharePointEnabled: true, grantedScopes: BASE_GRANT }));
    const entra = fakeEntra();

    await getAccessToken(prisma as never, entra, USER);

    expect(refreshScopes(entra)).toEqual([...M365_BASE_SCOPES]);
    expect(refreshScopes(entra)).not.toContain("Sites.Read.All");
    expect((prisma.__row() as any).state).toBe("CONNECTED");
  });

  it("a connection that DOES hold Sites.Read.All keeps asking for it — also after the person switches SharePoint off", async () => {
    // What a refresh returns is stored over `grantedScopes`: asking for less would
    // silently shrink what the grant is recorded as holding, and turning
    // SharePoint back on would then look like it needs consent again.
    for (const flag of [true, false]) {
      const prisma = fakePrisma(connectedWith({ sharePointEnabled: flag, grantedScopes: `${BASE_GRANT} Sites.Read.All` }));
      const entra = fakeEntra();
      await getAccessToken(prisma as never, entra, USER);
      expect(refreshScopes(entra)).toEqual([...M365_BASE_SCOPES, "Sites.Read.All"]);
    }
  });

  it.each([
    ["null (a legacy row)", null],
    ["empty", ""],
  ])("a connection with %s grantedScopes refreshes with the base set", async (_label, grantedScopes) => {
    const prisma = fakePrisma(connectedWith({ grantedScopes }));
    const entra = fakeEntra();
    await getAccessToken(prisma as never, entra, USER);
    expect(refreshScopes(entra)).toEqual([...M365_BASE_SCOPES]);
  });

  it("stores back what Microsoft returned, as it always has", async () => {
    const prisma = fakePrisma(connectedWith({ grantedScopes: BASE_GRANT }));
    const entra = fakeEntra({ acquireSilent: vi.fn(async () => ({ ...authResult({ grantedScopes: "Mail.ReadWrite User.Read" }), accessToken: "tok" })) });
    await getAccessToken(prisma as never, entra, USER);
    expect((prisma.__row() as any).grantedScopes).toBe("Mail.ReadWrite User.Read");
  });
});

// --- WARP-3538: a sign-in as somebody else also starts their files from nothing ---

describe("a reconnect as someone else removes the files landed from the old account (WARP-3538)", () => {
  const OLD = { homeAccountId: "old-oid.tid", tenantId: "tenant-a", accountUpn: "old@practice.com" };
  const NEW = { homeAccountId: "new-oid.tid", tenantId: "tenant-a", accountUpn: "new@practice.com" };

  /** A connection made as OLD, then a new sign-in pressed: parked PENDING_CONSENT, link hash kept. */
  async function relink(who: typeof OLD, opts: { capped: number }) {
    const prisma = fakePrisma(null);
    const first = await started(prisma, fakeEntra({ acquireByAuthorizationCode: vi.fn(async () => authResult({ ...OLD })) }));
    await completeAuthCodeConnect(prisma as never, first.entra, { state: first.state, browserState: first.state, code: "c" });
    await prisma.m365Connection.update({ where: { userId: USER }, data: { sharePointEnabled: true, sharePointLibrariesCapped: opts.capped } } as never);

    const c = prisma.__cloud;
    c.seedSource({ userId: USER, provider: "M365", kind: "ONEDRIVE", sourceId: "od-old", nameEnc: "dcv1:x" });
    c.seedItem({ userId: USER, provider: "M365", sourceId: "od-old", externalId: "f1", isFolder: false, nameEnc: "dcv1:x" });
    c.seedItem({ userId: "user-2", provider: "M365", sourceId: "od-x", externalId: "f9", isFolder: false, nameEnc: "dcv1:x" });

    const second = await started(prisma, fakeEntra({ acquireByAuthorizationCode: vi.fn(async () => authResult({ ...who })) }));
    await completeAuthCodeConnect(prisma as never, second.entra, { state: second.state, browserState: second.state, code: "c2" });
    return prisma;
  }

  it("deletes the previous account's landed items and sources, and nobody else's", async () => {
    // The new account's sweep only covers drives it reads, so nothing else would
    // ever remove the old account's file names — and a person who signs in as
    // somebody else must not search them.
    const prisma = await relink(NEW, { capped: 3 });
    expect(prisma.__cloud.items.map((r) => r.externalId)).toEqual(["f9"]);
    expect(prisma.__cloud.sources).toEqual([]);
  });

  it("clears the previous account's cap count, and keeps the person's SharePoint choice", async () => {
    const prisma = await relink(NEW, { capped: 3 });
    expect(prisma.__row()).toMatchObject({ state: "CONNECTED", sharePointLibrariesCapped: 0, sharePointEnabled: true });
  });

  it("keeps the files — and the cap count — when the SAME account signs in again", async () => {
    // Reconnecting after NEEDS_RECONNECT is the ordinary recovery path: the
    // landed list is still right, and re-landing it would be a full re-read.
    const prisma = await relink(OLD, { capped: 3 });
    expect(prisma.__cloud.items.map((r) => r.externalId).sort()).toEqual(["f1", "f9"]);
    expect(prisma.__row()).toMatchObject({ state: "CONNECTED", sharePointLibrariesCapped: 3 });
  });
});
