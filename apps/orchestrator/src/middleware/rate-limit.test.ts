import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createRateLimit } from "./rate-limit.js";

describe("rate-limit middleware", () => {
  it("answers 429 with the API error envelope once the window budget is spent", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.get("/t", createRateLimit("test-a", { windowMs: 60_000, limit: 2 }), (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/t").expect(200);
    await request(app).get("/t").expect(200);
    const res = await request(app).get("/t").expect(429);
    expect(res.body).toEqual({ error: "Too many requests, slow down" });
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("keys the window on the client IP, not the route", async () => {
    const app = express();
    app.set("trust proxy", 1);
    const limiter = createRateLimit("test-b", { windowMs: 60_000, limit: 1 });
    app.get("/a", limiter, (_req, res) => res.json({ ok: true }));
    app.get("/b", limiter, (_req, res) => res.json({ ok: true }));

    await request(app).get("/a").set("X-Forwarded-For", "10.0.0.1").expect(200);
    await request(app).get("/b").set("X-Forwarded-For", "10.0.0.1").expect(429);
    await request(app).get("/b").set("X-Forwarded-For", "10.0.0.2").expect(200);
  });

  it("does not 500 when req.ip is undefined", async () => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { value: undefined });
      next();
    });
    app.get("/t", createRateLimit("test-c", { windowMs: 60_000, limit: 1 }), (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/t").expect(200);
    await request(app).get("/t").expect(429);
  });
});
