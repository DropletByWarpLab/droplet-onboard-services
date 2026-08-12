/**
 * WARP-471 — /api/models READ-ONLY surface (Phase F3).
 *
 * Two layers:
 *   - Service: getModelsPagePayload composes from ai-gateway + static
 *     cloud catalogue. Mock ai-gateway.listModels and snapshot the
 *     shape.
 *   - Route: GET returns 200 + payload. Asserts no PATCH/POST/DELETE
 *     handlers registered (one-model rule enforcement).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, AI_GATEWAY_URL: "http://ai-gateway:8000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

const listModelsMock = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  listModels: () => listModelsMock(),
}));

// WARP-1112 — the active-model PATCH audits via recordActivity. Mock it so
// tests don't touch the real activity singleton (which needs a DB).
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

// WARP-836 — stub only the Ollama metrics *probe* (network); keep the real
// `metricsFor` so the enrichment name-matching is exercised for real.
const { fetchLocalModelMetricsMock } = vi.hoisted(() => ({
  fetchLocalModelMetricsMock: vi.fn(),
}));
vi.mock("../services/model-metrics.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/model-metrics.service.js")>();
  return {
    ...actual,
    fetchLocalModelMetrics: () => fetchLocalModelMetricsMock(),
  };
});

// WARP-836 — stub only the benchmark generation (network); keep benchCacheKey
// real so route + page-summary agree on the cache key.
const { benchmarkModelMock } = vi.hoisted(() => ({
  benchmarkModelMock: vi.fn(),
}));
vi.mock("../services/model-benchmark.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/model-benchmark.service.js")>();
  return {
    ...actual,
    benchmarkModel: (name: string) => benchmarkModelMock(name),
  };
});

// WARP-1827 — stub the inference-manager catalog proxy (network). The route
// validates pulls against the eligible catalog and pipes the sidecar's NDJSON
// stream through; both are exercised against these mocks.
const { fetchEligibleCatalogMock, openPullStreamMock } = vi.hoisted(() => ({
  fetchEligibleCatalogMock: vi.fn(),
  openPullStreamMock: vi.fn(),
}));
vi.mock("../services/model-catalog.service.js", () => ({
  fetchEligibleCatalog: () => fetchEligibleCatalogMock(),
  openPullStream: (model: string, signal: AbortSignal) =>
    openPullStreamMock(model, signal),
}));

// WARP-1861 — stub the device-bridge probe (network), keep the real
// `bytesToGiB` so the payload's arithmetic is exercised rather than mocked.
// Without this every test here runs against a bridge token vitest never sets,
// so `fetchGpuTelemetry` short-circuits to null and the populated GPU path is
// unreachable — a `gpu === null` assertion would pass for the wrong reason.
const { fetchGpuTelemetryMock } = vi.hoisted(() => ({
  fetchGpuTelemetryMock: vi.fn(),
}));
vi.mock("../lib/gpu-telemetry.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/gpu-telemetry.js")>();
  return { ...actual, fetchGpuTelemetry: () => fetchGpuTelemetryMock() };
});

/** A fully-populated bridge snapshot, as measured on the lab box. */
const GPU_SNAPSHOT = {
  available: true,
  card: "card1",
  reason: null,
  busyPercent: 97,
  vramTotalBytes: 17_095_983_104,
  vramUsedBytes: 14_190_886_912,
  vramUsedFraction: 0.83,
  powerWatts: 164,
  tempC: 62,
  processes: [],
};

import { createModelsRouter } from "../routes/models.js";
import { getModelsPagePayload } from "../services/models-summary.service.js";
import { benchCacheKey } from "../services/model-benchmark.service.js";

/**
 * Minimal prisma stub backing the `ai.model.chat` WorkspaceSetting. Starts at
 * `initialActive` (null = unset) and mutates on upsert so a GET-after-PATCH
 * round-trips in-test.
 */
function createPrismaMock(initialActive: string | null = null) {
  let active = initialActive;
  return {
    workspaceSetting: {
      findUnique: vi.fn(async () =>
        active == null ? null : { valueJson: active },
      ),
      upsert: vi.fn(async ({ update }: { update: { valueJson: string } }) => {
        active = update.valueJson;
        return {};
      }),
    },
    _active: () => active,
  };
}

function buildApp(
  asUser: { username?: string; role?: string },
  prismaMock: ReturnType<typeof createPrismaMock> = createPrismaMock(),
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createModelsRouter(prismaMock as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: metrics probe returns nothing → rows keep honest null placeholders.
  fetchLocalModelMetricsMock.mockResolvedValue(new Map());
  // Default: no bridge → no GPU. Cases that want a card say so explicitly.
  fetchGpuTelemetryMock.mockResolvedValue(null);
});

describe("WARP-471 — models page payload", () => {
  it("composes local list from ai-gateway with family inference", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "1", provider: "ollama", name: "gpt-oss:20b", context_window: 8192 },
        { id: "2", provider: "ollama", name: "llama3.1:70b", context_window: 131072 },
        { id: "3", provider: "ollama", name: "qwen2.5:32b", context_window: null },
      ],
    });
    const payload = await getModelsPagePayload();
    expect(payload.local).toHaveLength(3);
    expect(payload.local[0]?.family).toBe("gpt-oss");
    expect(payload.local[1]?.family).toBe("llama");
    expect(payload.local[2]?.family).toBe("qwen");
    expect(payload.local[0]?.status).toBe("ready");
  });

  it("returns 3 cloud providers all default-off", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const payload = await getModelsPagePayload();
    expect(payload.cloud.map((c) => c.provider).sort()).toEqual([
      "anthropic",
      "gemini",
      "openai",
    ]);
    expect(payload.cloud.every((c) => c.enabled === false)).toBe(true);
    expect(payload.cloud.every((c) => c.spendUsd === 0)).toBe(true);
  });

  it("degrades gracefully when ai-gateway is unreachable", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const payload = await getModelsPagePayload();
    expect(payload.local).toEqual([]);
    expect(payload.cloud).toHaveLength(3);
    expect(payload.gpu).toBeNull();
    expect(payload.cloudSpendUsd).toBe(0);
  });

  // ── WARP-1289 — honest degraded signal (same blindspot WARP-1284 fixed
  //    for the wizard): an empty local list from a DOWN gateway must carry
  //    `degraded: true`, never masquerade as "no local models". ──

  it("flags degraded when ai-gateway is unreachable (WARP-1289)", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const payload = await getModelsPagePayload();
    expect(payload.local).toEqual([]);
    expect(payload.degraded).toBe(true);
  });

  it("flags degraded when the gateway reports its ollama provider failed (WARP-1289)", async () => {
    listModelsMock.mockResolvedValue({
      models: [],
      degraded_providers: ["ollama"],
    });
    const payload = await getModelsPagePayload();
    expect(payload.local).toEqual([]);
    expect(payload.degraded).toBe(true);
  });

  it("does NOT flag degraded for a cloud-only provider failure (WARP-1289)", async () => {
    // Parity with GET /api/llm/models: only ollama serves LOCAL models, so a
    // cloud provider erroring during the gateway's listing fan-out does not
    // impugn the local list.
    listModelsMock.mockResolvedValue({
      models: [
        { id: "1", provider: "ollama", name: "llama3.1:70b", context_window: 131072 },
      ],
      degraded_providers: ["openai"],
    });
    const payload = await getModelsPagePayload();
    expect(payload.local).toHaveLength(1);
    expect(payload.degraded).toBe(false);
  });

  it("healthy listing reports degraded: false (WARP-1289)", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "1", provider: "ollama", name: "llama3.1:70b", context_window: 131072 },
      ],
    });
    const payload = await getModelsPagePayload();
    expect(payload.degraded).toBe(false);
  });

  it("the remaining placeholder fields return safe defaults (avg latency 0)", async () => {
    // `gpu` used to be a placeholder here; WARP-1861 made it a real reading,
    // so it moved to its own describe below. Latency and spend are still
    // unbuilt surfaces.
    listModelsMock.mockResolvedValue({ models: [] });
    const payload = await getModelsPagePayload();
    expect(payload.avgLatencyMs).toBe(0);
    expect(payload.cloudSpendUsd).toBe(0);
  });
});

// ── WARP-1861 — the GPU tile's real reading ─────────────────────────────
//
// Every counter degrades on its OWN. The failure this pins is the whole-tile
// drop: on a box with BRIDGE_GPU_CARD pinned, device-bridge returns the
// pinned node without reading mem_info_vram_total, so a live card that is
// visibly at 97% can legitimately report a null VRAM total. Dropping the tile
// there renders "No accelerator detected" over a working GPU — the exact
// false outage this chain exists to end.
describe("WARP-1861 — GPU telemetry on the models payload", () => {
  beforeEach(() => {
    listModelsMock.mockResolvedValue({ models: [] });
  });

  it("carries the full counter set when the bridge reports a card", async () => {
    fetchGpuTelemetryMock.mockResolvedValue(GPU_SNAPSHOT);
    const payload = await getModelsPagePayload();
    expect(payload.gpu).toEqual({
      name: "card1",
      vramGiB: 15.9,
      vramUsedGiB: 13.2,
      utilPct: 97,
      tempC: 62,
    });
  });

  it("still renders the card when VRAM total is unreadable (pinned card)", async () => {
    fetchGpuTelemetryMock.mockResolvedValue({
      ...GPU_SNAPSHOT,
      vramTotalBytes: null,
      vramUsedBytes: null,
      vramUsedFraction: null,
    });
    const payload = await getModelsPagePayload();
    expect(payload.gpu).not.toBeNull();
    expect(payload.gpu?.name).toBe("card1");
    expect(payload.gpu?.vramGiB).toBeNull();
    expect(payload.gpu?.vramUsedGiB).toBeNull();
    // The counters that ARE readable survive — that is the whole point.
    expect(payload.gpu?.utilPct).toBe(97);
    expect(payload.gpu?.tempC).toBe(62);
  });

  it("keeps a suspended card's util/temp null rather than reporting 0", async () => {
    fetchGpuTelemetryMock.mockResolvedValue({
      ...GPU_SNAPSHOT,
      busyPercent: null,
      tempC: null,
    });
    const payload = await getModelsPagePayload();
    expect(payload.gpu?.utilPct).toBeNull();
    expect(payload.gpu?.utilPct).not.toBe(0);
    expect(payload.gpu?.tempC).toBeNull();
    expect(payload.gpu?.vramGiB).toBe(15.9);
  });

  it("reports no GPU when the bridge resolved no card (available:false)", async () => {
    fetchGpuTelemetryMock.mockResolvedValue({
      available: false,
      card: null,
      reason: "no DRM card exposing mem_info_vram_total",
      busyPercent: null,
      vramTotalBytes: null,
      vramUsedBytes: null,
      vramUsedFraction: null,
      powerWatts: null,
      tempC: null,
      processes: [],
    });
    const payload = await getModelsPagePayload();
    expect(payload.gpu).toBeNull();
  });

  it("reports no GPU when the bridge itself is absent (probe returns null)", async () => {
    fetchGpuTelemetryMock.mockResolvedValue(null);
    const payload = await getModelsPagePayload();
    expect(payload.gpu).toBeNull();
  });
});

describe("WARP-836 — honest metrics enrichment", () => {
  it("enriches local rows with real Ollama metrics (disk/params/quant/vram)", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
        { id: "llama3.2:3b", provider: "ollama", name: "llama3.2:3b", context_window: 131072 },
      ],
    });
    fetchLocalModelMetricsMock.mockResolvedValue(
      new Map([
        ["gpt-oss:20b", { gbOnDisk: 13.8, parameterSize: "20.9B", quantization: "MXFP4", loaded: true, vramGb: 12.7 }],
        ["llama3.2:3b", { gbOnDisk: 2.0, parameterSize: "3.2B", quantization: "Q4_K_M", loaded: false, vramGb: null }],
      ]),
    );
    const payload = await getModelsPagePayload();
    const gpt = payload.local.find((m) => m.name === "gpt-oss:20b")!;
    expect(gpt.gbOnDisk).toBe(13.8);
    expect(gpt.parameterSize).toBe("20.9B");
    expect(gpt.quantization).toBe("MXFP4");
    expect(gpt.loaded).toBe(true);
    expect(gpt.vramGb).toBe(12.7);
    // disk bar = share of the 15.8 GB store → 13.8/15.8 ≈ 87%.
    expect(gpt.diskBarPct).toBe(87);
    const llama = payload.local.find((m) => m.name === "llama3.2:3b")!;
    expect(llama.loaded).toBe(false);
    expect(llama.vramGb).toBeNull();
  });

  it("keeps honest null metrics when the Ollama probe returns nothing", async () => {
    listModelsMock.mockResolvedValue({
      models: [{ id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 }],
    });
    fetchLocalModelMetricsMock.mockResolvedValue(new Map());
    const payload = await getModelsPagePayload();
    expect(payload.local[0].gbOnDisk).toBeNull();
    expect(payload.local[0].parameterSize).toBeNull();
    expect(payload.local[0].quantization).toBeNull();
    expect(payload.local[0].vramGb).toBeNull();
    expect(payload.local[0].diskBarPct).toBeNull();
  });
});

describe("WARP-471 — /api/models route", () => {
  it("GET returns 200 + payload shape", async () => {
    listModelsMock.mockResolvedValue({
      models: [{ id: "1", provider: "ollama", name: "llama3.1:70b", context_window: 131072 }],
    });
    const app = buildApp({ username: "stefan", role: "family" });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.local).toHaveLength(1);
    expect(res.body.cloud).toHaveLength(3);
    expect(res.body.gpu).toBeNull();
  });

  it("serves a degraded payload UNCACHED so it self-heals (WARP-1289)", async () => {
    // Mirror of the WARP-1284 rule on /api/llm/models: never cache the
    // degraded fallback — the next request retries the gateway so the page
    // recovers the moment the AI service is reachable again.
    const { cacheSet } = await import("../services/cache.service.js");
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const app = buildApp({ username: "stefan", role: "family" });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.local).toEqual([]);
    expect(vi.mocked(cacheSet)).not.toHaveBeenCalled();
  });

  it("caches a healthy payload (WARP-1289 leaves the happy path alone)", async () => {
    const { cacheSet } = await import("../services/cache.service.js");
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "family" });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    expect(vi.mocked(cacheSet)).toHaveBeenCalledTimes(1);
  });

  it("PATCH /api/models 404s — read-only enforcement", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).patch("/api/models").send({ name: "foo" });
    expect(res.status).toBe(404);
  });

  it("POST /api/models 404s — read-only enforcement", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models").send({});
    expect(res.status).toBe(404);
  });

  it("DELETE /api/models/:name 404s — no delete/pull on this surface", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).delete("/api/models/llama3.1");
    expect(res.status).toBe(404);
  });
});

describe("WARP-1112 — PATCH /api/models/active", () => {
  const installed = {
    models: [
      { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
      { id: "llama3.2:3b", provider: "ollama", name: "llama3.2:3b", context_window: 131072 },
    ],
  };

  it("owner sets an installed model → 200, persists, audits", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "llama3.2:3b" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeModel: "llama3.2:3b", changed: true });
    expect(prisma._active()).toBe("llama3.2:3b");
    expect(prisma.workspaceSetting.upsert).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("admin is allowed too", async () => {
    listModelsMock.mockResolvedValue(installed);
    const app = buildApp(
      { username: "ada", role: "admin" },
      createPrismaMock(null),
    );
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(200);
  });

  it("re-selecting the current model is a no-op (no write, no audit)", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock("gpt-oss:20b");
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeModel: "gpt-oss:20b", changed: false });
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("rejects a model that isn't installed → 400 not_installed", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gemma4:26b" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_installed");
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
  });

  it("rejects a cloud model — the active model is local-only → 400", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
        { id: "claude-sonnet", provider: "anthropic", name: "claude-sonnet", context_window: 200000 },
      ],
    });
    const app = buildApp(
      { username: "stefan", role: "owner" },
      createPrismaMock(null),
    );
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "claude-sonnet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_installed");
  });

  it("empty / missing model → 400", async () => {
    listModelsMock.mockResolvedValue(installed);
    const app = buildApp(
      { username: "stefan", role: "owner" },
      createPrismaMock(null),
    );
    const blank = await request(app)
      .patch("/api/models/active")
      .send({ model: "  " });
    expect(blank.status).toBe(400);
    const missing = await request(app).patch("/api/models/active").send({});
    expect(missing.status).toBe(400);
  });

  it("members (family) are forbidden → 403", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "kid", role: "family" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(403);
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
  });

  it("gateway unreachable → 503 (can't confirm installed, so refuse)", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "owner" }, prisma);
    const res = await request(app)
      .patch("/api/models/active")
      .send({ model: "gpt-oss:20b" });
    expect(res.status).toBe(503);
    expect(prisma.workspaceSetting.upsert).not.toHaveBeenCalled();
  });

  it("GET /api/models surfaces the active model when it's installed", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock("llama3.2:3b");
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.activeModel).toBe("llama3.2:3b");
  });
});

describe("WARP-1511 — GET /api/models blank/stale activeModel falls back", () => {
  const installed = {
    models: [
      { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
      { id: "llama3.2:3b", provider: "ollama", name: "llama3.2:3b", context_window: 131072 },
    ],
  };

  it("resolves a blank stored value to the sole installed model — the reported production bug", async () => {
    // Live evidence: ai.model.chat is "" and gpt-oss:20b is the only
    // installed model, yet /api/models used to report activeModel: null.
    listModelsMock.mockResolvedValue({
      models: [
        { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
      ],
    });
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.activeModel).toBe("gpt-oss:20b");
  });

  it("resolves a stale stored tag (since removed) to the first installed model, not null", async () => {
    listModelsMock.mockResolvedValue(installed);
    const prisma = createPrismaMock("gemma4:26b");
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.activeModel).toBe("gpt-oss:20b");
  });

  it("never offers a cloud-tagged entry as the local fallback", async () => {
    // Defensive: even if the gateway's local list is ever polluted with a
    // non-ollama entry, the fallback must stay local-only (same invariant
    // as localModelIdentifiers / the PATCH validation path).
    listModelsMock.mockResolvedValue({
      models: [
        { id: "claude-sonnet", provider: "anthropic", name: "claude-sonnet", context_window: 200000 },
        { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
      ],
    });
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.activeModel).toBe("gpt-oss:20b");
  });

  it("stays honestly null when nothing is installed, blank stored value", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.activeModel).toBeNull();
  });

  it("passes a previously-valid stored value through unresolved when the gateway is unreachable — never nulls it out", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const prisma = createPrismaMock("gpt-oss:20b");
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.activeModel).toBe("gpt-oss:20b");
  });

  it("does not fabricate a fallback from a blank stored value while the gateway is unreachable", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const prisma = createPrismaMock(null);
    const app = buildApp({ username: "stefan", role: "family" }, prisma);
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.activeModel).toBeNull();
  });
});

describe("WARP-836 — POST /api/models/:name/benchmark", () => {
  const installed = {
    models: [
      { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
    ],
  };
  const result = {
    tokensPerSec: 42.5,
    evalCount: 96,
    evalDurationMs: 2259,
    measuredAt: "2026-07-20T00:00:00.000Z",
  };

  it("owner measures an installed model → 200 + result, caches + busts page cache", async () => {
    listModelsMock.mockResolvedValue(installed);
    benchmarkModelMock.mockResolvedValue(result);
    const { cacheSet, cacheDel } = await import("../services/cache.service.js");
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/gpt-oss%3A20b/benchmark");
    expect(res.status).toBe(200);
    expect(res.body.tokensPerSec).toBe(42.5);
    expect(vi.mocked(cacheSet)).toHaveBeenCalledWith(
      benchCacheKey("gpt-oss:20b"),
      result,
      expect.any(Number),
    );
    expect(vi.mocked(cacheDel)).toHaveBeenCalledWith("models:page");
  });

  it("members (family) are forbidden → 403", async () => {
    listModelsMock.mockResolvedValue(installed);
    const app = buildApp({ username: "kid", role: "family" });
    const res = await request(app).post("/api/models/gpt-oss%3A20b/benchmark");
    expect(res.status).toBe(403);
    expect(benchmarkModelMock).not.toHaveBeenCalled();
  });

  it("rejects a model that isn't installed → 400", async () => {
    listModelsMock.mockResolvedValue(installed);
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/gemma4%3A26b/benchmark");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_installed");
    expect(benchmarkModelMock).not.toHaveBeenCalled();
  });

  it("a failed measurement → 502 benchmark_failed", async () => {
    listModelsMock.mockResolvedValue(installed);
    benchmarkModelMock.mockResolvedValue(null);
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/gpt-oss%3A20b/benchmark");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("benchmark_failed");
  });

  it("gateway unreachable → 503", async () => {
    listModelsMock.mockRejectedValue(new Error("connection refused"));
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/gpt-oss%3A20b/benchmark");
    expect(res.status).toBe(503);
    expect(benchmarkModelMock).not.toHaveBeenCalled();
  });

  it("GET /api/models surfaces a cached tokensPerSec + benchmarkedAt", async () => {
    listModelsMock.mockResolvedValue(installed);
    const { cacheGet } = await import("../services/cache.service.js");
    // Route reads the page-cache key first (miss), then the bench key per row.
    vi.mocked(cacheGet)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(result as never);
    const app = buildApp({ username: "stefan", role: "family" });
    const res = await request(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.local[0].tokensPerSec).toBe(42.5);
    expect(res.body.local[0].benchmarkedAt).toBe(result.measuredAt);
  });
});

// ── WARP-1827 — pull-from-catalog: GET /models/catalog + POST /models/:name/pull ──

/** The sidecar's eligible catalog: one model installed, one available. */
function eligibleCatalog() {
  return {
    detected_vram_gb: 16,
    models: [
      {
        name: "gpt-oss:20b",
        pull_tag: "gpt-oss:20b",
        min_vram_gb: 13,
        class: "flagship",
        default: true,
        display_name: "GPT-OSS 20B",
        maker: "OpenAI",
        description: "A strong general model.",
        capabilities: ["chat", "tools"],
        roles: ["chat"],
        disk_gb: 14,
        pulled: true,
      },
      {
        name: "qwen3:14b",
        pull_tag: "qwen3:14b",
        min_vram_gb: 12,
        class: "flagship",
        default: false,
        display_name: "Qwen3 14B",
        maker: "Alibaba",
        description: "A capable multilingual model.",
        capabilities: ["chat"],
        roles: ["chat"],
        disk_gb: 9,
        pulled: false,
      },
    ],
  };
}

/**
 * A catalog whose entries DIVERGE — the user-facing `name` is NOT the tag the
 * sidecar pulls. droplet-local-LLM's inference-manager hands `body.model`
 * straight to the runtime (`runtime.pull(body.model)`); its manifest lookup
 * only feeds the disk preflight. So `pull_tag` is the identifier that has to
 * go on the wire, per that repo's docs/model-management.md ("pull_tag — what
 * POST /api/pull is called with"), while `name` stays the identity the user
 * and the audit trail see.
 *
 * Deliberately a SEPARATE fixture from `eligibleCatalog()`: those tests assert
 * the name === pull_tag path, and mutating the shared fixture would move that
 * ground out from under them.
 */
function divergentCatalog() {
  const base = {
    min_vram_gb: 12,
    class: "flagship",
    default: false,
    maker: "Alibaba",
    description: "A capable multilingual model.",
    capabilities: ["chat"],
    roles: ["chat"],
    disk_gb: 9,
  };
  return {
    detected_vram_gb: 16,
    models: [
      // Divergent + available: the pull must go out as the pull_tag.
      {
        ...base,
        name: "qwen3:14b",
        pull_tag: "hf.co/Qwen/Qwen3-14B-GGUF:Q4_K_M",
        display_name: "Qwen3 14B",
        pulled: false,
      },
      // No pull_tag at all: the catalog identity is the only addressable
      // thing, so the wire identifier falls back to `name`.
      {
        ...base,
        name: "gemma3:12b",
        pull_tag: null,
        display_name: "Gemma 3 12B",
        maker: "Google",
        pulled: false,
      },
      // Divergent + already installed: the 409 arm must still speak `name`.
      {
        ...base,
        name: "gpt-oss:20b",
        pull_tag: "docker.io/ai/gpt-oss:20B-F16",
        display_name: "GPT-OSS 20B",
        maker: "OpenAI",
        pulled: true,
      },
    ],
  };
}

/** A mock upstream streaming response: NDJSON lines as an async iterable. */
function streamResponse(lines: string[], status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* () {
      for (const line of lines) {
        yield Buffer.from(`${line}\n`);
      }
    })(),
  };
}

describe("WARP-1827 — GET /api/models/catalog", () => {
  it("returns the eligible catalog to any authenticated principal", async () => {
    fetchEligibleCatalogMock.mockResolvedValue(eligibleCatalog());
    // family (member) role — reads stay open per ADR-004 §3, same as GET /models.
    const app = buildApp({ username: "kid", role: "family" });
    const res = await request(app).get("/api/models/catalog");
    expect(res.status).toBe(200);
    expect(res.body.detected_vram_gb).toBe(16);
    expect(res.body.models).toHaveLength(2);
    expect(res.body.models[1].pulled).toBe(false);
  });

  it("503s ai_service_unreachable when the sidecar can't be reached", async () => {
    fetchEligibleCatalogMock.mockRejectedValue(new Error("connection refused"));
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).get("/api/models/catalog");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("ai_service_unreachable");
    expect(res.body.detail).toMatch(/AI service/i);
  });
});

describe("WARP-1827 — POST /api/models/:name/pull", () => {
  beforeEach(() => {
    fetchEligibleCatalogMock.mockResolvedValue(eligibleCatalog());
  });

  it("members (family) are forbidden → 403, upstream never contacted", async () => {
    const app = buildApp({ username: "kid", role: "family" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(403);
    expect(fetchEligibleCatalogMock).not.toHaveBeenCalled();
    expect(openPullStreamMock).not.toHaveBeenCalled();
  });

  it("503s when the catalog can't be read (can't confirm eligibility → refuse)", async () => {
    fetchEligibleCatalogMock.mockRejectedValue(new Error("connection refused"));
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("ai_service_unreachable");
    expect(openPullStreamMock).not.toHaveBeenCalled();
  });

  it("400s not_eligible for a model outside the eligible catalog", async () => {
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/llama3.1%3A405b/pull");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_eligible");
    expect(openPullStreamMock).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("409s already_pulled for a model whose catalog entry says pulled", async () => {
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/gpt-oss%3A20b/pull");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_pulled");
    expect(openPullStreamMock).not.toHaveBeenCalled();
  });

  it("passes an upstream 409 (disk preflight) through verbatim", async () => {
    const preflight = {
      error: "insufficient_disk",
      detail: "Needs 9.0 GB free; 2.1 GB available.",
    };
    openPullStreamMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => preflight,
    });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(409);
    expect(res.body).toEqual(preflight);
    // The attempt was still audited as started — the sidecar refused it after.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("502s pull_failed on any other upstream error", async () => {
    openPullStreamMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("pull_failed");
  });

  it("streams the NDJSON body through and busts the page cache on success", async () => {
    const lines = [
      '{"status":"pulling manifest"}',
      '{"status":"success"}',
    ];
    openPullStreamMock.mockResolvedValue(streamResponse(lines));
    const { cacheDel } = await import("../services/cache.service.js");
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/x-ndjson/);
    // Both lines reached the client, in order.
    expect(res.text).toBe(lines.map((l) => `${l}\n`).join(""));
    // Terminal success → page cache busted + started/finished audited.
    expect(vi.mocked(cacheDel)).toHaveBeenCalledWith("models:page");
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    expect(recordActivityMock.mock.calls[0][0].what).toBe(
      "Model download started",
    );
    expect(recordActivityMock.mock.calls[1][0].what).toBe(
      "Model download finished",
    );
    // The upstream stream is opened for the requested model…
    expect(openPullStreamMock.mock.calls[0][0]).toBe("qwen3:14b");
    // …and its abort signal is UNTOUCHED after a normal completion. Guards
    // the Node ≥16 trap where the request's own "close" (which fires as soon
    // as the request MESSAGE completes, mid-stream) was used for disconnect
    // detection — that aborted every pull the moment the body was parsed.
    const signal = openPullStreamMock.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
  });

  it("audits a failed download (error line) and does NOT bust the cache", async () => {
    openPullStreamMock.mockResolvedValue(
      streamResponse([
        '{"status":"pulling manifest"}',
        '{"error":"pull model manifest: file does not exist"}',
      ]),
    );
    const { cacheDel } = await import("../services/cache.service.js");
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(200);
    // The error line still reaches the client (it renders the honest message).
    expect(res.text).toContain("file does not exist");
    expect(vi.mocked(cacheDel)).not.toHaveBeenCalled();
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    expect(recordActivityMock.mock.calls[1][0].what).toBe(
      "Model download failed",
    );
    expect(recordActivityMock.mock.calls[1][0].severity).toBe("warn");
  });

  it("tolerates unparseable NDJSON lines while watching for the terminal", async () => {
    openPullStreamMock.mockResolvedValue(
      streamResponse(["not-json-at-all", '{"status":"success"}']),
    );
    const { cacheDel } = await import("../services/cache.service.js");
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(200);
    expect(vi.mocked(cacheDel)).toHaveBeenCalledWith("models:page");
  });
});

// ── WARP-1827 — pull_tag is the WIRE identifier; name is the USER identity ──
//
// The sidecar does not resolve name → pull_tag for us: inference-manager's
// POST /models/pull passes the caller's identifier straight through to the
// runtime, so POSTing the catalog `name` when the two diverge pulls the wrong
// tag (or dies at the registry) with nothing on this side anticipating it.
// The divergent path was previously untested in BOTH directions — every
// fixture kept name === pull_tag.

describe("WARP-1827 — POST /api/models/:name/pull resolves the catalog pull_tag", () => {
  beforeEach(() => {
    fetchEligibleCatalogMock.mockResolvedValue(divergentCatalog());
  });

  it("POSTs the entry's pull_tag upstream, not the :name path param", async () => {
    openPullStreamMock.mockResolvedValue(streamResponse(['{"status":"success"}']));
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(200);
    expect(openPullStreamMock).toHaveBeenCalledTimes(1);
    expect(openPullStreamMock.mock.calls[0][0]).toBe(
      "hf.co/Qwen/Qwen3-14B-GGUF:Q4_K_M",
    );
    // The bug this guards: the raw path param going out on the wire.
    expect(openPullStreamMock.mock.calls[0][0]).not.toBe("qwen3:14b");
  });

  it("keeps `name` as the user-facing identity in the audit trail while pulling pull_tag", async () => {
    openPullStreamMock.mockResolvedValue(streamResponse(['{"status":"success"}']));
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/qwen3%3A14b/pull");
    expect(res.status).toBe(200);
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    const [started, finished] = recordActivityMock.mock.calls.map((c) => c[0]);
    expect(started.what).toBe("Model download started");
    expect(started.sub).toBe("qwen3:14b");
    expect(started.refs.model).toBe("qwen3:14b");
    expect(finished.what).toBe("Model download finished");
    expect(finished.sub).toBe("qwen3:14b");
    expect(finished.refs.model).toBe("qwen3:14b");
    // The registry tag is plumbing — it must not leak into the audit feed.
    expect(JSON.stringify(recordActivityMock.mock.calls)).not.toContain("hf.co");
  });

  it("falls back to `name` when the catalog entry has no pull_tag", async () => {
    openPullStreamMock.mockResolvedValue(streamResponse(['{"status":"success"}']));
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/gemma3%3A12b/pull");
    expect(res.status).toBe(200);
    expect(openPullStreamMock.mock.calls[0][0]).toBe("gemma3:12b");
    expect(recordActivityMock.mock.calls[0][0].sub).toBe("gemma3:12b");
  });

  it("409 already_pulled still speaks the user-facing name, never the pull_tag", async () => {
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post("/api/models/gpt-oss%3A20b/pull");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_pulled");
    expect(res.body.detail).toContain("gpt-oss:20b");
    expect(res.body.detail).not.toContain("docker.io");
    expect(openPullStreamMock).not.toHaveBeenCalled();
  });

  it("400 not_eligible is unchanged — an unknown name never reaches the sidecar", async () => {
    const app = buildApp({ username: "stefan", role: "owner" });
    const res = await request(app).post(
      "/api/models/hf.co%2FQwen%2FQwen3-14B-GGUF%3AQ4_K_M/pull",
    );
    // Asking for the pull_tag itself is NOT a catalog identity: the lookup is
    // by `name`, so this is out-of-catalog and must be refused, not pulled.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_eligible");
    expect(openPullStreamMock).not.toHaveBeenCalled();
  });
});

// ── WARP-1827 — placement threading through the page payload ──

describe("WARP-1827 — placement surfaced on LocalModelInfo", () => {
  it("threads gpuFraction/placement/placementState from the metrics probe", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
      ],
    });
    fetchLocalModelMetricsMock.mockResolvedValue(
      new Map([
        [
          "gpt-oss:20b",
          {
            gbOnDisk: 13.8,
            parameterSize: "20.9B",
            quantization: "MXFP4",
            loaded: true,
            vramGb: 6.9,
            gpuFraction: 0.5,
            placement: "partial",
            placementState: "measured",
          },
        ],
      ]),
    );
    const payload = await getModelsPagePayload();
    const row = payload.local[0];
    expect(row.gpuFraction).toBe(0.5);
    expect(row.placement).toBe("partial");
    expect(row.placementState).toBe("measured");
  });

  it("stays null against a metrics double that predates placement (additive)", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
      ],
    });
    fetchLocalModelMetricsMock.mockResolvedValue(
      new Map([
        [
          "gpt-oss:20b",
          { gbOnDisk: 13.8, parameterSize: "20.9B", quantization: "MXFP4", loaded: true, vramGb: 12.7 },
        ],
      ]),
    );
    const payload = await getModelsPagePayload();
    const row = payload.local[0];
    expect(row.gpuFraction).toBeNull();
    expect(row.placement).toBeNull();
    expect(row.placementState).toBeNull();
  });
});
