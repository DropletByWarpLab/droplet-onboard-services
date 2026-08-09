/**
 * WARP-1827 — model-catalog.service: the inference-manager catalog proxy.
 *
 * The orchestrator never decides what a box can run — the appliance-side
 * inference-manager (droplet-local-LLM, :8002) owns eligibility (VRAM gate,
 * disk preflight, pull execution). This service is a thin, honest proxy:
 *   - `fetchEligibleCatalog()` → GET /models/eligible, parsed tolerantly
 *     (missing fields become null/[] — never fabricated).
 *   - `openPullStream()` → POST /models/pull?stream=true, returning the RAW
 *     response so the route can pipe NDJSON through without buffering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchEligibleCatalog,
  openPullStream,
} from "../services/model-catalog.service.js";

function jsonResp(body: unknown, ok = true, status?: number): Response {
  return {
    ok,
    status: status ?? (ok ? 200 : 500),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A catalog entry as the sidecar reports it — every field present. */
const FULL_ENTRY = {
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
  pulled: false,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchEligibleCatalog", () => {
  it("GETs {base}/models/eligible on the default sidecar URL", async () => {
    fetchMock.mockResolvedValue(
      jsonResp({ detected_vram_gb: 16, models: [FULL_ENTRY] }),
    );
    await fetchEligibleCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://host.docker.internal:8002/models/eligible",
    );
  });

  it("respects INFERENCE_MANAGER_URL (trailing slash tolerated)", async () => {
    vi.stubEnv("INFERENCE_MANAGER_URL", "http://inference-manager:8002/");
    fetchMock.mockResolvedValue(jsonResp({ models: [] }));
    await fetchEligibleCatalog();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://inference-manager:8002/models/eligible");
  });

  it("sends no Authorization header when INFERENCE_AUTH_TOKEN is unset", async () => {
    fetchMock.mockResolvedValue(jsonResp({ models: [] }));
    await fetchEligibleCatalog();
    const [, init] = fetchMock.mock.calls[0];
    expect(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBeUndefined();
  });

  it("sends Authorization: Bearer when INFERENCE_AUTH_TOKEN is set", async () => {
    vi.stubEnv("INFERENCE_AUTH_TOKEN", "sekrit");
    fetchMock.mockResolvedValue(jsonResp({ models: [] }));
    await fetchEligibleCatalog();
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sekrit",
    );
  });

  it("parses a full entry through unchanged", async () => {
    fetchMock.mockResolvedValue(
      jsonResp({ detected_vram_gb: 16, models: [FULL_ENTRY] }),
    );
    const catalog = await fetchEligibleCatalog();
    expect(catalog.detected_vram_gb).toBe(16);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toEqual(FULL_ENTRY);
  });

  it("tolerates missing fields — nulls/[]/false, never fabricated", async () => {
    fetchMock.mockResolvedValue(
      jsonResp({ models: [{ name: "qwen3:14b" }] }),
    );
    const catalog = await fetchEligibleCatalog();
    expect(catalog.detected_vram_gb).toBeNull();
    const m = catalog.models[0];
    expect(m.name).toBe("qwen3:14b");
    expect(m.pull_tag).toBeNull();
    expect(m.min_vram_gb).toBeNull();
    expect(m.class).toBeNull();
    expect(m.default).toBe(false);
    expect(m.display_name).toBeNull();
    expect(m.maker).toBeNull();
    expect(m.description).toBeNull();
    expect(m.capabilities).toEqual([]);
    expect(m.roles).toEqual([]);
    expect(m.disk_gb).toBeNull();
    expect(m.pulled).toBe(false);
  });

  it("drops entries without a usable name — they can't be addressed", async () => {
    fetchMock.mockResolvedValue(
      jsonResp({
        models: [{ name: "  " }, { pulled: true }, FULL_ENTRY, "junk", null],
      }),
    );
    const catalog = await fetchEligibleCatalog();
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0].name).toBe("gpt-oss:20b");
  });

  it("returns an empty model list for a body with no models array", async () => {
    fetchMock.mockResolvedValue(jsonResp({ detected_vram_gb: 8 }));
    const catalog = await fetchEligibleCatalog();
    expect(catalog.models).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResp({ detail: "boom" }, false));
    await expect(fetchEligibleCatalog()).rejects.toThrow(/500/);
  });

  it("propagates a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));
    await expect(fetchEligibleCatalog()).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe("openPullStream", () => {
  it("POSTs {model} to /models/pull?stream=true with the NDJSON accept header", async () => {
    const raw = { ok: true, status: 200, body: {} } as unknown as Response;
    fetchMock.mockResolvedValue(raw);
    const ac = new AbortController();
    const resp = await openPullStream("qwen3:14b", ac.signal);
    // The raw response comes back UNCONSUMED — the route pipes the body.
    expect(resp).toBe(raw);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://host.docker.internal:8002/models/pull?stream=true",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ model: "qwen3:14b" });
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/x-ndjson");
  });

  it("threads the caller's abort signal through to fetch", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const ac = new AbortController();
    await openPullStream("qwen3:14b", ac.signal);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(ac.signal);
  });

  it("carries the Bearer token when INFERENCE_AUTH_TOKEN is set", async () => {
    vi.stubEnv("INFERENCE_AUTH_TOKEN", "sekrit");
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await openPullStream("qwen3:14b", new AbortController().signal);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sekrit",
    );
  });
});
