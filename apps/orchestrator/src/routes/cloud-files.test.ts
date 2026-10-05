/**
 * WARP-3538 (D13) — `GET /api/cloud-files`: one search over every cloud a person
 * has connected, for the person in the browser AND for the assistant's
 * `search_cloud_files` tool, which arrives as the `_service:mcp` principal and
 * acts for the person named in `X-Nextcloud-User`.
 *
 * The services underneath are the real ones — the search, the store, the column
 * crypto, `toolActingUser` and the access check — over in-memory tables that
 * EVALUATE their arguments; `requireRoleOrMcpService` is the shipped middleware.
 * What these pin:
 *
 *   - WHOSE files. The person is the session, or for the assistant the one person
 *     the header resolves to (distinct `User.id` and `User.username`, as in
 *     production). Nothing in a query can name anybody else, and a browser caller
 *     cannot borrow the header.
 *   - WHICH clouds. Only a cloud the person has CONNECTED is searched: a dead or
 *     missing connection answers 409, never somebody's stale list.
 *   - The CONTRACT the tool reads: `{ items: [{ name, isFolder, provider,
 *     location, path, webUrl, lastModifiedAt, lastModifiedBy, sizeBytes }], total }`,
 *     newest first; 400 `invalid_request` naming the fields; 409 when nothing is
 *     connected; 403 `acting_user_required` / `forbidden_tool_for_role`.
 *   - What it never says: an id, a source, a delta link, an error's text.
 *
 * The tool's own handler lives in tools-core and is tested there; the admission
 * suite (`__tests__/tools-mcp-admission.test.ts`) reads TOOL_ROUTES to prove the
 * route admits the principal. This file speaks the tool's request shape by hand
 * (`q`, `source`, `provider`, `modifiedSince`, `limit` and the stamped header).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const { effectiveAccess } = vi.hoisted(() => ({
  effectiveAccess: vi.fn(async (_userId: string): Promise<unknown> => null),
}));
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: (userId: string) => effectiveAccess(userId),
}));

import { __setColumnCryptoKeyForTest } from "../services/column-crypto.service.js";
import { upsertItem, upsertSource, type CloudFileDb } from "../services/cloud-files/cloud-file-store.service.js";
import { MAX_SEARCH_CANDIDATES } from "../services/cloud-files/cloud-file-search.service.js";
import { makeFakeM365World, type FakeM365World } from "../__tests__/helpers/fake-m365-world.js";
import type { Row } from "../__tests__/helpers/fake-table.js";
import { userDirectory, type DirectoryUser } from "../__tests__/helpers/user-directory.js";
import { isRoleGuard } from "../middleware/auth.js";
import { CLOUD_FILES_TOOL_ROUTES, createCloudFilesRouter } from "./cloud-files.js";

type FakeUser = DirectoryUser & {
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: string }> } | null;
};
const person = (over: Partial<FakeUser> & Pick<FakeUser, "id" | "username" | "role">): FakeUser => ({
  nextcloudUsername: null,
  accessRoleId: null,
  accessRole: null,
  ...over,
});

// Distinct User.id and User.username, as in production: a fake whose two agree
// cannot catch a route that keys on the wrong one.
const ALICE = person({ id: "5b0c7a4e-1f2d-4c3b-9a8e-7d6f5e4c3b2a", username: "alice", role: "owner" });
const BOB = person({ id: "1d2c3b4a-5968-4776-8a5b-4c3d2e1f0a9b", username: "bob", role: "owner" });
const KID = person({ id: "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b", username: "kid", role: "family" });
const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };

const T = (iso: string) => new Date(iso);

beforeEach(() => {
  effectiveAccess.mockReset();
  effectiveAccess.mockImplementation(async () => null);
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 9).toString("base64"));
});
afterEach(() => __setColumnCryptoKeyForTest(null));

const connection = (userId: string, state = "CONNECTED"): Row => ({ id: `conn-${userId}`, userId, state });

function build(users: FakeUser[] = [ALICE, BOB], connections: Row[] = [connection(ALICE.id), connection(BOB.id)]) {
  const w: FakeM365World = makeFakeM365World(connections);
  const user = userDirectory(users);
  const prisma = { ...w.client, user } as never;
  const cloud = w.cloud as unknown as CloudFileDb;

  /** One landed file, written the way the landing handler writes it: names sealed, ids in the clear. */
  const file = (
    owner: FakeUser,
    sourceId: string,
    externalId: string,
    name: string,
    over: Partial<Parameters<typeof upsertItem>[1]> = {},
  ) =>
    upsertItem(cloud, {
      userId: owner.id,
      provider: "M365",
      sourceId,
      externalId,
      parentExternalId: null,
      isFolder: false,
      name,
      webUrl: `https://contoso.sharepoint.com/${externalId}`,
      lastModifiedBy: "Sam Rivera",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      remoteCreatedAt: T("2026-01-01T00:00:00Z"),
      remoteModifiedAt: T("2026-10-01T00:00:00Z"),
      ...over,
    });
  const source = (owner: FakeUser, sourceId: string, kind: "ONEDRIVE" | "SHAREPOINT_LIBRARY", site: string | null, name: string) =>
    upsertSource(cloud, { userId: owner.id, provider: "M365", sourceId, kind, siteId: site ? "site-id" : null, siteName: site, name, webUrl: null, followed: false });
  return { w, prisma, user, file, source };
}

async function aliceAndBob() {
  const t = build();
  await t.source(ALICE, "od-a", "ONEDRIVE", null, "OneDrive");
  await t.source(ALICE, "lib-a", "SHAREPOINT_LIBRARY", "Front desk", "Documents");
  await t.source(BOB, "od-b", "ONEDRIVE", null, "OneDrive");
  await t.file(ALICE, "od-a", "a1", "alice budget.xlsx", { remoteModifiedAt: T("2026-10-02T00:00:00Z") });
  await t.file(ALICE, "lib-a", "a2", "alice consent form.pdf", { remoteModifiedAt: T("2026-10-03T00:00:00Z") });
  await t.file(BOB, "od-b", "b1", "bob budget.xlsx", { remoteModifiedAt: T("2026-10-04T00:00:00Z") });
  return t;
}

function app(prisma: never, user: { id?: string; username?: string; role?: string } | undefined) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (user) (req as unknown as { user?: unknown }).user = user;
    next();
  });
  server.use("/api", createCloudFilesRouter(prisma));
  return server;
}

const asAlice = { id: ALICE.id, username: "alice", role: "owner" };
const asBob = { id: BOB.id, username: "bob", role: "owner" };

describe("GET /api/cloud-files — the person in the browser", () => {
  it("answers with their files, newest first, in exactly the shape the tool and the dashboard read", async () => {
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 2,
      items: [
        {
          name: "alice consent form.pdf",
          isFolder: false,
          provider: "m365",
          location: "Front desk › Documents",
          path: "",
          webUrl: "https://contoso.sharepoint.com/a2",
          lastModifiedAt: "2026-10-03T00:00:00.000Z",
          lastModifiedBy: "Sam Rivera",
          sizeBytes: 1024,
        },
        {
          name: "alice budget.xlsx",
          isFolder: false,
          provider: "m365",
          location: "OneDrive",
          path: "",
          webUrl: "https://contoso.sharepoint.com/a1",
          lastModifiedAt: "2026-10-02T00:00:00.000Z",
          lastModifiedBy: "Sam Rivera",
          sizeBytes: 1024,
        },
      ],
    });
  });

  it("says nothing of storage: no id, no source id, no cursor, no ciphertext", async () => {
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files");
    const wire = JSON.stringify(res.body);
    for (const leaked of ["externalId", "sourceId", "userId", "nameEnc", "dcv1:", "od-a", "lib-a", "\"id\":", "deltaLink", ALICE.id]) {
      expect(wire, leaked).not.toContain(leaked);
    }
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(
        ["isFolder", "lastModifiedAt", "lastModifiedBy", "location", "name", "path", "provider", "sizeBytes", "webUrl"],
      );
    }
  });

  it("is the person's own: another person's files never appear, whatever they are called", async () => {
    // Mutation: drop `userId` from the search and Alice finds Bob's budget.
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files").query({ q: "budget" });
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(["alice budget.xlsx"]);
    const bobs = await request(app(prisma, asBob)).get("/api/cloud-files").query({ q: "budget" });
    expect(bobs.body.items.map((i: { name: string }) => i.name)).toEqual(["bob budget.xlsx"]);
  });

  it("cannot be pointed at somebody else: a user in the query is a request it does not understand", async () => {
    const { prisma } = await aliceAndBob();
    for (const query of [{ userId: BOB.id }, { user: "bob" }, { username: "bob" }]) {
      const res = await request(app(prisma, asAlice)).get("/api/cloud-files").query(query);
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
  });

  it("ignores the acting-user header from anybody but the assistant — a browser cannot borrow it", async () => {
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files").set("X-Nextcloud-User", "bob");
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(["alice consent form.pdf", "alice budget.xlsx"]);
  });

  it("filters by name (all words, any order, any case), by location, by cloud and by date", async () => {
    const { prisma } = await aliceAndBob();
    const get = (query: Record<string, string>) =>
      request(app(prisma, asAlice)).get("/api/cloud-files").query(query).then((r) => r.body.items.map((i: { name: string }) => i.name));

    expect(await get({ q: "FORM consent" })).toEqual(["alice consent form.pdf"]);
    expect(await get({ source: "onedrive" })).toEqual(["alice budget.xlsx"]);
    expect(await get({ source: "front desk" })).toEqual(["alice consent form.pdf"]);
    expect(await get({ provider: "m365" })).toHaveLength(2);
    // The modified-since moment is inclusive, and may be a date or a timestamp.
    expect(await get({ modifiedSince: "2026-10-03" })).toEqual(["alice consent form.pdf"]);
    expect(await get({ modifiedSince: "2026-10-02T00:00:00.000Z" })).toHaveLength(2);
    expect(await get({ modifiedSince: "2026-10-02T00:00:00.001Z" })).toEqual(["alice consent form.pdf"]);
    expect(await get({ q: "budget", source: "front desk" })).toEqual([]);
  });

  it("treats a blank filter as no filter — a client fills what it does not need with an empty string", async () => {
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files").query({ q: "  ", source: "", provider: "", modifiedSince: "" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it("limits to 25 by default and to at most 100, and reports how many matched in all", async () => {
    const t = build();
    await t.source(ALICE, "od-a", "ONEDRIVE", null, "OneDrive");
    for (let i = 0; i < 130; i += 1) await t.file(ALICE, "od-a", `f${i}`, `report ${i}.pdf`, { remoteModifiedAt: T(`2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`) });
    const get = (query: Record<string, string> = {}) => request(app(t.prisma, asAlice)).get("/api/cloud-files").query(query);

    const dflt = await get();
    expect(dflt.body.items).toHaveLength(25);
    expect(dflt.body.total).toBe(130);
    expect((await get({ limit: "3" })).body.items).toHaveLength(3);
    expect((await get({ limit: "100" })).body.items).toHaveLength(100);
  });

  it("answers an empty list — not an error — for a connected person with nothing matching", async () => {
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files").query({ q: "no such file" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it("builds a file's path from its folders, root excluded", async () => {
    const t = build();
    await t.source(ALICE, "od-a", "ONEDRIVE", null, "OneDrive");
    await t.file(ALICE, "od-a", "forms", "Forms", { isFolder: true, sizeBytes: null, parentExternalId: "root" });
    await t.file(ALICE, "od-a", "y2026", "2026", { isFolder: true, sizeBytes: null, parentExternalId: "forms" });
    await t.file(ALICE, "od-a", "f", "consent.pdf", { parentExternalId: "y2026" });
    const res = await request(app(t.prisma, asAlice)).get("/api/cloud-files").query({ q: "consent" });
    expect(res.body.items[0]).toMatchObject({ name: "consent.pdf", path: "Forms/2026" });
  });

  it.each([
    ["an unknown cloud", { provider: "dropbox" }, "provider"],
    ["a provider spelled as the database spells it", { provider: "M365" }, "provider"],
    ["a limit of zero", { limit: "0" }, "limit"],
    ["a limit past 100", { limit: "101" }, "limit"],
    ["a negative limit", { limit: "-1" }, "limit"],
    ["a fractional limit", { limit: "1.5" }, "limit"],
    ["a limit that is not a number", { limit: "ten" }, "limit"],
    ["a date that is not a date", { modifiedSince: "yesterday" }, "modifiedSince"],
    ["a month 13", { modifiedSince: "2026-13-01" }, "modifiedSince"],
    ["a name filter far past any name", { q: "x".repeat(201) }, "q"],
    ["a location filter far past any name", { source: "x".repeat(201) }, "source"],
  ])("answers 400 invalid_request naming the field for %s", async (_name, query, field) => {
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files").query(query);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(Object.keys(res.body.details.fieldErrors)).toEqual([field]);
  });

  it("refuses a parameter given twice — only a single value can be a filter", async () => {
    // `?q=a&q=b` arrives as an array; treating it as text is how a filter gets
    // type-confused into something it was never meant to be.
    const { prisma } = await aliceAndBob();
    const res = await request(app(prisma, asAlice)).get("/api/cloud-files?q=a&q=b");
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.details.fieldErrors)).toEqual(["q"]);
  });

  it("refuses the old M365-only filters — a stale client must hear that its filter does nothing, not get unfiltered files", async () => {
    const { prisma } = await aliceAndBob();
    for (const query of [{ site: "Front desk" }, { library: "Documents" }, { workload: "sharepoint" }]) {
      expect((await request(app(prisma, asAlice)).get("/api/cloud-files").query(query)).status, JSON.stringify(query)).toBe(400);
    }
  });
});

describe("GET /api/cloud-files — only a cloud the person has connected", () => {
  it.each(["DISCONNECTED", "PENDING_CONSENT", "NEEDS_RECONNECT", "ERROR"])(
    "answers 409 cloud_not_connected for a connection that is %s — even with files still stored",
    async (state) => {
      // A dead grant keeps its rows until a disconnect deletes them, and the
      // person may no longer be allowed to see those names: not connected is not
      // searchable.
      const t = build([ALICE], [connection(ALICE.id, state)]);
      await t.source(ALICE, "od-a", "ONEDRIVE", null, "OneDrive");
      await t.file(ALICE, "od-a", "a1", "stale.pdf");
      const res = await request(app(t.prisma, asAlice)).get("/api/cloud-files");
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("cloud_not_connected");
      expect(res.body.message).toMatch(/connect/i);
      expect(JSON.stringify(res.body)).not.toContain("stale");
    },
  );

  it("answers 409 for a person who never connected, and reads no files", async () => {
    const t = build([ALICE], []);
    const res = await request(app(t.prisma, asAlice)).get("/api/cloud-files");
    expect(res.status).toBe(409);
    expect(t.w.calls.filter((c) => c.op.startsWith("cloudFileItem."))).toEqual([]);
  });

  it("answers 409 even when only the other cloud is asked for — there is nothing connected to search", async () => {
    const t = build([ALICE], []);
    expect((await request(app(t.prisma, asAlice)).get("/api/cloud-files").query({ provider: "m365" })).status).toBe(409);
  });

  it("answers 200 and an empty list for a CONNECTED person whose first read has not landed anything yet", async () => {
    const t = build([ALICE], [connection(ALICE.id)]);
    const res = await request(app(t.prisma, asAlice)).get("/api/cloud-files");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it("never shows a file whose library was removed — what a switched-off SharePoint left behind", async () => {
    const t = build([ALICE], [connection(ALICE.id)]);
    await t.source(ALICE, "od-a", "ONEDRIVE", null, "OneDrive");
    await t.file(ALICE, "od-a", "a1", "kept.pdf");
    await t.file(ALICE, "lib-gone", "g1", "SECRET leftover from a removed library.pdf");
    const res = await request(app(t.prisma, asAlice)).get("/api/cloud-files");
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(["kept.pdf"]);
  });
});

describe("GET /api/cloud-files — a search too broad to answer", () => {
  it("answers 400 search_too_broad with the way out, and never a partial list", async () => {
    // Past the bound the search refuses rather than answer from "the first fifty
    // thousand the database returned". A 400, so the assistant's tool reports it
    // as an argument problem the model can fix by narrowing — an outage would
    // read as "try again later".
    const t = build([ALICE], [connection(ALICE.id)]);
    await t.source(ALICE, "od-a", "ONEDRIVE", null, "OneDrive");
    for (let i = 0; i <= MAX_SEARCH_CANDIDATES; i += 1) {
      t.w.item(ALICE.id, "od-a", `f${i}`);
    }
    const res = await request(app(t.prisma, asAlice)).get("/api/cloud-files").query({ q: "anything" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("search_too_broad");
    expect(res.body.message).toMatch(/narrow/i);
    expect(res.body).not.toHaveProperty("items");
  });
});

describe("GET /api/cloud-files — when it breaks", () => {
  it("answers 500 cloud_files_unavailable instead of hanging, without echoing the error", async () => {
    const t = await aliceAndBob();
    t.w.cloud.cloudFileSource.findMany.mockRejectedValueOnce(new Error("could not reach postgres with password hunter2"));
    const res = await request(app(t.prisma, asAlice)).get("/api/cloud-files");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "cloud_files_unavailable" });
  });
});

describe("GET /api/cloud-files — the roles", () => {
  it("is open to owner, admin and family, and closed to guests and to every service but the assistant", async () => {
    const t = await aliceAndBob();
    for (const role of ["owner", "admin", "family"]) {
      expect((await request(app(t.prisma, { ...asAlice, role })).get("/api/cloud-files")).status, role).toBe(200);
    }
    expect((await request(app(t.prisma, { ...asAlice, role: "guest" })).get("/api/cloud-files")).status).toBe(403);
    expect((await request(app(t.prisma, { id: "_service:voice", username: "_service:voice", role: "service" })).get("/api/cloud-files")).status).toBe(403);
  });

  it("answers 403 with no role on the session — authMiddleware is what answers 401, upstream of this router", async () => {
    const t = await aliceAndBob();
    expect((await request(app(t.prisma, undefined)).get("/api/cloud-files")).status).toBe(403);
    expect((await request(app(t.prisma, { id: ALICE.id, username: "alice" })).get("/api/cloud-files")).status).toBe(403);
  });

  it("carries a role guard that admits the assistant — the admission suite parses exactly this", () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
    const routes = (createCloudFilesRouter(build().prisma) as unknown as { stack: Layer[] }).stack.map((l) => l.route).filter(Boolean);
    expect(routes.map((r) => `${Object.keys(r!.methods)[0]} ${r!.path}`)).toEqual(["get /cloud-files"]);
    expect(routes[0]!.stack.some((l) => isRoleGuard(l.handle))).toBe(true);

    // The static admission test reads the registration as SOURCE, comments
    // stripped: the path is a literal and the guard is `requireRoleOrMcpService(`.
    const src = readFileSync(join(__dirname, "cloud-files.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(src).toMatch(/router\.get\(\s*"\/cloud-files",[\s\S]*?requireRoleOrMcpService\(/);
  });
});

describe("GET /api/cloud-files — the assistant's tool, acting for a person", () => {
  const asTool = (t: { prisma: never }, header: string | undefined, query: Record<string, string> = { limit: "25" }) => {
    const req = request(app(t.prisma, MCP)).get("/api/cloud-files").query(query);
    return header === undefined ? req : req.set("X-Nextcloud-User", header);
  };
  const names = (res: request.Response) => (res.body.items ?? []).map((i: { name: string }) => i.name);

  it("searches the files of the person the header names — by User.id (the HTTP transport) or by username (stdio)", async () => {
    const t = await aliceAndBob();
    expect(names(await asTool(t, ALICE.id))).toEqual(["alice consent form.pdf", "alice budget.xlsx"]);
    expect(names(await asTool(t, "alice"))).toEqual(["alice consent form.pdf", "alice budget.xlsx"]);
    expect(names(await asTool(t, BOB.id))).toEqual(["bob budget.xlsx"]);
  });

  it("never searches the assistant's own — nobody's — files, nor another person's", async () => {
    const t = await aliceAndBob();
    const res = await asTool(t, ALICE.id, { q: "bob" });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("speaks the tool's request: q, source, provider, modifiedSince, limit — and answers its `items`", async () => {
    const t = await aliceAndBob();
    const res = await asTool(t, ALICE.id, {
      q: "consent",
      source: "front desk",
      provider: "m365",
      modifiedSince: "2026-10-01T00:00:00.000Z",
      limit: "5",
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ name: "alice consent form.pdf", provider: "m365", location: "Front desk › Documents" });
  });

  it("answers 403 acting_user_required when it names nobody, or somebody who is not there", async () => {
    const t = await aliceAndBob();
    for (const header of [undefined, "", "   ", "mallory"]) {
      const res = await asTool(t, header);
      expect(res.status, String(header)).toBe(403);
      expect(res.body).toEqual({ error: "acting_user_required" });
    }
  });

  it("answers 403 acting_user_required for a deactivated person", async () => {
    const gone = person({ id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091", username: "gone", role: "owner", directoryStatus: "DEACTIVATED" });
    const t = build([ALICE, gone], [connection(ALICE.id), connection(gone.id)]);
    const res = await asTool(t, gone.id);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "acting_user_required" });
  });

  it("answers 403 forbidden_tool_for_role, naming the tool, for a person whose access role does not reach files", async () => {
    // Axis B: an access role limited to other domains. The route re-asks the
    // question chat asked before it dispatched the tool, of the same person.
    const ops = person({
      id: "7c6b5a49-3827-4165-9f4e-3d2c1b0a9f8e",
      username: "ops",
      role: "admin",
      accessRoleId: "role-reminders-only",
      accessRole: { toolGrants: [{ domain: "reminders", level: "use" }] },
    });
    effectiveAccess.mockImplementation(async () => ({ tier: "admin", toolDomains: ["reminders"], locks: false }));
    const t = build([ops], [connection(ops.id)]);
    const res = await asTool(t, ops.id);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden_tool_for_role", tool: "search_cloud_files" });
  });

  it("a family member may use it — searching is a read", async () => {
    const t = build([KID], [connection(KID.id)]);
    await t.source(KID, "od-k", "ONEDRIVE", null, "OneDrive");
    await t.file(KID, "od-k", "k1", "homework.docx");
    const res = await asTool(t, KID.id);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(["homework.docx"]);
  });

  it("answers 409 for a person who is not connected, exactly as for the person in the browser", async () => {
    const t = build([ALICE], []);
    const res = await asTool(t, ALICE.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cloud_not_connected");
  });

  it("answers 400 invalid_request with `details.fieldErrors`, the shape the tool reads", async () => {
    const t = await aliceAndBob();
    const res = await asTool(t, ALICE.id, { limit: "500", provider: "dropbox" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(Object.keys(res.body.details.fieldErrors).sort()).toEqual(["limit", "provider"]);
  });

  it("declares the one tool it serves, so the route re-checks exactly that tool", () => {
    expect(CLOUD_FILES_TOOL_ROUTES).toEqual({ "get /api/cloud-files": ["search_cloud_files"] });
  });
});

describe("the route is mounted", () => {
  it("app.ts mounts it under /api, below authMiddleware — the person is the session", () => {
    const src = readFileSync(join(__dirname, "..", "app.ts"), "utf8");
    const auth = src.indexOf("app.use(authMiddleware);");
    const mount = src.indexOf('app.use("/api", createCloudFilesRouter(prisma));');
    expect(auth).toBeGreaterThan(0);
    expect(mount).toBeGreaterThan(auth);
  });
});
