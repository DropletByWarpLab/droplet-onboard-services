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
