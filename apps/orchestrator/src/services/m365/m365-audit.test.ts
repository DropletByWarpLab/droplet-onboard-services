/**
 * WARP-2285 — audit gap 2: the Microsoft 365 surface shipped with ZERO
 * `recordActivity` calls.
 *
 * `grep -c 'recordActivity' routes/m365.ts services/m365/m365-auth.service.ts`
 * returned 0 for both files on `origin/stage`. A customer could grant consent,
 * have a refresh token encrypted onto their row, and later disconnect, and none
 * of it appeared in the activity log — on a surface that is already shipped.
 *
 * The distinction these tests defend hardest is NEEDS_RECONNECT vs
 * DISCONNECTED. `schema.prisma:4990-5012` requires the two states stay
 * distinguishable, and the audit has to preserve that: one is a person leaving,
 * the other is a grant dying. Flattening them answers a support question and
 * loses a security one.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import {
  __setColumnCryptoKeyForTest,
} from "../column-crypto.service.js";
import { sealTokenCache } from "./token-cache.js";
import {
  beginDeviceCodeConnect,
  disconnect,
  getAccessToken,
  type EntraAuthResult,
  type EntraClient,
} from "./m365-auth.service.js";

const TEST_KEY = Buffer.alloc(32, 2).toString("base64");
const USER_ID = "55555555-5555-4555-8555-555555555555";
const SEEDED_CACHE = "SEEDED-MSAL-CACHE-BLOB";
const SEEDED_TOKEN = "SEEDED-ACCESS-TOKEN";

function authResult(overrides: Partial<EntraAuthResult> = {}): EntraAuthResult {
  return {
    homeAccountId: "home-1",
    tenantId: "tenant-1",
    accountUpn: "person@acme.example",
    grantedScopes: "Mail.Read Files.Read",
    serializedCache: SEEDED_CACHE,
    accessToken: SEEDED_TOKEN,
    ...overrides,
  };
}

/** Minimal structural Prisma stub — no mock database, just recorded calls. */
function stubPrisma(row: Record<string, unknown> | null) {
  let current = row;
  return {
    _row: () => current,
    m365Connection: {
      findUnique: vi.fn(async () => current),
      upsert: vi.fn(async () => {
        current = { ...(current ?? {}), state: "PENDING_CONSENT" };
        return current;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...(current ?? {}), ...data };
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...(current ?? {}), ...data };
        return current;
      }),
    },
  };
}

function rows(what: string) {
  return recordActivityMock.mock.calls
    .map((c) => c[0] as { what: string; sub: string; refs: Record<string, unknown> })
    .filter((p) => p.what === what);
}

function allRows() {
  return recordActivityMock.mock.calls.map(
    (c) => c[0] as { what: string; sub: string; refs: Record<string, unknown> },
  );
}

beforeEach(() => {
  recordActivityMock.mockClear();
  __setColumnCryptoKeyForTest(TEST_KEY);
});

describe("connect", () => {
  it("writes exactly one row when the sign-in completes", async () => {
    const prisma = stubPrisma({ userId: USER_ID, state: "DISCONNECTED" });
    const entra: EntraClient = {
      acquireByDeviceCode: vi.fn(async ({ onCode }) => {
        onCode({
          userCode: "ABC-123",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 600_000),
          message: "enter the code",
        });
        return authResult();
      }),
      acquireSilent: vi.fn(),
    };

    await beginDeviceCodeConnect(prisma as never, entra, USER_ID);
    // The completion runs after the promise the caller awaits resolves.
    await new Promise((r) => setTimeout(r, 0));

    // Mutation: remove the call from `persistConnected` → red.
    expect(rows("Microsoft 365 connected")).toHaveLength(1);
    expect(rows("Microsoft 365 connected")[0].refs.state).toBe("CONNECTED");
  });

  it("records NO connected row when the guard rejects a stale flow", async () => {
    const prisma = stubPrisma({ userId: USER_ID, state: "DISCONNECTED" });
    // The person disconnected while the poll was in flight: updateMany matches
    // nothing. An audit row claiming a connection would be the log's own
    // version of the bug that guard exists to prevent.
    prisma.m365Connection.updateMany.mockResolvedValue({ count: 0 } as never);

    const entra: EntraClient = {
      acquireByDeviceCode: vi.fn(async ({ onCode }) => {
        onCode({
          userCode: "ABC-123",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 600_000),
          message: "enter the code",
        });
        return authResult();
      }),
      acquireSilent: vi.fn(),
    };

    await beginDeviceCodeConnect(prisma as never, entra, USER_ID);
    await new Promise((r) => setTimeout(r, 0));

    expect(rows("Microsoft 365 connected")).toHaveLength(0);
  });
});

describe("disconnect", () => {
  it("writes exactly one row, after the purge", async () => {
    const prisma = stubPrisma({ userId: USER_ID, state: "CONNECTED" });
    await disconnect(prisma as never, USER_ID);

    // Mutation: remove the call from `disconnect` → red.
    const written = rows("Microsoft 365 disconnected");
    expect(written).toHaveLength(1);
    expect(written[0].refs.state).toBe("DISCONNECTED");
  });

  it("writes nothing when there was never a connection to purge", async () => {
    const prisma = stubPrisma(null);
    await disconnect(prisma as never, USER_ID);
    expect(allRows()).toHaveLength(0);
  });
});

describe("reconnect", () => {
  it("writes exactly one row when a stored sign-in becomes unreadable", async () => {
    const prisma = stubPrisma({
      userId: USER_ID,
      state: "CONNECTED",
      homeAccountId: "home-1",
      tokenCacheEnc: sealTokenCache(USER_ID, SEEDED_CACHE),
    });
    // A factory reset regenerated DEVICE_SECRET_KEY: rows survive, the key does
    // not. That is a reconnect, not a crash.
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));

    await expect(
      getAccessToken(prisma as never, { acquireSilent: vi.fn() } as never, USER_ID),
    ).rejects.toThrow();

    // Mutation: remove the call from the NEEDS_RECONNECT branch → red.
    expect(rows("Microsoft 365 needs reconnect")).toHaveLength(1);
  });

  it("is DISTINGUISHABLE in the audit from a user-initiated disconnect", async () => {
    const prisma = stubPrisma({
      userId: USER_ID,
      state: "CONNECTED",
      homeAccountId: "home-1",
      tokenCacheEnc: sealTokenCache(USER_ID, SEEDED_CACHE),
    });
    __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
    await expect(
      getAccessToken(prisma as never, { acquireSilent: vi.fn() } as never, USER_ID),
    ).rejects.toThrow();

    __setColumnCryptoKeyForTest(TEST_KEY);
    await disconnect(prisma as never, USER_ID);

    const reconnect = rows("Microsoft 365 needs reconnect")[0];
    const disconnected = rows("Microsoft 365 disconnected")[0];

    // Mutation: give both the same `what` / state and this goes red — which is
    // exactly the flattening the schema docstring forbids.
    expect(reconnect.what).not.toBe(disconnected.what);
    expect(reconnect.refs.state).toBe("NEEDS_RECONNECT");
    expect(disconnected.refs.state).toBe("DISCONNECTED");
    // The box discovered one; a person asked for the other. `actor` carries it.
    expect(reconnect.sub).toBe("NEEDS_RECONNECT");
    expect(disconnected.sub).toBe("DISCONNECTED");
  });
});

describe("redaction", () => {
  it("never records a token, a cache blob, or a device code", async () => {
    const prisma = stubPrisma({ userId: USER_ID, state: "DISCONNECTED" });
    const entra: EntraClient = {
      acquireByDeviceCode: vi.fn(async ({ onCode }) => {
        onCode({
          userCode: "SEEDED-DEVICE-CODE",
          verificationUri: "https://microsoft.com/devicelogin",
          expiresAt: new Date(Date.now() + 600_000),
          message: "enter the code",
        });
        return authResult();
      }),
      acquireSilent: vi.fn(),
    };

    await beginDeviceCodeConnect(prisma as never, entra, USER_ID);
    await new Promise((r) => setTimeout(r, 0));
    await disconnect(prisma as never, USER_ID);

    const everything = JSON.stringify(allRows());
    expect(everything).not.toContain(SEEDED_CACHE);
    expect(everything).not.toContain(SEEDED_TOKEN);
    // A device code is a live bearer of the sign-in for its whole TTL, and the
    // activity log is readable and exportable.
    expect(everything).not.toContain("SEEDED-DEVICE-CODE");
  });
});
