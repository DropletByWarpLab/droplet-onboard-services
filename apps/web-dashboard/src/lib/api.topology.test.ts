/**
 * WARP-871 — getNetworkTopology() is best-effort: it parses the posture on a
 * 200 and returns null on any non-OK or thrown error, so the Overview badge
 * never breaks the page when the topology read hiccups.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { getNetworkTopology } from "./api";
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

describe("getNetworkTopology (WARP-871)", () => {
  it("returns the parsed posture on a 200", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({
        ok: true,
        status: 200,
        json: { posture: "DOWNSTREAM_ROUTER", evidence: { wan_present: false } },
      }),
    );
    await expect(getNetworkTopology()).resolves.toEqual({
      posture: "DOWNSTREAM_ROUTER",
      evidence: { wan_present: false },
    });
  });

  it("returns null on a non-OK response (best-effort badge)", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ ok: false, status: 503, json: {} }),
    );
    await expect(getNetworkTopology()).resolves.toBeNull();
  });

  it("returns null when the request throws", async () => {
    authFetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(getNetworkTopology()).resolves.toBeNull();
  });
});
