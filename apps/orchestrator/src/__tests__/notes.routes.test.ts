/**
 * /api/notes — the HTTP surface.
 *
 * notes.service.test.ts covers the business logic against an in-memory prisma
 * stub. This file covers what only the route can get wrong: that the endpoints
 * are behind auth at all, that the service's `forbidden` / `note_not_found`
 * throws map to 403 / 404 instead of falling through to the 500 handler, that
 * zod rejects a no-op PATCH, and that the userId written to the row comes from
 * the session rather than the request body.
 *
 * Pattern mirrors context-pins.routes.test.ts (WARP-460) and
 * home.routes.test.ts (WARP-469): mock config, mount the router behind a
 * synthetic auth middleware, drive it with supertest. The 401 case is the one
 * exception — it mounts the REAL authMiddleware, because "is this route
 * authed" is a question a synthetic stand-in cannot answer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// authMiddleware captures its service-principal table from `config` at
// module-import time, so config must be mocked before the import below.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

import { authMiddleware } from "../middleware/auth.js";
import { createNotesRouter } from "../routes/notes.js";
import { NOTE_MAX_BODY } from "../services/notes.service.js";

const ALICE = "alice";
const BOB = "bob";

interface MockNote {
  id: string;
  userId: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock() {
  const notes: MockNote[] = [
    {
      id: "note-alice",
      userId: ALICE,
      body: "buy milk",
      pinned: false,
      createdAt: new Date("2026-08-11T10:00:00Z"),
      updatedAt: new Date("2026-08-11T10:00:00Z"),
    },
    {
      id: "note-bob",
      userId: BOB,
      body: "bob's private note",
      pinned: false,
      createdAt: new Date("2026-08-11T10:00:00Z"),
      updatedAt: new Date("2026-08-11T10:00:00Z"),
    },
  ];
  let nextId = 1;
  return {
    notes,
    note: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        notes.filter((n) => n.userId === where.userId),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          notes.find((n) => n.id === where.id) ?? null,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: { userId: string; body: string; pinned: boolean };
        }) => {
          const created: MockNote = {
            id: `note-new-${nextId++}`,
            userId: data.userId,
            body: data.body,
            pinned: data.pinned,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          notes.push(created);
          return created;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Pick<MockNote, "body" | "pinned">>;
        }) => {
          const row = notes.find((n) => n.id === where.id)!;
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = notes.findIndex((n) => n.id === where.id);
        return notes.splice(i, 1)[0]!;
      }),
    },
  };
}

/** The router behind a stand-in that has already resolved a session. */
function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  asUser: { id?: string; username?: string; role?: string },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use(
    "/api",
    createNotesRouter(prismaMock as unknown as import("@prisma/client").PrismaClient),
  );
  return app;
}

/** The router behind the PRODUCTION auth chain — no synthetic session. */
function buildAuthedApp(prismaMock: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(
    "/api",
    createNotesRouter(prismaMock as unknown as import("@prisma/client").PrismaClient),
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/notes — authentication", () => {
  // Notes are private to the person who wrote them. If any verb ever mounts
  // ahead of authMiddleware (or lands in the public-path list), an anonymous
  // LAN client reads and edits the household's notes.
  it.each([
    ["get", "/api/notes"],
    ["post", "/api/notes"],
    ["patch", "/api/notes/note-alice"],
    ["delete", "/api/notes/note-alice"],
  ] as const)("%s %s without a session → 401", async (method, path) => {
    const prisma = createPrismaMock();
    const res = await request(buildAuthedApp(prisma))[method](path).send({});
    expect(res.status).toBe(401);
    expect(prisma.note.findMany).not.toHaveBeenCalled();
    expect(prisma.note.findUnique).not.toHaveBeenCalled();
  });
});

describe("/api/notes — listing", () => {
  it("returns only the caller's own notes", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" })).get(
      "/api/notes",
    );
    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: MockNote) => n.id)).toEqual(["note-alice"]);
  });
});

describe("/api/notes — ownership", () => {
  it("alice cannot PATCH bob's note → 403, and the row is untouched", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" }))
      .patch("/api/notes/note-bob")
      .send({ body: "owned" });
    expect(res.status).toBe(403);
    expect(prisma.note.update).not.toHaveBeenCalled();
    expect(prisma.notes.find((n) => n.id === "note-bob")!.body).toBe(
      "bob's private note",
    );
  });

  it("alice cannot DELETE bob's note → 403, and the row survives", async () => {
    const prisma = createPrismaMock();
    const res = await request(
      buildApp(prisma, { username: ALICE, role: "family" }),
    ).delete("/api/notes/note-bob");
    expect(res.status).toBe(403);
    expect(prisma.note.delete).not.toHaveBeenCalled();
    expect(prisma.notes.find((n) => n.id === "note-bob")).toBeDefined();
  });

  it("an owner is not exempt — the note belongs to whoever wrote it", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "owner" }))
      .patch("/api/notes/note-bob")
      .send({ pinned: true });
    expect(res.status).toBe(403);
  });
});

describe("/api/notes — unknown ids", () => {
  it("PATCH an id that doesn't exist → 404", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" }))
      .patch("/api/notes/no-such-note")
      .send({ body: "hello" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("note_not_found");
  });

  it("DELETE an id that doesn't exist → 404", async () => {
    const prisma = createPrismaMock();
    const res = await request(
      buildApp(prisma, { username: ALICE, role: "family" }),
    ).delete("/api/notes/no-such-note");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("note_not_found");
  });
});

describe("/api/notes — request validation", () => {
  it("PATCH with neither body nor pinned → 400, no write", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" }))
      .patch("/api/notes/note-alice")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(prisma.note.update).not.toHaveBeenCalled();
  });

  it("PATCH ignores unknown fields but still needs a real one", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" }))
      .patch("/api/notes/note-alice")
      .send({ colour: "blue" });
    expect(res.status).toBe(400);
  });

  it("POST rejects a body past NOTE_MAX_BODY → 400", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" }))
      .post("/api/notes")
      .send({ body: "x".repeat(NOTE_MAX_BODY + 1) });
    expect(res.status).toBe(400);
    expect(prisma.note.create).not.toHaveBeenCalled();
  });

  it("POST accepts a body exactly at NOTE_MAX_BODY", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" }))
      .post("/api/notes")
      .send({ body: "x".repeat(NOTE_MAX_BODY) });
    expect(res.status).toBe(201);
  });
});

describe("/api/notes — the userId comes from the session", () => {
  it("POST ignores an attacker-supplied userId in the body", async () => {
    // Mass assignment: the zod schema strips unknown keys and the service is
    // handed getUser(req), so a note can only ever be written as the caller.
    // If this regresses, one household member can plant notes in another's
    // account — which, since the list filters on userId, they'd never see
    // coming.
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { username: ALICE, role: "family" }))
      .post("/api/notes")
      .send({ body: "planted", userId: BOB, pinned: true });

    expect(res.status).toBe(201);
    expect(res.body.note.userId).toBe(ALICE);
    expect(prisma.note.create).toHaveBeenCalledWith({
      data: { userId: ALICE, body: "planted", pinned: true },
    });
  });

  it("GET ignores a userId in the query string", async () => {
    const prisma = createPrismaMock();
    const res = await request(
      buildApp(prisma, { username: ALICE, role: "family" }),
    ).get(`/api/notes?userId=${BOB}`);
    expect(res.status).toBe(200);
    expect(prisma.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: ALICE } }),
    );
  });

  it("a session with no username is an invariant break, not an anonymous read", async () => {
    // ORCH-007 fail-open: getUser throws rather than defaulting, so this must
    // reach the error handler — never return somebody's notes.
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, { role: "family" })).get("/api/notes");
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(prisma.note.findMany).not.toHaveBeenCalled();
  });
});
