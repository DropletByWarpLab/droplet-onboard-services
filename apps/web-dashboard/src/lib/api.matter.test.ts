/**
 * WARP-851 — Matter API client honesty.
 *
 * 1. `commissionMatterDevice` must attach the HTTP status to the thrown
 *    error so `translateError`'s status-based dispatch can map the
 *    orchestrator's 502 discovery-failure onto the network-discovery
 *    copy (instead of flattening every commissioning failure to the
 *    generic device fallback).
 * 2. `fetchMatterCapabilities` reads GET /api/matter/capabilities so the
 *    wizard and /devices/add-matter can tell the customer whether
 *    Bluetooth first-time setup works on this box.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { commissionMatterDevice, fetchMatterCapabilities } from "./api";
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

describe("commissionMatterDevice (WARP-851)", () => {
  it("attaches the response status to the thrown error", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 502,
        json: {
          error:
            "Couldn't find the device on the network. Make sure it's powered on, in pairing mode, and on the same Wi-Fi as the Droplet.",
        },
      }),
    );

    await expect(commissionMatterDevice("34970112332")).rejects.toSatisfy(
      (e) =>
        e instanceof Error &&
        (e as Error & { status?: number }).status === 502 &&
        /couldn't find the device on the network/i.test(e.message),
    );
  });

  it("still resolves the nodeId on success", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { status: "commissioned", nodeId: "42" } }),
    );
    await expect(commissionMatterDevice("34970112332")).resolves.toMatchObject({
      nodeId: "42",
    });
  });
});

describe("fetchMatterCapabilities (WARP-851)", () => {
  it("returns the capability surface from GET /api/matter/capabilities", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { bleCommissioning: false } }),
    );
    await expect(fetchMatterCapabilities()).resolves.toEqual({
      bleCommissioning: false,
    });
    expect(authFetchMock).toHaveBeenCalledWith("/api/matter/capabilities");
  });

  it("throws on a non-2xx so callers can treat capability as unknown", async () => {
    authFetchMock.mockResolvedValue(res({ ok: false, status: 503, json: {} }));
    await expect(fetchMatterCapabilities()).rejects.toBeInstanceOf(Error);
  });
});
