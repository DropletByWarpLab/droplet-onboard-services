/**
 * WARP-2704 + WARP-2705 — the Microsoft 365 routes, end to end over HTTP.
 *
 * The service underneath is the real one; only Prisma (an in-memory row), the
 * Entra port (a fake Microsoft) and the activity singleton are replaced.
 * `requireRole` is the shipped middleware, not a stand-in.
 *
 * What these pin:
 *   - connect names the customer's own app, validates it, and refuses to fall
 *     back to a box-wide one;
 *   - the redirect URI is the box's host-validated origin, never a forged Host;
 *   - the state cookie is httpOnly, Lax and scoped to /api/m365;
 *   - the callback is reachable WITHOUT a session, completes only for the
 *     browser that pressed Connect, and always answers with a redirect whose
 *     Location reflects nothing from the query.
 */
import { createHash } from "node:crypto";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
    DROPLET_PUBLIC_FQDN: "",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    M365_AUTHORITY_HOST: "https://login.microsoftonline.com",
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { __setColumnCryptoKeyForTest } from "../services/column-crypto.service.js";
import type { EntraAuthResult, EntraClient } from "../services/m365/m365-auth.service.js";
import { isRoleGuard } from "../middleware/auth.js";
import {
  createM365CallbackRouter,
  createM365Router,
  M365_STATE_COOKIE,
} from "./m365.js";

const USER = "user-1";
const APP = {
  clientId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
  tenantId: "9a8b7c6d-5e4f-4321-8fed-cba987654321",
};
const EXPECTED_REDIRECT = "https://droplet-ai.local/api/m365/callback";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** One in-memory M365Connection row that honours `where` on every call. */
function fakePrisma(seed: Record<string, unknown> | null = null) {
  let row: Record<string, unknown> | null = seed ? { ...seed } : null;
  const matches = (where: Record<string, unknown> = {}) =>
    row !== null && Object.entries(where).every(([k, v]) => row![k] === v);
  return {
    __row: () => row,
    m365Connection: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matches(where) ? { ...row! } : null,
      ),
      upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        row = row ? { ...row, ...update } : { id: "row-1", ...create };
        return { ...row };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        row = { ...(row ?? { id: "row-1", userId: USER }), ...data };
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 };
        row = { ...row!, ...data };
        return { count: 1 };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    m365DeltaCursor: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

function authResult(): EntraAuthResult {
  return {
    homeAccountId: "uid.utid",
    tenantId: APP.tenantId,
    accountUpn: "sam@practice.com",
    grantedScopes: "Mail.ReadWrite",
    serializedCache: "SERIALIZED-CACHE-WITH-REFRESH-TOKEN",
  };
}

function fakeEntra(): EntraClient {
  return {
    getAuthCodeUrl: vi.fn(async (_app, { state }) => `https://login.microsoftonline.com/x/authorize?state=${state}`),
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
    acquireSilent: vi.fn(),
  };
}

/** The authenticated surface, with a session injected the way authMiddleware would. */
function authedApp(
  prisma: ReturnType<typeof fakePrisma>,
  entra: EntraClient,
  user: { id?: string; role?: string } | undefined = { id: USER, role: "owner" },
) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createM365Router(prisma as never, entra));
  return app;
}

/** The public callback surface — no session middleware at all. */
function publicApp(prisma: ReturnType<typeof fakePrisma>, entra: EntraClient) {
  const app = express();
  app.use(cookieParser());
  app.use("/api", createM365CallbackRouter(prisma as never, entra));
  return app;
}

/** The raw `Set-Cookie` line for the state cookie, and its value. */
function stateCookie(res: request.Response): { line: string; value: string } {
  const lines = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const line = lines.find((l) => l.startsWith(`${M365_STATE_COOKIE}=`));
  if (!line) throw new Error("no state cookie was set");
  return { line, value: decodeURIComponent(line.split(";")[0]!.split("=")[1]!) };
}

beforeEach(() => {
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 7).toString("base64"));
  recordActivityMock.mockReset();
});
afterEach(() => __setColumnCryptoKeyForTest(null));

describe("GET /api/m365/connection", () => {
  it("tells the owner the exact redirect URI to register, from the box's own origin", async () => {
    const res = await request(authedApp(fakePrisma(), fakeEntra()))
      .get("/api/m365/connection")
      // A forged host must never end up in a URL the owner pastes into Entra.
      .set("X-Forwarded-Host", "evil.example");
    expect(res.status).toBe(200);
    expect(res.body.redirectUri).toBe(EXPECTED_REDIRECT);
    expect(res.body.state).toBe("DISCONNECTED");
    expect(res.body.app).toBeNull();
    // The box-wide on/off switch is gone with M365_CLIENT_ID.
    expect(res.body).not.toHaveProperty("available");
  });
});

describe("POST /api/m365/connect (authorization code)", () => {
  it("returns Microsoft's sign-in URL and sets a Lax, httpOnly state cookie scoped to /api/m365", async () => {
    const prisma = fakePrisma();
    const entra = fakeEntra();
    const res = await request(authedApp(prisma, entra))
      .post("/api/m365/connect")
      .set("X-Forwarded-Proto", "https")
      .send(APP);

    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toMatch(/^https:\/\/login\.microsoftonline\.com\//);

    const { line, value } = stateCookie(res);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\/api\/m365/);
    expect(line).toMatch(/Secure/i);
    // The cookie carries the raw state; the row only its hash.
    expect((prisma.__row() as Record<string, unknown>).pendingStateHash).toBe(sha256(value));

    // Microsoft is told the box's own callback, through the owner's app.
    const [app, opts] = vi.mocked(entra.getAuthCodeUrl).mock.calls[0]!;
    expect(app).toEqual(APP);
    expect(opts.redirectUri).toBe(EXPECTED_REDIRECT);
  });

  it("records that a person started a sign-in, without the state", async () => {
    const res = await request(authedApp(fakePrisma(), fakeEntra())).post("/api/m365/connect").send(APP);
    const { value } = stateCookie(res);
    const started = recordActivityMock.mock.calls.map((c) => c[0]).filter((r) => r.what === "Microsoft 365 sign-in started");
    expect(started).toHaveLength(1);
    expect(started[0].refs.method).toBe("authorization_code");
    expect(JSON.stringify(started)).not.toContain(value);
  });

  it("refuses to start with no app named and none stored — there is no shared app to fall back to", async () => {
    const prisma = fakePrisma();
    const res = await request(authedApp(prisma, fakeEntra())).post("/api/m365/connect").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("m365_app_required");
    expect(prisma.__row()).toBeNull();
  });

  it("reuses the stored app when the request names none", async () => {
    const prisma = fakePrisma({ id: "row-1", userId: USER, state: "DISCONNECTED", appClientId: APP.clientId, appTenantId: APP.tenantId });
    const entra = fakeEntra();
    const res = await request(authedApp(prisma, entra)).post("/api/m365/connect").send({});
    expect(res.status).toBe(200);
    expect(vi.mocked(entra.getAuthCodeUrl).mock.calls[0]![0]).toEqual(APP);
  });

  it("refuses a multitenant authority or a half-filled app, and writes nothing", async () => {
    for (const body of [
      { ...APP, tenantId: "organizations" },
      { ...APP, tenantId: "../common" },
      { clientId: APP.clientId },
      { ...APP, clientId: "not-a-guid" },
    ]) {
      const prisma = fakePrisma();
      const res = await request(authedApp(prisma, fakeEntra())).post("/api/m365/connect").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_app_registration");
      expect(prisma.__row()).toBeNull();
    }
  });

  it("is closed to guests", async () => {
    const res = await request(authedApp(fakePrisma(), fakeEntra(), { id: USER, role: "guest" }))
      .post("/api/m365/connect")
      .send(APP);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/m365/connect/device-code (fallback)", () => {
  it("still hands back a device code, through the named app", async () => {
    const entra = fakeEntra();
    const res = await request(authedApp(fakePrisma(), entra)).post("/api/m365/connect/device-code").send(APP);
    expect(res.status).toBe(202);
    expect(res.body.userCode).toBe("ABCD-EFGH");
    expect(vi.mocked(entra.acquireByDeviceCode).mock.calls[0]![0]).toEqual(APP);
  });
});

describe("GET /api/m365/callback", () => {
  async function connect(prisma: ReturnType<typeof fakePrisma>, entra: EntraClient) {
    const res = await request(authedApp(prisma, entra)).post("/api/m365/connect").send(APP);
    return stateCookie(res).value;
  }

  it("completes the sign-in for the browser that started it, with no session at all", async () => {
    const prisma = fakePrisma();
    const entra = fakeEntra();
    const state = await connect(prisma, entra);

    const res = await request(publicApp(prisma, entra))
      .get("/api/m365/callback")
      .query({ code: "the-code", state })
      .set("Cookie", `${M365_STATE_COOKIE}=${encodeURIComponent(state)}`);

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/settings?m365=connected");
    // Single-use: the cookie is cleared on the way out.
    expect(([] as string[]).concat(res.headers["set-cookie"] ?? []).join(";")).toMatch(
      new RegExp(`${M365_STATE_COOKIE}=;`),
    );
    expect(prisma.__row()).toMatchObject({ state: "CONNECTED", accountUpn: "sam@practice.com" });
  });

  it("refuses a callback from a browser that did not press Connect, and leaves the sign-in intact", async () => {
    const prisma = fakePrisma();
    const entra = fakeEntra();
    const state = await connect(prisma, entra);

    const res = await request(publicApp(prisma, entra)).get("/api/m365/callback").query({ code: "c", state });

    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/settings?m365=invalid");
    expect(entra.acquireByAuthorizationCode).not.toHaveBeenCalled();
    expect(prisma.__row()).toMatchObject({ state: "PENDING_CONSENT" });
  });

  it("reports Cancel on Microsoft's page as cancelled", async () => {
    const prisma = fakePrisma();
    const entra = fakeEntra();
    const state = await connect(prisma, entra);
    const res = await request(publicApp(prisma, entra))
      .get("/api/m365/callback")
      .query({ state, error: "access_denied", error_description: "AADSTS65004: declined" })
      .set("Cookie", `${M365_STATE_COOKIE}=${encodeURIComponent(state)}`);
    expect(res.headers.location).toBe("/settings?m365=cancelled");
  });

  it("reflects nothing from the query into the Location header", async () => {
    const hostile = "https://evil.example/\r\nSet-Cookie: x=1";
    const res = await request(publicApp(fakePrisma(), fakeEntra()))
      .get("/api/m365/callback")
      .query({ state: hostile, code: hostile, error: hostile })
      .set("Cookie", `${M365_STATE_COOKIE}=${encodeURIComponent(hostile)}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/settings?m365=invalid");
  });

  it("is the ONLY route without a role guard", () => {
    // Every authenticated route carries requireRole at registration; the
    // callback carries none because it must work with a lapsed session. A
    // second unguarded route here would be a new public surface.
    type Layer = { route?: { path: string; stack: Array<{ handle: unknown }> } };
    const guarded = (r: NonNullable<Layer["route"]>) => r.stack.some((l) => isRoleGuard(l.handle));

    const authed = (createM365Router(fakePrisma() as never, fakeEntra()) as unknown as { stack: Layer[] }).stack
      .map((l) => l.route)
      .filter(Boolean) as NonNullable<Layer["route"]>[];
    expect(authed.length).toBe(4);
    for (const r of authed) expect(guarded(r)).toBe(true);

    const open = (createM365CallbackRouter(fakePrisma() as never, fakeEntra()) as unknown as { stack: Layer[] }).stack
      .map((l) => l.route)
      .filter(Boolean) as NonNullable<Layer["route"]>[];
    expect(open.map((r) => r.path)).toEqual(["/m365/callback"]);
  });
});
