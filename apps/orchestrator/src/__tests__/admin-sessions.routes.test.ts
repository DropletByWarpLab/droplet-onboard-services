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
 *
 * The second block below crosses the two endpoints on purpose. This page is
 * the first caller ever to feed GET /auth/sessions' output straight back into
 * POST /auth/users/:username/revoke-sessions, and the two were reading
 * different columns — the read keys off `User.username`, the revoke resolved
 * `User.nextcloudUsername`. Asserting either endpoint alone cannot see that;
 * only sending the payload's own identifier back can.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const listUserSessions = vi.fn();
const revokeAllSessions = vi.fn(async (_userId: string) => 2);

vi.mock("../services/session.service.js", async () => {
  const actual =
    await vi.importActual<typeof import("../services/session.service.js")>(
      "../services/session.service.js",
    );
  return {
    ...actual,
    listUserSessions: (...a: unknown[]) => listUserSessions(...a),
    revokeAllSessions: (...a: unknown[]) => revokeAllSessions(...(a as [string])),
  };
});

// WARP-237 — revocation is a mandatory-emit privileged action. Stubbed so the
// route's audit write doesn't reach for a database this suite doesn't have.
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

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

/** A directory row as both endpoints see it. `nextcloudUsername` is `null` for
 *  every SCIM- and SSO-provisioned account: `provisionUser` and the SSO JIT
 *  create both seed `username` from the email and never write the Nextcloud
 *  mapping key, and the schema gives it no default. */
interface DirectoryRow {
  id: string;
  username: string;
  nextcloudUsername: string | null;
  displayName: string;
  role: string;
}

/**
 * Prisma stub over a directory. `findMany` projects exactly the columns the
 * caller selected, so a test can never read a field the endpoint does not put
 * on the wire; `findUnique` matches only the key actually present in `where`,
 * the way a real unique lookup does — a row with `nextcloudUsername: null`
 * must NOT answer a `where: { nextcloudUsername }` probe.
 */
function directoryDb(rows: DirectoryRow[]) {
  return {
    user: {
      findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> } = {}) =>
        rows.map((row) =>
          Object.fromEntries(
            Object.keys(select ?? row).map((k) => [k, (row as unknown as Record<string, unknown>)[k]]),
          ),
        ),
      ),
      findUnique: vi.fn(async ({ where }: { where: Partial<DirectoryRow> }) => {
        if (where.nextcloudUsername !== undefined) {
          return rows.find((r) => r.nextcloudUsername === where.nextcloudUsername) ?? null;
        }
        if (where.username !== undefined) {
          return rows.find((r) => r.username === where.username) ?? null;
        }
        if (where.id !== undefined) return rows.find((r) => r.id === where.id) ?? null;
        return null;
      }),
    },
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
  revokeAllSessions.mockClear();
  revokeAllSessions.mockResolvedValue(2);
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

/**
 * WARP-2820 (review round 3) — the two endpoints /admin/sessions calls have to
 * agree on what names a person.
 *
 * `GET /auth/sessions` lists by local `User.username`. The revoke route it
 * feeds resolved `User.nextcloudUsername`, which is `null` on every SCIM- and
 * SSO-provisioned account. Those accounts sign in through Okta, mint sessions
 * keyed on `User.id`, and therefore appear here as genuinely live — and every
 * "Sign out everywhere" on them 404'd `USER_NOT_FOUND`, silently, for exactly
 * the population an offboarding admin reaches for this page to handle.
 */
describe("POST /api/auth/users/:username/revoke-sessions — same identifier as the list (WARP-2820)", () => {
  const DIRECTORY: DirectoryRow[] = [
    // Local/Nextcloud-mirrored: both columns carry the same handle.
    { id: "u-owner", username: "stefan", nextcloudUsername: "stefan", displayName: "Stefan", role: "owner" },
    // SSO/SCIM-provisioned: no Nextcloud mapping key at all.
    { id: "u-sso", username: "dana.chen", nextcloudUsername: null, displayName: "Dana Chen", role: "family" },
  ];

  /** Round-trip: read the roster, then send back the identifier that roster
   *  carried — the dashboard holds nothing else. */
  async function listThenRevoke(displayName: string) {
    const app = buildApp(owner, directoryDb(DIRECTORY));
    listUserSessions.mockResolvedValue([
      { role: "family", createdAt: 1_000_000, lastSeenAt: 1_000_000 },
    ]);

    const list = await request(app).get("/api/auth/sessions");
    expect(list.status).toBe(200);
    const person = list.body.users.find((u: { displayName: string }) => u.displayName === displayName);
    expect(person).toBeDefined();

    const revoked = await request(app).post(
      `/api/auth/users/${encodeURIComponent(person.username)}/revoke-sessions`,
    );
    return { person, revoked };
  }

  it("revokes an SSO/SCIM account the list showed as live (nextcloudUsername is null)", async () => {
    const { person, revoked } = await listThenRevoke("Dana Chen");

    // The payload the dashboard renders and clicks on.
    expect(person.username).toBe("dana.chen");
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: "ok", username: "dana.chen", revoked: 2 });
    expect(revokeAllSessions).toHaveBeenCalledWith("u-sso");
  });

  it("still resolves a Nextcloud-mirrored account by its mapping key (WARP-116 contract)", async () => {
    const { revoked } = await listThenRevoke("Stefan");

    expect(revoked.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith("u-owner");
  });

  it("prefers the nextcloudUsername match when one column names a different row", async () => {
    // The mapping key keeps precedence, so widening the lookup cannot change
    // the answer for any call that resolved before. Collapsing this to a single
    // `findFirst({ OR: [...] })` would make the winner ordering-dependent.
    const app = buildApp(
      owner,
      directoryDb([
        { id: "u-a", username: "shared", nextcloudUsername: null, displayName: "A", role: "family" },
        { id: "u-b", username: "other", nextcloudUsername: "shared", displayName: "B", role: "family" },
      ]),
    );

    const res = await request(app).post("/api/auth/users/shared/revoke-sessions");

    expect(res.status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith("u-b");
    expect(revokeAllSessions).not.toHaveBeenCalledWith("u-a");
  });

  it("still 404s a name that matches neither column", async () => {
    const app = buildApp(owner, directoryDb(DIRECTORY));

    const res = await request(app).post("/api/auth/users/ghost/revoke-sessions");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NOT_FOUND");
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });
});
