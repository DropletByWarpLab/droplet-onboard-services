/**
 * WARP-1058 — /admin/audit `?kind=` deep-link pre-filter.
 *
 * The /voice page's "See all in Activity" footer points at
 * `/admin/audit?kind=voice`; the audit page must seed its kind filter
 * from that param (validated against the wire enum) so the operator
 * lands on an already-filtered view. Pins:
 *
 *   1. `?kind=voice` → the first-page fetch carries kind=voice and the
 *      dropdown shows the Voice option selected;
 *   2. an unknown `?kind=` value falls back to "All kinds" (no kind
 *      param on the fetch);
 *   3. `voice` is a first-class option in the kind dropdown.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

// ── next/navigation — the page reads ?kind= via useSearchParams. ──
let mockSearchParamsString = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/audit",
}));

// ShellPage passthrough (settings/updates page-test pattern) — the real
// shell pulls device/health SWR wiring this test doesn't exercise.
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({
    title,
    actions,
    children,
  }: {
    title: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {actions}
      {children}
    </div>
  ),
}));

const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u-owner", username: "owner", role: "owner" },
    isLoading: false,
  }),
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("@/lib/api", () => ({
  fetchUsers: vi.fn(async () => ({ users: [] })),
}));

import AuditPage from "@/app/admin/audit/page";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

beforeEach(() => {
  mockSearchParamsString = "";
  authFetchMock.mockReset();
  authFetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/api/activity/verify")) {
      return jsonResponse({
        ok: true,
        rowsChecked: 0,
        verifiedAt: "2026-07-15T00:00:00.000Z",
      });
    }
    return jsonResponse({ items: [], nextCursor: null });
  });
});

async function firstListFetchUrl(): Promise<string> {
  await waitFor(() => {
    expect(
      authFetchMock.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          (c[0] as string).startsWith("/api/activity?"),
      ),
    ).toBe(true);
  });
  const call = authFetchMock.mock.calls.find(
    (c) =>
      typeof c[0] === "string" && (c[0] as string).startsWith("/api/activity?"),
  );
  return call![0] as string;
}

describe("/admin/audit ?kind= deep-link (WARP-1058)", () => {
  it("?kind=voice pre-filters the list fetch and the dropdown", async () => {
    mockSearchParamsString = "kind=voice";
    render(<AuditPage />);
    const url = await firstListFetchUrl();
    expect(url).toContain("kind=voice");
    const select = screen.getByLabelText("Filter by kind") as HTMLSelectElement;
    expect(select.value).toBe("voice");
  });

  it("an unknown ?kind= value falls back to All kinds", async () => {
    mockSearchParamsString = "kind=telepathy";
    render(<AuditPage />);
    const url = await firstListFetchUrl();
    expect(url).not.toContain("kind=");
    const select = screen.getByLabelText("Filter by kind") as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("offers Voice as a kind option", async () => {
    render(<AuditPage />);
    await firstListFetchUrl();
    const option = screen.getByRole("option", {
      name: "Voice",
    }) as HTMLOptionElement;
    expect(option.value).toBe("voice");
  });
});
