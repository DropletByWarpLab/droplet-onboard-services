/**
 * WARP-836 — model-metrics.service: real Ollama stats, honestly.
 *
 * Merges GET /api/tags (disk size, parameter size, quantization) with
 * GET /api/ps (resident + graphics memory). Any endpoint failure degrades to
 * honest nulls / an empty map — never a fabricated number.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchLocalModelMetrics,
  metricsFor,
} from "../services/model-metrics.service.js";

function jsonResp(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model-metrics.service", () => {
  it("merges /api/tags (disk/params/quant) with /api/ps (loaded/vram)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/ps"))
        return Promise.resolve(
          jsonResp({ models: [{ name: "gpt-oss:20b", size_vram: 12_700_000_000 }] }),
        );
      if (url.endsWith("/api/tags"))
        return Promise.resolve(
          jsonResp({
            models: [
              { name: "gpt-oss:20b", size: 13_800_000_000, details: { parameter_size: "20.9B", quantization_level: "MXFP4" } },
              { name: "llama3.2:3b", size: 2_000_000_000, details: { parameter_size: "3.2B", quantization_level: "Q4_K_M" } },
            ],
          }),
        );
      return Promise.reject(new Error("unexpected url"));
    });

    const m = await fetchLocalModelMetrics();
    const gpt = metricsFor(m, "gpt-oss:20b")!;
    expect(gpt.gbOnDisk).toBe(13.8);
    expect(gpt.parameterSize).toBe("20.9B");
    expect(gpt.quantization).toBe("MXFP4");
    expect(gpt.loaded).toBe(true);
    expect(gpt.vramGb).toBe(12.7);

    const llama = metricsFor(m, "llama3.2:3b")!;
    expect(llama.loaded).toBe(false);
    expect(llama.vramGb).toBeNull();
  });

  it("returns an empty map when /api/tags is unreachable (no fabrication)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/ps")) return Promise.resolve(jsonResp({ models: [] }));
      if (url.endsWith("/api/tags")) return Promise.resolve(jsonResp({}, false));
      return Promise.reject(new Error("x"));
    });
    const m = await fetchLocalModelMetrics();
    expect(m.size).toBe(0);
  });

  it("still returns disk metrics when /api/ps fails (loaded defaults false)", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/ps")) return Promise.reject(new Error("ps down"));
      if (url.endsWith("/api/tags"))
        return Promise.resolve(
          jsonResp({
            models: [
              { name: "gpt-oss:20b", size: 13_800_000_000, details: { parameter_size: "20.9B", quantization_level: "MXFP4" } },
            ],
          }),
        );
      return Promise.reject(new Error("x"));
    });
    const m = await fetchLocalModelMetrics();
    const gpt = metricsFor(m, "gpt-oss:20b")!;
    expect(gpt.gbOnDisk).toBe(13.8);
    expect(gpt.parameterSize).toBe("20.9B");
    expect(gpt.loaded).toBe(false);
    expect(gpt.vramGb).toBeNull();
  });

  it("reports null for a model with no size/details", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/ps")) return Promise.resolve(jsonResp({ models: [] }));
      if (url.endsWith("/api/tags"))
        return Promise.resolve(jsonResp({ models: [{ name: "x:1b" }] }));
      return Promise.reject(new Error("x"));
    });
    const m = await fetchLocalModelMetrics();
    const x = metricsFor(m, "x:1b")!;
    expect(x.gbOnDisk).toBeNull();
    expect(x.parameterSize).toBeNull();
    expect(x.quantization).toBeNull();
  });
});

// ── WARP-1827 — placement: where the loaded weights actually sit ──
//
// gpuFraction = min(1, size_vram/size) from /api/ps, threshold 0.9 — the SAME
// arithmetic as the appliance-side enforcement (inference-manager
// /health.placement, WARP-1825), so the two surfaces can never disagree.
// Placement is a property of a RUNNING model: unloaded rows carry null state.

describe("WARP-1827 — placement classification (Ollama)", () => {
  function route(ps: unknown, tags: unknown) {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/ps")) return Promise.resolve(jsonResp(ps));
      if (url.endsWith("/api/tags")) return Promise.resolve(jsonResp(tags));
      return Promise.reject(new Error("unexpected url"));
    });
  }
  const TAGS = { models: [{ name: "gpt-oss:20b", size: 13_800_000_000 }] };

  it("fully on the GPU (fraction ≥ 0.9) → placement 'gpu', measured", async () => {
    route(
      { models: [{ name: "gpt-oss:20b", size: 13_000_000_000, size_vram: 12_700_000_000 }] },
      TAGS,
    );
    const m = metricsFor(await fetchLocalModelMetrics(), "gpt-oss:20b")!;
    expect(m.placement).toBe("gpu");
    expect(m.gpuFraction).toBe(0.977);
    expect(m.placementState).toBe("measured");
  });

  it("split across GPU and CPU (0 < fraction < 0.9) → 'partial'", async () => {
    route(
      { models: [{ name: "gpt-oss:20b", size: 13_000_000_000, size_vram: 6_500_000_000 }] },
      TAGS,
    );
    const m = metricsFor(await fetchLocalModelMetrics(), "gpt-oss:20b")!;
    expect(m.placement).toBe("partial");
    expect(m.gpuFraction).toBe(0.5);
    expect(m.placementState).toBe("measured");
  });

  it("size_vram === 0 → 'cpu' with a measured zero fraction", async () => {
    route(
      { models: [{ name: "gpt-oss:20b", size: 13_000_000_000, size_vram: 0 }] },
      TAGS,
    );
    const m = metricsFor(await fetchLocalModelMetrics(), "gpt-oss:20b")!;
    expect(m.placement).toBe("cpu");
    expect(m.gpuFraction).toBe(0);
    expect(m.placementState).toBe("measured");
    // Existing vram semantics DON'T move: bytesToGb still folds 0 → null.
    expect(m.vramGb).toBeNull();
  });

  it("caps the fraction at 1 when size_vram exceeds size", async () => {
    route(
      { models: [{ name: "gpt-oss:20b", size: 13_000_000_000, size_vram: 13_500_000_000 }] },
      TAGS,
    );
    const m = metricsFor(await fetchLocalModelMetrics(), "gpt-oss:20b")!;
    expect(m.gpuFraction).toBe(1);
    expect(m.placement).toBe("gpu");
  });

  it("a loaded model whose ps entry omits size → null + 'unreported', never guessed", async () => {
    route(
      { models: [{ name: "gpt-oss:20b", size_vram: 12_700_000_000 }] },
      TAGS,
    );
    const m = metricsFor(await fetchLocalModelMetrics(), "gpt-oss:20b")!;
    expect(m.loaded).toBe(true);
    expect(m.placement).toBeNull();
    expect(m.gpuFraction).toBeNull();
    expect(m.placementState).toBe("unreported");
  });

  it("an unloaded model has no placement at all (null state — not a claim)", async () => {
    route({ models: [] }, TAGS);
    const m = metricsFor(await fetchLocalModelMetrics(), "gpt-oss:20b")!;
    expect(m.loaded).toBe(false);
    expect(m.placement).toBeNull();
    expect(m.gpuFraction).toBeNull();
    expect(m.placementState).toBeNull();
  });
});
