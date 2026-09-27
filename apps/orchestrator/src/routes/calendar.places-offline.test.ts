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

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
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

function mkApp(channel: unknown, eventFindMany = vi.fn().mockResolvedValue([])) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user?: { username: string } }).user = { username: "sam" };
    next();
  });
  const prisma = {
    workspaceLocation: {
      findMany: vi.fn().mockResolvedValue([
        { id: "l1", building: "HQ", room: "Room Aurora" },
      ]),
    },
    calendarEvent: { findMany: eventFindMany },
    offLanAllowlistChannel: {
      findUnique:
        channel instanceof Error
          ? vi.fn().mockRejectedValue(channel)
          : vi.fn().mockResolvedValue(channel),
    },
  };
  app.use("/api", createCalendarRouter(prisma as never));
  return { app, eventFindMany };
}

beforeEach(() => {
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
    const eventFindMany = vi
      .fn()
      .mockResolvedValue([{ location: "Aurora Café, 5th St" }, { location: "HQ - Room Aurora" }]);
    const { app } = mkApp(null, eventFindMany);
    const res = await request(app).get("/api/calendar/places?q=aurora");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.body.places.map((p: { displayName: string }) => p.displayName)).toEqual([
      "HQ - Room Aurora",
      "Aurora Café, 5th St",
    ]);
    // Scoped to the caller's own calendar, never the whole box's.
    expect(eventFindMany.mock.calls[0][0].where.userId).toBe("sam");
  });

  it("calls OpenStreetMap only once the owner turned the channel on", async () => {
    const { app } = mkApp({ key: "place_lookup", enabled: true });
    await request(app).get("/api/calendar/places?q=aurora");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("nominatim.openstreetmap.org");
  });
});
