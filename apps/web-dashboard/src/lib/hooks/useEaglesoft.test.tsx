/**
 * WARP-3374 (Romain, 2026-09-30) — integrations detail is owner/admin only.
 * `GET /api/connectors/eaglesoft` (host, account, credential expiry) answers
 * 403 to a member, so the hook that reads it must not ask on a member's behalf:
 * it would 403 every 30 s for a surface the member never sees.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";

const fetchEaglesoftMock = vi.fn();
vi.mock("@/lib/api.erp", () => ({
  fetchEaglesoft: (...a: unknown[]) => fetchEaglesoftMock(...a),
  fetchEaglesoftSchedule: vi.fn(),
}));

let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: mockRole ? { id: "u1", username: "u", role: mockRole } : null }),
}));

import { useEaglesoft } from "@/lib/hooks/useEaglesoft";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

beforeEach(() => {
  fetchEaglesoftMock.mockReset().mockResolvedValue({
    connection: { provider: "eaglesoft", status: "CONNECTED", writeEnabled: false },
    kpis: null,
    schedule: [],
  });
});

describe("useEaglesoft asks only for owner and admin (WARP-3374)", () => {
  it.each(["owner", "admin"])("a %s reads the connection detail", async (role) => {
    mockRole = role;
    const { result } = renderHook(() => useEaglesoft(), { wrapper });
    await waitFor(() => expect(result.current.connection.status).toBe("CONNECTED"));
    expect(fetchEaglesoftMock).toHaveBeenCalled();
  });

  it.each(["family", "guest", undefined])("a %s makes no request and reads as not configured", async (role) => {
    mockRole = role;
    const { result } = renderHook(() => useEaglesoft(), { wrapper });
    // give SWR a tick: a request, if one were going to be made, is made on mount
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchEaglesoftMock).not.toHaveBeenCalled();
    expect(result.current.connection.status).toBe("NOT_CONFIGURED");
    expect(result.current.isLoading).toBe(false);
  });
});
