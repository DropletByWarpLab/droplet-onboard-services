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

const pinTargets = vi.hoisted(() => ({
  checkBusinessPinTarget: vi.fn(),
  resolveBusinessPinTargets: vi.fn(),
}));
vi.mock("../services/context-pin-targets.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/context-pin-targets.service.js")>()),
  checkBusinessPinTarget: pinTargets.checkBusinessPinTarget,
  resolveBusinessPinTargets: pinTargets.resolveBusinessPinTargets,
}));
vi.mock("../services/tool-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tool-access.service.js")>()),
  resolveToolAccessScope: vi.fn().mockResolvedValue(null),
}));

import { createLlmRouter } from "../routes/llm.js";
import { MAX_PINS_PER_SESSION } from "../services/context-pin-prompt.js";

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
      findFirst: vi.fn(
        async ({ where }: { where: { sessionId: string; kind?: string; ref?: string } }) =>
          pins.find(
            (p) =>
              p.sessionId === where.sessionId &&
              (where.kind === undefined || p.kind === where.kind) &&
              (where.ref === undefined || p.ref === where.ref),
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Omit<MockPin, "id" | "addedAt"> }) => {
        // The partial unique index (sessionId, kind, ref), modelled: the route's
        // idempotent branch is only reachable through this P2002.
        if (pins.some((p) => p.sessionId === data.sessionId && p.kind === data.kind && p.ref === data.ref)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
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
  pinTargets.checkBusinessPinTarget.mockResolvedValue({ ok: true });
  pinTargets.resolveBusinessPinTargets.mockResolvedValue(new Map());
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

// ── WARP-2582 (review): the business-pin branches of the route itself ───────
describe("WARP-2582 — business pins through the real route handler", () => {
  const CUSTOMER = "11111111-2222-4333-8444-555555555555";
  const owner = { id: OWNER_ID, username: OWNER_USERNAME, role: "owner" };

  it("404s module_disabled when the pin's module is switched off", async () => {
    pinTargets.checkBusinessPinTarget.mockResolvedValue({
      ok: false,
      reason: "module_disabled",
      module: "crm",
    });
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, owner))
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "customer", ref: CUSTOMER });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "crm" });
    expect(prisma.contextPin.create).not.toHaveBeenCalled();
  });

  it("422s pin_target_not_found when the record does not exist or cannot be read", async () => {
    pinTargets.checkBusinessPinTarget.mockResolvedValue({ ok: false, reason: "not_found" });
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, owner))
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "customer", ref: CUSTOMER });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "pin_target_not_found" });
    expect(prisma.contextPin.create).not.toHaveBeenCalled();
  });

  it("409s too_many_pins at the cap — for a NEW pin", async () => {
    const prisma = createPrismaMock();
    for (let i = 0; i < MAX_PINS_PER_SESSION - 1; i++) {
      prisma.pins.push({
        id: `pin-fill-${i}`,
        sessionId: OWNED_SESSION,
        kind: "folder",
        ref: `/share/fill-${i}`,
        meta: null,
        addedAt: new Date(),
      });
    }
    expect(prisma.pins.filter((p) => p.sessionId === OWNED_SESSION)).toHaveLength(MAX_PINS_PER_SESSION);
    const res = await request(buildApp(prisma, owner))
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "customer", ref: CUSTOMER });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "too_many_pins", limit: MAX_PINS_PER_SESSION });
  });

  it("re-pinning an existing record is 200 with the existing row, not 201 and not a second row", async () => {
    const prisma = createPrismaMock();
    const first = await request(buildApp(prisma, owner))
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "customer", ref: CUSTOMER });
    expect(first.status).toBe(201);
    const again = await request(buildApp(prisma, owner))
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "customer", ref: CUSTOMER });
    expect(again.status).toBe(200);
    expect(again.body.pin.id).toBe(first.body.pin.id);
    expect(prisma.pins.filter((p) => p.ref === CUSTOMER)).toHaveLength(1);
  });

  it("re-pinning an existing record at the cap is STILL 200 — the cap bounds new pins", async () => {
    const prisma = createPrismaMock();
    prisma.pins.push({
      id: "pin-customer",
      sessionId: OWNED_SESSION,
      kind: "customer",
      ref: CUSTOMER,
      meta: null,
      addedAt: new Date(),
    });
    for (let i = 0; i < MAX_PINS_PER_SESSION - 2; i++) {
      prisma.pins.push({
        id: `pin-fill-${i}`,
        sessionId: OWNED_SESSION,
        kind: "folder",
        ref: `/share/fill-${i}`,
        meta: null,
        addedAt: new Date(),
      });
    }
    expect(prisma.pins.filter((p) => p.sessionId === OWNED_SESSION)).toHaveLength(MAX_PINS_PER_SESSION);
    const res = await request(buildApp(prisma, owner))
      .post(`/api/llm/${OWNED_SESSION}/pins`)
      .send({ kind: "customer", ref: CUSTOMER });
    expect(res.status).toBe(200);
    expect(res.body.pin.id).toBe("pin-customer");
    expect(prisma.contextPin.create).not.toHaveBeenCalled();
  });

  it("GET still lists the pins when business-target resolution fails — business pins read unavailable", async () => {
    pinTargets.resolveBusinessPinTargets.mockRejectedValue(new Error("crm read timed out"));
    const prisma = createPrismaMock();
    prisma.pins.push({
      id: "pin-customer",
      sessionId: OWNED_SESSION,
      kind: "customer",
      ref: CUSTOMER,
      meta: null,
      addedAt: new Date(),
    });
    const res = await request(buildApp(prisma, owner)).get(`/api/llm/${OWNED_SESSION}/pins`);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.pins.map((p: { id: string; resolved: unknown }) => [p.id, p.resolved]));
    // The path-shaped pin is untouched by a CRM outage.
    expect(byId.get("pin-existing")).toBeNull();
    expect(byId.get("pin-customer")).toEqual({ state: "unavailable", label: null, sublabel: null });
  });
});
