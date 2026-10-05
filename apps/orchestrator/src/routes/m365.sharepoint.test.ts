/**
 * WARP-3538 — the SharePoint half of the Microsoft 365 routes, over HTTP:
 *
 *   GET /api/m365/connection   (+ `sharePoint { enabled, granted, needsConsent }`)
 *   PUT /api/m365/sharepoint   `{ enabled }`
 *   GET /api/m365/sync-status  workloads, OneDrive, SharePoint libraries
 *
 * The services underneath are the real ones; only Prisma (in-memory tables that
 * EVALUATE their arguments, behind a transaction that records which handle each
 * statement used) and the activity singleton are replaced, and `requireRole` is
 * the shipped middleware. What these pin is the CONTRACT the dashboard's card
 * reads, and the three things a route in front of a person's own data owes them:
 * it is self-scoped (no `:userId`, nothing from the body or the query can name
 * anybody else), it answers instead of hanging, and it never says more than it
 * should (no token, no delta link, no raw error text).
 */
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
import { sealSourceField } from "../services/cloud-files/cloud-file-crypto.js";
import { makeFakeM365World } from "../__tests__/helpers/fake-m365-world.js";
import type { Row } from "../__tests__/helpers/fake-table.js";
import type { EntraClient } from "../services/m365/m365-auth.service.js";
import { createM365Router } from "./m365.js";

const USER = "user-1";
const OTHER = "user-2";
const BASE =
  "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.ReadWrite.All";
const WITH_SITES = `${BASE} Sites.Read.All`;
const T1 = new Date("2026-10-04T10:00:00.000Z");

const entra = { acquireSilent: vi.fn() } as unknown as EntraClient;

const connected = (over: Row = {}): Row => ({
  id: "row-1",
  userId: USER,
  state: "CONNECTED",
  accountUpn: "sam@practice.com",
  grantedScopes: BASE,
  sharePointEnabled: false,
  sharePointLibrariesCapped: 0,
  ...over,
});

function app(world: ReturnType<typeof makeFakeM365World>, user: { id?: string; role?: string } | undefined = { id: USER, role: "owner" }) {
  const server = express();
  server.use(express.json());
  server.use(cookieParser());
  server.use((req, _res, next) => {
    if (user) (req as unknown as { user?: unknown }).user = user;
    next();
  });
  server.use("/api", createM365Router(world.prisma, entra));
  return server;
}

beforeEach(() => {
  recordActivityMock.mockReset();
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 8).toString("base64"));
});
afterEach(() => __setColumnCryptoKeyForTest(null));

const sealed = (userId: string, sourceId: string, column: "siteName" | "name" | "webUrl", text: string) =>
  sealSourceField({ provider: "M365", userId, sourceId }, column, text);

/** A person with SharePoint on, one library read and landed, a OneDrive — and somebody else with their own. */
function populated(over: Row = {}) {
  const w = makeFakeM365World([
    connected({ sharePointEnabled: true, grantedScopes: WITH_SITES, sharePointLibrariesCapped: 3, ...over }),
    connected({ id: "row-2", userId: OTHER, sharePointEnabled: true, grantedScopes: WITH_SITES }),
  ]);
  for (const user of [USER, OTHER]) {
    w.oneDrive(user, `od-${user}`, { nameEnc: sealed(user, `od-${user}`, "name", "OneDrive") });
    w.library(user, `lib-${user}`, {
      siteId: "site",
      siteNameEnc: sealed(user, `lib-${user}`, "siteName", `Site of ${user}`),
      nameEnc: sealed(user, `lib-${user}`, "name", `Library of ${user}`),
      webUrlEnc: sealed(user, `lib-${user}`, "webUrl", `https://contoso.sharepoint.com/sites/${user}`),
      followed: true,
    });
    w.cursor(user, "files", "-", { lastSyncedAt: T1 });
    w.cursor(user, "sharepoint", `lib-${user}`, { lastSyncedAt: T1 });
    w.cursor(user, "mail", "inbox", { lastSyncedAt: T1 });
    w.item(user, `od-${user}`, `${user}-1`);
    w.item(user, `od-${user}`, `${user}-2`);
    w.item(user, `lib-${user}`, `${user}-3`);
  }
  return w;
}

describe("GET /api/m365/connection — the sharePoint block", () => {
  it("is off, ungranted and needs nothing for a person who never connected", async () => {
    const res = await request(app(makeFakeM365World([]))).get("/api/m365/connection");
    expect(res.status).toBe(200);
    expect(res.body.sharePoint).toEqual({ enabled: false, granted: false, needsConsent: false });
  });

  it("says needsConsent when it is on and the grant lacks Sites.Read.All — and nothing else changes in the view", async () => {
    const res = await request(app(makeFakeM365World([connected({ sharePointEnabled: true })]))).get("/api/m365/connection");
    expect(res.body.sharePoint).toEqual({ enabled: true, granted: false, needsConsent: true });
    expect(res.body.state).toBe("CONNECTED");
    expect(res.body.redirectUri).toBe("https://droplet-ai.local/api/m365/callback");
    expect(res.body.grantedScopes).toEqual(BASE.split(" "));
  });

  it("is on, granted and settled once the grant holds it", async () => {
    const res = await request(
      app(makeFakeM365World([connected({ sharePointEnabled: true, grantedScopes: WITH_SITES })])),
    ).get("/api/m365/connection");
    expect(res.body.sharePoint).toEqual({ enabled: true, granted: true, needsConsent: false });
  });
});

describe("PUT /api/m365/sharepoint", () => {
  const put = (w: ReturnType<typeof makeFakeM365World>, body: unknown, user?: { id?: string; role?: string }) =>
    request(app(w, user)).put("/api/m365/sharepoint").send(body as object);

  it("turns it on for a connected person, and answers with the view the card then shows", async () => {
    const w = makeFakeM365World([connected()]);
    const res = await put(w, { enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.sharePoint).toEqual({ enabled: true, granted: false, needsConsent: true });
    expect(res.body.state).toBe("CONNECTED");
    expect(w.connection(USER)).toMatchObject({ sharePointEnabled: true });
    // A view, never a token.
    expect(JSON.stringify(res.body)).not.toMatch(/tokenCacheEnc|pendingFlow|homeAccountId/);
  });

  it("answers 409 m365_not_connected when there is no connection to turn it on for", async () => {
    const w = makeFakeM365World([]);
    const res = await put(w, { enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("m365_not_connected");
    expect(res.body.message).toMatch(/connect Microsoft 365/i);
    expect(w.connections).toEqual([]);
  });

  it("answers 409 for a connection that is not CONNECTED, and leaves the flag alone", async () => {
    const w = makeFakeM365World([connected({ state: "NEEDS_RECONNECT" })]);
    expect((await put(w, { enabled: true })).status).toBe(409);
    expect(w.connection(USER)).toMatchObject({ sharePointEnabled: false });
  });

  it("turns it off: the flag and the person's SharePoint list go, OneDrive stays, and the answer says off", async () => {
    const w = populated();
    const res = await put(w, { enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.sharePoint).toMatchObject({ enabled: false });
    expect(w.connection(USER)).toMatchObject({ sharePointEnabled: false, sharePointLibrariesCapped: 0 });
    expect(w.cursorKeys(USER)).toEqual(["files:-", "mail:inbox"]);
    expect(w.sources(USER)).toEqual([`od-${USER}`]);
    expect(w.items(USER)).toEqual([`${USER}-1`, `${USER}-2`]);
  });

  it("does it in ONE transaction", async () => {
    const w = populated();
    await put(w, { enabled: false });
    expect(w.$transaction).toHaveBeenCalledTimes(1);
    for (const write of w.calls.filter((c) => /updateMany|deleteMany/.test(c.op))) {
      expect(write, write.op).toMatchObject({ via: "tx", inTransaction: true });
    }
  });

  it("never touches anybody else's connection, cursors, libraries or files — whatever the body says", async () => {
    // The route has no :userId and takes no identity from the body: the person
    // is the session. A body that tries to name somebody else is not a request
    // this route understands.
    const w = populated();
    const theirs = { cursors: w.cursorKeys(OTHER), items: w.items(OTHER), sources: w.sources(OTHER) };
    const refused = await put(w, { enabled: false, userId: OTHER });
    expect(refused.status).toBe(400);
    expect(w.connection(OTHER)).toMatchObject({ sharePointEnabled: true });

    await put(w, { enabled: false });
    expect({ cursors: w.cursorKeys(OTHER), items: w.items(OTHER), sources: w.sources(OTHER) }).toEqual(theirs);
    expect(w.connection(OTHER)).toMatchObject({ sharePointEnabled: true });
  });

  it.each([
    ["no body", undefined],
    ["an empty object", {}],
    ["a string", { enabled: "true" }],
    ["a number", { enabled: 1 }],
    ["null", { enabled: null }],
    ["an extra key", { enabled: true, userId: "someone-else" }],
    ["an array", [{ enabled: true }]],
  ])("answers 400 invalid_request for %s, and changes nothing", async (_name, body) => {
    const w = populated();
    const res = await put(w, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(w.calls.filter((c) => /updateMany|deleteMany/.test(c.op))).toEqual([]);
    expect(w.connection(USER)).toMatchObject({ sharePointEnabled: true });
  });

  it("answers 500 m365_sharepoint_failed — rolled back, and without echoing the error", async () => {
    // The last statement fails: a half-done removal must not be left behind, and
    // the person gets an answer instead of a hung card.
    const w = populated();
    const real = w.cloud.cloudFileSource.deleteMany.getMockImplementation()!;
    w.cloud.cloudFileSource.deleteMany.mockImplementation(async (a) => {
      await real(a);
      throw new Error("could not reach postgres at 10.9.8.7 with password hunter2");
    });
    const res = await put(w, { enabled: false });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "m365_sharepoint_failed" });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(w.connection(USER)).toMatchObject({ sharePointEnabled: true });
    expect(w.items(USER)).toHaveLength(3);
  });

  it("is allowed to owner, admin and family and closed to guests and services — the connect gate", async () => {
    for (const role of ["owner", "admin", "family"]) {
      const w = makeFakeM365World([connected()]);
      expect((await put(w, { enabled: true }, { id: USER, role })).status, role).toBe(200);
    }
    for (const role of ["guest", "service"]) {
      const w = makeFakeM365World([connected()]);
      const res = await put(w, { enabled: true }, { id: USER, role });
      expect(res.status, role).toBe(403);
      expect(w.connection(USER)).toMatchObject({ sharePointEnabled: false });
    }
  });

  it("answers 401 without a session id", async () => {
    const w = makeFakeM365World([connected()]);
    const res = await put(w, { enabled: true }, { role: "owner" });
    expect(res.status).toBe(401);
    expect(w.connection(USER)).toMatchObject({ sharePointEnabled: false });
  });

  it("audits a change once, as the person, and a repeat not at all", async () => {
    const w = makeFakeM365World([connected()]);
    await put(w, { enabled: true });
    await put(w, { enabled: true });
    const rows = recordActivityMock.mock.calls.map((c) => c[0] as { what: string; actor: unknown });
    expect(rows.map((r) => r.what)).toEqual(["Microsoft 365 SharePoint turned on"]);
    expect(rows[0]!.actor).toEqual({ type: "user", id: USER });
  });
});

describe("GET /api/m365/sync-status", () => {
  const get = (w: ReturnType<typeof makeFakeM365World>, user?: { id?: string; role?: string }) =>
    request(app(w, user)).get("/api/m365/sync-status");

  it("answers with workloads, the OneDrive and the SharePoint libraries — the shape the card reads", async () => {
    const res = await get(populated());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workloads: [
        { workload: "mail", cursors: 1, idle: 1, backoff: 0, failed: 0, lastSyncedAt: T1.toISOString() },
        { workload: "files", cursors: 1, idle: 1, backoff: 0, failed: 0, lastSyncedAt: T1.toISOString() },
        { workload: "sharepoint", cursors: 1, idle: 1, backoff: 0, failed: 0, lastSyncedAt: T1.toISOString() },
      ],
      oneDrive: { files: 2, lastSyncedAt: T1.toISOString(), state: "IDLE", lastError: null },
      sharePoint: {
        enabled: true,
        granted: true,
        needsConsent: false,
        capped: 3,
        libraries: [
          {
            driveId: `lib-${USER}`,
            siteName: `Site of ${USER}`,
            libraryName: `Library of ${USER}`,
            webUrl: `https://contoso.sharepoint.com/sites/${USER}`,
            followed: true,
            files: 1,
            lastSyncedAt: T1.toISOString(),
            state: "IDLE",
            lastError: null,
          },
        ],
      },
    });
  });

  it("says nothing is registered for a person with no connection", async () => {
    const res = await get(makeFakeM365World([]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workloads: [],
      oneDrive: null,
      sharePoint: { enabled: false, granted: false, needsConsent: false, capped: 0, libraries: [] },
    });
  });

  it("is the person's own: nothing of anybody else's appears, and no query can change whose it is", async () => {
    // Mutation: drop `userId` from any read and the other person's library,
    // their file counts and their names are on this person's card.
    const w = populated();
    const res = await get(w).query({ userId: OTHER });
    expect(JSON.stringify(res.body)).not.toContain(OTHER);
    expect(res.body.sharePoint.libraries).toHaveLength(1);
    expect(res.body.oneDrive.files).toBe(2);
  });

  it("never carries a delta link, a resume checkpoint or a token", async () => {
    const w = populated();
    w.cursors.rows.forEach((r) => {
      r.deltaLink = "https://graph.example/v1.0/me/drive/root/delta?token=LINKSECRET";
      r.resumeLink = "https://graph.example/v1.0/me/drive/root/delta?$skiptoken=RESUMESECRET";
      r.lastError = "GET https://graph.example/delta?token=ERRSECRET failed";
      r.state = "BACKOFF";
    });
    const res = await get(w);
    expect(JSON.stringify(res.body)).not.toMatch(/LINKSECRET|RESUMESECRET|ERRSECRET|deltaLink|resumeLink/);
  });

  it("answers 500 m365_sync_status_unavailable instead of hanging, without echoing the error", async () => {
    const w = populated();
    w.cursors.delegate.findMany.mockRejectedValueOnce(new Error("could not reach postgres with password hunter2"));
    const res = await get(w);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "m365_sync_status_unavailable" });
  });

  it("is allowed to owner, admin and family and closed to guests and services", async () => {
    for (const role of ["owner", "admin", "family"]) expect((await get(populated(), { id: USER, role })).status, role).toBe(200);
    for (const role of ["guest", "service"]) expect((await get(populated(), { id: USER, role })).status, role).toBe(403);
    expect((await get(populated(), { role: "owner" })).status).toBe(401);
  });
});
