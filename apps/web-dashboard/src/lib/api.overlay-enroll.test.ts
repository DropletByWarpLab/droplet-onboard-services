/**
 * WARP-1475 — overlay QR-enroll API client (ADR-030).
 *
 * Exercises the REAL fetch path (WARP-1288 lesson: mock the transport
 * `authFetch`, never the function under test) so the on-the-wire method /
 * path / body and the error-shape parsing are what's actually verified.
 *
 * Contract (orchestrator WARP-1474 / PR #1208):
 *   POST /api/vpn/overlay/link-tokens              → 201 { token, server, box_name, expires_at }
 *   GET  /api/vpn/overlay/pending-enrollments      → 200 [{ id, label, fingerprint_short, presented_at, state, conflict }]
 *   POST /api/vpn/overlay/pending-enrollments/:id/approve → 200 { state:"approved", device_id } | 409 | 503
 *   POST /api/vpn/overlay/pending-enrollments/:id/deny    → 200 { state:"denied" }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  mintOverlayLinkToken,
  fetchPendingOverlayEnrollments,
  approveOverlayEnrollment,
  denyOverlayEnrollment,
} from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("mintOverlayLinkToken", () => {
  it("POSTs to /api/vpn/overlay/link-tokens and returns the one-shot token", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse(201, {
        token: "base64urlToken",
        server: "box.example",
        box_name: "Droplet",
        expires_at: "2026-07-21T18:00:00.000Z",
      }),
    );

    const res = await mintOverlayLinkToken();

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/vpn/overlay/link-tokens",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res.token).toBe("base64urlToken");
    expect(res.server).toBe("box.example");
    expect(res.box_name).toBe("Droplet");
    expect(res.expires_at).toBe("2026-07-21T18:00:00.000Z");
  });

  it("throws on a 429 rate-limit", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(429, { error: "rate_limited" }));
    await expect(mintOverlayLinkToken()).rejects.toThrow();
  });
});

describe("fetchPendingOverlayEnrollments", () => {
  it("GETs the review queue and returns the array", async () => {
    const rows = [
      {
        id: "pe-1",
        label: "Alice iPhone",
        fingerprint_short: "a1b2c3d4",
        presented_at: "2026-07-21T17:00:00.000Z",
        state: "pending",
        conflict: false,
      },
    ];
    authFetchMock.mockResolvedValue(jsonResponse(200, rows));

    const res = await fetchPendingOverlayEnrollments();

    expect(authFetchMock).toHaveBeenCalledWith("/api/vpn/overlay/pending-enrollments");
    expect(res).toHaveLength(1);
    expect(res[0].fingerprint_short).toBe("a1b2c3d4");
    expect(res[0].conflict).toBe(false);
  });

  it("throws on a non-2xx", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(500, { error: "boom" }));
    await expect(fetchPendingOverlayEnrollments()).rejects.toThrow();
  });
});

describe("approveOverlayEnrollment", () => {
  it("POSTs to the approve path and returns the enrolled device ref", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse(200, { state: "approved", device_id: "dev-99" }),
    );

    const res = await approveOverlayEnrollment("pe-1");

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/vpn/overlay/pending-enrollments/pe-1/approve",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res.state).toBe("approved");
    expect(res.device_id).toBe("dev-99");
  });

  it("URL-encodes the id in the path", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(200, { state: "approved", device_id: null }));
    await approveOverlayEnrollment("pe/../x");
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/vpn/overlay/pending-enrollments/pe%2F..%2Fx/approve",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws an error carrying the 409 code and status", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse(409, { error: "wg_key_conflict" }),
    );
    await expect(approveOverlayEnrollment("pe-1")).rejects.toMatchObject({
      code: "wg_key_conflict",
      status: 409,
    });
  });

  it("carries the 503 vouch-retry sentence on both message and code", async () => {
    const sentence =
      "Couldn't reach the fleet directory to finish linking this device. It's back in your review queue — try approving again in a minute.";
    authFetchMock.mockResolvedValue(jsonResponse(503, { error: sentence }));
    await expect(approveOverlayEnrollment("pe-1")).rejects.toMatchObject({
      status: 503,
      message: sentence,
    });
  });
});

describe("denyOverlayEnrollment", () => {
  it("POSTs to the deny path and returns the denied state", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(200, { state: "denied" }));

    const res = await denyOverlayEnrollment("pe-2");

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/vpn/overlay/pending-enrollments/pe-2/deny",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res.state).toBe("denied");
  });

  it("throws on a 404", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(404, { error: "not_found" }));
    await expect(denyOverlayEnrollment("pe-2")).rejects.toThrow();
  });
});
