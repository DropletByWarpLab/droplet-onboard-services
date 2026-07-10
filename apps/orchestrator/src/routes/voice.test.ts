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

// WARP-1057 — the restart route audits via the activity singleton;
// mock it so assertions see the call and no recorder wiring is needed.
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
}));

import { createVoiceRouter } from "./voice.js";
import { recordActivity } from "../services/activity.singleton.js";
import type { AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";

const recordActivityMock = vi.mocked(recordActivity);

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
  recordActivityMock.mockClear();
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

describe("POST /api/voice/measure (WARP-1055)", () => {
  it("forwards {kind, seconds} to voice-io /audio/measure and relays the result", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, {
        rms_dbfs: -50.5,
        peak_dbfs: -30.2,
        duration_s: 5,
        kind: "noise_floor",
      }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/measure")
      .send({ kind: "noise_floor", seconds: 5 });
    expect(res.status).toBe(200);
    expect(res.body.rms_dbfs).toBe(-50.5);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/audio/measure",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "noise_floor", seconds: 5 }),
      }),
    );
  });

  it("omits seconds from the upstream body when not supplied (voice-io default rules)", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { rms_dbfs: -40, peak_dbfs: -20, duration_s: 5 }),
    );
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/measure")
      .send({ kind: "speech_peak" });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/audio/measure",
      expect.objectContaining({
        body: JSON.stringify({ kind: "speech_peak" }),
      }),
    );
  });

  it("rejects an invalid kind with 400 and never calls upstream", async () => {
    const app = buildApp(mkUser("owner"));
    for (const body of [{}, { kind: "loudness" }, { kind: 42 }]) {
      const res = await request(app).post("/api/voice/measure").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_kind");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects out-of-range seconds with 400 (mirrors voice-io's bound)", async () => {
    const app = buildApp(mkUser("owner"));
    for (const seconds of [0, 61, "five"]) {
      const res = await request(app)
        .post("/api/voice/measure")
        .send({ kind: "noise_floor", seconds });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_seconds");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/measure")
      .send({ kind: "noise_floor" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });
});

describe("POST /api/voice/echo-check (WARP-1055)", () => {
  it("proxies to voice-io /audio/echo-check and relays the detection", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { heard: true, tone_dbfs: -22.4, floor_dbfs: -57.1 }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/echo-check")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      heard: true,
      tone_dbfs: -22.4,
      floor_dbfs: -57.1,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/audio/echo-check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/echo-check")
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });
});

describe("GET/POST /api/voice/calibration (WARP-1055)", () => {
  it("GET proxies to voice-io /voice/calibration", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { calibrated: false }));
    const res = await request(buildApp(mkUser("owner"))).get(
      "/api/voice/calibration",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ calibrated: false });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/calibration",
      expect.objectContaining({ method: "GET" }),
    );
  });

  const APPLY_BODY = {
    input_gain: 2,
    noise_floor_dbfs: -41,
    speech_peak_dbfs: -18,
    wake_detections: 3,
    echo_ok: true,
    flags: [] as string[],
  };

  it("POST forwards the calibration payload and relays the stored record", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { ...APPLY_BODY, calibrated: true, calibrated_at: 1 }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/calibration")
      .send(APPLY_BODY);
    expect(res.status).toBe(200);
    expect(res.body.calibrated).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/calibration",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(APPLY_BODY),
      }),
    );
  });

  it("POST rejects a non-object body with 400 and never calls upstream", async () => {
    // An array parses fine under express.json's strict mode but is not
    // a calibration record — our guard must catch it before the proxy.
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/calibration")
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_calibration");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POST relays a voice-io validation rejection (422) verbatim", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(422, { detail: [{ msg: "field required" }] }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/calibration")
      .send({ echo_ok: true });
    expect(res.status).toBe(422);
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/calibration")
      .send(APPLY_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });
});

describe("POST /api/voice/restart-processor (WARP-1057)", () => {
  it("proxies to voice-io and audits the successful restart", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { ok: true, method: "xvf_host", restarted_at: 123 }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/restart-processor")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, method: "xvf_host", restarted_at: 123 });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/restart-processor",
      expect.objectContaining({ method: "POST" }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "system",
      severity: "info",
      what: "Voice processor restarted",
      refs: { surface: "voice-restart-processor", upstreamStatus: 200 },
      actor: { type: "user", id: "user-owner" },
    });
  });

  it("relays an upstream fault verbatim and audits the failure", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(503, { detail: "xvf_host REBOOT 1 failed (exit 1)" }),
    );
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/restart-processor")
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/xvf_host REBOOT 1 failed/);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "system",
      severity: "err",
      what: "Voice processor restart failed",
      refs: { upstreamStatus: 503 },
    });
  });

  it("answers 503 voice_unavailable when unreachable — audited as a failure", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/restart-processor")
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      severity: "err",
    });
  });

  it("denied roles never reach upstream nor record a restart row", async () => {
    const res = await request(buildApp(mkUser("family")))
      .post("/api/voice/restart-processor")
      .send({});
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    // requireRole records its own "Access denied" row; what must NOT
    // exist is a restart-outcome row from the handler.
    const whats = recordActivityMock.mock.calls.map((c) => c[0].what);
    expect(whats).not.toContain("Voice processor restarted");
    expect(whats).not.toContain("Voice processor restart failed");
  });
});

describe("voice routes RBAC (owner/admin only — service principals denied)", () => {
  const DENIED: (Role | null)[] = ["family", "guest", "service", null];
  const ROUTES: { method: "get" | "post"; path: string; body?: unknown }[] = [
    { method: "get", path: "/api/voice/status" },
    { method: "get", path: "/api/voice/devices" },
    { method: "post", path: "/api/voice/say", body: { text: "hello" } },
    // WARP-1055 — calibration surface rides the same guard.
    { method: "post", path: "/api/voice/measure", body: { kind: "noise_floor" } },
    { method: "post", path: "/api/voice/echo-check", body: {} },
    { method: "get", path: "/api/voice/calibration" },
    {
      method: "post",
      path: "/api/voice/calibration",
      body: {
        noise_floor_dbfs: -41,
        speech_peak_dbfs: -18,
        wake_detections: 3,
        echo_ok: true,
        flags: [],
      },
    },
    // WARP-1057 — DSP restart rides the same guard.
    { method: "post", path: "/api/voice/restart-processor", body: {} },
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
