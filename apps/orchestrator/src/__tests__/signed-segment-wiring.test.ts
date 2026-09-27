/**
 * WARP-3122 — signed recordings-segment URLs through the REAL createApp
 * mount order. segment-url-signing.service.test.ts proves the verifier on a
 * hand-built app; this pins what a merge of app.ts could silently undo:
 * the signature router sits before authMiddleware, it only authorizes the
 * segment route, and a signed URL beats a stale bearer.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: true } };
});
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

// The module toggle reads the DB; with it open, every OTHER gate after the
// signature (password change, feature access, role, camera grant) still runs.
vi.mock("../middleware/module-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/module-gate.js")>();
  return {
    ...actual,
    createModuleGate: () => ({
      requireModuleEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
      invalidate: () => {},
    }),
  };
});

import { createApp } from "../app.js";
import { signSegmentQuery, SEGMENT_SIG_MAX_TTL_SEC } from "../services/segment-url-signing.service.js";

const SEGMENT_BODY = "FAKE-SEGMENT-BYTES";
const realFetch = globalThis.fetch;

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  process.env.DEVICE_SECRET = "signed-segment-wiring-test-secret";
  const prisma = new PrismaClient();
  // Only the models the signed path reads; anything else would need a DB.
  const owner = {
    id: "u-owner",
    username: "owner",
    displayName: "Owner",
    role: "owner",
    directoryStatus: "ACTIVE",
    accessRoleId: null,
    mustChangePassword: false,
  };
  Object.defineProperty(prisma, "user", {
    value: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === owner.id ? owner : null)),
    },
  });
  app = createApp(prisma);
  // Frigate: every upstream segment fetch answers with fixed bytes.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: unknown) =>
      String(input).includes("/vod/")
        ? new Response(SEGMENT_BODY, { status: 200, headers: { "content-type": "video/mp2t" } })
        : realFetch(input as never, init as never),
    ),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const now = () => Math.floor(Date.now() / 1000);
const BEFORE = String(now() - 3600);
const AFTER = String(now() - 7200);

function signed(path: "playback.segment" | "playback.m3u8", exp = now() + 600) {
  const q = signSegmentQuery({ camera: "front", after: AFTER, before: BEFORE, seg: "0.ts", userId: "u-owner" }, exp);
  return `/api/cameras/front/${path}?after=${AFTER}&before=${BEFORE}&seg=0.ts${q}`;
}

describe("createApp: signed segment URLs", () => {
  it("a signed segment URL is served with no bearer", async () => {
    const res = await request(app).get(signed("playback.segment"));
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe(SEGMENT_BODY);
  });

  it("the same URL without the signature is a 401", async () => {
    const url = signed("playback.segment").replace(/&u=.*$/, "");
    expect((await request(app).get(url)).status).toBe(401);
  });

  it("valid signed params on another camera route are a 401", async () => {
    expect((await request(app).get(signed("playback.m3u8"))).status).toBe(401);
    const onSettings = signed("playback.segment").replace("/playback.segment?", "/settings?");
    expect((await request(app).get(onSettings)).status).toBe(401);
  });

  it("a signed URL beats a stale bearer", async () => {
    const res = await request(app).get(signed("playback.segment")).set("Authorization", "Bearer stale.jwt.value");
    expect(res.status).toBe(200);
  });

  it("tampering with exp alone is rejected", async () => {
    const url = signed("playback.segment").replace(/exp=(\d+)/, (_m, e: string) => `exp=${Number(e) + 1}`);
    expect((await request(app).get(url)).status).toBe(401);
  });

  it("an exp beyond the TTL cap is rejected even when correctly signed", async () => {
    const url = signed("playback.segment", now() + SEGMENT_SIG_MAX_TTL_SEC + 3600);
    expect((await request(app).get(url)).status).toBe(401);
  });
});
