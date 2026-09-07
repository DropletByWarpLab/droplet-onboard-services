/**
 * WARP-2820 — GET /api/auth/sessions, the "who is signed in" surface.
 *
 * The contract worth pinning is not the happy path — it is that
 * `sessions: null` (the box could not read them) survives all the way to the
 * wire as `null`, and is never flattened into `[]`. An operator asking whether
 * a departing employee has been cut off must not be told "yes" by a Redis
 * outage, and every layer below this one already keeps the two apart.
 *
 * The deadlines are asserted too: they are policy the orchestrator owns, and a
 * dashboard that recomputed them would drift the moment the limits become
 * configurable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const listUserSessions = vi.fn();

vi.mock("../services/session.service.js", async () => {
  const actual =
    await vi.importActual<typeof import("../services/session.service.js")>(
      "../services/session.service.js",
    );
  return { ...actual, listUserSessions: (...a: unknown[]) => listUserSessions(...a) };
});

import { createProtectedAuthRouter } from "../routes/auth.js";
import type { AuthUser } from "../middleware/auth.js";

const owner: AuthUser = { id: "u-owner", username: "stefan", displayName: "S", role: "owner" };
const family: AuthUser = { id: "u-kid", username: "kid", displayName: "K", role: "family" };

const ROSTER = [
  { id: "u-owner", username: "stefan", displayName: "Stefan", role: "owner" },
  { id: "u-kid", username: "kid", displayName: "Kid", role: "family" },
];

function db() {
  return {
    user: { findMany: vi.fn(async () => ROSTER) },
  } as never;
}

function buildApp(user: AuthUser, prisma = db()) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createProtectedAuthRouter(prisma));
  return app;
}

beforeEach(() => {
  listUserSessions.mockReset();
});

describe("GET /api/auth/sessions (WARP-2820)", () => {
  it("is owner/admin only", async () => {
    listUserSessions.mockResolvedValue([]);
    expect((await request(buildApp(family)).get("/api/auth/sessions")).status).toBe(403);
  });

  it("passes `null` through as null — NOT as an empty list", async () => {
    // The whole point. `[]` here would render as "Signed out" and offer a
    // Sign-out button for sessions nobody could see.
    listUserSessions.mockResolvedValue(null);
    const res = await request(buildApp(owner)).get("/api/auth/sessions");
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    for (const u of res.body.users) expect(u.sessions).toBeNull();
  });

  it("reports an empty list for somebody genuinely signed out", async () => {
    listUserSessions.mockResolvedValue([]);
    const res = await request(buildApp(owner)).get("/api/auth/sessions");
    expect(res.body.users[0].sessions).toEqual([]);
  });

  it("computes both deadlines from the session's own role", async () => {
    // admin-class idle window is 15 min, absolute is 8 h. Computed here so the
    // dashboard never has to know either number.
    listUserSessions.mockResolvedValue([
      { role: "owner", createdAt: 1_000_000, lastSeenAt: 1_000_600 },
    ]);
    const res = await request(buildApp(owner)).get("/api/auth/sessions");
    const s = res.body.users[0].sessions[0];
    expect(s.idleDeadline).toBe(1_000_600 + 15 * 60);
    expect(s.absoluteDeadline).toBe(1_000_000 + 8 * 60 * 60);
  });

  it("uses the SESSION's role for the idle window, not the account's", async () => {
    // A family member's session gets the 60-min window even when the roster
    // row beside it is an owner. Reading the account role here would shorten
    // or lengthen the wrong clock.
    listUserSessions.mockResolvedValue([
      { role: "family", createdAt: 1_000_000, lastSeenAt: 1_000_000 },
    ]);
    const res = await request(buildApp(owner)).get("/api/auth/sessions");
    expect(res.body.users[0].sessions[0].idleDeadline).toBe(1_000_000 + 60 * 60);
  });

  it("never returns a sid", async () => {
    // An admin needs to know a session exists, not how to name it.
    listUserSessions.mockResolvedValue([
      { role: "owner", createdAt: 1_000_000, lastSeenAt: 1_000_000 },
    ]);
    const res = await request(buildApp(owner)).get("/api/auth/sessions");
    expect(JSON.stringify(res.body)).not.toContain("sid");
  });

  it("asks the session store once per person, by local User.id", async () => {
    listUserSessions.mockResolvedValue([]);
    await request(buildApp(owner)).get("/api/auth/sessions");
    expect(listUserSessions).toHaveBeenCalledTimes(2);
    expect(listUserSessions).toHaveBeenCalledWith("u-owner");
    expect(listUserSessions).toHaveBeenCalledWith("u-kid");
  });
});
