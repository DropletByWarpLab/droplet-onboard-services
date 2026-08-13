/**
 * WARP-1906 — premade conference rooms merged into GET /api/calendar/places.
 *
 * The existing suggestion mechanism (Nominatim proxy + 10-min Redis cache) is
 * EXTENDED, not replaced: matching WorkspaceLocation rows are read fresh on
 * every request and ranked AHEAD of the Nominatim results, so an admin edit
 * in Settings shows up immediately while city lookups keep their cache.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { cacheGetMock, cacheSetMock, fetchNominatimMock } = vi.hoisted(() => ({
  cacheGetMock: vi.fn(),
  cacheSetMock: vi.fn(),
  fetchNominatimMock: vi.fn(),
}));
vi.mock("../services/cache.service.js", () => ({
  cacheGet: cacheGetMock,
  cacheSet: cacheSetMock,
}));
vi.mock("../services/places.service.js", () => ({
  fetchNominatim: fetchNominatimMock,
}));
// calendar.service transitively pulls the CalDAV client + encryption — same
// stubs as calendar-meeting-url.routes.test.ts.
vi.mock("../services/caldav.client.js", () => ({
  fetchIcsFeed: vi.fn(),
  syncCalendarSource: vi.fn(),
}));
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));

import { createCalendarRouter } from "./calendar.js";

const ROOM_ROWS = [
  {
    id: "loc-1",
    building: "HQ",
    room: "Room Aurora",
    createdBy: "stefan",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "loc-2",
    building: "HQ",
    room: "Fishbowl",
    createdBy: "stefan",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const CITY = {
  name: "Aurora",
  context: "IL",
  displayName: "Aurora, Kane County, Illinois, United States",
  lat: "41.76",
  lon: "-88.32",
  type: "city",
};

function mkApp(findMany: ReturnType<typeof vi.fn>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: { username: string } }).user = {
      username: "sam",
    };
    next();
  });
  const prisma = { workspaceLocation: { findMany } };
  app.use("/api", createCalendarRouter(prisma as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(undefined);
  fetchNominatimMock.mockResolvedValue([CITY]);
});

describe("GET /api/calendar/places — premade room merge (WARP-1906)", () => {
  it("ranks a matching room AHEAD of the Nominatim results", async () => {
    const findMany = vi.fn().mockResolvedValue(ROOM_ROWS);
    const res = await request(mkApp(findMany)).get(
      "/api/calendar/places?q=aurora",
    );
    expect(res.status).toBe(200);
    expect(res.body.places).toHaveLength(2);
    expect(res.body.places[0]).toMatchObject({
      kind: "room",
      name: "Room Aurora",
      context: "HQ",
      displayName: "HQ - Room Aurora",
    });
    expect(res.body.places[1]).toMatchObject({ name: "Aurora", context: "IL" });
  });

  it("reads rooms fresh even on a Nominatim cache hit — admin edits are never stale", async () => {
    cacheGetMock.mockResolvedValue([CITY]);
    const findMany = vi.fn().mockResolvedValue(ROOM_ROWS);
    const res = await request(mkApp(findMany)).get(
      "/api/calendar/places?q=aurora",
    );
    expect(res.status).toBe(200);
    expect(fetchNominatimMock).not.toHaveBeenCalled();
    expect(res.body.places[0]).toMatchObject({ kind: "room" });
    expect(res.body.places[1]).toMatchObject({ name: "Aurora" });
  });

  it("never caches the room entries — the cache holds only the Nominatim list", async () => {
    const findMany = vi.fn().mockResolvedValue(ROOM_ROWS);
    await request(mkApp(findMany)).get("/api/calendar/places?q=aurora");
    expect(cacheSetMock).toHaveBeenCalledTimes(1);
    const cachedList = cacheSetMock.mock.calls[0][1];
    expect(cachedList).toEqual([CITY]);
  });

  it("returns Nominatim results alone when no room matches", async () => {
    const findMany = vi.fn().mockResolvedValue(ROOM_ROWS);
    const res = await request(mkApp(findMany)).get(
      "/api/calendar/places?q=paris",
    );
    expect(res.status).toBe(200);
    expect(res.body.places).toEqual([CITY]);
  });

  it("degrades to Nominatim-only when the workspace-location read fails", async () => {
    const findMany = vi.fn().mockRejectedValue(new Error("db down"));
    const res = await request(mkApp(findMany)).get(
      "/api/calendar/places?q=aurora",
    );
    expect(res.status).toBe(200);
    expect(res.body.places).toEqual([CITY]);
  });
});
