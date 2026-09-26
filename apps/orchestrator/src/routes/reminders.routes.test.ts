/**
 * WARP-3193 QUAL-14 — /api/reminders route contract, as a browser user.
 *
 *   - ORCH-008: PATCH and DELETE on another user's reminder answer 404 (not
 *     403, so ids cannot be enumerated) and leave the row untouched.
 *   - `due_before` is validated: garbage is a 400, never an Invalid Date
 *     handed to Prisma (which surfaced as a 500).
 *
 * Prisma is a small in-memory stub whose updateMany / deleteMany honour the
 * `{ id, userId }` where-clause the routes send.
 */
import { describe, it, expect, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createRemindersRouter } from "./reminders.js";
import type { AuthUser } from "../middleware/auth.js";

type Row = { id: string; userId: string; title: string; completedAt: Date | null };

function mkPrisma(rows: Row[]) {
  const matches = (r: Row, where: { id: string; userId: string }) =>
    r.id === where.id && r.userId === where.userId;
  return {
    rows,
    reminder: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows.filter((r) => r.userId === where.userId),
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; userId: string }; data: Partial<Row> }) => {
          const hit = rows.filter((r) => matches(r, where));
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const before = rows.length;
        const keep = rows.filter((r) => !matches(r, where));
        rows.splice(0, rows.length, ...keep);
        return { count: before - rows.length };
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        return r;
      }),
    },
  };
}

function user(username: string): AuthUser {
  return { id: `id-${username}`, username, displayName: username, role: "owner" };
}

function buildApp(as: AuthUser, prisma: ReturnType<typeof mkPrisma>) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = as;
    next();
  });
  app.use("/api", createRemindersRouter(prisma as unknown as PrismaClient));
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal" });
  });
  return app;
}

const aliceRow = (): Row => ({ id: "r-alice", userId: "alice", title: "Alice's", completedAt: null });

describe("/api/reminders ownership (ORCH-008)", () => {
  it("PATCH on another user's reminder is a 404 and changes nothing", async () => {
    const prisma = mkPrisma([aliceRow()]);
    const res = await request(buildApp(user("bob"), prisma))
      .patch("/api/reminders/r-alice")
      .send({ title: "pwned", completed: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("reminder_not_found");
    expect(prisma.rows[0]).toMatchObject({ title: "Alice's", completedAt: null });
  });

  it("DELETE on another user's reminder is a 404 and deletes nothing", async () => {
    const prisma = mkPrisma([aliceRow()]);
    const res = await request(buildApp(user("bob"), prisma)).delete("/api/reminders/r-alice");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("reminder_not_found");
    expect(prisma.rows).toHaveLength(1);
  });

  it("the owner can PATCH and DELETE their own reminder", async () => {
    const prisma = mkPrisma([aliceRow()]);
    const app = buildApp(user("alice"), prisma);
    const patched = await request(app).patch("/api/reminders/r-alice").send({ title: "renamed" });
    expect(patched.status).toBe(200);
    expect(patched.body.reminder.title).toBe("renamed");
    const deleted = await request(app).delete("/api/reminders/r-alice");
    expect(deleted.status).toBe(200);
    expect(prisma.rows).toHaveLength(0);
  });
});

describe("GET /api/reminders?due_before", () => {
  it("rejects an unparseable due_before with 400 before querying", async () => {
    const prisma = mkPrisma([aliceRow()]);
    const res = await request(buildApp(user("alice"), prisma)).get(
      "/api/reminders?due_before=garbage",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(prisma.reminder.findMany).not.toHaveBeenCalled();
  });

  it("passes a valid ISO due_before through as a Date bound", async () => {
    const prisma = mkPrisma([aliceRow()]);
    const res = await request(buildApp(user("alice"), prisma)).get(
      "/api/reminders?due_before=2026-10-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    const where = prisma.reminder.findMany.mock.calls[0][0].where as {
      dueAt?: { lte: Date };
    };
    expect(where.dueAt?.lte.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
