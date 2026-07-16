/**
 * WARP-1056 — `/api/voice/profiles` + `/api/voice/enroll/*` proxy tests.
 *
 * Same harness as routes/voice.test.ts (supertest + synthetic auth +
 * mocked global fetch); Prisma is a hand stub — the router only ever
 * calls `user.findUnique` / `user.findMany` with narrow selects.
 *
 * Contract pins:
 *   * enrollment never creates a person: /voice/enroll/start 404s on an
 *     unknown user id BEFORE any upstream call;
 *   * the profile listing joins display names locally (voice-io stores
 *     only ids) and never grows an embedding field;
 *   * commit / remove leave activity rows; a failed upstream write, a
 *     cancel, or a no-op repeat delete leaves NONE;
 *   * owner/admin only — family and service principals get 403.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
}));

import { createVoiceProfilesRouter } from "./voice-profiles.js";
import { recordActivity } from "../services/activity.singleton.js";
import type { AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";

const recordActivityMock = vi.mocked(recordActivity);

const SESSION_ID = "a".repeat(32);

function mkUser(role: Role): AuthUser {
  return {
    id: `user-${role}`,
    username: `user-${role}`,
    displayName: `User ${role}`,
    role,
  };
}

/** Minimal Prisma stub: a fixed directory of local users. */
function mkPrisma(
  users: Array<{ id: string; displayName: string; username: string }>,
) {
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        byId.get(where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => byId.get(id)).filter(Boolean),
      ),
    },
  };
}

const DIRECTORY = [
  { id: "u-nadia", displayName: "Nadia", username: "nadia" },
  { id: "u-sam", displayName: "", username: "sam" },
];

function buildApp(
  user: AuthUser | null,
  prisma = mkPrisma(DIRECTORY),
): { app: express.Express; prisma: ReturnType<typeof mkPrisma> } {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createVoiceProfilesRouter(prisma as unknown as PrismaClient));
  return { app, prisma };
}

function upstreamJson(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Awaited<ReturnType<typeof fetch>>;
}

const spyOnFetch = () => vi.spyOn(globalThis, "fetch");
let fetchSpy: ReturnType<typeof spyOnFetch>;

beforeEach(() => {
  fetchSpy = spyOnFetch();
  recordActivityMock.mockClear();
});

afterEach(() => {
  fetchSpy.mockRestore();
  delete process.env.VOICE_IO_URL;
});

describe("role wall", () => {
  it.each(["family", "guest", "service"] as Role[])(
    "%s principals get 403 and no upstream call",
    async (role) => {
      const { app } = buildApp(mkUser(role));
      const res = await request(app).get("/api/voice/profiles");
      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/voice/profiles", () => {
  it("relays voice-io's listing enriched with display names (§3.3/§7.6)", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, {
        speaker_model_available: true,
        profiles: [
          {
            user_id: "u-nadia",
            enrolled_at: 100,
            updated_at: 100,
            learning: false,
            confused_with: "u-sam",
          },
          {
            user_id: "u-sam",
            enrolled_at: 200,
            updated_at: 200,
            learning: true,
            confused_with: "u-nadia",
          },
        ],
      }),
    );
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).get("/api/voice/profiles");
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/speaker/profiles",
      expect.objectContaining({ method: "GET" }),
    );
    const [nadia, sam] = res.body.profiles;
    expect(nadia.display_name).toBe("Nadia");
    // displayName empty → username fallback, same as the People rows.
    expect(sam.display_name).toBe("sam");
    expect(nadia.confused_with_name).toBe("sam");
    expect(sam.confused_with_name).toBe("Nadia");
    // The embedding never crosses (voice-io strips it; we must not add it).
    expect(JSON.stringify(res.body)).not.toContain("embedding");
  });

  it("passes an empty listing through untouched", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { speaker_model_available: false, profiles: [] }),
    );
    const { app, prisma } = buildApp(mkUser("admin"));
    const res = await request(app).get("/api/voice/profiles");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ speaker_model_available: false, profiles: [] });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).get("/api/voice/profiles");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });
});

describe("POST /api/voice/enroll/start", () => {
  it("404s an unknown person BEFORE any upstream call (never creates one)", async () => {
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app)
      .post("/api/voice/enroll/start")
      .send({ userId: "u-ghost" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("person_not_found");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed ids without touching Prisma or upstream", async () => {
    const { app, prisma } = buildApp(mkUser("owner"));
    for (const userId of ["../evil", "", 42, "x".repeat(65), undefined]) {
      const res = await request(app)
        .post("/api/voice/enroll/start")
        .send({ userId });
      expect(res.status).toBe(400);
    }
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards an existing person as user_id", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { session_id: SESSION_ID, lines_required: 4 }),
    );
    const { app } = buildApp(mkUser("admin"));
    const res = await request(app)
      .post("/api/voice/enroll/start")
      .send({ userId: "u-nadia" });
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(SESSION_ID);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/speaker/enroll/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "u-nadia" }),
      }),
    );
  });

  it("relays voice-io's 503 (model not installed) verbatim", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(503, { detail: "voice model isn't installed" }),
    );
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app)
      .post("/api/voice/enroll/start")
      .send({ userId: "u-nadia" });
    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/voice model/);
  });
});

describe("POST /api/voice/enroll/capture|verify", () => {
  it("forwards capture with an optional validated replaceIndex", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { quality: "good", captured: 2, required: 4 }),
    );
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app)
      .post("/api/voice/enroll/capture")
      .send({ sessionId: SESSION_ID, replaceIndex: 1 });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/speaker/enroll/capture",
      expect.objectContaining({
        body: JSON.stringify({ session_id: SESSION_ID, replace_index: 1 }),
      }),
    );
  });

  it("rejects bad session ids / replace indexes without an upstream call", async () => {
    const { app } = buildApp(mkUser("owner"));
    for (const body of [
      {},
      { sessionId: "short" },
      { sessionId: SESSION_ID, replaceIndex: -1 },
      { sessionId: SESSION_ID, replaceIndex: 1.5 },
    ]) {
      const res = await request(app).post("/api/voice/enroll/capture").send(body);
      expect(res.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("relays the verify words verbatim — no numeric score is added", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { quality: "good", matched: true, confidence: "high" }),
    );
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app)
      .post("/api/voice/enroll/verify")
      .send({ sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      quality: "good",
      matched: true,
      confidence: "high",
    });
  });
});

describe("POST /api/voice/enroll/commit", () => {
  it("records a named activity row on a successful save", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, {
        saved: true,
        profile: { user_id: "u-nadia", learning: false },
      }),
    );
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app)
      .post("/api/voice/enroll/commit")
      .send({ sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "system",
      severity: "ok",
      sourceIcon: "mic",
      what: "Voice profile saved",
      sub: "Voiceprint enrolled for Nadia · stored on this box only",
      refs: { surface: "voice-enrollment", userId: "u-nadia" },
      actor: { type: "user", id: "user-owner" },
    });
  });

  it("leaves NO activity row when the upstream write failed", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(400, { detail: "need 4 captured lines before saving" }),
    );
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app)
      .post("/api/voice/enroll/commit")
      .send({ sessionId: SESSION_ID });
    expect(res.status).toBe(400);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/voice/enroll/:sessionId (cancel)", () => {
  it("forwards the discard and records nothing (nothing was persisted)", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { discarded: true }));
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).delete(`/api/voice/enroll/${SESSION_ID}`);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      `http://voice-io:8086/speaker/enroll/${SESSION_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed session id", async () => {
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).delete("/api/voice/enroll/not-a-session");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/voice/profiles/:userId", () => {
  it("proxies the immediate delete and records the removal", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { deleted: true }));
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).delete("/api/voice/profiles/u-nadia");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/speaker/profiles/u-nadia",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "system",
      severity: "info",
      what: "Voice profile removed",
      sub: "Voiceprint for Nadia deleted from this box",
      refs: { surface: "voice-enrollment", userId: "u-nadia" },
    });
  });

  it("records nothing for a no-op repeat delete", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { deleted: false }));
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).delete("/api/voice/profiles/u-nadia");
    expect(res.status).toBe(200);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed user id without an upstream call", async () => {
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).delete(
      `/api/voice/profiles/${encodeURIComponent("../evil")}`,
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 503 voice_unavailable when unreachable — no activity row", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const { app } = buildApp(mkUser("owner"));
    const res = await request(app).delete("/api/voice/profiles/u-nadia");
    expect(res.status).toBe(503);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
