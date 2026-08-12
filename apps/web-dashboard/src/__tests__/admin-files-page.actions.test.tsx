/**
 * WARP-1506 — "Company files: no way to add a file from the page."
 *
 * The page shipped as a read-only roster: total company storage, a People
 * table, and a Libraries table whose empty state read "No department
 * libraries yet" and offered nothing to click. It is titled Company files,
 * so both of the missing verbs are asserted here.
 *
 * Server-side truth this leans on (verified, NOT invented):
 *   · POST /api/files/upload is `requireRoleOrMcpService("owner","admin",
 *     "family")` + `requireSpaceAccess(prisma, "contributor")`, and
 *     `?space=shared` resolves to the seeded HOUSEHOLD department. Company
 *     storage is shared, multi-user storage — the gate is the server's, and
 *     hiding the button is only the courtesy layer on top of it.
 *   · POST /api/departments is `requireRole("owner","admin")`.
 * Neither endpoint was added for this ticket.
 *
 * The household seed can legitimately be absent (household-seed.service:
 * "fresh box before init hook ran; seed retries on each boot"), so the
 * unavailable case is a real state, not defensive noise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const fetchAdminFilesUsageMock = vi.fn();
const listDepartmentsMock = vi.fn();
const createDepartmentMock = vi.fn();
const uploadFilesMock = vi.fn();
const createDirectoryMock = vi.fn();
const toastSpy = vi.fn();
const pushMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchAdminFilesUsage: (...a: unknown[]) => fetchAdminFilesUsageMock(...a),
    listDepartments: (...a: unknown[]) => listDepartmentsMock(...a),
    createDepartment: (...a: unknown[]) => createDepartmentMock(...a),
    uploadFiles: (...a: unknown[]) => uploadFilesMock(...a),
    createDirectory: (...a: unknown[]) => createDirectoryMock(...a),
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
    fetchDevices: vi.fn().mockResolvedValue([]),
    fetchHealth: vi.fn().mockResolvedValue({}),
  };
});

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
  useWorkspace: () => ({ workspaceType: "business", isBusiness: true }),
}));

vi.mock("@/components/Toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/Toast")>();
  return { ...actual, useToast: () => ({ toast: toastSpy }) };
});

// The company space is the seeded HOUSEHOLD department, surfaced by
// GET /api/files/spaces as id="shared" under the tenant's own name.
let mockSpaces: unknown[] = [
  { id: "personal", name: "My Files", root: "/" },
  { id: "shared", name: "Acme", root: "/Household", kind: "household", state: "active" },
];
vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({ spaces: mockSpaces, sharedAvailable: true, isLoading: false, error: null }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { hostname: "droplet" },
    devices: [],
    health: undefined,
    isLoading: false,
    error: null,
  }),
}));

import AdminFilesPage from "@/app/admin/files/page";

const USAGE_WITH_NO_LIBRARIES = {
  users: [
    {
      userId: "u1",
      displayName: "Priya Nair",
      quota: "26843545600",
      used: "4404019200",
      free: "22439526400",
      largestUploadMb: 2048,
      lastActive: null,
    },
  ],
  departments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  authRole = "owner";
  mockSpaces = [
    { id: "personal", name: "My Files", root: "/" },
    { id: "shared", name: "Acme", root: "/Household", kind: "household", state: "active" },
  ];
  fetchAdminFilesUsageMock.mockResolvedValue(USAGE_WITH_NO_LIBRARIES);
  listDepartmentsMock.mockResolvedValue({ departments: [] });
  uploadFilesMock.mockResolvedValue(undefined);
  createDirectoryMock.mockResolvedValue(undefined);
});

describe("Company files — adding a file (WARP-1506)", () => {
  it("uploads into company (shared) storage, not the admin's personal space", async () => {
    render(<AdminFilesPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(["x"], "policy.pdf")] } });

    await waitFor(() => expect(uploadFilesMock).toHaveBeenCalledTimes(1));
    const [dir, files, , space] = uploadFilesMock.mock.calls[0];
    expect(dir).toBe("/");
    expect(Array.from(files as File[]).map((f) => f.name)).toEqual(["policy.pdf"]);
    // `shared` is the wire token the upload route maps to the HOUSEHOLD
    // department; "personal" here would silently put a company document in
    // the admin's own drive.
    expect(space).toBe("shared");
  });

  it("names the company space when the upload lands", async () => {
    render(<AdminFilesPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "policy.pdf")] } });

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("Uploaded 1 file to Acme."));
  });

  it("takes a folder too, creating its directories first", async () => {
    render(<AdminFilesPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    const folderInput = document.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
    expect(folderInput.hasAttribute("webkitdirectory")).toBe(true);
    const f = new File(["x"], "jan.pdf");
    Object.defineProperty(f, "webkitRelativePath", { value: "Policies/jan.pdf" });
    fireEvent.change(folderInput, { target: { files: [f] } });

    await waitFor(() => expect(createDirectoryMock).toHaveBeenCalledWith("/Policies", "shared"));
    await waitFor(() => expect(uploadFilesMock.mock.calls[0][0]).toBe("/Policies"));
  });

  it("refuses to offer an upload with no company space to put it in", async () => {
    // No HOUSEHOLD department seeded yet — the route would 403. Say so
    // instead of shipping a button that only ever fails.
    mockSpaces = [{ id: "personal", name: "My Files", root: "/" }];
    render(<AdminFilesPage />);
    await waitFor(() => expect(screen.getByText("Priya Nair")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upload folder" })).toBeDisabled();
  });

  it("offers nothing to a non-admin — the server gate's courtesy layer", async () => {
    authRole = "family";
    render(<AdminFilesPage />);
    await waitFor(() =>
      expect(screen.getByText("Admin access required")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe("Company files — creating a department library (WARP-1506)", () => {
  it("gives the empty Libraries section a real action", async () => {
    render(<AdminFilesPage />);
    await waitFor(() =>
      expect(screen.getByText("No department libraries yet")).toBeInTheDocument(),
    );
    // The empty state used to be a dead sentence.
    expect(screen.getByRole("button", { name: "New library" })).toBeInTheDocument();
  });

  it("moves the action into the section header once a library exists", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({
      ...USAGE_WITH_NO_LIBRARIES,
      departments: [
        { id: "d1", name: "Finance", kind: "DEPARTMENT", sizeBytes: "1024", quotaBytes: null },
      ],
    });
    listDepartmentsMock.mockResolvedValue({
      departments: [
        { id: "d1", name: "Finance", slug: "finance", kind: "DEPARTMENT", memberCount: 2 },
      ],
    });

    render(<AdminFilesPage />);
    await waitFor(() => expect(screen.getByText("Finance")).toBeInTheDocument());

    // Exactly one — never a header button AND an empty-state button.
    expect(screen.getAllByRole("button", { name: /New library/ })).toHaveLength(1);
  });

  it("creates the department and refreshes the roster", async () => {
    createDepartmentMock.mockResolvedValue({
      department: { id: "d9", name: "Finance", slug: "finance", kind: "DEPARTMENT" },
      warning: null,
    });

    render(<AdminFilesPage />);
    await waitFor(() =>
      expect(screen.getByText("No department libraries yet")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "New library" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Finance"), {
      target: { value: "Finance" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create library" }));

    await waitFor(() =>
      expect(createDepartmentMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Finance" }),
      ),
    );
    // The new library is provisioned asynchronously (state=pending), so the
    // page has to re-read rather than fabricate an active row.
    await waitFor(() => expect(listDepartmentsMock).toHaveBeenCalledTimes(2));
  });
});
