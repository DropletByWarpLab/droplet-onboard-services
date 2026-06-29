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

import {
  commissionMatterDevice,
  fetchMatterCapabilities,
  sendMatterCommand,
  confirmMatterCommand,
} from "./api";
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

describe("sendMatterCommand (KAN-5)", () => {
  it("returns the 202 confirmation_required body instead of swallowing it", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false, // a 202 is NOT res.ok, but it is a success the caller must read
        status: 202,
        json: {
          status: "confirmation_required",
          nodeId: "12345",
          command: "lock",
          service: "lock",
          tier: 2,
          reason: "Commands to lock devices require confirmation",
          confirmationToken: "tok-abc",
          expiresIn: 60,
        },
      }),
    );

    const result = await sendMatterCommand("12345", "lock");
    expect(result).toMatchObject({
      status: "confirmation_required",
      confirmationToken: "tok-abc",
      service: "lock",
      tier: 2,
      nodeId: "12345",
    });
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/matter/devices/12345/command",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns the Tier-1 success body on a 200", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { status: "sent", nodeId: "12345", command: "toggle", tier: 1 } }),
    );
    await expect(sendMatterCommand("12345", "toggle")).resolves.toMatchObject({
      nodeId: "12345",
      tier: 1,
    });
  });

  it("still throws on a real error status (e.g. 429 blocked)", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: false, status: 429, json: { error: "Rate limited", blocked: true } }),
    );
    await expect(sendMatterCommand("12345", "toggle")).rejects.toThrow(/rate limited/i);
  });
});

describe("confirmMatterCommand (KAN-5)", () => {
  it("POSTs the token + echoed service to /confirm and resolves the result", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { confirmed: true, nodeId: "12345" } }),
    );

    await expect(
      confirmMatterCommand("12345", "tok-abc", "lock"),
    ).resolves.toMatchObject({ confirmed: true });

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/matter/devices/12345/confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirmationToken: "tok-abc", service: "lock" }),
      }),
    );
  });

  it("throws the server message on a rejected confirm (e.g. expired token)", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 400,
        json: { error: "Confirmation expired", code: "TOKEN_EXPIRED" },
      }),
    );
    await expect(
      confirmMatterCommand("12345", "tok-old", "lock"),
    ).rejects.toThrow(/confirmation expired/i);
  });
});
