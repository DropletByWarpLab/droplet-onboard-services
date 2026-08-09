/**
 * WARP-1749 — model-metrics: unknown is not zero, and a runtime that CANNOT
 * report a metric says so.
 *
 * The defect this file guards: Docker Model Runner answers the two
 * Ollama-shaped lifecycle endpoints with structurally empty numbers —
 * `/api/tags` reports `size: 0` for every model, always, and `/api/ps` never
 * populates `size_vram` on any accelerator (both measured live 2026-08-05
 * against docker/model-runner:v1.2.6). Read naively, a flipped box renders
 * "0 B" on the WARP-836 honest-metrics surface: a confident wrong number on
 * the one page whose selling point is that it doesn't do that.
 *
 * Two things are asserted throughout:
 *   - a missing number stays null and carries an explicit reason, and
 *   - the Ollama path does not move (same two requests, same values).
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

/**
 * Route the three endpoints by path. `native` is DMR's own `GET /models` —
 * pass `undefined` to make it 500, or an Error to make the request reject.
 */
function routeFetch(opts: {
  ps?: unknown;
  tags?: unknown;
  native?: unknown | Error;
}) {
  fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/api/ps")) return Promise.resolve(jsonResp(opts.ps ?? { models: [] }));
    if (u.endsWith("/api/tags")) return Promise.resolve(jsonResp(opts.tags ?? { models: [] }));
    if (u.endsWith("/models")) {
      if (opts.native instanceof Error) return Promise.reject(opts.native);
      if (opts.native === undefined) return Promise.resolve(jsonResp({}, false));
      return Promise.resolve(jsonResp(opts.native));
    }
    return Promise.reject(new Error(`unexpected url: ${u}`));
  });
}

/** What DMR's ollama-compat surface actually returns for a healthy model:
 *  fully-qualified id, size hard-zero, ps entry with no size_vram key. */
const DMR_TAGS = {
  models: [{ name: "docker.io/ai/smollm2:latest", size: 0 }],
};
const DMR_PS = {
  models: [{ name: "docker.io/ai/smollm2:latest", model: "docker.io/ai/smollm2:latest" }],
};

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("DMR runtime — a structural gap is reported as unsupported, never as 0", () => {
  beforeEach(() => {
    vi.stubEnv("INFERENCE_RUNTIME", "dmr");
  });

  it("never turns `size: 0` into a 0 GB disk figure", async () => {
    routeFetch({ tags: DMR_TAGS, ps: { models: [] }, native: undefined });
    const m = metricsFor(await fetchLocalModelMetrics(), "docker.io/ai/smollm2:latest")!;
    // The bug in one assertion: 0 must not survive as a number.
    expect(m.gbOnDisk).toBeNull();
    expect(m.gbOnDisk).not.toBe(0);
    // …and the reason is stated, not left to the reader.
    expect(m.gbOnDiskState).toBe("unsupported");
  });

  it("never reports a VRAM figure for a resident model — /api/ps has no such field", async () => {
    routeFetch({ tags: DMR_TAGS, ps: DMR_PS, native: undefined });
    const m = metricsFor(await fetchLocalModelMetrics(), "docker.io/ai/smollm2:latest")!;
    expect(m.loaded).toBe(true); // residency IS knowable on DMR…
    expect(m.vramGb).toBeNull(); // …the number behind it is not
    expect(m.vramGb).not.toBe(0);
    expect(m.vramState).toBe("unsupported");
  });

  it("recovers a real disk size from the native GET /models human string", async () => {
    routeFetch({
      tags: DMR_TAGS,
      ps: DMR_PS,
      native: [
        {
          id: "sha256:abc",
          tags: ["ai/smollm2:latest"],
          config: { size: "12.5 GiB", parameters: "360.82 M", quantization: "Q4_K_M" },
        },
      ],
    });
    const m = metricsFor(await fetchLocalModelMetrics(), "docker.io/ai/smollm2:latest")!;
    expect(m.gbOnDisk).toBe(13.4); // 12.5 GiB → 13.42 GB, one decimal
    expect(m.gbOnDiskState).toBe("measured");
    // Same payload, same defensiveness: these fill a gap /api/tags left.
    expect(m.parameterSize).toBe("360.82 M");
    expect(m.quantization).toBe("Q4_K_M");
    // VRAM is still structurally absent — a native size doesn't change that.
    expect(m.vramState).toBe("unsupported");
  });

  it("joins the fully-qualified /api/tags id to the native listing's short reference", async () => {
    routeFetch({
      tags: { models: [{ name: "docker.io/ai/smollm2:latest", size: 0 }] },
      native: { models: [{ tags: ["ai/smollm2"], config: { size: "1.2 GB" } }] },
    });
    const m = metricsFor(await fetchLocalModelMetrics(), "docker.io/ai/smollm2:latest")!;
    expect(m.gbOnDisk).toBe(1.2);
  });

  it("declines to guess when two builds of one repository are installed", async () => {
    // Repository-level matching is a SECOND chance, not a free-for-all:
    // attributing one build's size to another build's row is the same class of
    // lie as printing 0.
    routeFetch({
      tags: { models: [{ name: "docker.io/ai/smollm2:latest", size: 0 }] },
      native: [
        { tags: ["ai/smollm2:360M-Q4_K_M"], config: { size: "0.4 GB" } },
        { tags: ["ai/smollm2:1.7B-Q8_0"], config: { size: "1.9 GB" } },
      ],
    });
    const m = metricsFor(await fetchLocalModelMetrics(), "docker.io/ai/smollm2:latest")!;
    expect(m.gbOnDisk).toBeNull();
    expect(m.gbOnDiskState).toBe("unsupported");
  });

  it("treats an unparseable native size as unknown, not as zero", async () => {
    routeFetch({
      tags: DMR_TAGS,
      native: [{ tags: ["ai/smollm2:latest"], config: { size: "unknown" } }],
    });
    const m = metricsFor(await fetchLocalModelMetrics(), "docker.io/ai/smollm2:latest")!;
    expect(m.gbOnDisk).toBeNull();
    expect(m.gbOnDiskState).toBe("unsupported");
  });

  it("survives an unreachable / unrecognised native listing without fabricating", async () => {
    for (const native of [new Error("ECONNREFUSED"), { unexpected: "shape" }]) {
      routeFetch({ tags: DMR_TAGS, native });
      const m = metricsFor(await fetchLocalModelMetrics(), "docker.io/ai/smollm2:latest")!;
      expect(m.gbOnDisk).toBeNull();
      expect(m.gbOnDiskState).toBe("unsupported");
    }
  });
});

describe("Ollama runtime — unchanged (WARP-1749 acceptance)", () => {
  const OLLAMA_TAGS = {
    models: [
      {
        name: "gpt-oss:20b",
        size: 13_800_000_000,
        details: { parameter_size: "20.9B", quantization_level: "MXFP4" },
      },
      { name: "llama3.2:3b", size: 2_000_000_000 },
    ],
  };
  const OLLAMA_PS = {
    models: [{ name: "gpt-oss:20b", size_vram: 12_700_000_000 }],
  };

  it("still reports the real numbers, and marks them measured", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "ollama");
    routeFetch({ tags: OLLAMA_TAGS, ps: OLLAMA_PS });
    const all = await fetchLocalModelMetrics();

    const gpt = metricsFor(all, "gpt-oss:20b")!;
    expect(gpt.gbOnDisk).toBe(13.8);
    expect(gpt.gbOnDiskState).toBe("measured");
    expect(gpt.parameterSize).toBe("20.9B");
    expect(gpt.quantization).toBe("MXFP4");
    expect(gpt.loaded).toBe(true);
    expect(gpt.vramGb).toBe(12.7);
    expect(gpt.vramState).toBe("measured");

    const llama = metricsFor(all, "llama3.2:3b")!;
    expect(llama.gbOnDisk).toBe(2);
    expect(llama.loaded).toBe(false);
    expect(llama.vramGb).toBeNull();
    // Not "unsupported": Ollama reports VRAM fine, this model just isn't
    // resident. The two must never collapse into one string on the card.
    expect(llama.vramState).toBe("unreported");
  });

  it("issues exactly the two requests it always did — no DMR-only traffic", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "ollama");
    routeFetch({ tags: OLLAMA_TAGS, ps: OLLAMA_PS });
    await fetchLocalModelMetrics();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/api/ps"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/tags"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/models"))).toBe(false);
  });

  it("an unrecognised INFERENCE_RUNTIME behaves as ollama, never as DMR", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "not-a-runtime");
    routeFetch({ tags: OLLAMA_TAGS, ps: OLLAMA_PS });
    const gpt = metricsFor(await fetchLocalModelMetrics(), "gpt-oss:20b")!;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(gpt.gbOnDisk).toBe(13.8);
    expect(gpt.vramState).toBe("measured");
  });

  it("a model Ollama listed without a size stays unknown-because-unreported", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "ollama");
    routeFetch({ tags: { models: [{ name: "x:1b" }] } });
    const x = metricsFor(await fetchLocalModelMetrics(), "x:1b")!;
    expect(x.gbOnDisk).toBeNull();
    // "unreported", not "unsupported": Ollama CAN report sizes, so this may
    // well be filled in on the next poll.
    expect(x.gbOnDiskState).toBe("unreported");
  });
});
