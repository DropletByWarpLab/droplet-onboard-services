/**
 * WARP-1036 — `/api/voice/*` proxy route tests.
 *
 * Mirrors the stt.ts / admin-rag-eval.ts posture: supertest against a
 * minimal express app with a synthetic auth middleware (same pattern as
 * rbac.test.ts), global `fetch` mocked so no real voice-io container is
 * ever needed. The 503 `voice_unavailable` contract (container absent —
 * macOS dev, or the `linux` compose profile inactive) is what the setup
 * wizard's voice step keys its auto-skip on, so it gets explicit coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

import { createVoiceRouter } from "./voice.js";
import type { AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";

function mkUser(role: Role): AuthUser {
  return {
    id: `user-${role}`,
    username: `user-${role}`,
    displayName: `User ${role}`,
    role,
  };
}

function buildApp(user: AuthUser | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createVoiceRouter());
  return app;
}

/** A `fetch` Response-shaped stub relaying JSON. */
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
});

afterEach(() => {
  fetchSpy.mockRestore();
  delete process.env.VOICE_IO_URL;
});

describe("GET /api/voice/status (WARP-1036)", () => {
  it("relays the voice-io status payload for the owner", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { state: "listening", wake_loaded: true }),
    );
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "listening", wake_loaded: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/status",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("honours VOICE_IO_URL when set", async () => {
    process.env.VOICE_IO_URL = "http://localhost:9999/";
    fetchSpy.mockResolvedValue(upstreamJson(200, { state: "listening" }));
    const res = await request(buildApp(mkUser("admin"))).get("/api/voice/status");
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:9999/voice/status",
      expect.anything(),
    );
  });

  it("answers 503 voice_unavailable when voice-io is unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/status");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });

  it("relays an upstream non-2xx verbatim (pipeline fault is NOT voice_unavailable)", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(500, { detail: "boom" }));
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/status");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "boom" });
  });
});

describe("GET /api/voice/devices (WARP-1036)", () => {
  it("proxies to voice-io /audio/devices", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { input: null, devices: [] }));
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ input: null, devices: [] });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/audio/devices",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("getaddrinfo ENOTFOUND voice-io"));
    const res = await request(buildApp(mkUser("admin"))).get("/api/voice/devices");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });
});

describe("POST /api/voice/say (WARP-1036)", () => {
  it("forwards {text} to voice-io and relays the result", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { ok: true, duration_s: 1.2 }));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/say")
      .send({ text: "Hi — I'm your Droplet" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, duration_s: 1.2 });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/say",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "Hi — I'm your Droplet" }),
      }),
    );
  });

  it("rejects a missing/empty text with 400 and never calls upstream", async () => {
    const app = buildApp(mkUser("owner"));
    for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }]) {
      const res = await request(app).post("/api/voice/say").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("empty_text");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects text over the 2000-char cap (mirrors voice-io's bound)", async () => {
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/say")
      .send({ text: "a".repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text_too_long");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/say")
      .send({ text: "hello" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });
});

describe("voice routes RBAC (owner/admin only — service principals denied)", () => {
  const DENIED: (Role | null)[] = ["family", "guest", "service", null];
  const ROUTES: { method: "get" | "post"; path: string; body?: unknown }[] = [
    { method: "get", path: "/api/voice/status" },
    { method: "get", path: "/api/voice/devices" },
    { method: "post", path: "/api/voice/say", body: { text: "hello" } },
  ];

  for (const route of ROUTES) {
    for (const role of DENIED) {
      it(`${route.method.toUpperCase()} ${route.path}: ${role ?? "no session"} → 403`, async () => {
        fetchSpy.mockResolvedValue(upstreamJson(200, {}));
        const app = buildApp(role ? mkUser(role) : null);
        const res = await request(app)
          [route.method](route.path)
          .send(route.body ?? {});
        expect(res.status).toBe(403);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    for (const role of ["owner", "admin"] as Role[]) {
      it(`${route.method.toUpperCase()} ${route.path}: ${role} → passes the guard`, async () => {
        fetchSpy.mockResolvedValue(upstreamJson(200, {}));
        const app = buildApp(mkUser(role));
        const res = await request(app)
          [route.method](route.path)
          .send(route.body ?? {});
        expect(res.status).toBe(200);
      });
    }
  }
});
