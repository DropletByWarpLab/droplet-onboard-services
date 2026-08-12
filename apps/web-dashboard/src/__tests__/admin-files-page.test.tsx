/**
 * WARP-1270 (T18) — Surface D, zone 1: /admin/files "Company files" page
 * (design brief §5).
 *
 * Covers: Business + owner/admin gating, the serif hero total, both
 * tables (BigInt-string fields render as formatted sizes, not raw
 * strings), the "Open library" jump navigating to /files?space=dept:<id>,
 * and — the hard requirement — that the personal-file oversight zone
 * (WARP-1272, out of scope for this ticket) is absent from the DOM
 * entirely: no teaser, no lock icon, nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const fetchAdminFilesUsageMock = vi.fn();
const listDepartmentsMock = vi.fn();
const pushMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchAdminFilesUsage: (...a: any[]) => fetchAdminFilesUsageMock(...a),
  listDepartments: (...a: any[]) => listDepartmentsMock(...a),
  // ShellPage status chip pulls device + health hooks — keep them callable.
  // WARP-1506: the page also reads the space list to find the company
  // (shared) space its Upload action writes into.
  fetchSpaces: vi.fn().mockResolvedValue({ spaces: [], sharedAvailable: false }),
  fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  fetchDevices: vi.fn().mockResolvedValue([]),
  fetchHealth: vi.fn().mockResolvedValue({}),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/files",
  useSearchParams: () => new URLSearchParams(),
}));

let authRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: authRole ? { id: "u1", username: "u1", displayName: "U1", role: authRole } : null,
    isLoading: false,
  }),
}));

vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    workspaceType: "business",
    isBusiness: true,
  }),
}));

import AdminFilesPage from "@/app/admin/files/page";

beforeEach(() => {
  authRole = "owner";
  fetchAdminFilesUsageMock.mockReset();
  listDepartmentsMock.mockReset();
  pushMock.mockReset();
  fetchAdminFilesUsageMock.mockResolvedValue({
    users: [
      {
        userId: "u1",
        displayName: "Priya Nair",
        quota: "26843545600", // 25 GB
        used: "4404019200", // 4.1 GB
        free: "22439526400",
        largestUploadMb: 2048,
        lastActive: null,
      },
    ],
    departments: [
      { id: "d1", name: "Finance", kind: "DEPARTMENT", sizeBytes: "14179869184", quotaBytes: "53687091200" },
    ],
  });
  listDepartmentsMock.mockResolvedValue({
    departments: [
      {
        id: "d1",
        name: "Finance",
        slug: "finance",
        kind: "DEPARTMENT",
        parentId: null,
        description: null,
        state: "active",
        quotaBytes: "53687091200",
        aclVersion: 1,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
        memberCount: 4,
        teamCount: 0,
        myRight: null,
        usedBytes: "14179869184",
      },
    ],
  });
});

describe("/admin/files — gating", () => {
  it("shows an admin-required notice for a non-admin caller", async () => {
    authRole = "family";
    render(<AdminFilesPage />);
    await waitFor(() => {
      expect(screen.getByText(/admin access required/i)).toBeInTheDocument();
    });
    expect(fetchAdminFilesUsageMock).not.toHaveBeenCalled();
  });
});

describe("/admin/files — content", () => {
  it("renders the serif hero total, both tables, and formatted (not raw) sizes", async () => {
    render(<AdminFilesPage />);

    await waitFor(() => {
      expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    });
    // Hero total = 4.1 GB (people) + 13 GB (dept) ≈ 17.3 GB, formatted —
    // never the raw BigInt-string.
    expect(screen.queryByText(/14179869184|4404019200/)).not.toBeInTheDocument();
    expect(screen.getByText(/total company storage used/i)).toBeInTheDocument();

    // People table: used/limit meter, mono.
    expect(screen.getByText(/4\.1 GB \/ 25 GB/)).toBeInTheDocument();
    expect(screen.getByText("2048 MB")).toBeInTheDocument();

    // Libraries table.
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText(/13 GB \/ 50 GB/)).toBeInTheDocument();
    expect(screen.getByText("4 members")).toBeInTheDocument();
  });

  it("'Open library' navigates to /files with that space active", async () => {
    render(<AdminFilesPage />);
    const openBtn = await screen.findByRole("button", { name: /open library/i });
    fireEvent.click(openBtn);
    expect(pushMock).toHaveBeenCalledWith("/files?space=dept%3Ad1");
  });

  it("never renders the personal-file oversight zone — no teaser, no lock icon, nothing", async () => {
    render(<AdminFilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    });
    expect(screen.queryByText(/private files/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/oversight/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/every access is logged/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /oversight/i })).not.toBeInTheDocument();
  });

  it("renders '—' for last-active (no fabricated date) and 'Device default' when no upload override", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({
      users: [
        {
          userId: "u2",
          displayName: "Tom Alvarez",
          quota: null,
          used: "0",
          free: null,
          largestUploadMb: null,
          lastActive: null,
        },
      ],
      departments: [],
    });
    listDepartmentsMock.mockResolvedValue({ departments: [] });

    render(<AdminFilesPage />);
    await waitFor(() => {
      expect(screen.getByText("Tom Alvarez")).toBeInTheDocument();
    });
    expect(screen.getByText("Device default")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
