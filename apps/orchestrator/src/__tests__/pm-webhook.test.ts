/**
 * WARP-566 — Plane webhook HMAC must be computed over the raw received
 * bytes, not a re-serialized JSON representation of the parsed body.
 *
 * These tests mount the router exactly as app.ts does: `express.raw`
 * scoped to the webhook path BEFORE the global `express.json()`, so the
 * webhook handler sees a Buffer and every other route still sees parsed
 * JSON. Expected signatures are computed in-test with Node crypto over
 * the literal raw buffer to assert byte-level fidelity.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createHmac } from "node:crypto";

// Mutable mock config so individual tests can null out the secret to
// exercise the fail-CLOSED path. `vi.mock` is hoisted above the imports
// by vitest, so the router below sees the mocked config.
const mockConfig = { DROPLET_PM_WEBHOOK_SECRET: "test-webhook-secret" as string };
vi.mock("../config.js", () => ({
  get config() {
    return mockConfig;
  },
}));

// The route's per-IP rate limiter calls `cacheIncr`. Mock it so the rate-
// limit tests can drive the returned count deterministically; by default it
// returns null (Redis unavailable) which the route treats as fail-OPEN, so
// every existing signature/replay test runs unaffected.
const cacheIncrMock = vi.fn(async (): Promise<number | null> => null);
vi.mock("../services/cache.service.js", () => ({
  cacheIncr: (...args: unknown[]) => cacheIncrMock(...args),
}));

import { createPmWebhookRouter, pmWebhookBus } from "../routes/pm-webhook.js";

const WEBHOOK_PATH = "/api/pm/webhook";
const SIGNATURE_HEADER = "x-plane-signature";
const TIMESTAMP_HEADER = "x-plane-delivery-timestamp";

/**
 * Build the app the way app.ts mounts it: raw parser scoped to the
 * webhook path BEFORE the global json parser, then a probe route after
 * json() to prove non-webhook routes still get parsed objects.
 */
function buildApp() {
  const app = express();
  // Webhook gets raw bytes (mounted before json, scoped to the path).
  app.use(WEBHOOK_PATH, express.raw({ type: () => true, limit: "1mb" }));
  app.use(express.json());
  app.use(createPmWebhookRouter());
  // Probe route to confirm global json parsing is unaffected.
  app.post("/api/probe", (req, res) => {
    res.json({ parsedType: typeof req.body, body: req.body });
  });
  return app;
}

/** Sign exactly `${timestamp}.${rawBody}` over raw bytes, hex digest. */
function sign(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), raw]))
    .digest("hex");
}

describe("WARP-566 pm-webhook HMAC over raw bytes", () => {
  beforeEach(() => {
    mockConfig.DROPLET_PM_WEBHOOK_SECRET = "test-webhook-secret";
    pmWebhookBus.removeAllListeners();
    // Default: cache unavailable → cacheIncr returns null → fail-OPEN (no
    // limiting), so the signature/replay assertions below are untouched.
    cacheIncrMock.mockReset();
    cacheIncrMock.mockResolvedValue(null);
  });

  it("verifies a byte-identical signed body and emits the event", async () => {
    const app = buildApp();
    const ts = String(Date.now());
    const rawBody = '{"event":"issue","action":"created","data":{"id":"abc"}}';
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, rawBody);

    const received: unknown[] = [];
    pmWebhookBus.on("event", (e) => received.push(e));

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ event: "issue", action: "created" });
  });

  it("rejects a tampered body (one byte flipped) with the original signature", async () => {
    const app = buildApp();
    const ts = String(Date.now());
    const signedBody = '{"event":"issue","action":"created","data":{"id":"abc"}}';
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, signedBody);
    // Flip one byte: abc -> abd.
    const tamperedBody = '{"event":"issue","action":"created","data":{"id":"abd"}}';

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(tamperedBody);

    expect(res.status).toBe(401);
  });

  it("rejects the same logical JSON re-serialized with different key order/whitespace", async () => {
    // This is the regression guard. The old JSON.stringify(req.body)
    // implementation would re-serialize the parsed object to a canonical
    // form, so a signature over differently-formatted-but-equivalent
    // bytes could falsely pass. Raw-byte hashing must reject it.
    const app = buildApp();
    const ts = String(Date.now());
    // Signature is computed over THIS exact byte string...
    const signedBytes = '{"action":"created","event":"issue"}';
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, signedBytes);
    // ...but the client sends the same logical object, different bytes
    // (key order swapped + extra whitespace).
    const sentBytes = '{ "event": "issue", "action": "created" }';

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(sentBytes);

    expect(res.status).toBe(401);
  });

  it("accepts a body whose JSON.stringify round-trip differs from the raw bytes", async () => {
    // A body with non-canonical key order + whitespace. JSON.stringify of
    // the parsed object would NOT equal these raw bytes, so the old code
    // would have rejected this validly-signed event. Raw-byte hashing must
    // accept it.
    const app = buildApp();
    const ts = String(Date.now());
    const rawBody = '{ "data": {"id":1}, "event": "issue",  "action":"updated" }';
    // Sanity: confirm JSON.stringify of the parsed object diverges.
    expect(JSON.stringify(JSON.parse(rawBody))).not.toBe(rawBody);
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, rawBody);

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(204);
  });

  it("rejects a stale timestamp outside the replay window", async () => {
    const app = buildApp();
    const ts = String(Date.now() - 10 * 60 * 1000); // 10 min ago
    const rawBody = '{"event":"issue","data":{}}';
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, rawBody);

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(401);
  });

  it("fails CLOSED with 503 when the secret is not configured", async () => {
    mockConfig.DROPLET_PM_WEBHOOK_SECRET = "";
    const app = buildApp();
    const ts = String(Date.now());
    const rawBody = '{"event":"issue","data":{}}';
    // Sign with anything — should never get to the comparison.
    const sig = sign("whatever", ts, rawBody);

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(503);
  });

  it("returns 401 when the signature header is missing", async () => {
    const app = buildApp();
    const ts = String(Date.now());
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send('{"event":"issue","data":{}}');

    expect(res.status).toBe(401);
  });

  it("returns 400 (not 500) for malformed JSON after a valid signature", async () => {
    const app = buildApp();
    const ts = String(Date.now());
    const rawBody = '{"event":"issue", BROKEN';
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, rawBody);

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(400);
  });

  it("returns 400 (not 500) for a signature-valid non-object payload (literal null)", async () => {
    // WARP-566 review (stefan-cruceru, Low #1): a validly-signed body that
    // parses to a non-object (null / array / scalar) must not reach
    // `payload.event` and throw a TypeError → 500. Fail-CLOSED to 400.
    const app = buildApp();
    const ts = String(Date.now());
    const rawBody = "null";
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, rawBody);

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(400);
  });

  it("returns 400 (not 500) for a signature-valid JSON array payload", async () => {
    const app = buildApp();
    const ts = String(Date.now());
    const rawBody = "[1,2,3]";
    const sig = sign(mockConfig.DROPLET_PM_WEBHOOK_SECRET, ts, rawBody);

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(SIGNATURE_HEADER, sig)
      .set(TIMESTAMP_HEADER, ts)
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(400);
  });

  it("returns 429 when the per-IP rate limit is exceeded (before HMAC work)", async () => {
    // Count over the cap → limiter fires BEFORE the signature check, so an
    // unsigned request still 429s (proving the limiter runs first).
    cacheIncrMock.mockResolvedValue(61);
    const app = buildApp();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("Content-Type", "application/json")
      .send('{"event":"issue","data":{}}');

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("does not rate-limit a count at or below the cap", async () => {
    // Count at the cap → request proceeds; missing signature → 401 (not 429).
    cacheIncrMock.mockResolvedValue(60);
    const app = buildApp();
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set(TIMESTAMP_HEADER, String(Date.now()))
      .set("Content-Type", "application/json")
      .send('{"event":"issue","data":{}}');

    expect(res.status).toBe(401);
  });

  it("leaves non-webhook routes receiving parsed JSON objects", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/probe")
      .set("Content-Type", "application/json")
      .send({ hello: "world" });

    expect(res.status).toBe(200);
    expect(res.body.parsedType).toBe("object");
    expect(res.body.body).toEqual({ hello: "world" });
  });
});
