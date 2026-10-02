/**
 * WARP-3047 — the orchestrator's client for the inference-manager's
 * `POST /models/unload {keep}`: the lifecycle half of a real model swap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { unloadAllExcept } from "./model-residency.service.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INFERENCE_MANAGER_URL", "http://inference-manager:8002/");
  vi.stubEnv("INFERENCE_AUTH_TOKEN", "im-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("unloadAllExcept (WARP-3047)", () => {
  it("POSTs {keep} to the sidecar with its bearer and maps the report", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        unloaded: ["docker.io/ai/gpt-oss:20B-F16"],
        still_resident: [],
      }),
    );

    const report = await unloadAllExcept("docker.io/ai/qwen3:8B-Q4_K_M");

    expect(report).toEqual({ unloaded: ["docker.io/ai/gpt-oss:20B-F16"], stillResident: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://inference-manager:8002/models/unload");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ keep: "docker.io/ai/qwen3:8B-Q4_K_M" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer im-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a model still serving a request as still resident, not unloaded", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { unloaded: [], still_resident: ["docker.io/ai/gpt-oss:20B-F16"] }),
    );
    await expect(unloadAllExcept("b")).resolves.toEqual({
      unloaded: [],
      stillResident: ["docker.io/ai/gpt-oss:20B-F16"],
    });
  });

  it("tolerates a malformed body without inventing names", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unloaded: "nope", still_resident: [1, "a"] }));
    await expect(unloadAllExcept("b")).resolves.toEqual({ unloaded: [], stillResident: ["a"] });
  });

  it("throws on a non-2xx so the caller can decide how fatal it is", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(unloadAllExcept("b")).rejects.toThrow(/answered 502/);
  });

  it("sends no Authorization header when no token is configured", async () => {
    vi.stubEnv("INFERENCE_AUTH_TOKEN", "");
    fetchMock.mockResolvedValue(jsonResponse(200, { unloaded: [], still_resident: [] }));
    await unloadAllExcept("b");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
