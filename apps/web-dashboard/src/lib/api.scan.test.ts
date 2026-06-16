/**
 * WARP-816 — scanWifiNetworks() parses the orchestrator's typed error body.
 *
 * The orchestrator returns 409 with a flat `{ code: "SCAN_UNSUPPORTED", message }`
 * when the radio is in AP mode and can't station-scan. scanWifiNetworks() must
 * surface that as a RouterStatusError (so the WiFi panel branches on the code),
 * NOT as a plain Error and NOT as an empty list. A 200 still returns the
 * results array; an untyped failure stays a plain Error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { scanWifiNetworks, RouterStatusError } from "./api";
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

describe("scanWifiNetworks (WARP-816)", () => {
  it("returns the results array on 200", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { results: [{ ssid: "HomeNet" }] } }),
    );
    await expect(scanWifiNetworks()).resolves.toEqual([{ ssid: "HomeNet" }]);
  });

  it("maps a 409 SCAN_UNSUPPORTED body to a typed RouterStatusError carrying the message", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 409,
        json: { code: "SCAN_UNSUPPORTED", message: "Your Droplet can't scan while broadcasting." },
      }),
    );

    await expect(scanWifiNetworks()).rejects.toSatisfy(
      (e) =>
        e instanceof RouterStatusError &&
        e.code === "SCAN_UNSUPPORTED" &&
        e.status === 409 &&
        e.message === "Your Droplet can't scan while broadcasting.",
    );
  });

  it("falls back to a plain Error when a failure carries no typed code", async () => {
    authFetchMock.mockResolvedValue(res({ ok: false, status: 500, json: {} }));

    await expect(scanWifiNetworks()).rejects.toSatisfy(
      (e) => e instanceof Error && !(e instanceof RouterStatusError),
    );
  });
});
