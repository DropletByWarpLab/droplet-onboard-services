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

// Capture logger.info so we can assert the pct=0 progress line is emitted.
// pino is the only logger this module constructs at load.
const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock("pino", () => ({
  default: () => ({
    info: loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  backgroundPull,
  ensureDefaultModelPulled,
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
  function pullRequests(fetchMock: ReturnType<typeof vi.fn>): string[] {
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
