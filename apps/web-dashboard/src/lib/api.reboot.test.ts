/**
 * WARP-871 — rebootRouter() handles the owner-only Tier-3 confirm flow.
 *
 * "reboot" is a Tier-3 operation confirmable via the dashboard: the POST to
 * /api/network/system/reboot answers 202 + a confirmation token, and the
 * Restart click IS the consent, so rebootRouter echoes the token straight back
 * through /api/network/command/confirm and returns the operationId. A 403
 * (non-owner) surfaces the server's message; any other non-OK throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { rebootRouter } from "./api";
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

describe("rebootRouter (WARP-871)", () => {
  it("echoes the 202 confirmation token back to /command/confirm and returns the operationId", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        res({
          ok: true,
          status: 202,
          json: {
            status: "confirmation_required",
            confirmationToken: "tok-abc",
            operation: "reboot",
          },
        }),
      )
      .mockResolvedValueOnce(
        res({ ok: true, status: 200, json: { operationId: "op-42" } }),
      );

    await expect(rebootRouter()).resolves.toEqual({ operationId: "op-42" });

    // First call mints, second confirms with the echoed operation.
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    const [rebootUrl] = authFetchMock.mock.calls[0];
    const [confirmUrl, confirmInit] = authFetchMock.mock.calls[1];
    expect(rebootUrl).toContain("/api/network/system/reboot");
    expect(confirmUrl).toContain("/api/network/command/confirm");
    expect(JSON.parse((confirmInit as RequestInit).body as string)).toMatchObject({
      confirmationToken: "tok-abc",
      operation: "reboot",
    });
  });

  it("returns immediately when the route executes without asking for confirmation", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ ok: true, status: 200, json: { status: "ok", operationId: "op-now" } }),
    );
    await expect(rebootRouter()).resolves.toEqual({ operationId: "op-now" });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server message on a 403 (non-owner)", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ ok: false, status: 403, json: { error: "Forbidden: role not permitted" } }),
    );
    await expect(rebootRouter()).rejects.toThrow("Forbidden: role not permitted");
  });

  it("throws on any other non-OK response", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ ok: false, status: 503, json: {} }),
    );
    await expect(rebootRouter()).rejects.toThrow(/503/);
  });

  it("throws on a 202 with missing operation field (malformed server response)", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({
        ok: true,
        status: 202,
        json: { status: "confirmation_required", confirmationToken: "tok-x" },
      }),
    );
    await expect(rebootRouter()).rejects.toThrow(
      /Unexpected 202 response: missing confirmationToken or operation/,
    );
    // It must NOT silently treat the 202 as success — only the reboot POST runs,
    // no /command/confirm follow-up.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a 202 'confirmation_required' that omits BOTH confirm fields (no silent success)", async () => {
    // A 202 satisfies res.ok, so a confirm-required body that's missing the
    // token/operation would otherwise fall through to the res.ok branch and be
    // reported as an immediate (op-less) success. It must be treated as an error.
    authFetchMock.mockResolvedValueOnce(
      res({ ok: true, status: 202, json: { status: "confirmation_required" } }),
    );
    await expect(rebootRouter()).rejects.toThrow(
      /Unexpected 202 response: missing confirmationToken or operation/,
    );
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });
});
