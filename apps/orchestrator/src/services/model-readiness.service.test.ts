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
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("pino", () => ({
  default: () => ({
    info: loggerInfo,
    warn: loggerWarn,
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
  probeModelResidency,
  warmModelIfCold,
  onDemandWarmState,
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

/** WARP-3047 — the injected active-model resolver: a fixed answer. */
const activeIs = (model: string | null) => async () => model;

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

    await ensureDefaultModelPulled(activeIs("mistral:7b-instruct"));
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

    await ensureDefaultModelPulled(activeIs("mistral:7b-instruct"));
    await new Promise((r) => setTimeout(r, 0));

    const pulled = pullRequests(fetchMock);
    expect(pulled).toEqual(["llava:7b"]); // only the missing one
  });
});

// ──────────────────────────────────────────────────────────────────
// WARP-1041 — warmDefaultModel: pre-load the chat model into GPU
// memory so the wizard's first "Ask the AI" doesn't eat the 30-90 s
// cold load behind a frozen "Thinking…" button. WARP-3047: the caller
// names the model (the box's ACTIVE model), and the debounce is per model.
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
    loggerWarn.mockReset();
    resetWarmStateForTests();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("POSTs the OpenAI chat path with max_tokens=1 and NO keep_alive (runtime-agnostic warm, WARP-1772)", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okJsonResponse());

    await warmDefaultModel("gpt-oss:20b");

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

  it("warms the model it is GIVEN, never env LLM_MODEL (WARP-3047)", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okJsonResponse());

    await warmDefaultModel("qwen3:8b");

    expect(warmRequests(fetchMock)).toEqual(["qwen3:8b"]);
  });

  it("is a no-op when no model resolved (null, undefined, blank)", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    await warmDefaultModel(null);
    await warmDefaultModel(undefined);
    await warmDefaultModel("   ");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("debounces: a second trigger within 10 minutes does not re-fetch, a later one does", async () => {
    vi.useFakeTimers();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okJsonResponse());

    await warmDefaultModel("gpt-oss:20b");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 5 min later — inside the window, debounced.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await warmDefaultModel("gpt-oss:20b");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 6 more min (11 total) — outside the window, fires again.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await warmDefaultModel("gpt-oss:20b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("debounces PER MODEL: a login warm of A never swallows the switch's warm of B (WARP-3047)", async () => {
    vi.useFakeTimers();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okJsonResponse());

    await warmDefaultModel("gpt-oss:20b"); // the login warm
    await vi.advanceTimersByTimeAsync(60_000);
    await warmDefaultModel("qwen3:8b"); // the owner switches a minute later
    await warmDefaultModel("gpt-oss:20b"); // A itself is still debounced

    expect(warmRequests(fetchMock)).toEqual(["gpt-oss:20b", "qwen3:8b"]);
  });

  it("force: an explicit model switch warms even inside the debounce window (WARP-3047)", async () => {
    // A→B→A→B within ten minutes: B's earlier warm is stale — the swap back
    // to A unloaded it — so the owner's switch must not be debounced away.
    vi.useFakeTimers();
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(okJsonResponse());

    await warmDefaultModel("qwen3:8b");
    await vi.advanceTimersByTimeAsync(60_000);
    await warmDefaultModel("qwen3:8b"); // login/setup trigger: debounced
    await warmDefaultModel("qwen3:8b", { force: true }); // the switch: not

    expect(warmRequests(fetchMock)).toEqual(["qwen3:8b", "qwen3:8b"]);
  });

  it("logs a non-2xx at WARN with the status and the runtime's reason, and lets the NEXT trigger retry", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: () =>
        Promise.resolve(
          "unable to load runner: not enough GPU memory to load the model (CUDA)",
        ),
    } as unknown as Response);

    await expect(warmDefaultModel("gpt-oss:20b")).resolves.toBeUndefined();
    // WARP-3047: a warm that fails to LOAD is the out-of-memory signal —
    // debug level hid it entirely.
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [fields] = loggerWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ model: "gpt-oss:20b", status: 500 });
    expect(String(fields.detail)).toContain("not enough GPU memory");

    // A failed attempt must NOT hold the 10-min debounce — otherwise the
    // pull-complete hook that fires minutes later would be silently
    // swallowed and the boot never warms (finding risk 3).
    await warmDefaultModel("gpt-oss:20b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drains the error body on a non-ok response (undici socket release)", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    // Under Node's undici fetch an undrained body can pin the socket until
    // GC — the non-2xx branch must consume it, same as the ok branch does.
    const text = vi.fn(() => Promise.resolve("model not found"));
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text,
    } as unknown as Response);

    await warmDefaultModel("gpt-oss:20b");

    expect(text).toHaveBeenCalledTimes(1);
  });

  it("swallows a network error (ECONNREFUSED) non-fatally with a debug log", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(warmDefaultModel("gpt-oss:20b")).resolves.toBeUndefined();
    expect(loggerDebug).toHaveBeenCalled();

    // Retryable on the next trigger, same as the non-2xx case.
    await warmDefaultModel("gpt-oss:20b");
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

  it("startup: warms when the active chat model is already present", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    vi.stubEnv("VISION_MODEL", "");
    const fetchMock = routedFetch(["gpt-oss:20b"]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled(activeIs("gpt-oss:20b"));
    await new Promise((r) => setTimeout(r, 0));

    expect(warmRequests(fetchMock)).toEqual(["gpt-oss:20b"]);
  });

  it("startup: warms the ACTIVE model — not LLM_MODEL — when the owner switched (WARP-3047)", async () => {
    // LLM_MODEL is still provisioned (the env loop checks it), but the box
    // answers with B: warming A here would load it next to B on DMR.
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    vi.stubEnv("VISION_MODEL", "");
    const fetchMock = routedFetch(["gpt-oss:20b", "qwen3:8b"]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled(activeIs("qwen3:8b"));
    await new Promise((r) => setTimeout(r, 0));

    expect(warmRequests(fetchMock)).toEqual(["qwen3:8b"]);
  });

  it("startup: nothing resolved → no warm", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    vi.stubEnv("VISION_MODEL", "");
    const fetchMock = routedFetch(["gpt-oss:20b"]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureDefaultModelPulled(activeIs(null));
    await new Promise((r) => setTimeout(r, 0));

    expect(warmRequests(fetchMock)).toEqual([]);
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

    await ensureDefaultModelPulled(activeIs("gpt-oss:20b"));
    await new Promise((r) => setTimeout(r, 0));

    // The chat model is mid-pull; warming now would 404. The
    // pull-complete hook owns that boot's warm instead.
    expect(warmRequests(fetchMock)).toEqual([]);
  });

  it("backgroundPull: warms right after model_pull_complete when the pulled model is the ACTIVE one", async () => {
    const fetchMock = routedFetch([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await backgroundPull("gpt-oss:20b", activeIs("gpt-oss:20b"));
    await new Promise((r) => setTimeout(r, 0));

    expect(warmRequests(fetchMock)).toEqual(["gpt-oss:20b"]);
  });

  it("backgroundPull: does not warm after pulling a model that is not the active one", async () => {
    vi.stubEnv("LLM_MODEL", "llava:7b");
    const fetchMock = routedFetch([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await backgroundPull("llava:7b", activeIs("gpt-oss:20b"));
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

// ──────────────────────────────────────────────────────────────────
// WARP-3127 — warm on wake. The voice module asks the orchestrator to load
// the active model the moment the wake word is heard, so the (re)load
// overlaps the user speaking + STT instead of landing after them. The 5 min
// residency (WARP-1826) is untouched: this is probe-first, never sets
// keep_alive, and never uses warmDefaultModel's 10-minute debounce.
// ──────────────────────────────────────────────────────────────────

type ListAnswer = unknown[] | Error | { status: number };

/**
 * Runtime fetch router for the on-demand path: /api/ps + /api/tags feed the
 * residency probe, /v1/chat/completions is the warm. `warm` defaults to 200;
 * pass a function to control when (or whether) the load finishes.
 */
function runtimeFetch(opts: {
  loaded?: ListAnswer;
  installed?: ListAnswer;
  warm?: () => Promise<Response>;
}) {
  const respond = (v: ListAnswer | undefined): Promise<Response> => {
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
    if (u.endsWith("/v1/chat/completions")) {
      return opts.warm ? opts.warm() : Promise.resolve(okJsonResponse());
    }
    return Promise.reject(new Error(`unexpected runtime fetch: ${u}`));
  });
}

/** A warm whose load the test finishes by hand — models a 30-90 s cold load. */
function deferredWarm() {
  let finish: (r: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  return { warm: () => pending, finish: () => finish(okJsonResponse()) };
}

function probeRequests(fetchMock: { mock: { calls: unknown[][] } }): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/ps")).length;
}

const GPT = "gpt-oss:20b";

describe("model-readiness probeModelResidency (WARP-3127)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    loggerDebug.mockReset();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("'loaded' when /api/ps lists the model", async () => {
    global.fetch = runtimeFetch({
      loaded: [{ name: GPT }],
      installed: [{ name: GPT }],
    }) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("loaded");
  });

  it("'cold' when the model is installed (/api/tags) but not loaded (/api/ps)", async () => {
    global.fetch = runtimeFetch({ loaded: [], installed: [{ name: GPT }] }) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("cold");
  });

  it("'unknown' — never 'loaded' — when the runtime is unreachable", async () => {
    global.fetch = runtimeFetch({
      loaded: new Error("connect ECONNREFUSED"),
      installed: new Error("connect ECONNREFUSED"),
    }) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("unknown");
  });

  it("'unknown' when /api/ps answers non-2xx (loadedness cannot be known)", async () => {
    global.fetch = runtimeFetch({ loaded: { status: 500 }, installed: [{ name: GPT }] }) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("unknown");
  });

  it("'unknown' when the model is neither loaded nor listed in /api/tags", async () => {
    global.fetch = runtimeFetch({ loaded: [], installed: [{ name: "qwen3:8b" }] }) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("unknown");
  });

  it("'unknown' when /api/tags fails and the model is not loaded", async () => {
    global.fetch = runtimeFetch({ loaded: [], installed: { status: 503 } }) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("unknown");
  });

  it("matches DMR's registry-qualified ids against a non-qualified model (docker.io/ai/... vs ai/...)", async () => {
    // DMR reports `docker.io/ai/<name>:<tag>` from /api/ps and /api/tags
    // (ADR-036). A stored / fallback id without the registry host is the
    // same model and must read as loaded, or every wake would reload it.
    global.fetch = runtimeFetch({
      loaded: [{ name: "docker.io/ai/gpt-oss:20B-F16", model: "docker.io/ai/gpt-oss:20B-F16" }],
      installed: [{ name: "docker.io/ai/gpt-oss:20B-F16" }],
    }) as unknown as typeof fetch;
    await expect(probeModelResidency("ai/gpt-oss:20B-F16")).resolves.toBe("loaded");

    global.fetch = runtimeFetch({
      loaded: [],
      installed: [{ name: "docker.io/ai/smollm2:latest" }],
    }) as unknown as typeof fetch;
    await expect(probeModelResidency("ai/smollm2")).resolves.toBe("cold");
  });

  it("reads the /api/ps `model` key when `name` is absent", async () => {
    global.fetch = runtimeFetch({ loaded: [{ model: GPT }], installed: [{ name: GPT }] }) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("loaded");
  });

  it("treats a bare name and its :latest tag as the same model (Ollama canonicalisation)", async () => {
    global.fetch = runtimeFetch({ loaded: [{ name: "qwen3:latest" }], installed: [] }) as unknown as typeof fetch;
    await expect(probeModelResidency("qwen3")).resolves.toBe("loaded");
  });

  it("time-budgets both probe requests with an abort signal", async () => {
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }] });
    global.fetch = fetchMock as unknown as typeof fetch;
    await probeModelResidency(GPT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("drains the resolved sibling body when the other probe request rejects", async () => {
    const tagsJson = vi.fn(() => Promise.resolve({ models: [{ name: GPT }] }));
    global.fetch = vi.fn((url: string) =>
      String(url).endsWith("/api/ps")
        ? Promise.reject(new Error("socket hang up"))
        : Promise.resolve({ ok: true, status: 200, json: tagsJson } as unknown as Response),
    ) as unknown as typeof fetch;
    await expect(probeModelResidency(GPT)).resolves.toBe("unknown");
    expect(tagsJson).toHaveBeenCalledTimes(1);
  });
});

describe("model-readiness warmModelIfCold — on-demand warm (WARP-3127)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    loggerInfo.mockReset();
    loggerDebug.mockReset();
    loggerWarn.mockReset();
    resetWarmStateForTests();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
  });

  it("cold: issues ONE runtime-agnostic warm with no keep_alive, and logs it at info", async () => {
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }] });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(warmModelIfCold(GPT)).resolves.toBe("warmed");

    const warms = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/v1/chat/completions"));
    expect(warms).toHaveLength(1);
    // Residency stays owned by OLLAMA_KEEP_ALIVE / the runtime (WARP-1826).
    expect(JSON.parse((warms[0]![1] as RequestInit).body as string)).toEqual({
      model: GPT,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
    expect(loggerInfo.mock.calls.map((c) => c[1])).toContain("model_warm_complete");
  });

  it("loaded: no warm, and only a debug line", async () => {
    const fetchMock = runtimeFetch({ loaded: [{ name: GPT }], installed: [{ name: GPT }] });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(warmModelIfCold(GPT)).resolves.toBe("loaded");

    expect(warmRequests(fetchMock)).toEqual([]);
    expect(loggerInfo).not.toHaveBeenCalled();
    expect(loggerDebug).toHaveBeenCalled();
  });

  it("does NOT use the 10-minute setup debounce: a cold model is warmed again on the next wake", async () => {
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }] });
    global.fetch = fetchMock as unknown as typeof fetch;

    await warmDefaultModel(GPT); // login / setup warm: stamps the 10-min debounce
    await warmModelIfCold(GPT); // model since unloaded, probe says cold
    await warmModelIfCold(GPT);

    expect(warmRequests(fetchMock)).toEqual([GPT, GPT, GPT]);
  });

  it("concurrent wakes share ONE probe and ONE load", async () => {
    const load = deferredWarm();
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }], warm: load.warm });
    global.fetch = fetchMock as unknown as typeof fetch;

    const calls = [warmModelIfCold(GPT), warmModelIfCold(GPT), warmModelIfCold(GPT)];
    await vi.waitFor(() => expect(warmRequests(fetchMock)).toHaveLength(1));
    load.finish();

    await expect(Promise.all(calls)).resolves.toEqual(["warmed", "warmed", "warmed"]);
    expect(warmRequests(fetchMock)).toEqual([GPT]);
    expect(probeRequests(fetchMock)).toBe(1);
  });

  it("joins an in-flight login/setup warm of the same model instead of stacking a second load", async () => {
    const load = deferredWarm();
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }], warm: load.warm });
    global.fetch = fetchMock as unknown as typeof fetch;

    const login = warmDefaultModel(GPT);
    await vi.waitFor(() => expect(warmRequests(fetchMock)).toHaveLength(1));
    const wake = warmModelIfCold(GPT);
    load.finish();

    await login;
    await expect(wake).resolves.toBe("warmed");
    expect(warmRequests(fetchMock)).toEqual([GPT]);
    // The wake saw the load already under way, so it did not even probe.
    expect(probeRequests(fetchMock)).toBe(0);
  });

  it("a setup/login warm joins an in-flight on-demand warm of the same model", async () => {
    const load = deferredWarm();
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }], warm: load.warm });
    global.fetch = fetchMock as unknown as typeof fetch;

    const wake = warmModelIfCold(GPT);
    await vi.waitFor(() => expect(warmRequests(fetchMock)).toHaveLength(1));
    const login = warmDefaultModel(GPT, { force: true });
    load.finish();

    await Promise.all([wake, login]);
    expect(warmRequests(fetchMock)).toEqual([GPT]);
  });

  it("unknown residency: warms, unless a warm of that model completed in the last ~4 min", async () => {
    vi.useFakeTimers();
    // /api/ps unreachable: loadedness unknowable, /v1/chat/completions fine.
    const fetchMock = runtimeFetch({ loaded: new Error("ECONNRESET"), installed: new Error("ECONNRESET") });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(warmModelIfCold(GPT)).resolves.toBe("warmed");
    expect(warmRequests(fetchMock)).toHaveLength(1);

    // 3 min later: that warm left the model resident for at least another
    // minute of the 5 min residency, so no second load.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await expect(warmModelIfCold(GPT)).resolves.toBe("recently-warmed");
    expect(warmRequests(fetchMock)).toHaveLength(1);

    // 4.5 min after the warm: it may be about to expire, so warm again.
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(warmModelIfCold(GPT)).resolves.toBe("warmed");
    expect(warmRequests(fetchMock)).toHaveLength(2);
  });

  it("a recent warm of ANOTHER model does not suppress an unknown-residency warm", async () => {
    const fetchMock = runtimeFetch({ loaded: { status: 500 }, installed: [] });
    global.fetch = fetchMock as unknown as typeof fetch;

    await warmModelIfCold("qwen3:8b");
    await warmModelIfCold(GPT);

    expect(warmRequests(fetchMock)).toEqual(["qwen3:8b", GPT]);
  });

  it("runtime unreachable: resolves (never throws) as warm-failed, and the next wake retries", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.reject(new Error("connect ECONNREFUSED")),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(warmModelIfCold(GPT)).resolves.toBe("warm-failed");
    await expect(warmModelIfCold(GPT)).resolves.toBe("warm-failed");
    expect(warmRequests(fetchMock)).toEqual([GPT, GPT]);
    expect(loggerInfo.mock.calls.map((c) => c[1])).not.toContain("model_warm_complete");
  });

  it("a runtime that cannot load the model is a WARN (the out-of-memory signal), not a throw", async () => {
    const fetchMock = runtimeFetch({
      loaded: [],
      installed: [{ name: GPT }],
      warm: () =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("unable to load runner: not enough GPU memory"),
        } as unknown as Response),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(warmModelIfCold(GPT)).resolves.toBe("warm-failed");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("no model resolved: no runtime traffic at all", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(warmModelIfCold(null)).resolves.toBe("no-model");
    await expect(warmModelIfCold("  ")).resolves.toBe("no-model");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("model-readiness onDemandWarmState — the 202's advisory state (WARP-3127)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    resetWarmStateForTests();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
  });

  it("'unknown' before anything is known", () => {
    expect(onDemandWarmState()).toBe("unknown");
  });

  it("'warming' while a load is in flight, 'warm' once it completes, 'unknown' again after ~4 min", async () => {
    vi.useFakeTimers();
    const load = deferredWarm();
    const fetchMock = runtimeFetch({ loaded: [], installed: [{ name: GPT }], warm: load.warm });
    global.fetch = fetchMock as unknown as typeof fetch;

    const wake = warmModelIfCold(GPT);
    await vi.waitFor(() => expect(warmRequests(fetchMock)).toHaveLength(1));
    expect(onDemandWarmState()).toBe("warming");

    load.finish();
    await wake;
    expect(onDemandWarmState()).toBe("warm");

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
    expect(onDemandWarmState()).toBe("unknown");
  });

  it("'warm' after the probe found the model resident", async () => {
    global.fetch = runtimeFetch({ loaded: [{ name: GPT }], installed: [{ name: GPT }] }) as unknown as typeof fetch;
    await warmModelIfCold(GPT);
    expect(onDemandWarmState()).toBe("warm");
  });
});
