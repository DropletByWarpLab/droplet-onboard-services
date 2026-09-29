/**
 * ADR-055 (P4a) — /api/doors.
 *
 * The real `requireRole` runs (a stub would let a wrong allowlist pass) against the real service and a stubbed Prisma. The
 * module gates — the box toggle and the per-person `doors` grant — are mounted
 * by `mountModuleGates` off the registry prefix; doors-negative-suite.test.ts
 * drives them, since this file mounts the router alone.
 *
 * WHO, the load-bearing part: reads are owner and admin; writes are the owner
 * ALONE; no route admits a service principal — the assistant has no doors
 * surface in P4a, and can never change a door (§11.4, §11.5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import { createTransactionSeam } from "./helpers/prisma-tx-harness.js";

const recordActivity = vi.fn(async (..._args: unknown[]) => null);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => recordActivity(...args),
  recordActivityInTx: vi.fn(),
  getActivityRecorder: () => null,
}));

import { createDoorsRouter } from "../routes/doors.js";
import { formatEventCursor } from "../services/doors.service.js";

type Principal = "owner" | "admin" | "family" | "guest" | "mcp" | "voice" | null;

const USERS = {
  owner: { id: "u-owner", username: "olive", displayName: "Olive", role: "owner" },
  admin: { id: "u-admin", username: "adam", displayName: "Adam", role: "admin" },
  family: { id: "u-family", username: "fran", displayName: "Fran", role: "family" },
  guest: { id: "u-guest", username: "gus", displayName: "Gus", role: "guest" },
  mcp: { id: "_service:mcp", username: "_service:mcp", displayName: "mcp", role: "service" },
  voice: { id: "_service:voice", username: "_service:voice", displayName: "voice", role: "service" },
} as const;

const DOOR_ID = "6f0d5d4e-2b1c-4f7a-9d6e-0a1b2c3d4e5f";

function doorRow(over: Record<string, unknown> = {}) {
  return {
    id: DOOR_ID,
    name: "Front door",
    doorPositionSource: "lock",
    heldOpenSeconds: 30,
    status: "active",
    retiredAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

const prisma = {
  accessPoint: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  accessEvent: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: undefined as unknown,
};
prisma.$transaction = createTransactionSeam({ client: () => prisma }).$transaction;

function app(principal: Principal = "owner") {
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    if (principal !== null) (req as Request & { user?: unknown }).user = USERS[principal];
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.use("/api", createDoorsRouter(prisma as any, { now: () => new Date("2026-09-29T03:00:00Z") }));
  return server;
}

/** Door-change audit rows only: a refused request is itself audited by the role guard (WARP-237), which is not what these assert. */
function doorAudits(): unknown[] {
  return recordActivity.mock.calls.filter((c) => (c[0] as { refs?: { surface?: string } })?.refs?.surface === "doors");
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.accessPoint.findMany.mockResolvedValue([doorRow()]);
  prisma.accessPoint.findUnique.mockResolvedValue(doorRow());
  prisma.accessPoint.create.mockImplementation(async (a: { data: Record<string, unknown> }) => doorRow(a.data));
  prisma.accessPoint.updateMany.mockResolvedValue({ count: 1 });
  prisma.accessEvent.findMany.mockResolvedValue([]);
  prisma.$queryRaw.mockResolvedValue([]);
});

describe("GET /api/doors", () => {
  it.each(["owner", "admin"] as const)("%s may read", async (who) => {
    const res = await request(app(who)).get("/api/doors");
    expect(res.status).toBe(200);
    expect(res.body.doors).toHaveLength(1);
    expect(res.body.doors[0]).toMatchObject({
      id: DOOR_ID,
      name: "Front door",
      doorPositionSource: "lock",
      status: "active",
      position: "unknown",
      claims: { forcedDoor: "latch_witnessed", heldOpen: true },
    });
  });

  it("carries positionSince, and a position older than three missed heartbeats reads unknown with it (§9.7: never left at closed)", async () => {
    // The router's clock is 03:00:00Z. A lock's cutoff is 90 s.
    prisma.$queryRaw.mockResolvedValue([
      { accessPointId: DOOR_ID, kind: "door_closed", troubleCode: null, occurredAt: new Date("2026-09-29T02:58:29Z") },
    ]);
    const stale = await request(app()).get("/api/doors");
    expect(stale.body.doors[0]).toMatchObject({ position: "unknown", positionSince: "2026-09-29T02:58:29.000Z" });

    prisma.$queryRaw.mockResolvedValue([
      { accessPointId: DOOR_ID, kind: "door_closed", troubleCode: null, occurredAt: new Date("2026-09-29T02:58:31Z") },
    ]);
    const fresh = await request(app()).get("/api/doors");
    expect(fresh.body.doors[0]).toMatchObject({ position: "closed", positionSince: "2026-09-29T02:58:31.000Z" });
  });

  it.each(["family", "guest", "mcp", "voice", null] as const)("%s is refused, and nothing is read", async (who) => {
    const res = await request(app(who)).get("/api/doors");
    expect(res.status).toBe(403);
    expect(prisma.accessPoint.findMany).not.toHaveBeenCalled();
  });

  it("include=retired lists retired doors too; any other include is a 400", async () => {
    await request(app()).get("/api/doors?include=retired").expect(200);
    expect((prisma.accessPoint.findMany.mock.calls[0]![0] as { where?: unknown }).where).toBeUndefined();
    await request(app()).get("/api/doors?include=everything").expect(400);
    await request(app()).get("/api/doors?nope=1").expect(400);
  });

  it("a database failure is a 503, never an empty 200 that reads as 'no doors'", async () => {
    prisma.accessPoint.findMany.mockRejectedValue(new Error("db down"));
    const res = await request(app()).get("/api/doors");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("DOORS_UNAVAILABLE");
    expect(res.body.doors).toBeUndefined();
  });
});

describe("GET /api/doors/events", () => {
  const evRow = (id: number) => ({
    id: BigInt(id),
    accessPointId: DOOR_ID,
    accessPoint: { name: "Front door" },
    kind: "door_open",
    occurredAt: new Date(`2026-09-29T02:00:0${id}Z`),
    forcedClaim: null,
    troubleCode: null,
    derivedFromId: null,
    correlationKey: null,
  });

  it.each(["owner", "admin"] as const)("%s may read; ids come back as strings", async (who) => {
    prisma.accessEvent.findMany.mockResolvedValue([evRow(2), evRow(1)]);
    const res = await request(app(who)).get("/api/doors/events?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { id: string }) => e.id)).toEqual(["2", "1"]);
    expect(res.body.nextCursor).toBeNull();
  });

  it.each(["family", "guest", "mcp", "voice", null] as const)("%s is refused", async (who) => {
    expect((await request(app(who)).get("/api/doors/events")).status).toBe(403);
    expect(prisma.accessEvent.findMany).not.toHaveBeenCalled();
  });

  it("pages with a cursor: one row past the limit means there is more, and the cursor resumes after the last row shown", async () => {
    prisma.accessEvent.findMany.mockResolvedValue([evRow(3), evRow(2), evRow(1)]);
    const first = await request(app()).get("/api/doors/events?limit=2");
    expect(first.body.events).toHaveLength(2);
    expect(first.body.nextCursor).toBe(formatEventCursor(new Date("2026-09-29T02:00:02Z"), 2n));

    prisma.accessEvent.findMany.mockClear();
    await request(app()).get(`/api/doors/events?limit=2&cursor=${first.body.nextCursor}&door=${DOOR_ID}`).expect(200);
    const where = (prisma.accessEvent.findMany.mock.calls[0]![0] as { where: { AND: unknown[] } }).where;
    expect(where.AND).toHaveLength(2);
  });

  it.each([
    "limit=0",
    "limit=201",
    "limit=abc",
    "limit=1.5",
    "cursor=nonsense",
    "cursor=12345678901234567890_1",
    "door=not-a-uuid",
    "kind=door_open",
  ])("rejects %s with a 400 and reads nothing", async (qs) => {
    const res = await request(app()).get(`/api/doors/events?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prisma.accessEvent.findMany).not.toHaveBeenCalled();
  });

  it("a database failure is a 503, never an empty page", async () => {
    prisma.accessEvent.findMany.mockRejectedValue(new Error("db down"));
    const res = await request(app()).get("/api/doors/events");
    expect(res.status).toBe(503);
    expect(res.body.events).toBeUndefined();
  });
});

describe("POST /api/doors — owner only (§11.4)", () => {
  const body = { name: "Front door", doorPositionSource: "lock" };

  it("the owner creates a door: 201, defaults applied, audited", async () => {
    const res = await request(app("owner")).post("/api/doors").send(body);
    expect(res.status).toBe(201);
    expect(res.body.door).toMatchObject({ name: "Front door", doorPositionSource: "lock", heldOpenSeconds: 30 });
    expect(prisma.accessPoint.create).toHaveBeenCalledTimes(1);
    expect(doorAudits()).toHaveLength(1);
  });

  it.each(["admin", "family", "guest", "mcp", "voice", null] as const)(
    "%s is refused — door authority does not inherit the rank ladder — and nothing is written",
    async (who) => {
      const res = await request(app(who)).post("/api/doors").send(body);
      expect(res.status).toBe(403);
      expect(prisma.accessPoint.create).not.toHaveBeenCalled();
      expect(doorAudits()).toEqual([]);
    },
  );

  it.each<[unknown, string]>([
    [{}, "empty"],
    [{ name: "Front" }, "no source"],
    [{ name: "Front", doorPositionSource: "wall" }, "unknown source"],
    [{ name: "Front", doorPositionSource: "NONE" }, "case-changed source"],
    [{ name: "Front", doorPositionSource: "lock", heldOpenSeconds: 4 }, "held-open under 5 s"],
    [{ name: "Front", doorPositionSource: "lock", heldOpenSeconds: 3601 }, "held-open over an hour"],
    [{ name: "Front", doorPositionSource: "lock", heldOpenSeconds: 30.5 }, "fractional held-open"],
    [{ name: "Front", doorPositionSource: "lock", heldOpenSeconds: "30" }, "string held-open"],
    [{ name: "Front", doorPositionSource: "lock", status: "retired" }, "smuggled status"],
    [{ name: "Front", doorPositionSource: "lock", id: DOOR_ID }, "smuggled id"],
    [{ name: 42, doorPositionSource: "lock" }, "numeric name"],
    [{ name: "x".repeat(241), doorPositionSource: "lock" }, "name over the raw cap"],
  ])("rejects %j (%s) with a 400 and writes nothing", async (payload: unknown, _why: string) => {
    const res = await request(app()).post("/api/doors").send(payload as object);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(prisma.accessPoint.create).not.toHaveBeenCalled();
  });

  it("refuses a name the service will not store, with its own code", async () => {
    const res = await request(app()).post("/api/doors").send({ name: "Front‮door", doorPositionSource: "lock" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_NAME");
    expect(prisma.accessPoint.create).not.toHaveBeenCalled();
  });

  it("a database failure is a 503 and the request is not reported as done", async () => {
    prisma.accessPoint.create.mockRejectedValue(new Error("db down"));
    const res = await request(app()).post("/api/doors").send(body);
    expect(res.status).toBe(503);
    expect(doorAudits()).toEqual([]);
  });
});

describe("PATCH /api/doors/:id — owner only", () => {
  it("the owner changes a door", async () => {
    prisma.accessPoint.findUnique
      .mockResolvedValueOnce(doorRow())
      .mockResolvedValueOnce(doorRow({ name: "Main entrance" }));
    const res = await request(app()).patch(`/api/doors/${DOOR_ID}`).send({ name: "Main entrance" });
    expect(res.status).toBe(200);
    expect(res.body.door.name).toBe("Main entrance");
    expect(prisma.accessPoint.updateMany).toHaveBeenCalledWith({
      where: { id: DOOR_ID, status: "active" },
      data: { name: "Main entrance" },
    });
  });

  it.each(["admin", "family", "guest", "mcp", "voice", null] as const)("%s is refused and nothing is written", async (who) => {
    const res = await request(app(who)).patch(`/api/doors/${DOOR_ID}`).send({ name: "X" });
    expect(res.status).toBe(403);
    expect(prisma.accessPoint.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["not-a-uuid", { name: "X" }],
    [DOOR_ID, {}],
    [DOOR_ID, { doorPositionSource: "wall" }],
    [DOOR_ID, { status: "retired" }],
    [DOOR_ID, { name: "X", extra: 1 }],
  ])("rejects id %j with body %j as a 400", async (id: string, payload: object) => {
    const res = await request(app()).patch(`/api/doors/${id}`).send(payload);
    expect(res.status).toBe(400);
    expect(prisma.accessPoint.updateMany).not.toHaveBeenCalled();
  });

  it("404 for a door that does not exist, 409 for a retired one", async () => {
    prisma.accessPoint.findUnique.mockResolvedValueOnce(null);
    expect((await request(app()).patch(`/api/doors/${DOOR_ID}`).send({ name: "X" })).status).toBe(404);
    prisma.accessPoint.findUnique.mockResolvedValueOnce(doorRow({ status: "retired", retiredAt: new Date() }));
    const res = await request(app()).patch(`/api/doors/${DOOR_ID}`).send({ name: "X" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DOOR_RETIRED");
  });
});

describe("POST /api/doors/:id/retire — owner only", () => {
  it("the owner retires a door", async () => {
    prisma.accessPoint.findUnique
      .mockResolvedValueOnce(doorRow())
      .mockResolvedValueOnce(doorRow({ status: "retired", retiredAt: new Date("2026-09-29T03:00:00Z") }));
    const res = await request(app()).post(`/api/doors/${DOOR_ID}/retire`).send({});
    expect(res.status).toBe(200);
    expect(res.body.door.status).toBe("retired");
    expect(prisma.accessPoint.updateMany).toHaveBeenCalledWith({
      where: { id: DOOR_ID, status: "active" },
      data: { status: "retired", retiredAt: new Date("2026-09-29T03:00:00Z") },
    });
  });

  it.each(["admin", "family", "guest", "mcp", "voice", null] as const)("%s is refused", async (who) => {
    expect((await request(app(who)).post(`/api/doors/${DOOR_ID}/retire`).send({})).status).toBe(403);
    expect(prisma.accessPoint.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed id, and 404s an unknown door", async () => {
    expect((await request(app()).post("/api/doors/nope/retire").send({})).status).toBe(400);
    prisma.accessPoint.findUnique.mockResolvedValueOnce(null);
    expect((await request(app()).post(`/api/doors/${DOOR_ID}/retire`).send({})).status).toBe(404);
  });
});

describe("no route deletes anything", () => {
  it.each(["delete", "put"] as const)("%s /api/doors/:id does not exist", async (method) => {
    const res = await request(app("owner"))[method](`/api/doors/${DOOR_ID}`).send({});
    expect(res.status).toBe(404);
    expect(prisma.accessPoint.updateMany).not.toHaveBeenCalled();
  });
});
