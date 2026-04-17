import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch, type TypedError } from "@/lib/hooks/apiFetch";

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
    expect(mockFetch).toHaveBeenCalledWith("/api/anything", undefined);
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
});
