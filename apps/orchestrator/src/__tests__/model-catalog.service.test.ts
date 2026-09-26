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
  readPullRefusal,
} from "../services/model-catalog.service.js";

function jsonResp(body: unknown, ok = true, status?: number): Response {
  return {
    ok,
    status: status ?? (ok ? 200 : 500),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * A catalog entry as the sidecar reports it, every field populated.
 *
 * WARP-2129 — every value here is now one the sidecar can actually emit.
 * It previously carried `class: "flagship"` and `capabilities: ["chat", …]`,
 * neither of which is producible: `ManifestEntry.cls` is
 * `Literal["fast","balanced","smart"]`, and `chat` is a ROLE in the manifest
 * vocabulary, never a capability. A fixture is the closest thing this side of
 * the seam has to a spec for that payload, so a fabricated value here teaches
 * the wrong vocabulary to everything written against it. These values mirror
 * the real `gpt-oss:20b` entry in droplet-local-LLM
 * `models/model-manifest.json`.
 *
 * `pull_tag` was a fiction too, and a larger one: `/models/eligible` never
 * emitted the key at all, so the comment above this fixture described a
 * payload that had never existed. Fixed sidecar-side in droplet-local-LLM #53
 * — the field is real now. The `name` !== `pull_tag` divergence it exists to
 * carry is exercised at the route level in `models.routes.test.ts`
 * (`divergentCatalog`), not here.
 */
const FULL_ENTRY = {
  name: "gpt-oss:20b",
  pull_tag: "gpt-oss:20b",
  min_vram_gb: 14,
  class: "smart",
  default: true,
  display_name: "GPT-OSS 20B",
  maker: "OpenAI",
  description: "Everyday chat and agent tool use. The box's proven default.",
  capabilities: ["tools", "thinking"],
  roles: ["chat"],
  disk_gb: 13.8,
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

// ── WARP-3046 — the catalog says WHY it is empty (contract C1) ─────────────

describe("fetchEligibleCatalog — honesty flags (WARP-3046)", () => {
  it("passes vram_source, tags_unreachable and degraded_manifest through", async () => {
    fetchMock.mockResolvedValue(
      jsonResp({
        detected_vram_gb: 16,
        vram_source: "device_bridge",
        tags_unreachable: true,
        degraded_manifest: true,
        models: [FULL_ENTRY],
      }),
    );
    const catalog = await fetchEligibleCatalog();
    expect(catalog.detected_vram_gb).toBe(16);
    expect(catalog.vram_source).toBe("device_bridge");
    expect(catalog.tags_unreachable).toBe(true);
    expect(catalog.degraded_manifest).toBe(true);
  });

  it("keeps unknown VRAM null — never a fabricated 0", async () => {
    fetchMock.mockResolvedValue(
      jsonResp({ detected_vram_gb: null, vram_source: null, tags_unreachable: false, models: [] }),
    );
    const catalog = await fetchEligibleCatalog();
    expect(catalog.detected_vram_gb).toBeNull();
    expect(catalog.vram_source).toBeNull();
  });

  it("reads absent flags (an older sidecar) as false / null", async () => {
    fetchMock.mockResolvedValue(jsonResp({ detected_vram_gb: 16, models: [] }));
    const catalog = await fetchEligibleCatalog();
    expect(catalog.vram_source).toBeNull();
    expect(catalog.tags_unreachable).toBe(false);
    expect(catalog.degraded_manifest).toBe(false);
  });
});

// ── WARP-3046 — a refused pull, in the orchestrator's own words (contract C2) ──
//
// The sidecar is FastAPI, so every refusal arrives as `{"detail": X}`: X is
// the disk preflight's OBJECT on a 409 (which the dashboard rendered as a
// React child and crashed on), or the runtime's own body relayed as a STRING
// (DMR's `{"error":"Failed to pull model: …"}`) on anything else.

function refusal(status: number, body: unknown, raw = false): Response {
  return {
    ok: false,
    status,
    text: async () => (raw ? String(body) : JSON.stringify(body)),
  } as unknown as Response;
}

describe("readPullRefusal (WARP-3046)", () => {
  it("maps the sidecar's disk-preflight 409 to insufficient_disk with a STRING detail", async () => {
    const out = await readPullRefusal(
      refusal(409, { detail: { error: "insufficient_disk", needed_gb: 28.1, free_gb: 12.4 } }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toEqual({
      error: "insufficient_disk",
      detail: expect.any(String),
      needed_gb: 28.1,
      free_gb: 12.4,
    });
    expect(out.body.detail).toMatch(/28\.1 GB/);
    expect(out.body.detail).toMatch(/12\.4 GB/);
  });

  it("surfaces DMR's own pre-stream reason as a 502 pull_failed detail", async () => {
    const dmr = JSON.stringify({
      error: "Failed to pull model: reading model from registry: not found",
    });
    const out = await readPullRefusal(refusal(500, { detail: dmr }));
    expect(out).toEqual({
      status: 502,
      body: {
        error: "pull_failed",
        detail: "Failed to pull model: reading model from registry: not found",
      },
    });
  });

  it("surfaces a transport-level reason the sidecar relayed as plain text", async () => {
    const out = await readPullRefusal(refusal(502, { detail: "All connection attempts failed" }));
    expect(out.body).toEqual({ error: "pull_failed", detail: "All connection attempts failed" });
  });

  it("uses a non-JSON body verbatim", async () => {
    const out = await readPullRefusal(refusal(500, "upstream exploded", true));
    expect(out.body.detail).toBe("upstream exploded");
  });

  it("falls back to generic copy when there is no reason at all", async () => {
    const out = await readPullRefusal(refusal(500, "", true));
    expect(out.status).toBe(502);
    expect(out.body.error).toBe("pull_failed");
    expect(typeof out.body.detail).toBe("string");
    expect(out.body.detail.length).toBeGreaterThan(0);
  });

  it("never hands the dashboard a non-string detail", async () => {
    const out = await readPullRefusal(refusal(409, { detail: { error: "something_else" } }));
    expect(out.status).toBe(502);
    expect(typeof out.body.detail).toBe("string");
    expect(out.body.detail).toBe("something_else");
  });

  it("bounds an oversized reason", async () => {
    const out = await readPullRefusal(refusal(500, { detail: "x".repeat(5000) }));
    expect(out.body.detail.length).toBeLessThanOrEqual(500);
  });
});
