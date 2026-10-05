/**
 * WARP-3372 — what the DATABASE holds for a calendar date.
 *
 * A due / start date is a calendar day, not an instant. The column is a
 * `DateTime`, so the day is stored as 00:00:00Z — and that has to be true
 * whatever time zone the orchestrator process runs in, which only the real
 * Prisma-to-Postgres path can prove: this reads the column back as text.
 * The API speaks `YYYY-MM-DD` in and out, and the summary's "overdue" is
 * measured against the day the caller names.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";
import { createPmNativeRouter } from "../routes/pm/native.js";
import type { AuthUser } from "../middleware/auth.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PM calendar dates against Postgres (WARP-3372)", () => {
  let prisma: PrismaClient;
  const WS = "warp3372-ws";
  const ORIGINAL_TZ = process.env.TZ;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.pmWorkspace.deleteMany({ where: { slug: WS } });
  });

  describe.each(["America/Los_Angeles", "Pacific/Auckland"])("under TZ=%s", (zone) => {
    beforeAll(() => {
      process.env.TZ = zone;
    });

    it("a date is stored as that day at 00:00:00Z and read back as YYYY-MM-DD", async () => {
      const project = await pm.createProject(prisma, null, { workspaceSlug: WS, name: "warp3372-dates", identifier: "W72T" });
      const app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        (req as Request & { user?: AuthUser }).user = { id: "u1", username: "ada", displayName: "ada", role: "owner" };
        next();
      });
      app.use("/api", createPmNativeRouter(prisma));

      const res = await request(app)
        .post(`/api/pm/projects/${project.id}/work-items`)
        .send({ name: "warp3372-dated", due_date: "2026-06-25", start_date: "2026-06-20" });
      expect(res.status).toBe(201);
      expect(res.body.work_item.dueDate).toBe("2026-06-25");
      expect(res.body.work_item.startDate).toBe("2026-06-20");

      // What Postgres holds: the day, at UTC midnight — no zone arithmetic.
      const [stored] = await prisma.$queryRawUnsafe<Array<{ due: string; start: string }>>(
        `SELECT "dueDate"::text AS due, "startDate"::text AS start FROM "PmWorkItem" WHERE "id" = $1`,
        res.body.work_item.id,
      );
      expect(stored).toEqual({ due: "2026-06-25 00:00:00", start: "2026-06-20 00:00:00" });

      const back = await request(app).get(`/api/pm/work-items/${res.body.work_item.id}`);
      expect(back.body.work_item.dueDate).toBe("2026-06-25");

      // Overdue starts the day AFTER, measured against the day the caller names.
      const overdue = async (today: string) =>
        (await request(app).get(`/api/pm/summary?workspace=${WS}&today=${today}`)).body.summary.overdue as number;
      expect(await overdue("2026-06-25")).toBe(0);
      expect(await overdue("2026-06-26")).toBe(1);
    });
  });
});
