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

// WARP-3396 — voice-io's status carries what was last SAID in the room and
// what the assistant answered. Nothing on the dashboard reads them, but the
// Voice page polls the status every second, so they sat in every open tab,
// HAR export and proxy log. The default answer drops the four fields; the
// setup wizard's voice step asks for them ("what it heard") with
// `?include=transcript`, on the same owner/admin-only route.
describe("GET /api/voice/status — the transcript stays out of the default answer (WARP-3396)", () => {
  const FULL = {
    enabled: true,
    state: "listening",
    wake_loaded: true,
    last_wake_at: 100.5,
    input_flatlined: false,
    last_transcript: "call the landlord about the lease",
    last_transcript_at: 101.2,
    last_response: "Calling the landlord now.",
    last_response_at: 103.4,
  };
  const STRIPPED = {
    enabled: true,
    state: "listening",
    wake_loaded: true,
    last_wake_at: 100.5,
    input_flatlined: false,
  };

  it.each(["owner", "admin"] as const)("a %s gets the status without the last transcript or reply", async (role) => {
    fetchSpy.mockResolvedValue(upstreamJson(200, FULL));
    const res = await request(buildApp(mkUser(role))).get("/api/voice/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(STRIPPED);
    expect(JSON.stringify(res.body)).not.toMatch(/landlord|last_transcript|last_response/);
  });

  it("the wizard's `?include=transcript` gets all four fields, and the upstream call carries no query", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, FULL));
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/status?include=transcript");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(FULL);
    expect(fetchSpy).toHaveBeenCalledWith("http://voice-io:8086/voice/status", expect.anything());
  });

  it("any other include value is the default answer", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, FULL));
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/status?include=everything");
    expect(res.body).toEqual(STRIPPED);
  });

  it("the transcript is not a way round the role floor: a member and a guest are 403 with or without it", async () => {
    for (const role of ["family", "guest"] as const) {
      for (const qs of ["", "?include=transcript"]) {
        fetchSpy.mockClear();
        const res = await request(buildApp(mkUser(role))).get(`/api/voice/status${qs}`);
        expect(res.status, `${role} ${qs}`).toBe(403);
        expect(fetchSpy).not.toHaveBeenCalled();
      }
    }
  });

  it("an upstream fault body is relayed as before (the strip touches only the four fields)", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(500, { detail: "boom" }));
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/status");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "boom" });
  });
});

describe("GET /api/voice/devices (WARP-1036)", () => {
  it("proxies to voice-io /voice/devices (WARP-3710: scored list + active pair)", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { input: null, devices: [] }));
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ input: null, devices: [] });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/devices",
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
    // WARP-1058 — a successful apply leaves a kind=voice activity row
    // with the measured values in the sub line.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      severity: "ok",
      sourceIcon: "mic",
      what: "Calibration applied",
      sub: "noise floor -41 dB · wake word 3/3",
      refs: { surface: "voice-calibration", upstreamStatus: 200 },
      actor: { type: "user", id: "user-owner" },
    });
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

  it("POST relays a voice-io validation rejection (422) verbatim — no activity row", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(422, { detail: [{ msg: "field required" }] }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/calibration")
      .send({ echo_ok: true });
    expect(res.status).toBe(422);
    // WARP-1058 — a rejected apply changed nothing on the box, so it
    // must not read as "Calibration applied" in the activity feed.
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("answers 503 voice_unavailable when unreachable — no activity row", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/calibration")
      .send(APPLY_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
    expect(recordActivityMock).not.toHaveBeenCalled();
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
      // WARP-1058: kind voice (was system) so the row lands in the
      // /voice feed's kind filter.
      kind: "voice",
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
      kind: "voice",
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

describe("POST /api/voice/mic/restart (WARP-3710)", () => {
  const OK = {
    ok: true,
    device: "reSpeaker XVF3800 (hw:3,0)",
    device_is_xvf: true,
    dsp_rebooted: false,
    dsp_error: null,
    state: "listening",
    mic_fault: null,
    restarted_at: 123,
  };

  it("forwards {} and audits a successful restart naming the device", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, OK));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/mic/restart")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(OK);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/mic/restart",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      severity: "info",
      what: "Microphone restarted",
      sub: "Now using reSpeaker XVF3800 (hw:3,0)",
      refs: { surface: "voice-mic-restart", upstreamStatus: 200 },
      actor: { type: "user", id: "user-owner" },
    });
  });

  it("forwards a strict-boolean dspReboot and notes it in the audit row", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { ...OK, dsp_rebooted: true }));
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/mic/restart")
      .send({ dspReboot: true, junk: "dropped" });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/mic/restart",
      expect.objectContaining({ body: JSON.stringify({ dspReboot: true }) }),
    );
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      sub: "Now using reSpeaker XVF3800 (hw:3,0) · DSP rebooted",
    });
  });

  it("rejects a non-boolean dspReboot before touching hardware", async () => {
    for (const bad of ["true", 1, null, {}]) {
      const res = await request(buildApp(mkUser("owner")))
        .post("/api/voice/mic/restart")
        .send({ dspReboot: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_dsp_reboot");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("relays an upstream fault verbatim and audits the failure", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(503, { detail: "No microphone came back after the restart." }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/mic/restart")
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/No microphone came back/);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      severity: "err",
      what: "Microphone restart failed",
      refs: { upstreamStatus: 503 },
    });
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/mic/restart")
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });

  it("denies every role except owner/admin and never reaches upstream", async () => {
    for (const role of ["family", "guest", "service"] as const) {
      const res = await request(buildApp(mkUser(role)))
        .post("/api/voice/mic/restart")
        .send({});
      expect(res.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    const whats = recordActivityMock.mock.calls.map((c) => c[0].what);
    expect(whats).not.toContain("Microphone restarted");
    expect(whats).not.toContain("Microphone restart failed");
  });
});

describe("POST /api/voice/mic/test (WARP-3710)", () => {
  const RESULT = {
    ok: true,
    flatlined: false,
    rms_dbfs: -38.2,
    peak_dbfs: -21.4,
    duration_s: 3,
    device: "reSpeaker XVF3800 (hw:3,0)",
    device_is_xvf: true,
    played: null,
  };

  it("forwards the validated fields and relays the result", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, RESULT));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/mic/test")
      .send({ playback: true, duration_s: 4, junk: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESULT);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/mic/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ playback: true, duration_s: 4 }),
      }),
    );
  });

  it("works with an empty body (voice-io applies its 3 s default)", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, RESULT));
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/mic/test")
      .send({});
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it("rejects a bad playback flag or duration", async () => {
    const app = buildApp(mkUser("owner"));
    for (const body of [
      { playback: "yes" },
      { duration_s: 0 },
      { duration_s: 99 },
      { duration_s: "3" },
    ]) {
      const res = await request(app).post("/api/voice/mic/test").send(body);
      expect(res.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("relays a 409 busy answer verbatim", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(409, { detail: "busy" }));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/mic/test")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ detail: "busy" });
  });

  it("answers 503 voice_unavailable when unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/mic/test")
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
  });

  it("denies non owner/admin roles", async () => {
    const res = await request(buildApp(mkUser("family")))
      .post("/api/voice/mic/test")
      .send({});
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST/DELETE /api/voice/calibration-mode (WARP-1059)", () => {
  it("POST forwards {ttl_s} to voice-io and relays the mode payload", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { active: true, expires_at: 1_800_000_060 }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/calibration-mode")
      .send({ ttl_s: 60 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: true, expires_at: 1_800_000_060 });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/calibration-mode",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ttl_s: 60 }),
      }),
    );
  });

  it("POST omits ttl_s from the upstream body when not supplied (voice-io default)", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { active: true }));
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/calibration-mode")
      .send({});
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/calibration-mode",
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it("POST rejects an out-of-bounds ttl_s with 400 and never calls upstream", async () => {
    const app = buildApp(mkUser("owner"));
    for (const ttl_s of [0, 4, 301, "sixty", NaN]) {
      const res = await request(app)
        .post("/api/voice/calibration-mode")
        .send({ ttl_s });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_ttl");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("DELETE proxies the idempotent exit", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { active: false, expires_at: null }),
    );
    const res = await request(buildApp(mkUser("owner"))).delete(
      "/api/voice/calibration-mode",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false, expires_at: null });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/calibration-mode",
      expect.objectContaining({ method: "DELETE" }),
    );
    // DELETE carries no body upstream.
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("answers 503 voice_unavailable when unreachable (both verbs)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const app = buildApp(mkUser("owner"));
    const post = await request(app)
      .post("/api/voice/calibration-mode")
      .send({ ttl_s: 60 });
    expect(post.status).toBe(503);
    expect(post.body.error).toBe("voice_unavailable");
    const del = await request(app).delete("/api/voice/calibration-mode");
    expect(del.status).toBe(503);
    expect(del.body.error).toBe("voice_unavailable");
  });
});

describe("POST /api/voice/events (WARP-1058)", () => {
  /** The exact principal authMiddleware mints for ORCHESTRATOR_TOKEN. */
  function mkVoicePrincipal(): AuthUser {
    return {
      id: "_service:voice",
      username: "_service:voice",
      displayName: "voice-io",
      role: "service" as Role,
    };
  }

  it("maps wake_answered to the §3.4 'Answered' Guest row", async () => {
    const res = await request(buildApp(mkVoicePrincipal()))
      .post("/api/voice/events")
      .send({ type: "wake_answered", score: 0.91, threshold: 0.7, model: "hey_droplet" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ recorded: false }); // mock recorder returns null
    expect(fetchSpy).not.toHaveBeenCalled(); // no proxy hop — direct record
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      severity: "info",
      sourceIcon: "mic",
      what: "Answered",
      sub: "Guest",
      refs: {
        surface: "voice-io",
        principal: "_service:voice",
        person: "Guest",
        score: 0.91,
        threshold: 0.7,
        model: "hey_droplet",
      },
      // Service principals map to the system actor (actorFromRequest).
      actor: { type: "system", id: null },
    });
  });

  it("maps wake_missed to a warn row and dsp_wedge to an err row", async () => {
    const app = buildApp(mkVoicePrincipal());
    await request(app).post("/api/voice/events").send({ type: "wake_missed" });
    await request(app).post("/api/voice/events").send({ type: "dsp_wedge" });
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      severity: "warn",
      what: "Missed wake word",
      sub: "Guest",
    });
    // DSP rows carry no person — they're §6.3 self-heal transparency.
    expect(recordActivityMock.mock.calls[1]![0]).toMatchObject({
      kind: "voice",
      severity: "err",
      what: "Mic processor stopped responding",
      sub: null,
    });
    expect(
      (recordActivityMock.mock.calls[1]![0].refs as Record<string, unknown>)
        .person,
    ).toBeUndefined();
  });

  it("honours a sane caller-supplied event time and clamps a skewed one", async () => {
    const app = buildApp(mkVoicePrincipal());
    const recentS = Math.floor(Date.now() / 1000) - 30;
    await request(app)
      .post("/api/voice/events")
      .send({ type: "wake_heard", at: recentS });
    const recentAt = recordActivityMock.mock.calls[0]![0].at as Date;
    expect(recentAt.getTime()).toBe(recentS * 1000);

    // 1970-era timestamp (skewed container clock) → clamped to now.
    await request(app).post("/api/voice/events").send({ type: "wake_heard", at: 123 });
    const clampedAt = recordActivityMock.mock.calls[1]![0].at as Date;
    expect(Math.abs(clampedAt.getTime() - Date.now())).toBeLessThan(10_000);
  });

  it("rejects an unknown event type with 400 and records nothing", async () => {
    const res = await request(buildApp(mkVoicePrincipal()))
      .post("/api/voice/events")
      .send({ type: "wake_word_stolen" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_event");
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("denies every human role, other service principals, and no-session", async () => {
    const principals: (AuthUser | null)[] = [
      mkUser("owner"),
      mkUser("admin"),
      mkUser("family"),
      mkUser("guest"),
      mkUser("service"), // coarse service role, NOT _service:voice
      null,
    ];
    for (const principal of principals) {
      const res = await request(buildApp(principal))
        .post("/api/voice/events")
        .send({ type: "wake_answered" });
      expect(res.status).toBe(403);
    }
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/voice/enabled (WARP-1599)", () => {
  it("forwards {enabled:false} and audits the switch-off with the admin-facing copy", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { enabled: false }));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/enabled")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/enabled",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      severity: "info",
      sourceIcon: "mic",
      what: "Voice turned off",
      sub: "Droplet stopped listening — the wake word is off until voice is turned back on",
      // Route-scoped surface + upstream status, like both sibling
      // writes (voice-calibration / voice-restart-processor).
      refs: { surface: "voice-enabled", upstreamStatus: 200 },
      actor: { type: "user", id: "user-owner" },
    });
  });

  it("forwards {enabled:true} and audits the switch-on with the admin-facing copy", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { enabled: true }));
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/enabled")
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/enabled",
      expect.objectContaining({ body: JSON.stringify({ enabled: true }) }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      severity: "info",
      sourceIcon: "mic",
      what: "Voice turned on",
      sub: "Droplet is listening for the wake word again",
      refs: { surface: "voice-enabled", upstreamStatus: 200 },
      actor: { type: "user", id: "user-admin" },
    });
  });

  it("rejects a missing/non-boolean enabled with 400 and never calls upstream", async () => {
    const app = buildApp(mkUser("owner"));
    for (const body of [
      {},
      { enabled: "true" },
      { enabled: "false" },
      { enabled: 1 },
      { enabled: 0 },
      { enabled: null },
    ]) {
      const res = await request(app).post("/api/voice/enabled").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_enabled");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("answers 503 voice_unavailable when unreachable — and records no toggle row", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/enabled")
      .send({ enabled: false });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("voice_unavailable");
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("relays an upstream 409 (concurrent toggle) verbatim and records no row", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(409, {
        detail: "The voice assistant is already being switched on or off",
      }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/enabled")
      .send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/already being switched on or off/);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("GET/POST /api/voice/volume (speaker output volume)", () => {
  it("GET proxies to voice-io /voice/volume and relays the state", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, { level: 70, muted: false, fault: null }),
    );
    const res = await request(buildApp(mkUser("owner"))).get("/api/voice/volume");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ level: 70, muted: false, fault: null });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/volume",
      expect.objectContaining({ method: "GET" }),
    );
    // A read leaves no activity row.
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("POST {level} forwards exactly the validated field and audits the new level", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, {
        level: 40,
        muted: false,
        fault: null,
        previous_level: 70,
        previous_muted: false,
      }),
    );
    const res = await request(buildApp(mkUser("admin")))
      .post("/api/voice/volume")
      .send({ level: 40 });
    expect(res.status).toBe(200);
    expect(res.body.level).toBe(40);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/volume",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ level: 40 }),
      }),
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      severity: "info",
      sourceIcon: "volume-2",
      what: "Volume set to 40",
      sub: "Was 70",
      refs: { surface: "voice-volume", upstreamStatus: 200 },
      actor: { type: "user", id: "user-admin" },
    });
  });

  it("POST {change} forwards the signed step and audits the resulting level", async () => {
    fetchSpy.mockResolvedValue(
      upstreamJson(200, {
        level: 60,
        muted: false,
        fault: null,
        previous_level: 50,
        previous_muted: true,
      }),
    );
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/volume")
      .send({ change: 10 });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://voice-io:8086/voice/volume",
      expect.objectContaining({ body: JSON.stringify({ change: 10 }) }),
    );
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      what: "Volume set to 60",
      // A level change on a muted speaker also unmutes it — say so.
      sub: "Was 50, muted",
    });
  });

  it("POST {muted:true} audits a mute and {muted:false} an unmute", async () => {
    const app = buildApp(mkUser("owner"));
    fetchSpy.mockResolvedValueOnce(
      upstreamJson(200, {
        level: 55,
        muted: true,
        fault: null,
        previous_level: 55,
        previous_muted: false,
      }),
    );
    await request(app).post("/api/voice/volume").send({ muted: true });
    fetchSpy.mockResolvedValueOnce(
      upstreamJson(200, {
        level: 55,
        muted: false,
        fault: null,
        previous_level: 55,
        previous_muted: true,
      }),
    );
    await request(app).post("/api/voice/volume").send({ muted: false });
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      body: JSON.stringify({ muted: true }),
    });
    expect(fetchSpy.mock.calls[1]![1]).toMatchObject({
      body: JSON.stringify({ muted: false }),
    });
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "voice",
      sourceIcon: "volume-x",
      what: "Speaker muted",
      sub: "Droplet's spoken replies are silent until the speaker is unmuted",
      refs: { surface: "voice-volume", upstreamStatus: 200 },
    });
    expect(recordActivityMock.mock.calls[1]![0]).toMatchObject({
      sourceIcon: "volume-2",
      what: "Speaker unmuted",
      sub: "Volume 55",
    });
  });

  it("rejects anything but exactly one integer level/change or boolean muted, without calling upstream", async () => {
    const app = buildApp(mkUser("owner"));
    for (const body of [
      {},
      { level: 40, muted: false },
      { level: 40, change: 10 },
      { change: 10, muted: true },
      { level: "40" },
      { level: 40.5 },
      { level: -1 },
      { level: 101 },
      { level: true },
      { level: null },
      { change: "up" },
      { change: 1.5 },
      { change: 101 },
      { change: -101 },
      { muted: "true" },
      { muted: 1 },
      { volume: 40 },
    ]) {
      const res = await request(app).post("/api/voice/volume").send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("invalid_volume");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("answers 503 voice_unavailable when unreachable — and records no row", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const app = buildApp(mkUser("owner"));
    const get = await request(app).get("/api/voice/volume");
    expect(get.status).toBe(503);
    expect(get.body.error).toBe("voice_unavailable");
    const post = await request(app).post("/api/voice/volume").send({ level: 30 });
    expect(post.status).toBe(503);
    expect(post.body.error).toBe("voice_unavailable");
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("relays a 2xx that lacks the state fields verbatim, without inventing a row", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { ok: true }));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/volume")
      .send({ level: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("relays an upstream 422 verbatim and records no row", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(422, { detail: [{ msg: "bad" }] }));
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/voice/volume")
      .send({ level: 30 });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ detail: [{ msg: "bad" }] });
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("voice routes RBAC (owner/admin only — service principals denied)", () => {
  const DENIED: (Role | null)[] = ["family", "guest", "service", null];
  const ROUTES: {
    method: "get" | "post" | "delete";
    path: string;
    body?: unknown;
  }[] = [
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
    // WARP-1059 — calibration mode rides the same guard.
    {
      method: "post",
      path: "/api/voice/calibration-mode",
      body: { ttl_s: 60 },
    },
    { method: "delete", path: "/api/voice/calibration-mode" },
    // WARP-1599 — the kill switch rides the same guard: only owner/admin
    // may silence (or un-silence) the household's assistant.
    { method: "post", path: "/api/voice/enabled", body: { enabled: true } },
    // Speaker volume rides the same guard: it drives the room speaker.
    { method: "get", path: "/api/voice/volume" },
    { method: "post", path: "/api/voice/volume", body: { level: 40 } },
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

// WARP-3625 — voice-io fails closed without a shared bearer; the proxy sends it.
describe("voice-io service bearer (WARP-3625)", () => {
  afterEach(() => {
    delete process.env.VOICE_IO_SERVICE_TOKEN;
  });

  it("sends Authorization: Bearer <VOICE_IO_SERVICE_TOKEN> upstream", async () => {
    process.env.VOICE_IO_SERVICE_TOKEN = "voice-io-secret";
    fetchSpy.mockResolvedValue(upstreamJson(200, { state: "listening" }));
    await request(buildApp(mkUser("owner"))).get("/api/voice/status");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer voice-io-secret",
    );
  });

  it("sends no Authorization header when the token is unset", async () => {
    fetchSpy.mockResolvedValue(upstreamJson(200, { state: "listening" }));
    await request(buildApp(mkUser("owner"))).get("/api/voice/status");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
