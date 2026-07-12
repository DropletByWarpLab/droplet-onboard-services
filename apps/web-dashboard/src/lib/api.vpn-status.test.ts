/**
 * WARP-1283 — Remote Access status client honesty.
 *
 * `fetchVpnStatus` must attach the orchestrator's typed `code` and the HTTP
 * status to the thrown error (the `storageWriteError` / WARP-851
 * `commissionMatterDevice` precedent) so the setup wizard's VpnStep can render
 * the specific "the box's network service isn't responding" copy when the
 * routing sidecar is unavailable (503 + code ROUTING_UNAVAILABLE), instead of
 * flattening every precheck failure onto the generic error page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchVpnStatus } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(init: { ok: boolean; status: number; json: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(init.json),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchVpnStatus (WARP-1283)", () => {
  it("attaches the response code + status to the thrown error", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 503,
        json: {
          error:
            "The box's network service isn't responding right now. Try again in a minute.",
          code: "ROUTING_UNAVAILABLE",
        },
      }),
    );

    await expect(fetchVpnStatus()).rejects.toSatisfy(
      (e) =>
        e instanceof Error &&
        (e as Error & { status?: number }).status === 503 &&
        (e as Error & { code?: string }).code === "ROUTING_UNAVAILABLE" &&
        /isn't responding right now/i.test(e.message),
    );
  });

  it("keeps the generic fallback (no code) when the error body is not JSON", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error("not json")),
    } as unknown as Response);

    await expect(fetchVpnStatus()).rejects.toSatisfy(
      (e) =>
        e instanceof Error &&
        (e as Error & { status?: number }).status === 500 &&
        (e as Error & { code?: string }).code === undefined &&
        /failed to fetch remote access status: 500/i.test(e.message),
    );
  });

  it("still resolves the status payload on success", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: true,
        status: 200,
        json: { configured: true, endpointConfigured: true, peerCount: 0 },
      }),
    );
    await expect(fetchVpnStatus()).resolves.toMatchObject({
      configured: true,
      endpointConfigured: true,
    });
    expect(authFetchMock).toHaveBeenCalledWith("/api/vpn/status");
  });
});
