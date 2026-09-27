/**
 * WARP-3122 part 2 — signed recordings-segment URLs.
 *
 * Runs the REAL authMiddleware and the REAL per-camera guard behind the
 * signature router, so the test proves a signature only ever stands in for
 * the bearer and never skips a gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-at-least-32-chars-long-aaa",
    NODE_ENV: "test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./jwt.service.js", () => ({
  verifyAccessToken: vi.fn((t: string) =>
    t === "good-bearer"
      ? { sub: "u-bearer", username: "bearer", displayName: "Bearer", role: "owner" }
      : null,
  ),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
}));

import { authMiddleware } from "../middleware/auth.js";
import { requireCameraAccess } from "./camera-access.service.js";
import {
  createSignedSegmentRouter,
  segmentSignatureTtlSec,
  signSegmentQuery,
} from "./segment-url-signing.service.js";
import { cacheGet } from "./cache.service.js";

process.env.DEVICE_SECRET = "segment-signing-test-secret";

type U = { id: string; username: string; displayName: string; role: string; directoryStatus: string; accessRoleId: string | null };
const users = new Map<string, U>();
const grants = new Map<string, string[]>();
const prisma = {
  user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null) },
  cameraAccessGrant: {
    findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
      (grants.get(where.userId) ?? []).map((name) => ({ camera: { name } })),
    ),
  },
} as never;

function makeApp() {
  const app = express();
  app.use("/api", createSignedSegmentRouter(prisma));
  app.use(authMiddleware);
  // Mounted like the real cameras router, so the guard sees `/cameras/:name…`.
  const cameras = express.Router();
  cameras.get("/cameras/:name/playback.segment", requireCameraAccess(prisma), (req, res) => {
    res.json({ user: req.user?.id });
  });
  app.use("/api", cameras);
  return app;
}

const now = () => Math.floor(Date.now() / 1000);
const AFTER = "1758800000";
const BEFORE = "1758803600";

function signedUrl(opts: { camera?: string; userId?: string; exp?: number; seg?: string } = {}) {
  const camera = opts.camera ?? "front";
  const seg = opts.seg ?? "0.ts";
  const q = signSegmentQuery(
    { camera, after: AFTER, before: BEFORE, seg, userId: opts.userId ?? "u-member" },
    opts.exp ?? now() + 600,
  );
  return `/api/cameras/${camera}/playback.segment?after=${AFTER}&before=${BEFORE}&seg=${seg}${q}`;
}

beforeEach(() => {
  users.clear();
  grants.clear();
  users.set("u-member", { id: "u-member", username: "m", displayName: "Member", role: "family", directoryStatus: "ACTIVE", accessRoleId: null });
  grants.set("u-member", ["front"]);
  vi.mocked(cacheGet).mockResolvedValue(null);
});

describe("signed segment URLs", () => {
  it("a valid signature authenticates as the signer, with no bearer", async () => {
    const res = await request(makeApp()).get(signedUrl());
    expect(res.status).toBe(200);
    expect(res.body.user).toBe("u-member");
  });

  it("an expired signature is refused", async () => {
    const res = await request(makeApp()).get(signedUrl({ exp: now() - 1 }));
    expect(res.status).toBe(401);
  });

  it("a tampered signature, segment or window is refused", async () => {
    const url = signedUrl();
    const flipped = url.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "A" ? "B" : "A"}`);
    expect((await request(makeApp()).get(flipped)).status).toBe(401);
    expect((await request(makeApp()).get(url.replace("seg=0.ts", "seg=1.ts"))).status).toBe(401);
    expect((await request(makeApp()).get(url.replace(`before=${BEFORE}`, `before=${Number(BEFORE) + 60}`))).status).toBe(401);
    // Swapping the user id to an owner's does not carry the signature with it.
    users.set("u-owner", { id: "u-owner", username: "o", displayName: "Owner", role: "owner", directoryStatus: "ACTIVE", accessRoleId: null });
    expect((await request(makeApp()).get(url.replace("u=u-member", "u=u-owner"))).status).toBe(401);
  });

  it("a signature for one camera does not open another", async () => {
    const url = signedUrl({ camera: "front" }).replace("/cameras/front/", "/cameras/back/");
    expect((await request(makeApp()).get(url)).status).toBe(401);
  });

  it("a deactivated, denylisted or deleted signer is refused", async () => {
    users.get("u-member")!.directoryStatus = "DEACTIVATED";
    expect((await request(makeApp()).get(signedUrl())).status).toBe(401);

    users.get("u-member")!.directoryStatus = "ACTIVE";
    vi.mocked(cacheGet).mockResolvedValue(1);
    expect((await request(makeApp()).get(signedUrl())).status).toBe(401);

    vi.mocked(cacheGet).mockResolvedValue(null);
    users.delete("u-member");
    expect((await request(makeApp()).get(signedUrl())).status).toBe(401);
  });

  it("a signer who lost the camera grant gets 404, like any other request", async () => {
    grants.set("u-member", []);
    expect((await request(makeApp()).get(signedUrl())).status).toBe(404);
  });

  it("an external guest's signature is refused (not a camera role)", async () => {
    users.get("u-member")!.role = "guest";
    expect((await request(makeApp()).get(signedUrl())).status).toBe(401);
  });

  it("the bearer still works without a signature, and with a stale one", async () => {
    const plain = `/api/cameras/front/playback.segment?after=${AFTER}&before=${BEFORE}&seg=0.ts`;
    const ok = await request(makeApp()).get(plain).set("Authorization", "Bearer good-bearer");
    expect(ok.status).toBe(200);
    expect(ok.body.user).toBe("u-bearer");

    const stale = await request(makeApp()).get(signedUrl({ exp: now() - 1 })).set("Authorization", "Bearer good-bearer");
    expect(stale.status).toBe(200);
    expect(stale.body.user).toBe("u-bearer");

    expect((await request(makeApp()).get(plain)).status).toBe(401);
  });

  it("no usable DEVICE_SECRET means no signature is emitted", () => {
    const saved = process.env.DEVICE_SECRET;
    process.env.DEVICE_SECRET = "change-me";
    try {
      expect(signSegmentQuery({ camera: "front", after: AFTER, before: BEFORE, seg: "0.ts", userId: "u" }, now() + 60)).toBe("");
    } finally {
      process.env.DEVICE_SECRET = saved;
    }
  });
});

describe("segmentSignatureTtlSec (ruling: max(10 min, duration + 5 min), capped at 2 h)", () => {
  it.each([
    [60, 600],
    [30 * 60, 35 * 60],
    [3 * 60 * 60, 2 * 60 * 60],
  ])("a %i s window gets %i s", (duration, ttl) => {
    expect(segmentSignatureTtlSec(1000, 1000 + duration)).toBe(ttl);
  });
});
