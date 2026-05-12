import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  apiFetch,
  DEFAULT_API_FETCH_TIMEOUT_MS,
  type TypedError,
} from "@/lib/hooks/apiFetch";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("apiFetch", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns parsed body on ok response", async () => {
    const payload = { id: "abc", name: "thing" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    });

    const result = await apiFetch<typeof payload>("/api/anything");
    expect(result).toEqual(payload);
    // WARP-303: every call now gets a default timeout signal attached.
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/anything",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("throws TypedError with code + status on typed error envelope", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          error: { code: "DUPLICATE_GROUP_NAME", message: "Already exists" },
        }),
    });

    await expect(apiFetch("/api/network/groups")).rejects.toMatchObject({
      message: "Already exists",
      code: "DUPLICATE_GROUP_NAME",
      status: 409,
    });
  });

  it("falls back to UNKNOWN code + HTTP <status> message when envelope is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    let thrown: TypedError | undefined;
    try {
      await apiFetch("/api/boom");
    } catch (e) {
      thrown = e as TypedError;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe("UNKNOWN");
    expect(thrown?.status).toBe(500);
    expect(thrown?.message).toBe("HTTP 500");
  });

  it("exposes the full response body on the thrown error", async () => {
    const envelope = {
      error: { code: "REQUIRES_CONFIRMATION", message: "need confirm" },
      requiresConfirmation: true,
    };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 428,
      json: () => Promise.resolve(envelope),
    });

    let thrown: TypedError | undefined;
    try {
      await apiFetch("/api/network/firewall/block");
    } catch (e) {
      thrown = e as TypedError;
    }
    expect(thrown?.code).toBe("REQUIRES_CONFIRMATION");
    expect(thrown?.status).toBe(428);
    expect(thrown?.body).toEqual(envelope);
  });

  describe("WARP-303 timeouts and aborts", () => {
    it("attaches an AbortSignal with the default timeout when no init is given", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      await apiFetch("/api/x");
      const callInit = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callInit.signal).toBeInstanceOf(AbortSignal);
    });

    it("rejects with code='TIMEOUT' when the timeout fires before fetch resolves", async () => {
      // Simulate a fetch that respects the abort signal but never resolves
      // until aborted. The timeout (10 ms here) is what should fire first.
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new DOMException("aborted", "AbortError");
            reject(err);
          });
        });
      });

      let thrown: TypedError | undefined;
      try {
        await apiFetch("/api/slow", { timeoutMs: 10 });
      } catch (e) {
        thrown = e as TypedError;
      }
      expect(thrown).toBeDefined();
      expect(thrown?.code).toBe("TIMEOUT");
      expect(thrown?.status).toBe(0);
      expect(thrown?.message).toContain("10ms");
    });

    it("rejects with code='ABORTED' when the caller's signal fires first", async () => {
      const ctrl = new AbortController();
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new DOMException("aborted", "AbortError");
            reject(err);
          });
        });
      });

      // Abort the caller synchronously so the test is deterministic
      // regardless of setTimeout scheduling. Through the composed signal,
      // the abort fires the listener attached by the mock and rejects.
      const promise = apiFetch("/api/cancellable", {
        timeoutMs: 10_000,
        signal: ctrl.signal,
      });
      ctrl.abort();

      let thrown: TypedError | undefined;
      try {
        await promise;
      } catch (e) {
        thrown = e as TypedError;
      }
      expect(thrown?.code).toBe("ABORTED");
      expect(thrown?.status).toBe(0);
    });

    it("rejects with code='NETWORK_ERROR' for non-abort fetch failures", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      let thrown: TypedError | undefined;
      try {
        await apiFetch("/api/down");
      } catch (e) {
        thrown = e as TypedError;
      }
      expect(thrown?.code).toBe("NETWORK_ERROR");
      expect(thrown?.status).toBe(0);
      expect(thrown?.message).toBe("Failed to fetch");
    });

    it("does not attach a timeout signal when timeoutMs=0", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      await apiFetch("/api/long-poll", { timeoutMs: 0 });
      const callInit = mockFetch.mock.calls[0][1] as RequestInit;
      // No caller signal passed AND timeout disabled → no signal at all.
      expect(callInit.signal).toBeUndefined();
    });

    it("exposes DEFAULT_API_FETCH_TIMEOUT_MS as a sane default", () => {
      expect(DEFAULT_API_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
      expect(DEFAULT_API_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    });
  });
});
