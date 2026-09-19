/**
 * CodeQL js/type-confusion-through-parameter-tampering — `?rate=` on
 * POST /api/stt is read as a string, but `?rate=16000&rate=8000` reaches
 * Express as an array. That must be a 400, never coerced
 * (`String(["16000","8000"])` → "16000,8000" → parseInt → 16000).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));
vi.mock("../services/stt.client.js", () => ({
  transcribePcm: vi.fn(async () => "hello"),
  SttUnavailableError: class SttUnavailableError extends Error {},
}));

import { transcribePcm } from "../services/stt.client.js";
import { createSttRouter } from "../routes/stt.js";

const mockTranscribe = vi.mocked(transcribePcm);
/** 20 ms of 16 kHz int16 mono silence — enough to pass the empty check. */
const PCM = Buffer.alloc(640);

function makeApp() {
  const app = express();
  // Mirrors app.ts, which mounts express.json() ahead of the STT router — so
  // a JSON request reaches the route with req.body already parsed, not raw.
  app.use(express.json({ type: ["application/json", "application/scim+json"] }));
  app.use("/api", createSttRouter());
  return app;
}

function post(path: string) {
  return request(makeApp())
    .post(path)
    .set("Content-Type", "application/octet-stream")
    .send(PCM);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/stt — ?rate= parsing", () => {
  it("passes a single numeric rate through to the transcriber", async () => {
    const res = await post("/api/stt?rate=48000");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "hello" });
    expect(mockTranscribe).toHaveBeenCalledWith(expect.objectContaining({ rate: 48000 }));
  });

  it("defaults to 16000 when the parameter is absent", async () => {
    const res = await post("/api/stt");
    expect(res.status).toBe(200);
    expect(mockTranscribe).toHaveBeenCalledWith(expect.objectContaining({ rate: 16000 }));
  });

  it("400s a repeated ?rate= (array) instead of coercing it", async () => {
    const res = await post("/api/stt?rate=16000&rate=8000");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_rate" });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("400s a non-numeric or out-of-range rate", async () => {
    for (const q of ["rate=fast", "rate=4000", "rate=96000"]) {
      const res = await post(`/api/stt?${q}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_rate" });
    }
    expect(mockTranscribe).not.toHaveBeenCalled();
  });
});

/**
 * WARP-2873: express.json() runs first for a JSON content-type, so req.body
 * can be a string or an array by the time the route sees it. Both must 400
 * — and CodeQL needs the string/array test to be the guard that says so.
 */
describe("POST /api/stt — non-Buffer bodies", () => {
  function postJson(payload: unknown) {
    return request(makeApp())
      .post("/api/stt")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(payload));
  }

  it("400s a string body", async () => {
    // express.json() is strict (objects/arrays only), so a bare string can
    // only arrive from another parser — set it directly to pin the route's
    // own guard rather than whichever middleware produced it.
    const app = express();
    app.use((req, _res, next) => {
      req.body = "not audio";
      // body-parser's own flag: express.raw() leaves an already-parsed body
      // alone, which is exactly how express.json() wins in app.ts.
      (req as unknown as { _body: boolean })._body = true;
      next();
    });
    app.use("/api", createSttRouter());
    const res = await request(app)
      .post("/api/stt")
      .set("Content-Type", "application/octet-stream")
      .send(PCM);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "empty_audio" });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("400s a JSON array body", async () => {
    const res = await postJson([1, 2, 3]);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "empty_audio" });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("400s a body shorter than one sample", async () => {
    const res = await request(makeApp())
      .post("/api/stt")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(1));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "empty_audio" });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("still passes a real PCM buffer through to the transcriber", async () => {
    const res = await post("/api/stt");
    expect(res.status).toBe(200);
    expect(mockTranscribe).toHaveBeenCalledWith(
      expect.objectContaining({ pcm: PCM, rate: 16000 }),
    );
  });
});
