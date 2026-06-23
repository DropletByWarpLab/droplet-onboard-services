/**
 * WARP-883 (ADR-027 WS-5) — Files spaces api helpers.
 *
 * Pins the wire contract the dashboard switcher depends on:
 *   - fetchFiles(path, "shared") sends ?space=shared so the backend roots the
 *     listing under the Household prefix; the personal call URL is unchanged.
 *   - fetchSpaces() reads GET /api/files/spaces.
 *   - fetchShares(path) returns the full ShareDetail[] the ShareDialog renders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchFiles, fetchSpaces, fetchShares } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(json: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

beforeEach(() => authFetchMock.mockReset());

describe("WARP-883 — Files spaces api", () => {
  it("fetchFiles defaults to the personal URL (no space param)", async () => {
    authFetchMock.mockResolvedValue(res([]));
    await fetchFiles("/Documents");
    const url = authFetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/files?");
    expect(url).toContain("path=%2FDocuments");
    expect(url).not.toContain("space=");
  });

  it("fetchFiles(path, 'shared') adds ?space=shared", async () => {
    authFetchMock.mockResolvedValue(res([]));
    await fetchFiles("/Trips", "shared");
    const url = authFetchMock.mock.calls[0][0] as string;
    expect(url).toContain("space=shared");
    expect(url).toContain("path=%2FTrips");
  });

  it("fetchSpaces reads GET /api/files/spaces and returns the body", async () => {
    const body = {
      sharedAvailable: true,
      spaces: [
        { id: "personal", name: "My Files", available: true, root: "/" },
        { id: "shared", name: "Household", available: true, root: "/Household" },
      ],
    };
    authFetchMock.mockResolvedValue(res(body));
    await expect(fetchSpaces()).resolves.toEqual(body);
    expect(authFetchMock.mock.calls[0][0]).toBe("/api/files/spaces");
  });

  it("fetchShares returns the shares array (full ShareDetail shape)", async () => {
    const shares = [
      { id: 1, url: "https://x/s/a", permissions: 1, shareType: 3 },
    ];
    authFetchMock.mockResolvedValue(res({ shares }));
    await expect(fetchShares("/a.pdf")).resolves.toEqual(shares);
  });

  it("fetchShares tolerates a missing shares field", async () => {
    authFetchMock.mockResolvedValue(res({}));
    await expect(fetchShares("/a.pdf")).resolves.toEqual([]);
  });
});
