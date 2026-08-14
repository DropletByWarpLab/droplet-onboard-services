/**
 * model-readiness.service — regression test for Ollama pull progress.
 *
 * Bug: the streaming-progress parser guarded on falsiness
 * (`if (ev.total && ev.completed)`). Ollama emits the first progress event
 * for each new blob/layer with `completed: 0`, which is falsy, so that event
 * was silently dropped — `model_pull_progress` was never logged at pct=0 for a
 * new layer, leaving the front-panel/dashboard progress bar frozen at the
 * previous layer's high-water mark on multi-layer pulls.
 *
 * Fix (two parts):
 *   1. Guard on null/undefined (`ev.total != null && ev.completed != null`) so
 *      `completed: 0` is forwarded as pct=0 instead of being dropped as falsy.
 *   2. The +10% log throttle (seeded at -1) also suppressed pct=0, and never
 *      re-logged when a new layer reset progress below the previous high-water
 *      mark. Seed at -10 (so the first event logs) and also log on a reset
 *      (`pct < lastLoggedPercent`) so each layer's 0% start is logged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture logger.info so we can assert the pct=0 progress line is emitted,
// and logger.debug for the WARP-1041 warm-swallow assertions. pino is the
// only logger this module constructs at load.
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());
vi.mock("pino", () => ({
  default: () => ({
    info: loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: loggerDebug,
  }),
}));

import {
  backgroundPull,
  ensureDefaultModelPulled,
  warmDefaultModel,
  resetWarmStateForTests,
  probeColdModel,
} from "./model-readiness.service.js";

/**
 * Build a fake streaming Response whose body yields the given NDJSON progress
 * events, mirroring Ollama's newline-delimited /api/pull stream.
 */
function streamingResponse(events: unknown[]): Response {
  const ndjson = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(ndjson);
  let delivered = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (delivered) {
              return Promise.resolve({ done: true, value: undefined });
            }
            delivered = true;
            return Promise.resolve({ done: false, value: bytes });
          },
        };
      },
    },
  } as unknown as Response;
}

/** Extract the `percent` field from every model_pull_progress log call. */
function loggedPercents(): number[] {
  return loggerInfo.mock.calls
    .filter((c) => c[1] === "model_pull_progress")
    .map((c) => (c[0] as { percent: number }).percent);
}

describe("model-readiness backgroundPull — progress forwarding", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    loggerInfo.mockReset();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("forwards a new-layer start event (total>0, completed===0) as pct=0", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      streamingResponse([
        // First event Ollama emits when it begins pulling a new blob/layer.
        { status: "pulling manifest", total: 4_000_000_000, completed: 0 },
        { status: "downloading", total: 4_000_000_000, completed: 2_000_000_000 },
        { status: "success" },
      ]),
    );

    await backgroundPull("gpt-oss:20b");

    // Regression: before the fix the completed:0 event was dropped, so the
    // first logged percent was 50, never 0.
    const percents = loggedPercents();
    expect(percents).toContain(0);
    expect(percents[0]).toBe(0);
  });

  it("re-logs each layer's 0% start on a multi-layer pull (throttle resets on progress decrease)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      streamingResponse([
        // Layer 1: 0% → 50% → 100%
        { status: "downloading", digest: "sha256:aaa", total: 1_000_000_000, completed: 0 },
        { status: "downloading", digest: "sha256:aaa", total: 1_000_000_000, completed: 500_000_000 },
        { status: "downloading", digest: "sha256:aaa", total: 1_000_000_000, completed: 1_000_000_000 },
        // Layer 2: resets to 0% → 100%. The 0% MUST log again — under the old
        // +10-only throttle (last=100) both of these were dropped, leaving the
        // log stuck at the previous layer's 100%.
        { status: "downloading", digest: "sha256:bbb", total: 2_000_000_000, completed: 0 },
        { status: "downloading", digest: "sha256:bbb", total: 2_000_000_000, completed: 2_000_000_000 },
        { status: "success" },
      ]),
    );

    await backgroundPull("gpt-oss:20b");

    expect(loggedPercents()).toEqual([0, 50, 100, 0, 100]);
  });

  it("does not log progress for events missing total/completed", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      streamingResponse([
        { status: "pulling manifest" },
        { status: "verifying sha256 digest" },
        { status: "success" },
      ]),
    );

    await backgroundPull("gpt-oss:20b");

    expect(loggedPercents()).toHaveLength(0);
  });
});

describe("model-readiness ensureDefaultModelPulled — vision model", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    loggerInfo.mockReset();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  /** URLs of every POST /api/pull request, with the requested model name. */
  function pullRequests(fetchMock: { mock: { calls: unknown[][] } }): string[] {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith("/api/pull"))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string).name);
  }

  it("pulls VISION_MODEL in addition to LLM_MODEL when both are missing", async () => {
    vi.stubEnv("LLM_MODEL", "mistral:7b-instruct");
    vi.stubEnv("VISION_MODEL", "llava:7b");

    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith("/api/tags")) {
        // Neither model present yet.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ models: [] }),
        } as unknown as Response);
      }
      // /api/pull — minimal streaming success.
      return Promise.resolve(streamingResponse([{ status: "success" }]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled();
    // Flush the fire-and-forget background pulls' first tick.
    await new Promise((r) => setTimeout(r, 0));

    const pulled = pullRequests(fetchMock);
    expect(pulled).toContain("mistral:7b-instruct");
    expect(pulled).toContain("llava:7b");
  });

  it("does not pull a model that is already present", async () => {
    vi.stubEnv("LLM_MODEL", "mistral:7b-instruct");
    vi.stubEnv("VISION_MODEL", "llava:7b");

    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith("/api/tags")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ models: [{ name: "mistral:7b-instruct" }] }),
        } as unknown as Response);
      }
      return Promise.resolve(streamingResponse([{ status: "success" }]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled();
    await new Promise((r) => setTimeout(r, 0));

    const pulled = pullRequests(fetchMock);
    expect(pulled).toEqual(["llava:7b"]); // only the missing one
  });
});

// ──────────────────────────────────────────────────────────────────
// WARP-1041 — warmDefaultModel: pre-load the configured chat model
// into GPU memory so the wizard's first "Ask the AI" doesn't eat the
// 30-90 s cold load behind a frozen "Thinking…" button.
// ──────────────────────────────────────────────────────────────────

/** Model names of every warm request (POST /v1/chat/completions — the
 *  runtime-agnostic warm path, WARP-1772). */
function warmRequests(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith("/v1/chat/completions"))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string).model);
}

function okJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

describe("model-readiness warmDefaultModel (WARP-1041)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    loggerInfo.mockReset();
    loggerDebug.mockReset();
    resetWarmStateForTests();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("POSTs the OpenAI chat path with max_tokens=1 and NO keep_alive (runtime-agnostic warm, WARP-1772)", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okJsonResponse());

    await warmDefaultModel();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // /v1/chat/completions is the only load-triggering request BOTH runtimes
    // serve — Ollama's empty-prompt /v1/chat/completions no-op 404s on DMR, which
    // silently killed pre-warm on a flipped box (found in the flip audit).
    expect(String(url)).toMatch(/\/v1\/chat\/completions$/);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // A keep_alive key would override the runtime's residency policy, so the
    // body carries exactly: the model, a one-word prompt, a 1-token budget.
    expect(body).toEqual({
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
  });

  it("is a no-op when LLM_MODEL is unset", async () => {
    vi.stubEnv("LLM_MODEL", "");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    await warmDefaultModel();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debounces: a second trigger within 10 minutes does not re-fetch, a later one does", async () => {
    vi.useFakeTimers();
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okJsonResponse());

    await warmDefaultModel();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 5 min later — inside the window, debounced.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await warmDefaultModel();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 6 more min (11 total) — outside the window, fires again.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await warmDefaultModel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows a 404 (model not pulled yet) with a debug log, and lets the NEXT trigger retry", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "model not found" }),
    } as unknown as Response);

    await expect(warmDefaultModel()).resolves.toBeUndefined();
    expect(loggerDebug).toHaveBeenCalled();

    // A failed attempt must NOT hold the 10-min debounce — otherwise the
    // pull-complete hook that fires minutes later would be silently
    // swallowed and the boot never warms (finding risk 3).
    await warmDefaultModel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drains the error body on a non-ok response (undici socket release)", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    // Under Node's undici fetch an undrained body can pin the socket until
    // GC — the 404 branch must consume it, same as the ok branch does.
    const json = vi.fn(() => Promise.resolve({ error: "model not found" }));
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json,
    } as unknown as Response);

    await warmDefaultModel();

    expect(json).toHaveBeenCalledTimes(1);
  });

  it("swallows a network error (ECONNREFUSED) non-fatally with a debug log", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(warmDefaultModel()).resolves.toBeUndefined();
    expect(loggerDebug).toHaveBeenCalled();

    // Retryable on the next trigger, same as the 404 case.
    await warmDefaultModel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("model-readiness warm hooks (WARP-1041)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    loggerInfo.mockReset();
    loggerDebug.mockReset();
    resetWarmStateForTests();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  /** Fetch router: tags list, streaming pull success, warm 200. */
  function routedFetch(presentModels: string[]) {
    return vi.fn((url: string) => {
      const u = String(url);
      if (u.endsWith("/api/tags")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ models: presentModels.map((name) => ({ name })) }),
        } as unknown as Response);
      }
      if (u.endsWith("/v1/chat/completions")) {
        return Promise.resolve(okJsonResponse());
      }
      return Promise.resolve(streamingResponse([{ status: "success" }]));
    });
  }

  it("startup: warms when the default chat model is already present", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    vi.stubEnv("VISION_MODEL", "");
    const fetchMock = routedFetch(["gpt-oss:20b"]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled();
    await new Promise((r) => setTimeout(r, 0));

    expect(warmRequests(fetchMock)).toEqual(["gpt-oss:20b"]);
  });

  it("startup: does NOT warm when only the vision model is present (chat model still pulling)", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    vi.stubEnv("VISION_MODEL", "llava:7b");
    // The chat model's pull stays IN PROGRESS (no "success" event) so the
    // only warm that could fire here is the present-branch one under test —
    // the pull-complete hook (covered below) must not muddy this assertion.
    const fetchMock = vi.fn((url: string) => {
      const u = String(url);
      if (u.endsWith("/api/tags")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ models: [{ name: "llava:7b" }] }),
        } as unknown as Response);
      }
      if (u.endsWith("/v1/chat/completions")) {
        return Promise.resolve(okJsonResponse());
      }
      return Promise.resolve(
        streamingResponse([
          { status: "downloading", total: 1_000, completed: 0 },
        ]),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled();
    await new Promise((r) => setTimeout(r, 0));

    // The chat model is mid-pull; warming now would 404. The
    // pull-complete hook owns that boot's warm instead.
    expect(warmRequests(fetchMock)).toEqual([]);
  });

  it("backgroundPull: warms right after model_pull_complete for the default model", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = routedFetch([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await backgroundPull("gpt-oss:20b");
    await new Promise((r) => setTimeout(r, 0));

    expect(warmRequests(fetchMock)).toEqual(["gpt-oss:20b"]);
  });

  it("backgroundPull: does not warm after pulling a non-default model", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = routedFetch([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await backgroundPull("llava:7b");
    await new Promise((r) => setTimeout(r, 0));

    expect(warmRequests(fetchMock)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// WARP-903 — probeColdModel: one-shot "is this model cold?" check
// backing the /api/llm/chat `model_loading` SSE event. Reads Ollama's
// documented lifecycle endpoints directly (GET /api/ps = loaded-in-
// memory, GET /api/tags = installed-on-disk + size); chat traffic
// itself never routes through here. Contract: NEVER throws — every
// failure mode degrades to null (= "don't claim anything").
// ──────────────────────────────────────────────────────────────────

describe("model-readiness probeColdModel (WARP-903)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    loggerDebug.mockReset();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  /**
   * Fetch router for the two probe endpoints. `loaded` feeds /api/ps,
   * `installed` feeds /api/tags; pass an Error to make that endpoint
   * reject, or `{ status }` to answer non-2xx.
   */
  function probeFetch(opts: {
    loaded?: unknown[] | Error | { status: number };
    installed?: unknown[] | Error | { status: number };
  }) {
    const respond = (
      v: unknown[] | Error | { status: number } | undefined,
    ): Promise<Response> => {
      if (v instanceof Error) return Promise.reject(v);
      if (v && !Array.isArray(v) && typeof v === "object" && "status" in v) {
        return Promise.resolve({
          ok: false,
          status: v.status,
          json: () => Promise.resolve({}),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ models: v ?? [] }),
      } as unknown as Response);
    };
    return vi.fn((url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/ps")) return respond(opts.loaded);
      if (u.endsWith("/api/tags")) return respond(opts.installed);
      return Promise.reject(new Error(`unexpected probe fetch: ${u}`));
    });
  }

  it("reports a model that is installed but not loaded as cold, with its size in GB", async () => {
    global.fetch = probeFetch({
      loaded: [],
      installed: [{ name: "gpt-oss:20b", size: 13_780_000_000 }],
    }) as unknown as typeof fetch;

    await expect(probeColdModel("gpt-oss:20b")).resolves.toEqual({
      model: "gpt-oss:20b",
      sizeGb: 13.8,
    });
  });

  it("returns null when the model is already loaded (warm)", async () => {
    global.fetch = probeFetch({
      loaded: [{ name: "gpt-oss:20b", size: 13_780_000_000 }],
      installed: [{ name: "gpt-oss:20b", size: 13_780_000_000 }],
    }) as unknown as typeof fetch;

    await expect(probeColdModel("gpt-oss:20b")).resolves.toBeNull();
  });

  it("returns null for a model Ollama does not host (cloud model / not yet pulled)", async () => {
    global.fetch = probeFetch({
      loaded: [],
      installed: [{ name: "gpt-oss:20b", size: 13_780_000_000 }],
    }) as unknown as typeof fetch;

    // A cloud-provider id (or a model mid-pull) must not produce a
    // "loading" claim the stream can never clear honestly.
    await expect(probeColdModel("claude-sonnet-4")).resolves.toBeNull();
  });

  it("treats a bare name and its :latest tag as the same model", async () => {
    global.fetch = probeFetch({
      loaded: [],
      installed: [{ name: "qwen3:latest", size: 5_200_000_000 }],
    }) as unknown as typeof fetch;

    // Ollama canonicalises "qwen3" → "qwen3:latest"; the probe must too.
    await expect(probeColdModel("qwen3")).resolves.toEqual({
      model: "qwen3",
      sizeGb: 5.2,
    });
  });

  it("reports sizeGb null when /api/tags carries no size for the model", async () => {
    global.fetch = probeFetch({
      loaded: [],
      installed: [{ name: "gpt-oss:20b" }],
    }) as unknown as typeof fetch;

    await expect(probeColdModel("gpt-oss:20b")).resolves.toEqual({
      model: "gpt-oss:20b",
      sizeGb: null,
    });
  });

  it("returns null (never throws) when Ollama is unreachable", async () => {
    global.fetch = probeFetch({
      loaded: new Error("connect ECONNREFUSED"),
      installed: new Error("connect ECONNREFUSED"),
    }) as unknown as typeof fetch;

    await expect(probeColdModel("gpt-oss:20b")).resolves.toBeNull();
  });

  it("returns null when either endpoint answers non-2xx", async () => {
    global.fetch = probeFetch({
      loaded: { status: 500 },
      installed: [{ name: "gpt-oss:20b", size: 13_780_000_000 }],
    }) as unknown as typeof fetch;

    // /api/ps failed — we cannot know loadedness, so claim nothing.
    await expect(probeColdModel("gpt-oss:20b")).resolves.toBeNull();
  });

  it("passes an abort signal to both probe requests (time-budgeted, non-blocking)", async () => {
    const fetchMock = probeFetch({
      loaded: [],
      installed: [{ name: "gpt-oss:20b", size: 13_780_000_000 }],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await probeColdModel("gpt-oss:20b");

    // Both requests ride a shared timeout signal so a hung Ollama can
    // only ever cost the probe budget, never the chat turn.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("drains the fulfilled body when the sibling probe fetch rejects (undici socket release)", async () => {
    // Asymmetric failure: /api/ps socket-resets while /api/tags returns 200.
    // Promise.all would reject on the /api/ps rejection and leave the
    // already-resolved /api/tags body unconsumed — under undici an undrained
    // body can pin the socket until GC. allSettled + an explicit drain of the
    // fulfilled sibling releases it; the probe still claims nothing → null.
    // Mirrors the warm-path drain regression above.
    const tagsJson = vi.fn(() =>
      Promise.resolve({
        models: [{ name: "gpt-oss:20b", size: 13_780_000_000 }],
      }),
    );
    const fetchMock = vi.fn((url: string) => {
      const u = String(url);
      if (u.endsWith("/api/ps")) {
        return Promise.reject(new Error("socket hang up"));
      }
      // /api/tags resolved 2xx — its body MUST be drained before we bail.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: tagsJson,
      } as unknown as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(probeColdModel("gpt-oss:20b")).resolves.toBeNull();

    // The resolved /api/tags body was consumed exactly once — no leak.
    expect(tagsJson).toHaveBeenCalledTimes(1);
  });
});
