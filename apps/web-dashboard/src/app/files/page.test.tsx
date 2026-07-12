/**
 * WARP-883 (QA finding #3) — FilesPage render smoke test.
 *
 * The leaf-component suites (SpaceSwitcher / ShareDialog) render those pieces
 * in isolation and never mount the page that wires them together. That gap let
 * a temporal-dead-zone bug ship: a `useEffect` listed `loadExistingShares` in
 * its dependency array before the `const loadExistingShares = useCallback(...)`
 * was declared, so the page threw `ReferenceError: Cannot access
 * 'loadExistingShares' before initialization` on FIRST render — white-screening
 * the whole Files surface (incl. the SpaceSwitcher).
 *
 * This test mounts the real <FilesPage/> with the data hooks mocked and asserts
 * it renders without throwing AND the SpaceSwitcher + file list appear. It FAILS
 * (ReferenceError) before the hoist fix and PASSES after.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FileEntryInfo, FileSpace } from "@/lib/types";

// ── next/navigation — the page reads ?path= via useSearchParams ──
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/files",
}));

// ── Data hooks ──
const PERSONAL: FileSpace = { id: "personal", name: "My Files", root: "/" };
const SHARED: FileSpace = { id: "shared", name: "Household", root: "/Household", kind: "household", state: "active" };

const FILES: FileEntryInfo[] = [
  {
    name: "report.pdf",
    path: "/report.pdf",
    isDirectory: false,
    size: 2048,
    modifiedAt: "2026-04-16T00:00:00.000Z",
    mimeType: "application/pdf",
  },
];

// WARP-1267 — `let` bindings so individual tests can point the hooks at a
// department/team space and a different viewer role before rendering. Mock
// factories close over these by reference (read at call time, i.e. every
// render), not by value at registration time — reset in beforeEach below.
let mockSpaces: FileSpace[] = [PERSONAL, SHARED];
let mockSharedAvailable = true;
vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({
    spaces: mockSpaces,
    sharedAvailable: mockSharedAvailable,
    error: undefined,
    isLoading: false,
  }),
}));

let mockUser: { id: string; email: string; role: string } = {
  id: "u1",
  email: "family@example.com",
  role: "family",
};
// WARP-1267 — the page now reads the viewer's role (reader posture, admin
// foreign-library banner) via useAuth. Keep authFetch real (spread actual)
// since handleDownload uses it; only override useAuth.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    useAuth: () => ({
      user: mockUser,
      isLoading: false,
    }),
  };
});

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({ files: FILES, error: undefined, isLoading: false, refresh: vi.fn() }),
}));

vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({ items: [], error: undefined, isLoading: false, refresh: vi.fn() }),
}));

vi.mock("@/lib/hooks/useFileRealtime", () => ({
  useFileRealtime: () => undefined,
}));

// ShellPage's status chip pulls device/health via useDevice (SWR → network).
// Stub it so the page chrome renders without hitting the api in the test env.
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));

vi.mock("@/lib/hooks/useFileManager", () => ({
  useFileManager: () => ({
    selection: new Set<string>(),
    selectedPaths: [],
    selectedCount: 0,
    isSelected: () => false,
    selectOnly: vi.fn(),
    toggleSelection: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    renamingPath: null,
    beginRename: vi.fn(),
    endRename: vi.fn(),
    clipboard: null,
    cut: vi.fn(),
    copy: vi.fn(),
    clearClipboard: vi.fn(),
    viewMode: "list",
    setViewMode: vi.fn(),
  }),
}));

// Spread the real api module (so every export the page chrome references — e.g.
// ShellPage's fetchSystemHealth — stays defined) but override the network-
// touching calls that fire at render so nothing hits a server in the test env.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchShares: vi.fn().mockResolvedValue([]),
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  };
});

import FilesPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mockSpaces = [PERSONAL, SHARED];
  mockSharedAvailable = true;
  mockUser = { id: "u1", email: "family@example.com", role: "family" };
});

describe("<FilesPage /> (WARP-883 smoke)", () => {
  it("mounts without throwing (no temporal-dead-zone on loadExistingShares)", () => {
    // The bug surfaced as a render-time ReferenceError; a successful render is
    // the assertion. render() rethrows any error raised during the render pass.
    expect(() => render(<FilesPage />)).not.toThrow();
  });

  it("renders the SpaceSwitcher when a shared space is available", () => {
    render(<FilesPage />);
    expect(screen.getByRole("tab", { name: /my files/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /household/i })).toBeInTheDocument();
  });

  it("renders the file list rows", () => {
    render(<FilesPage />);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });
});

// WARP-1267 (T15) — reader posture inside a `reader`-right department space:
// upload / new-folder / row-delete render visible-but-disabled with the
// verbatim tooltip copy; toolbar layout doesn't shift (same buttons, just
// disabled).
describe("<FilesPage /> — reader posture (WARP-1267)", () => {
  const READER_TOOLTIP =
    "You can view and download here. Ask a manager for edit access.";
  const FINANCE_READER: FileSpace = {
    id: "dept:finance",
    name: "Finance",
    root: "/Finance",
    kind: "department",
    state: "active",
    right: "reader",
    isMember: true,
  };

  beforeEach(() => {
    mockSpaces = [PERSONAL, FINANCE_READER];
  });

  it("disables New folder + Upload with the reader tooltip once a reader space is active", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));

    const newFolderBtn = screen.getByRole("button", { name: /new folder/i });
    expect(newFolderBtn).toBeDisabled();
    expect(newFolderBtn).toHaveAttribute("title", READER_TOOLTIP);

    const uploadBtn = screen.getByRole("button", { name: /^upload$/i });
    expect(uploadBtn).toBeDisabled();
    expect(uploadBtn).toHaveAttribute("title", READER_TOOLTIP);
  });

  it("disables the per-row Delete affordance with the reader tooltip", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));

    const deleteBtn = screen.getByRole("button", { name: /delete report\.pdf/i });
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn).toHaveAttribute("title", READER_TOOLTIP);
  });

  it("leaves the write actions enabled in a non-reader space (My Files)", () => {
    render(<FilesPage />);
    expect(screen.getByRole("button", { name: /new folder/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^upload$/i })).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /delete report\.pdf/i })
    ).not.toBeDisabled();
  });
});

// WARP-1267 (T15) — admin-in-foreign-library banner: shown only to an
// owner/admin viewing a department/team they're not a member of, dismissible
// per visit, and back on space re-entry.
describe("<FilesPage /> — admin foreign-library banner (WARP-1267)", () => {
  const ADMIN_BANNER_COPY =
    "You're viewing this library as an administrator. This visit is logged.";
  const LEGAL_FOREIGN: FileSpace = {
    id: "dept:legal",
    name: "Legal",
    root: "/Legal",
    kind: "department",
    state: "active",
    right: "manager",
    isMember: false,
  };

  beforeEach(() => {
    mockSpaces = [PERSONAL, LEGAL_FOREIGN];
    mockUser = { id: "admin-1", email: "dana@example.com", role: "admin" };
  });

  it("shows the banner when an admin enters a department they don't belong to", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /legal/i }));
    expect(screen.getByText(ADMIN_BANNER_COPY)).toBeInTheDocument();
  });

  it("never shows the banner to a plain member (isMember true)", () => {
    mockSpaces = [PERSONAL, { ...LEGAL_FOREIGN, isMember: true }];
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /legal/i }));
    expect(screen.queryByText(ADMIN_BANNER_COPY)).not.toBeInTheDocument();
  });

  it("never shows the banner to a non-admin viewer even if isMember is false", () => {
    mockUser = { id: "family-1", email: "priya@example.com", role: "family" };
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /legal/i }));
    expect(screen.queryByText(ADMIN_BANNER_COPY)).not.toBeInTheDocument();
  });

  it("dismisses on click and returns when the admin re-enters the space", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /legal/i }));
    expect(screen.getByText(ADMIN_BANNER_COPY)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(ADMIN_BANNER_COPY)).not.toBeInTheDocument();

    // Leave the space and come back — the banner returns (per-visit dismiss).
    fireEvent.click(screen.getByRole("tab", { name: /my files/i }));
    fireEvent.click(screen.getByRole("tab", { name: /legal/i }));
    expect(screen.getByText(ADMIN_BANNER_COPY)).toBeInTheDocument();
  });
});

// WARP-1267 (T15) — team breadcrumb: a non-navigating parent-department
// crumb prefixes the breadcrumb when the active space is a team.
describe("<FilesPage /> — team breadcrumb (WARP-1267)", () => {
  const PLATFORM_TEAM: FileSpace = {
    id: "dept:eng-platform",
    name: "Platform",
    root: "/Engineering — Platform",
    kind: "team",
    state: "active",
    right: "contributor",
    isMember: true,
    parentName: "Engineering",
  };

  it("prefixes the parent department name as a non-navigating crumb", () => {
    mockSpaces = [PERSONAL, PLATFORM_TEAM];
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /platform/i }));
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    // Non-navigating — it's plain text, not a breadcrumb nav button.
    expect(
      screen.queryByRole("button", { name: /^engineering$/i })
    ).not.toBeInTheDocument();
  });

  it("does not prefix a crumb for a department (non-team) space", () => {
    mockSpaces = [
      PERSONAL,
      { ...PLATFORM_TEAM, id: "dept:eng", kind: "department", name: "Engineering", parentName: undefined },
    ];
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /^engineering$/i }));
    // Only one "Engineering" text node now — the active segmented tab label
    // itself — no extra prefix crumb duplicate.
    expect(screen.getAllByText("Engineering")).toHaveLength(1);
  });
});
