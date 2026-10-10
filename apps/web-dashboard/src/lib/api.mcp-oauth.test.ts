/**
 * WARP-3951 — `fetchMcpOAuthConnections` against the real JSON body, not a
 * mocked function. The pinned contract is `{ providers: [...] }` (orchestrator
 * #2770, "pin the connections response shape"); the Mac client reads the same.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchMcpOAuthConnections } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(status: number, json?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

beforeEach(() => authFetchMock.mockReset());

describe("fetchMcpOAuthConnections", () => {
  it("reads the providers array from the pinned body", async () => {
    const providers = [
      {
        provider: "atlassian",
        member: { id: "11111111-1111-4111-8111-111111111111", state: "CONNECTED", connectedAt: "2026-10-09T00:00:00Z", lastRefreshOkAt: null },
        workspace: null,
        redirectUri: "https://droplet-ai.lan/api/mcp/oauth/callback",
        callbackSupported: true,
        apiToken: false,
      },
    ];
    authFetchMock.mockResolvedValue(res(200, { providers }));
    await expect(fetchMcpOAuthConnections()).resolves.toEqual(providers);
    expect(authFetchMock).toHaveBeenCalledWith("/api/mcp/oauth/connections");
  });

  it("rejects a 200 whose body has no providers array (contract drift is visible)", async () => {
    for (const body of [[], { connections: [] }, { providers: "x" }, null]) {
      authFetchMock.mockResolvedValue(res(200, body));
      await expect(fetchMcpOAuthConnections()).rejects.toThrow("mcp_oauth_shape");
    }
  });

  it("marks a 404 as absent routes", async () => {
    authFetchMock.mockResolvedValue(res(404, { error: "not found" }));
    await expect(fetchMcpOAuthConnections()).rejects.toThrow("mcp_oauth_absent");
  });

  it("throws on other failures", async () => {
    authFetchMock.mockResolvedValue(res(500));
    await expect(fetchMcpOAuthConnections()).rejects.toThrow("500");
  });
});
