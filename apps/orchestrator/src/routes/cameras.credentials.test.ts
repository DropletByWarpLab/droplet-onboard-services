/**
 * WARP-3505 — "Add camera" had no way to enter camera credentials, so an
 * ONVIF-discovered camera with a non-default password could not be added.
 *
 *   POST /api/cameras/discovered/:id/credentials
 *        {username, password} for a live (`mac:`) candidate → camera-discovery
 *        re-probes with those credentials and adds the camera. Distinct
 *        failures (wrong password / locked / no stream path / unreachable) are
 *        passed through with a `code`. The password is never echoed or logged.
 *   POST /api/cameras  {name, rtspUrl, username?, password?}
 *        the manual form: credentials merged into the stream URL server-side.
 *
 * Focused harness, same shape as cameras.discovered-list.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: {
    SERVICE_SECRET: "",
    FRIGATE_URL: "http://frigate.test:5000",
    CAMERA_DISCOVERY_URL: "http://camera-discovery.test:8085",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  requireRoleOrMcpService:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));

vi.mock("../services/camera-retention-purge.service.js", () => ({
  loadCameraRetentionPolicy: vi.fn().mockResolvedValue({ clipDays: 14, eventDays: null }),
}));

const internalFetch = vi.fn();
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: (...args: unknown[]) => internalFetch(...args),
  internalBaseUrl: (url: string) => url,
}));

const getCameraCandidates = vi.fn();
const mutateLiveCandidate = vi.fn();
const submitLiveCandidateCredentials = vi.fn();
vi.mock("../services/camera-candidates.service.js", async () => {
  // macFromCandidateId is pure id parsing — the routes' dispatch logic is what's
  // under test, so keep the real implementation and fake only the I/O.
  const actual = await vi.importActual<
    typeof import("../services/camera-candidates.service.js")
  >("../services/camera-candidates.service.js");
  return {
    ...actual,
    getCameraCandidates: (...a: unknown[]) => getCameraCandidates(...a),
    mutateLiveCandidate: (...a: unknown[]) => mutateLiveCandidate(...a),
    submitLiveCandidateCredentials: (...a: unknown[]) => submitLiveCandidateCredentials(...a),
  };
});

const syncCamerasFromDb = vi.fn();
const addCamera = vi.fn();
vi.mock("../services/frigate.client.js", () => ({
  fetchSnapshot: vi.fn(),
  fetchEventThumbnail: vi.fn(),
  fetchKnownFaces: vi.fn(),
  fetchKnownPlates: vi.fn(),
  fetchFaceImage: vi.fn(),
  deleteKnownFace: vi.fn(),
  deleteFaceImage: vi.fn(),
  deleteKnownPlate: vi.fn(),
  nameKnownPlate: vi.fn(),
  regenerateEventDescription: vi.fn(),
  tagEventAsFace: vi.fn(),
  openBirdseyeStream: vi.fn(),
  openMjpegStream: vi.fn(),
  enableDetection: vi.fn(),
  disableDetection: vi.fn(),
  deleteCamera: vi.fn(),
  addCamera: (...a: unknown[]) => addCamera(...a),
  syncCamerasFromDb: (...a: unknown[]) => syncCamerasFromDb(...a),
  fetchEvents: vi.fn(),
  buildRecordingClipUrl: vi.fn(),
  buildVodMasterUrl: vi.fn(),
  buildVodSegmentUrl: vi.fn(),
  fetchHlsPlaylist: vi.fn(),
  fetchPtzCapabilities: vi.fn(),
  ptzGoToPreset: vi.fn(),
  ptzMove: vi.fn(),
  restartFrigate: vi.fn(),
}));

vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(),
  invalidateCamerasCache: vi.fn(),
  getEventsFiltered: vi.fn(),
  getRecentEvents: vi.fn(),
  getRecordings: vi.fn(),
  getRecordingsSummary: vi.fn(),
  getReviewsFiltered: vi.fn(),
  getStats: vi.fn(),
  getTimelineEntries: vi.fn(),
  searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(),
  setReviewViewed: vi.fn(),
  subscribeCameraEvents: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(true),
}));

vi.mock("../services/camera-system.service.js", () => ({
  getCameraSystemStatus: vi.fn(),
}));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));
vi.mock("../services/clips.service.js", () => ({
  exportClip: vi.fn(),
  signShareUrl: vi.fn(),
  verifyShareUrl: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncDownloadFile: vi.fn(),
}));
vi.mock("../services/camera-groups.service.js", () => ({
  listGroups: vi.fn(),
  isValidGroupName: vi.fn(),
  isValidGroupIcon: vi.fn(),
}));
vi.mock("../services/camera-pins.service.js", () => ({}));
vi.mock("../services/camera-settings.service.js", () => ({
  getCameraSettings: vi.fn(),
  updateCameraSettings: vi.fn(),
}));

import { cameraReceives } from "../__tests__/frigate-credentials.fake.js";
import { createCamerasRouter } from "./cameras.js";

const HANWHA_ID = "mac:E4:30:22:50:2A:FD";

function makePrisma() {
  return {
    camera: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([{ name: "front_door" }]),
      update: vi.fn().mockResolvedValue({ name: "old_cam" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeApp(prisma: ReturnType<typeof makePrisma>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createCamerasRouter(prisma as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  syncCamerasFromDb.mockResolvedValue([]);
});


const SECRET_PW = "s3cret!";

describe("POST /api/cameras/discovered/:id/credentials", () => {
  it("hands the credentials to camera-discovery, syncs the DB and returns accepted — without the password", async () => {
    submitLiveCandidateCredentials.mockResolvedValue({
      ok: true,
      status: 200,
      camera: { name: "xnv_c8083r", ip: "192.168.9.219", mac: "e4:30:22:50:2a:fd" },
    });
    const prisma = makePrisma();

    const res = await request(makeApp(prisma))
      .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
      .send({ username: "admin", password: SECRET_PW });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted" });
    expect(submitLiveCandidateCredentials).toHaveBeenCalledWith("E4:30:22:50:2A:FD", "admin", SECRET_PW);
    expect(syncCamerasFromDb).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PW);
  });

  it("enables the DB row by MAC, and by the name and address discovery returns — a static-IP camera has no MAC on its row (F6)", async () => {
    submitLiveCandidateCredentials.mockResolvedValue({
      ok: true,
      status: 200,
      camera: { name: "camera_192_168_9_5", ip: "192.168.9.5", mac: "ip:192.168.9.5" },
    });
    const prisma = makePrisma();

    await request(makeApp(prisma))
      .post("/api/cameras/discovered/mac:IP:192.168.9.5/credentials")
      .send({ username: "admin", password: SECRET_PW });

    expect(prisma.camera.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { macAddress: { in: ["IP:192.168.9.5", "ip:192.168.9.5"] } },
          { name: "camera_192_168_9_5" },
          { ipAddress: "192.168.9.5" },
        ],
      },
      data: { enabled: true },
    });
  });

  it("falls back to the MAC alone when an older camera-discovery returns no camera", async () => {
    submitLiveCandidateCredentials.mockResolvedValue({ ok: true, status: 200 });
    const prisma = makePrisma();

    await request(makeApp(prisma))
      .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
      .send({ username: "admin", password: SECRET_PW });

    expect(prisma.camera.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ macAddress: { in: ["E4:30:22:50:2A:FD", "e4:30:22:50:2a:fd"] } }] },
      data: { enabled: true },
    });
  });

  it.each([
    [422, "auth_failed", 422],
    [423, "locked", 423],
    [422, "no_stream_path", 422],
    [502, "unreachable", 502],
    // camera-discovery hung past the orchestrator's wait: still a coded 502 to the browser.
    [504, "timeout", 502],
  ])("passes upstream %i / %s through with its code so the dashboard can say what is wrong", async (status, code, expected) => {
    submitLiveCandidateCredentials.mockResolvedValue({
      ok: false,
      status,
      code,
      message: "Operator-facing prose.",
    });

    const res = await request(makeApp(makePrisma()))
      .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
      .send({ username: "admin", password: SECRET_PW });

    expect(res.status).toBe(expected);
    expect(res.body).toEqual({ error: "Operator-facing prose.", code });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PW);
  });

  it("normalises an upstream 5xx to 502 and does not touch the DB on failure", async () => {
    submitLiveCandidateCredentials.mockResolvedValue({ ok: false, status: 500, message: "Failed to add camera to Frigate" });
    const prisma = makePrisma();

    const res = await request(makeApp(prisma))
      .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
      .send({ username: "admin", password: SECRET_PW });

    expect(res.status).toBe(502);
    expect(prisma.camera.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ username: "admin" }],
    [{ password: SECRET_PW }],
    [{ username: "", password: SECRET_PW }],
    [{ username: "   ", password: SECRET_PW }],
    [{ username: "ad\r\nmin", password: SECRET_PW }],
    [{ username: "ad:min", password: SECRET_PW }],
    [{ username: "admin", password: "pw\r\nCSeq: 9" }],
    [{ username: "admin", password: "bad\ud800pw" }],
    [{ username: "admin", password: "p".repeat(300) }],
    [{ username: 7, password: SECRET_PW }],
  ])("rejects an invalid body %j with 400 and a code before calling camera-discovery", async (body) => {
    const res = await request(makeApp(makePrisma()))
      .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_credentials");
    expect(submitLiveCandidateCredentials).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PW);
  });

  it.each(["has space", "brace{", "{FRIGATE_CAMERA_X_PASSWORD}"])(
    "a password Frigate cannot store (%j) is a 400 unsupported_password — before any sign-in is spent on the camera",
    async (pw) => {
      const res = await request(makeApp(makePrisma()))
        .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
        .send({ username: "admin", password: pw });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("unsupported_password");
      expect(JSON.stringify(res.body)).not.toContain(pw);
      expect(submitLiveCandidateCredentials).not.toHaveBeenCalled();
    },
  );

  it.each([[400, "unsupported_password"], [400, "unsupported_stream_address"], [422, "basic_auth_only"]] as const)(
    "passes camera-discovery %i / %s through with its code", async (status, code) => {
    submitLiveCandidateCredentials.mockResolvedValue({
      ok: false,
      status,
      code,
      message: "This camera sign-in cannot be used.",
    });
    const res = await request(makeApp(makePrisma()))
      .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
      .send({ username: "john.doe", password: SECRET_PW });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PW);
  });

  it("refuses a non-live id — only camera-discovery can probe, so a DB row has nothing to verify against", async () => {
    const res = await request(makeApp(makePrisma()))
      .post("/api/cameras/discovered/db-1/credentials")
      .send({ username: "admin", password: SECRET_PW });

    expect(res.status).toBe(400);
    expect(submitLiveCandidateCredentials).not.toHaveBeenCalled();
  });

  it("never logs the password", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      }),
    );
    const writes = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as never);
    try {
      submitLiveCandidateCredentials.mockResolvedValueOnce({ ok: false, status: 422, code: "auth_failed", message: "Rejected." });
      await request(makeApp(makePrisma()))
        .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
        .send({ username: "admin", password: SECRET_PW });
      submitLiveCandidateCredentials.mockResolvedValueOnce({ ok: true, status: 200 });
      await request(makeApp(makePrisma()))
        .post(`/api/cameras/discovered/${HANWHA_ID}/credentials`)
        .send({ username: "admin", password: SECRET_PW });
    } finally {
      spies.forEach((s) => s.mockRestore());
      writes.mockRestore();
    }
    expect(logs.join("\n")).not.toContain(SECRET_PW);
  });
});

describe("POST /api/cameras — optional username/password merged server-side", () => {
  it("embeds the credentials in the URL handed to Frigate and keeps them out of the response", async () => {
    addCamera.mockResolvedValue(true);
    const prisma = makePrisma();

    const res = await request(makeApp(prisma))
      .post("/api/cameras")
      .send({
        name: "front_door",
        rtspUrl: "rtsp://192.168.9.219:554/profile2/media.smp",
        username: "admin",
        password: SECRET_PW,
      });

    expect(res.status).toBe(200);
    expect(addCamera).toHaveBeenCalledWith(
      "front_door",
      "rtsp://admin:s3cret!@192.168.9.219:554/profile2/media.smp",
    );
    expect(JSON.stringify(res.body)).not.toContain(SECRET_PW);
    // The DB row keeps the host only — no credentials.
    expect(prisma.camera.upsert.mock.calls[0][0].create.ipAddress).toBe("192.168.9.219");
    expect(JSON.stringify(prisma.camera.upsert.mock.calls)).not.toContain(SECRET_PW);
  });

  it.each(["C@mera!2024", "Qa@2024#x", "p:ss/w?rd", "WarpLab123!", "100%sure"])(
    "Frigate is given a path that delivers %j to the camera exactly as typed",
    async (pw) => {
      addCamera.mockResolvedValue(true);
      const prisma = makePrisma();

      const res = await request(makeApp(prisma))
        .post("/api/cameras")
        .send({ name: "cam", rtspUrl: "rtsp://192.168.9.60:554/live", username: "admin", password: pw });

      expect(res.status).toBe(200);
      const stored = addCamera.mock.calls[0][1] as string;
      expect(cameraReceives(stored)).toEqual({ user: "admin", password: pw });
      // The host came from the address as typed, NOT from a string with the raw
      // password merged in (a '/', '?', '#' or '@' in it moves where a parser ends the authority).
      expect(prisma.camera.upsert.mock.calls[0][0].create.ipAddress).toBe("192.168.9.60");
    },
  );

  it("percent-encodes for a username Frigate's pattern does not match, which nothing then re-encodes", async () => {
    addCamera.mockResolvedValue(true);
    await request(makeApp(makePrisma()))
      .post("/api/cameras")
      .send({ name: "cam", rtspUrl: "rtsp://192.168.9.60/live", username: "john.doe", password: "p@ss/w:rd" });
    expect(addCamera).toHaveBeenCalledWith("cam", "rtsp://john.doe:p%40ss%2Fw%3Ard@192.168.9.60/live");
    expect(cameraReceives(addCamera.mock.calls[0][1] as string)).toEqual({ user: "john.doe", password: "p@ss/w:rd" });
  });

  it.each(["has space", "brace{", "{FRIGATE_CAMERA_X_PASSWORD}"])(
    "refuses a password Frigate cannot store (%j) with a 400 and a code, writing nothing",
    async (pw) => {
      const res = await request(makeApp(makePrisma()))
        .post("/api/cameras")
        .send({ name: "cam", rtspUrl: "rtsp://192.168.9.60/live", username: "admin", password: pw });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("unsupported_password");
      expect(JSON.stringify(res.body)).not.toContain(pw);
      expect(addCamera).not.toHaveBeenCalled();
    },
  );

  it("refuses a password that would be rewritten inside the address too, instead of storing a broken URL", async () => {
    const res = await request(makeApp(makePrisma()))
      .post("/api/cameras")
      .send({ name: "cam", rtspUrl: "rtsp://192.168.9.60/a/b", username: "admin", password: "/" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unsupported_password");
    expect(addCamera).not.toHaveBeenCalled();
  });

  it.each(["/a@b", "/live?token=a@b"])(
    "refuses a stream address Frigate would send the credentials away from: %s", async (tail) => {
      const prisma = makePrisma();
      const res = await request(makeApp(prisma))
        .post("/api/cameras")
        .send({ name: "cam", rtspUrl: `rtsp://192.168.9.60${tail}`, username: "admin", password: SECRET_PW });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("unsupported_stream_address");
      expect(JSON.stringify(res.body)).not.toContain(SECRET_PW);
      expect(addCamera).not.toHaveBeenCalled();
      expect(prisma.camera.upsert).not.toHaveBeenCalled();
    },
  );

  it("leaves a URL that already embeds credentials alone when no username is sent (back-compat)", async () => {
    addCamera.mockResolvedValue(true);
    await request(makeApp(makePrisma()))
      .post("/api/cameras")
      .send({ name: "cam", rtspUrl: "rtsp://u:p@192.168.9.60/live" });
    expect(addCamera).toHaveBeenCalledWith("cam", "rtsp://u:p@192.168.9.60/live");
  });

  it.each([
    [{ username: "ad\r\nmin", password: "x" }],
    [{ username: "admin", password: "x\ny" }],
    [{ password: "orphan" }],
    [{ username: "a".repeat(200), password: "x" }],
    [{ username: 5, password: "x" }],
    [{ username: "   ", password: "x" }], // whitespace-only username
    [{ username: "   " }],
    [{ username: "admin", password: "bad\ud800pw" }], // a lone surrogate: encodeURIComponent throws on it
    [{ username: "ad:min", password: "x" }],
  ])("rejects invalid credentials %j with 400 and a code, not a 500, before any Frigate write", async (creds) => {
    const res = await request(makeApp(makePrisma()))
      .post("/api/cameras")
      .send({ name: "cam", rtspUrl: "rtsp://192.168.9.60/live", ...creds });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_credentials");
    expect(addCamera).not.toHaveBeenCalled();
  });

  it("an empty username with an empty password is just a blank form, not an error", async () => {
    addCamera.mockResolvedValue(true);
    const res = await request(makeApp(makePrisma()))
      .post("/api/cameras")
      .send({ name: "cam", rtspUrl: "rtsp://192.168.9.60/live", username: "", password: "" });
    expect(res.status).toBe(200);
    expect(addCamera).toHaveBeenCalledWith("cam", "rtsp://192.168.9.60/live");
  });
});
