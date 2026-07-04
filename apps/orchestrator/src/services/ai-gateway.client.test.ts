/**
 * WARP-303: ai-gateway client must time out non-streaming requests instead
 * of hanging forever. The dashboard polls `/api/llm/models` every 30 s; under
 * inference load a single stuck poll used to block every subsequent poll,
 * making the UI conclude "no models available" even when Ollama recovered.
 *
 * These tests verify that every non-streaming call attaches an `AbortSignal`
 * (so the fetch can be cancelled by the runtime) AND surfaces a clear
 * timeout error when the abort fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    NEXTCLOUD_URL: "http://nextcloud.test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://ai-gateway.test:8000",
    PORT: 3000,
    NODE_ENV: "test",
    FILES_ROOT: "/tmp/files",
    MAX_UPLOAD_SIZE_MB: 10,
    STORAGE_BACKEND: "nextcloud",
  },
}));

import {
  listModels,
  listKeys,
  deleteKey,
  saveKey,
  isTimeoutError,
} from "./ai-gateway.client.js";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(""),
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("ai-gateway.client — WARP-303 timeouts", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("listModels attaches an AbortSignal", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      okResponse({ models: [] }),
    );
    await listModels();
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("http://ai-gateway.test:8000/ai/models");
    expect(call[1]).toBeDefined();
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("listModels rethrows with a timeout-flagged message when AbortSignal fires", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new DOMException("timed out", "TimeoutError");
            reject(err);
          });
        });
      },
    );

    // Use the real timeout path: feed AbortSignal.timeout via the function's
    // own helper. The first call attaches a 10s default; we cannot wait that
    // long, so trigger via a separate controller piped through the same
    // listener pattern — emulate the abort with a fresh signal.
    // Easier: just rely on AbortSignal.timeout(0) which fires immediately.
    const tinyAbort = AbortSignal.timeout(0);
    (global.fetch as ReturnType<typeof vi.fn>).mockReset();
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_url: string, _init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          tinyAbort.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
        });
      },
    );

    await expect(listModels()).rejects.toThrow(/timeout.*listModels/i);
  });

  it("listKeys attaches an AbortSignal", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      okResponse({ providers: ["openai"] }),
    );
    await listKeys();
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("saveKey and deleteKey attach an AbortSignal", async () => {
    // WARP-311: createSession was removed alongside the legacy
    // `/llm/sessions/*` route. saveKey + deleteKey are the remaining
    // non-streaming gateway proxies the orchestrator owns; both must
    // honor the WARP-303 timeout contract.
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    fetchMock.mockResolvedValueOnce(okResponse({}));
    await saveKey("openai", "sk-test");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    fetchMock.mockResolvedValueOnce(okResponse({}));
    await deleteKey("openai");
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("isTimeoutError recognizes AbortSignal.timeout abort reasons", () => {
    expect(isTimeoutError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTimeoutError(new Error("nope"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

// WARP-236 — with internal mTLS on, the base URL is rewritten to https:// and
// every call routes through internalFetch (which attaches the client-cert
// dispatcher). We stub the internal-tls seam so the assertion is deterministic
// without minting real certs: internalBaseUrl rewrites the scheme, internalFetch
// records the URL + init it received (proving the client wired both in).
describe("ai-gateway.client — WARP-236 internal mTLS", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../lib/internal-tls.js");
  });

  it("targets https and routes through internalFetch when mTLS is enabled", async () => {
    const seen: { url?: string; init?: unknown } = {};
    const fakeDispatcher = { marker: "internal-dispatcher" };

    vi.doMock("../lib/internal-tls.js", () => ({
      internalTlsEnabled: () => true,
      internalBaseUrl: (u: string) =>
        u.startsWith("http://") ? "https://" + u.slice("http://".length) : u,
      internalDispatcher: () => fakeDispatcher,
      internalFetch: (url: string, init?: unknown) => {
        seen.url = url;
        seen.init = { ...(init as object), dispatcher: fakeDispatcher };
        return Promise.resolve(okResponse({ models: [] }));
      },
    }));

    vi.resetModules();
    const { listModels: freshListModels } = await import("./ai-gateway.client.js");
    await freshListModels();

    expect(seen.url).toMatch(/^https:\/\/ai-gateway\.test:8000\//);
    expect((seen.init as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });
});
