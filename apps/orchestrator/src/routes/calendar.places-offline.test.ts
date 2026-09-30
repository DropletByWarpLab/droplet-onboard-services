/**
 * WARP-3264 — calendar place suggestions never leave the box by default.
 *
 * The online (OpenStreetMap Nominatim) leg of GET /api/calendar/places sits
 * behind the owner-only `place_lookup` off-LAN channel, default off. The
 * REAL places.service is loaded here and global fetch is spied, so "no
 * outbound request" is proven at the network seam, not at a mock of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const cacheGet = vi.fn();
vi.mock("../services/cache.service.js", () => ({
  cacheGet: (...a: unknown[]) => cacheGet(...a),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/caldav.client.js", () => ({
  fetchIcsFeed: vi.fn(),
  syncCalendarSource: vi.fn(),
}));
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));

import { createCalendarRouter } from "./calendar.js";

const fetchSpy = vi.fn();

function mkApp(
  channel: unknown,
  queryRaw = vi.fn().mockResolvedValue([]),
  rooms: Array<{ id: string; building: string; room: string }> = [
    { id: "l1", building: "HQ", room: "Room Aurora" },
  ],
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user?: { username: string } }).user = { username: "sam" };
    next();
  });
  const prisma = {
    workspaceLocation: {
      findMany: vi.fn().mockResolvedValue(rooms),
    },
    $queryRaw: queryRaw,
    offLanAllowlistChannel: {
      findUnique:
        channel instanceof Error
          ? vi.fn().mockRejectedValue(channel)
          : vi.fn().mockResolvedValue(channel),
    },
  };
  app.use("/api", createCalendarRouter(prisma as never));
  return { app, queryRaw };
}

beforeEach(() => {
  cacheGet.mockReset();
  cacheGet.mockResolvedValue(null);
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/calendar/places — place_lookup off by default (WARP-3264)", () => {
  for (const [label, channel] of [
    ["no channel row (fresh box)", null],
    ["channel present but off (the seeded default)", { key: "place_lookup", enabled: false }],
    ["channel unreadable (DB error)", new Error("db down")],
  ] as const) {
    it(`makes no outbound request: ${label}`, async () => {
      const { app } = mkApp(channel);
      const res = await request(app).get("/api/calendar/places?q=aurora");
      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(res.body.places[0]).toMatchObject({ kind: "room", displayName: "HQ - Room Aurora" });
    });
  }

  it("suggests the caller's own previously used places, deduped against rooms", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ location: "Aurora Café, 5th St" }, { location: "HQ - Room Aurora" }]);
    const { app } = mkApp(null, queryRaw);
    const res = await request(app).get("/api/calendar/places?q=aurora");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.body.places.map((p: { displayName: string }) => p.displayName)).toEqual([
      "HQ - Room Aurora",
      "Aurora Café, 5th St",
    ]);
    // Scoped to the caller's own calendar, never the whole box's.
    const [sql, ...values] = queryRaw.mock.calls[0];
    expect(values[0]).toBe("sam");
    expect(sql.join("?")).toContain('"userId" = ?');
    // Meeting links stored in `location` are never suggested as places.
    expect(sql.join("?")).toContain("^https?://");
  });

  it("escapes LIKE wildcards in the typed text", async () => {
    const { app, queryRaw } = mkApp(null);
    await request(app).get("/api/calendar/places?q=50%25_off");
    expect(queryRaw.mock.calls[0][2]).toBe("%50\\%\\_off%");
  });

  it("rooms filling the limit don't starve the caller's own places", async () => {
    const rooms = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, building: "HQ", room: `Room ${i}` }));
    const queryRaw = vi.fn().mockResolvedValue([{ location: "Room with a view café" }]);
    const { app } = mkApp(null, queryRaw, rooms);
    const res = await request(app).get("/api/calendar/places?q=room&limit=5");
    const names = res.body.places.map((p: { displayName: string }) => p.displayName);
    expect(names).toHaveLength(6);
    expect(names.at(-1)).toBe("Room with a view café");
  });

  it("never serves a cached OpenStreetMap list while the channel is off", async () => {
    cacheGet.mockResolvedValue([{ name: "Aurora, IL", context: "", displayName: "Aurora, IL", lat: "1", lon: "2", type: "city" }]);
    const { app } = mkApp(null);
    const res = await request(app).get("/api/calendar/places?q=aurora");
    expect(cacheGet).not.toHaveBeenCalled();
    expect(res.body.places.map((p: { displayName: string }) => p.displayName)).not.toContain("Aurora, IL");
  });

  it("with the channel on but OpenStreetMap unreachable, still offers the caller's places", async () => {
    fetchSpy.mockRejectedValue(new Error("ENOTFOUND"));
    const queryRaw = vi.fn().mockResolvedValue([{ location: "Aurora Café, 5th St" }]);
    const { app } = mkApp({ key: "place_lookup", enabled: true }, queryRaw);
    const res = await request(app).get("/api/calendar/places?q=aurora");
    expect(res.body.places.map((p: { displayName: string }) => p.displayName)).toEqual([
      "HQ - Room Aurora",
      "Aurora Café, 5th St",
    ]);
  });

  it("calls OpenStreetMap only once the owner turned the channel on", async () => {
    const { app } = mkApp({ key: "place_lookup", enabled: true });
    await request(app).get("/api/calendar/places?q=aurora");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("nominatim.openstreetmap.org");
  });
});
