/**
 * WARP-1749 — presence in /api/tags is not readiness.
 *
 * Under Ollama it is: a model is listed only once its blobs are written and
 * verified, and the entry carries a real byte count. Under Docker Model Runner
 * it is not. MEASURED (2026-08-05, docker/model-runner:v1.2.6): a corrupt blob
 * wedges the store — the pull fails on a digest mismatch, a retry fails
 * differently, and `/api/tags` then lists the model anyway at `size: 0`.
 * Because DMR reports `size: 0` for HEALTHY models too, the ollama-compatible
 * surface cannot tell a working model from a phantom, and first boot would
 * cheerfully log "ready" and warm something that can never load.
 *
 * The corroborating source is DMR's native `GET /models`, which reports a real
 * per-model size as a human string.
 *
 * The load-bearing half of this file is the Ollama half: the default runtime
 * must issue no extra request and take the same branch it always did.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());
vi.mock("pino", () => ({
  default: () => ({
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: loggerDebug,
  }),
}));

import {
  ensureDefaultModelPulled,
  resetWarmStateForTests,
  verifyListedModelServeable,
} from "./model-readiness.service.js";

const MODEL = "docker.io/ai/smollm2:latest";

/**
 * A pull stream. `outcome: "error"` reproduces what a wedged DMR store
 * actually does — the pull comes back reporting a digest mismatch — which is
 * also why no warm may follow it.
 */
function pullStream(outcome: "success" | "error"): Response {
  const event =
    outcome === "success"
      ? { status: "success" }
      : { status: "error", error: "digest mismatch" };
  const bytes = new TextEncoder().encode(JSON.stringify(event) + "\n");
  let delivered = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          delivered
            ? Promise.resolve({ done: true, value: undefined })
            : ((delivered = true), Promise.resolve({ done: false, value: bytes })),
      }),
    },
  } as unknown as Response;
}

/**
 * Route the daemon endpoints. `native` is DMR's own `GET /models`:
 *   - an array/object → served 200
 *   - `"down"`        → 500
 *   - `"unreachable"` → rejects
 */
function routedFetch(opts: {
  tags: string[];
  native?: unknown;
  pull?: "success" | "error";
}) {
  return vi.fn((url: string) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        // DMR's hard-coded zero, verbatim.
        json: () => Promise.resolve({ models: opts.tags.map((name) => ({ name, size: 0 })) }),
      } as unknown as Response);
    }
    if (u.endsWith("/api/generate")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as unknown as Response);
    }
    if (u.endsWith("/api/pull")) return Promise.resolve(pullStream(opts.pull ?? "success"));
    if (u.endsWith("/models")) {
      if (opts.native === "unreachable") return Promise.reject(new Error("ECONNREFUSED"));
      if (opts.native === "down") {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({}),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(opts.native),
      } as unknown as Response);
    }
    return Promise.reject(new Error(`unexpected url: ${u}`));
  });
}

const callsTo = (fetchMock: { mock: { calls: unknown[][] } }, suffix: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix));

const realFetch = global.fetch;

beforeEach(() => {
  loggerInfo.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
  loggerDebug.mockReset();
  resetWarmStateForTests();
});
afterEach(() => {
  global.fetch = realFetch;
  vi.unstubAllEnvs();
});

describe("Ollama — untouched (WARP-1749 acceptance)", () => {
  it("treats a listed model as ready WITHOUT any corroborating request", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "ollama");
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    vi.stubEnv("VISION_MODEL", "");
    const fetchMock = routedFetch({ tags: ["gpt-oss:20b"] });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled();
    await new Promise((r) => setTimeout(r, 0));

    // Exactly the two requests this path always made: the tags listing and the
    // WARP-1041 warm. No native listing, no pull.
    expect(callsTo(fetchMock, "/models")).toHaveLength(0);
    expect(callsTo(fetchMock, "/api/pull")).toHaveLength(0);
    expect(callsTo(fetchMock, "/api/generate")).toHaveLength(1);
  });

  it("verifyListedModelServeable() answers serveable with no network at all", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "ollama");
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(verifyListedModelServeable("gpt-oss:20b")).resolves.toBe("serveable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DMR — a listed model is corroborated against the native listing", () => {
  beforeEach(() => {
    vi.stubEnv("INFERENCE_RUNTIME", "dmr");
    vi.stubEnv("LLM_MODEL", MODEL);
    vi.stubEnv("VISION_MODEL", "");
  });

  it("a real size in the native listing means ready — warm, no pull", async () => {
    const fetchMock = routedFetch({
      tags: [MODEL],
      native: [{ tags: ["ai/smollm2:latest"], config: { size: "256.35 MiB" } }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled();
    await new Promise((r) => setTimeout(r, 0));

    expect(callsTo(fetchMock, "/api/pull")).toHaveLength(0);
    expect(callsTo(fetchMock, "/api/generate")).toHaveLength(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("a phantom (listed, absent from the store) is NOT ready: pull retried, never warmed", async () => {
    // The wedged store, end to end: /api/tags lists it, the native listing has
    // no copy, and the repair pull comes back on a digest mismatch.
    const fetchMock = routedFetch({ tags: [MODEL], native: [], pull: "error" });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled();
    await new Promise((r) => setTimeout(r, 0));

    expect(callsTo(fetchMock, "/api/pull")).toHaveLength(1);
    // Warming a model that cannot load just errors — and would mask the cause.
    // (Nothing warms off a FAILED pull either, which is the real sequence.)
    expect(callsTo(fetchMock, "/api/generate")).toHaveLength(0);
    // The operator has to be told, with the only recovery that works.
    const [, message] = loggerError.mock.calls[0] as [unknown, string];
    expect(message).toContain("model_listed_but_not_serveable");
    expect(message).toContain("docker model purge -f");
  });

  it("an entry with no usable size is a phantom too (0 B, garbage, missing)", async () => {
    for (const config of [{ size: "0 B" }, { size: "unknown" }, {}]) {
      loggerError.mockReset();
      const fetchMock = routedFetch({
        tags: [MODEL],
        native: [{ tags: ["ai/smollm2:latest"], config }],
        pull: "error",
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      resetWarmStateForTests();

      await ensureDefaultModelPulled();
      await new Promise((r) => setTimeout(r, 0));

      expect(callsTo(fetchMock, "/api/pull")).toHaveLength(1);
      expect(loggerError).toHaveBeenCalled();
    }
  });

  it("fails OPEN: an unreachable or unrecognised native listing keeps today's behaviour", async () => {
    for (const native of ["unreachable", "down", { unexpected: "shape" }]) {
      loggerError.mockReset();
      const fetchMock = routedFetch({ tags: [MODEL], native });
      global.fetch = fetchMock as unknown as typeof fetch;
      resetWarmStateForTests();

      await ensureDefaultModelPulled();
      await new Promise((r) => setTimeout(r, 0));

      // A probe outage must never trigger a pull storm against a store that is
      // probably fine — probes here are optimisations, not dependencies.
      expect(callsTo(fetchMock, "/api/pull")).toHaveLength(0);
      expect(callsTo(fetchMock, "/api/generate")).toHaveLength(1);
      expect(loggerError).not.toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalled();
    }
  });

  it("verifyListedModelServeable() never throws, whatever the daemon does", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "dmr");
    global.fetch = vi.fn(() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch;
    await expect(verifyListedModelServeable(MODEL)).resolves.toBe("unverified");
  });
});
