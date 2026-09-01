/**
 * WARP-460 — context-pin CRUD on /api/llm/:sessionId/pins.
 *
 * Pattern mirrors settings.routes.test.ts: mock heavy dependencies, mount
 * createLlmRouter with a synthetic auth middleware, drive endpoints via
 * supertest.
 *
 * Covered:
 *   - GET    list pins (owner)                       → 200 + array
 *   - GET    list pins (non-owner)                    → 404
 *   - POST   add pin (folder, file, camera_window)    → 201 + body
 *   - POST   add pin (invalid kind)                   → 400
 *   - DELETE pin (owner)                              → 204
 *   - DELETE pin (wrong session)                      → 404 (atomic deleteMany)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn(),
    finalizeAssistantMessage: vi.fn(),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
  })),
}));

import { createLlmRouter } from "../routes/llm.js";

const OWNER_ID = "owner-uuid";
const OWNER_USERNAME = "stefan";
const OTHER_ID = "other-uuid";
const OWNED_SESSION = "session-1";
const OTHER_SESSION = "session-2";

interface MockPin {
  id: string;
  sessionId: string;
  kind: string;
  ref: string;
  meta: unknown;
  addedAt: Date;
}

function createPrismaMock() {
  const pins: MockPin[] = [
    {
      id: "pin-existing",
      sessionId: OWNED_SESSION,
      kind: "folder",
      ref: "/share/logistics",
      meta: null,
      addedAt: new Date("2026-05-27T10:00:00Z"),
    },
  ];
  const sessions = [
    { id: OWNED_SESSION, userId: OWNER_USERNAME },
    { id: OTHER_SESSION, userId: "someone-else" },
  ];
  return {
    pins,
    sessions,
    chatSession: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId?: { in: string[] } } }) => {
          const allowed = where.userId?.in ?? [];
          const s = sessions.find(
            (x) => x.id === where.id && allowed.includes(x.userId),
          );
          return s ? { userId: s.userId } : null;
        },
      ),
    },
    contextPin: {
      findMany: vi.fn(
        async ({ where, orderBy }: { where: { sessionId: string }; orderBy?: unknown }) => {
          void orderBy;
          return pins
            .filter((p) => p.sessionId === where.sessionId)
            .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
        },
      ),
      // WARP-2582 — POST now counts the session's pins before creating one, so
      // a thread cannot accumulate an unbounded prompt block. Runs for EVERY
      // kind, not only the business ones, so this mock is required even though
      // this suite creates only folder/file/camera_window pins.
      count: vi.fn(async ({ where }: { where: { sessionId: string } }) =>
        pins.filter((p) => p.sessionId === where.sessionId).length,
      ),
      create: vi.fn(async ({ data }: { data: Omit<MockPin, "id" | "addedAt"> }) => {
        const created: MockPin = {
          id: `pin-${pins.length + 1}`,
          sessionId: data.sessionId,
          kind: data.kind,
          ref: data.ref,
          meta: data.meta ?? null,
          addedAt: new Date(),
        };
        pins.push(created);
        return created;
      }),
      deleteMany: vi.fn(
        async ({ where }: { where: { id?: string; sessionId?: string } }) => {
          const before = pins.length;
          for (let i = pins.length - 1; i >= 0; i--) {
            if (
              (!where.id || pins[i]!.id === where.id) &&
              (!where.sessionId || pins[i]!.sessionId === where.sessionId)
            ) {
              pins.splice(i, 1);
            }
          }
          return { count: before - pins.length };
        },
      ),
    },
  };
}

function buildApp(prismaMock: ReturnType<typeof createPrismaMock>, asUser: { id?: string; username?: string; role?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createLlmRouter(prismaMock as unknown as import("@prisma/client").PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-460 — context-pin CRUD", () => {
  it("GET /api/llm/:sessionId/pins returns pins for owner", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: OWNER_ID, username: OWNER_USERNAME, role: "owner" });
    const res = await request(app).get(`/api/llm/${OWNED_SESSION}/pins`);
    expect(res.status).toBe(200);
    expect(res.body.pins).toHaveLength(1);
    expect(res.body.pins[0].kind).toBe("folder");
  });

  it("GET pins on a session you don't own → 404", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: OTHER_ID, username: "nobody", role: "family" });
    const res = await request(app).get(`/api/llm/${OWNED_SESSION}/pins`);
    expect(res.status).toBe(404);
  });

  it("POST creates a pin with valid kind", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: OWNER_ID, username: OWNER_USERNAME, role: "owner" });
    const res = await request(app)
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "camera_window", ref: "dock-3", meta: { from: "06:00", to: "09:00" } });
    expect(res.status).toBe(201);
    expect(res.body.pin.kind).toBe("camera_window");
    expect(res.body.pin.ref).toBe("dock-3");
  });

  it("POST rejects invalid kind with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: OWNER_ID, username: OWNER_USERNAME, role: "owner" });
    const res = await request(app)
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "made_up", ref: "x" });
    expect(res.status).toBe(400);
  });

  it("DELETE removes the pin for the owner (atomic deleteMany)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: OWNER_ID, username: OWNER_USERNAME, role: "owner" });
    const res = await request(app).delete(`/api/llm/${OWNED_SESSION}/pins/pin-existing`);
    expect(res.status).toBe(204);
    expect(prisma.pins.find((p) => p.id === "pin-existing")).toBeUndefined();
  });

  it("DELETE with a wrong sessionId returns 404 — no cross-session delete", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { id: OWNER_ID, username: OWNER_USERNAME, role: "owner" });
    // pin-existing belongs to OWNED_SESSION but we ask through a different
    // session id that the owner *also* technically passes ownership for.
    // Ownership check loads the OTHER_SESSION which the owner does NOT own
    // (different userId) → 404 from the ownership guard.
    const res = await request(app).delete(`/api/llm/${OTHER_SESSION}/pins/pin-existing`);
    expect(res.status).toBe(404);
    // Pin still present.
    expect(prisma.pins.find((p) => p.id === "pin-existing")).toBeDefined();
  });
});
