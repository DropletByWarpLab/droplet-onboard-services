/**
 * WARP-1749 — the Models page payload carries WHY a metric is missing, and
 * refuses to draw a share-of-store bar it can't compute honestly.
 *
 * Companion to model-metrics.honesty.test.ts (which pins the probe). This file
 * pins the composer: the reason travels to the wire unchanged, and the derived
 * number — `diskBarPct`, "this model's share of the model store" — is only
 * emitted when the whole store is actually known.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    AI_GATEWAY_URL: "http://ai-gateway:8000",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
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

// Stub only the network probe; `metricsFor` stays real so the name matching is
// exercised for real (same seam the WARP-836 route test uses).
const { fetchLocalModelMetricsMock } = vi.hoisted(() => ({
  fetchLocalModelMetricsMock: vi.fn(),
}));
vi.mock("../services/model-metrics.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/model-metrics.service.js")>();
  return { ...actual, fetchLocalModelMetrics: () => fetchLocalModelMetricsMock() };
});

import { getModelsPagePayload } from "../services/models-summary.service.js";

const TWO_MODELS = {
  models: [
    { id: "a", provider: "ollama", name: "gpt-oss:20b", context_window: 131072 },
    { id: "b", provider: "ollama", name: "llama3.2:3b", context_window: 131072 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchLocalModelMetricsMock.mockResolvedValue(new Map());
});

describe("WARP-1749 — metric state on the wire", () => {
  it("carries `unsupported` through to the payload (a DMR box's VRAM)", async () => {
    listModelsMock.mockResolvedValue({
      models: [{ id: "a", provider: "ollama", name: "ai/smollm2", context_window: 8192 }],
    });
    fetchLocalModelMetricsMock.mockResolvedValue(
      new Map([
        [
          "ai/smollm2:latest",
          {
            gbOnDisk: 0.3,
            gbOnDiskState: "measured",
            parameterSize: "360.82 M",
            quantization: "Q4_K_M",
            loaded: true,
            vramGb: null,
            vramState: "unsupported",
          },
        ],
      ]),
    );
    const payload = await getModelsPagePayload();
    const row = payload.local[0]!;
    expect(row.gbOnDisk).toBe(0.3);
    expect(row.gbOnDiskState).toBe("measured");
    // The card needs this to say "your runtime doesn't report it" instead of a
    // bare dash — and it must never become 0 on the way out.
    expect(row.vramGb).toBeNull();
    expect(row.vramState).toBe("unsupported");
  });

  it("defaults to `unreported` before anything has been probed", async () => {
    listModelsMock.mockResolvedValue(TWO_MODELS);
    fetchLocalModelMetricsMock.mockResolvedValue(new Map());
    const payload = await getModelsPagePayload();
    for (const row of payload.local) {
      expect(row.gbOnDisk).toBeNull();
      expect(row.gbOnDiskState).toBe("unreported");
      expect(row.vramState).toBe("unreported");
    }
  });

  it("infers the state when a metrics object predates the field", async () => {
    // Defensive: a partial/older metrics shape must not produce `undefined` on
    // the wire — a present number is measured, an absent one is unreported.
    listModelsMock.mockResolvedValue(TWO_MODELS);
    fetchLocalModelMetricsMock.mockResolvedValue(
      new Map([
        ["gpt-oss:20b", { gbOnDisk: 13.8, parameterSize: null, quantization: null, loaded: false, vramGb: null }],
        ["llama3.2:3b", { gbOnDisk: 2, parameterSize: null, quantization: null, loaded: true, vramGb: 1.5 }],
      ]),
    );
    const payload = await getModelsPagePayload();
    const gpt = payload.local.find((m) => m.name === "gpt-oss:20b")!;
    const llama = payload.local.find((m) => m.name === "llama3.2:3b")!;
    expect(gpt.gbOnDiskState).toBe("measured");
    expect(gpt.vramState).toBe("unreported");
    expect(llama.vramState).toBe("measured");
  });
});

describe("WARP-1749 — diskBarPct is only drawn when the whole store is known", () => {
  it("Ollama (every size known) still gets the same bars as today", async () => {
    listModelsMock.mockResolvedValue(TWO_MODELS);
    fetchLocalModelMetricsMock.mockResolvedValue(
      new Map([
        ["gpt-oss:20b", { gbOnDisk: 13.8, gbOnDiskState: "measured", parameterSize: "20.9B", quantization: "MXFP4", loaded: true, vramGb: 12.7, vramState: "measured" }],
        ["llama3.2:3b", { gbOnDisk: 2, gbOnDiskState: "measured", parameterSize: "3.2B", quantization: "Q4_K_M", loaded: false, vramGb: null, vramState: "unreported" }],
      ]),
    );
    const payload = await getModelsPagePayload();
    expect(payload.local.find((m) => m.name === "gpt-oss:20b")!.diskBarPct).toBe(87);
    expect(payload.local.find((m) => m.name === "llama3.2:3b")!.diskBarPct).toBe(13);
  });

  it("draws NO bar when only some sizes are known — a partial total inflates every share", async () => {
    // The failure being prevented: with only the 2 GB model measured, the
    // total is 2 GB and that model renders as 100% of a store it is a seventh
    // of. A missing bar is honest; a wrong bar is not.
    listModelsMock.mockResolvedValue(TWO_MODELS);
    fetchLocalModelMetricsMock.mockResolvedValue(
      new Map([
        ["gpt-oss:20b", { gbOnDisk: null, gbOnDiskState: "unsupported", parameterSize: null, quantization: null, loaded: true, vramGb: null, vramState: "unsupported" }],
        ["llama3.2:3b", { gbOnDisk: 2, gbOnDiskState: "measured", parameterSize: null, quantization: null, loaded: false, vramGb: null, vramState: "unsupported" }],
      ]),
    );
    const payload = await getModelsPagePayload();
    for (const row of payload.local) {
      expect(row.diskBarPct).toBeNull();
    }
  });
});
