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
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { FileEntryInfo, FileSpace } from "@/lib/types";

// ── next/navigation — the page reads ?path= (and, WARP-1270, ?space=) via
// useSearchParams. `let` so the WARP-1270 deep-link tests can point it at a
// `?space=` query before rendering; reset in beforeEach below.
let mockSearchParamsString = "";
// WARP-1547 — the page now WRITES the URL too, so `push` has to be a stable
// module-level spy the tests can assert against (a fresh `vi.fn()` per
// useRouter() call would be a different mock on every render, and would also
// make the router identity churn).
const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/files",
}));

// ── Data hooks ──
const PERSONAL: FileSpace = { id: "personal", name: "My Files", root: "/" };
const SHARED: FileSpace = {
  id: "shared",
  name: "Household",
  root: "/Household",
  kind: "household",
  state: "active",
};

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

// WARP-1338 — `let` bindings so the failed-listing tests can hand the page a
// listing error (the WebDAV 404 an unregistered drive deep-link hits). Read
// at call time; reset in beforeEach below.
let mockFiles: FileEntryInfo[] = FILES;
let mockFilesError: unknown = undefined;
// WARP-1623 — the (path, space) pair the page actually asks for. `currentPath`
// is space-root-relative, so this is what proves a library listing is requested
// relative to its own mount rather than double-prefixed. Reset in beforeEach.
let mockFilesCalls: Array<[string, string]> = [];
vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: (path: string, space: string) => {
    mockFilesCalls.push([path, space]);
    return {
      files: mockFilesError ? [] : mockFiles,
      error: mockFilesError,
      isLoading: false,
      refresh: vi.fn(),
    };
  },
}));

// WARP-1338 (UX review) — the page feeds the breadcrumb the same volume
// display chain the tiles use (useDrives/usePools), so a deep-linked GUID
// mount tail is never the location label. `let` bindings, reset below.
let mockDrives: unknown[] = [];
let mockPools: unknown[] = [];
vi.mock("@/lib/hooks/useDrives", () => ({
  useDrives: () => ({
    drives: mockDrives,
    disks: [],
    isLoading: false,
    bridgeError: undefined,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/usePools", () => ({
  usePools: () => ({
    pools: mockPools,
    isLoading: false,
    error: undefined,
    bridgeError: undefined,
    refresh: vi.fn(),
  }),
}));

// WARP-1547 — the page's `onPickResult` handler is the funnel's other entry
// point (it used to call `setSpace` directly, bypassing `handleSpaceChange`).
// Stub the SearchBar down to a button that fires a fixture result, so the
// handler can be driven without the real component's debounced network search.
let mockSearchResult: FileEntryInfo = FILES[0];
vi.mock("@/components/FileManager/SearchBar", () => ({
  SearchBar: ({ onPickResult }: { onPickResult: (f: FileEntryInfo) => void }) => (
    <button type="button" onClick={() => onPickResult(mockSearchResult)}>
      pick search result
    </button>
  ),
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

// WARP-1540 — the selection toolbar only renders with something selected, so
// the Share tests need to drive `selectedPaths`. `let` binding read at call
// time (every render); reset in beforeEach below so every other suite keeps
// the empty selection it was written against.
let mockSelectedPaths: string[] = [];
vi.mock("@/lib/hooks/useFileManager", () => ({
  useFileManager: () => ({
    selection: new Set<string>(mockSelectedPaths),
    selectedPaths: mockSelectedPaths,
    selectedCount: mockSelectedPaths.length,
    isSelected: (p: string) => mockSelectedPaths.includes(p),
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
// WARP-1540 — the multi-file Share loop calls createShare once per path.
// Declared outside the factory so tests can script per-path outcomes (incl. a
// failure at item 2 of 3) and assert the exact arguments.
const createShareMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchShares: vi.fn().mockResolvedValue([]),
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
    // WARP-1623 — asserted below: an entry path must be converted to the
    // active space's relative form before it reaches a space-threaded write.
    deleteFile: vi.fn().mockResolvedValue(undefined),
    createShare: (...args: unknown[]) => createShareMock(...args),
  };
});

// WARP-1540 — the single-file branch must land on the SAME surface the detail
// panel's "Share…" opens. Stub the dialog down to a marker so the assertion is
// about the page's wiring (which dialog, for which file), not the dialog's own
// network-touching internals (it fetches share recipients on mount).
vi.mock("@/components/FileManager/ShareDialog", () => ({
  ShareDialog: ({ fileName }: { fileName: string }) => (
    <div data-testid="share-dialog">ShareDialog: {fileName}</div>
  ),
}));

import FilesPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mockSpaces = [PERSONAL, SHARED];
  mockSharedAvailable = true;
  mockUser = { id: "u1", email: "family@example.com", role: "family" };
  mockSearchParamsString = "";
  mockFiles = FILES;
  mockFilesError = undefined;
  mockDrives = [];
  mockPools = [];
  mockSearchResult = FILES[0];
  mockFilesCalls = [];
  mockSelectedPaths = [];
  createShareMock.mockReset();
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

// WARP-1338 — a FAILED listing must never masquerade as an empty folder.
// A drive tile deep-links to /files?path=/<mount-tail>; when the drive isn't
// registered in Nextcloud the WebDAV listing 404s, and the page used to
// ignore the useFiles error entirely — rendering the false "This folder is
// empty" over what is actually a broken browse chain.
describe("<FilesPage /> — failed listing is distinct from empty (WARP-1338)", () => {
  it("renders the drive-not-connected state (not 'empty') when a deep-linked listing fails", () => {
    mockSearchParamsString = "path=%2Fpool-cafef00d";
    mockFilesError = new Error("Request failed with status 404");
    render(<FilesPage />);
    expect(
      screen.getByText(/isn't connected to the file browser yet/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
  });

  it("renders a generic couldn't-load state at the root (not 'empty') on error", () => {
    mockFilesError = new Error("network down");
    render(<FilesPage />);
    expect(screen.getByText(/couldn't load your files/i)).toBeInTheDocument();
    expect(screen.queryByText(/this folder is empty/i)).not.toBeInTheDocument();
  });

  it("keeps the honest empty state when the listing succeeds with zero entries", () => {
    mockFiles = [];
    render(<FilesPage />);
    expect(screen.getByText(/this folder is empty/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/isn't connected to the file browser/i)
    ).not.toBeInTheDocument();
  });

  // UX review (WARP-1338): the not-connected copy is keyed to the CAUSE (the
  // 404 an unregistered drive actually hits — fetchFiles embeds the status in
  // the thrown message), not merely to being below root. A transient blip
  // deep inside a healthy, registered drive must never claim the drive
  // "isn't connected".
  it("shows the generic couldn't-load copy for a non-404 failure below root", () => {
    mockSearchParamsString = "path=%2Fpool-cafef00d";
    mockFilesError = new Error("Failed to fetch files: 500");
    render(<FilesPage />);
    expect(screen.getByText(/couldn't load your files/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/isn't connected to the file browser/i)
    ).not.toBeInTheDocument();
  });

  // UX review (WARP-1338): the failed listing appears asynchronously after
  // load — announce it (role="alert", matching the PoolAlarmBanner
  // precedent) instead of updating the region silently.
  it("announces the failed listing to assistive tech (role=alert)", () => {
    mockSearchParamsString = "path=%2Fpool-cafef00d";
    mockFilesError = new Error("Failed to fetch files: 404");
    render(<FilesPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /isn't connected to the file browser yet/i
    );
  });
});

// UX review (WARP-1338) — clicking the GUID-guarded "Storage pool" tile must
// not land the user on a breadcrumb whose primary location label is the raw
// fs-UUID mount tail (the live box's legacy pool mounts — exactly the volumes
// WARP-1337 established "GUIDs are never the primary label" for). The page
// maps a first-segment volume match through the shared display chain.
describe("<FilesPage /> — breadcrumb never shows a GUID mount tail (WARP-1338 UX review)", () => {
  const GUID = "a0f10a84-7116-46a7-a3e3-5e00ea1c7d08";
  const poolDrive = {
    device: "/dev/md127",
    mount: `/mnt/droplet/${GUID}`,
    label: "",
    uuid: "U-POOL-1",
    size_bytes: 4_000_000_000_000,
    used_bytes: 1_000_000_000_000,
    free_bytes: 3_000_000_000_000,
    mounted: true,
    bus: "disk",
    removable: false,
    displayName: null,
    icon: null,
    notes: null,
  };

  it("labels a deep-linked legacy GUID pool crumb through the shared display chain", () => {
    mockSearchParamsString = `path=%2F${GUID}`;
    mockDrives = [poolDrive];
    mockPools = [
      { device: "md127", level: "raid1", status: "active", members: ["sda", "sdb"], displayName: null },
    ];
    render(<FilesPage />);
    const nav = screen.getByRole("navigation", { name: /breadcrumbs/i });
    expect(within(nav).getByText("Storage pool")).toBeInTheDocument();
    expect(within(nav).queryByText(GUID)).not.toBeInTheDocument();
  });

  it("uses the pool's own display name when the customer has named it", () => {
    mockSearchParamsString = `path=%2F${GUID}`;
    mockDrives = [poolDrive];
    mockPools = [
      { device: "md127", level: "raid1", status: "active", members: ["sda", "sdb"], displayName: "Family Vault" },
    ];
    render(<FilesPage />);
    const nav = screen.getByRole("navigation", { name: /breadcrumbs/i });
    expect(within(nav).getByText("Family Vault")).toBeInTheDocument();
    expect(within(nav).queryByText(GUID)).not.toBeInTheDocument();
  });

  it("humanizes the GUID crumb even before the drives payload arrives", () => {
    mockSearchParamsString = `path=%2F${GUID}`;
    render(<FilesPage />);
    const nav = screen.getByRole("navigation", { name: /breadcrumbs/i });
    expect(within(nav).queryByText(GUID)).not.toBeInTheDocument();
    expect(within(nav).getByText("Drive")).toBeInTheDocument();
  });

  it("keeps real folder crumbs raw below the volume segment", () => {
    mockSearchParamsString = `path=${encodeURIComponent(`/${GUID}/Photos`)}`;
    mockDrives = [poolDrive];
    mockPools = [
      { device: "md127", level: "raid1", status: "active", members: ["sda", "sdb"], displayName: null },
    ];
    render(<FilesPage />);
    const nav = screen.getByRole("navigation", { name: /breadcrumbs/i });
    expect(within(nav).getByText("Storage pool")).toBeInTheDocument();
    expect(within(nav).getByText("Photos")).toBeInTheDocument();
    expect(within(nav).queryByText(GUID)).not.toBeInTheDocument();
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

// WARP-1270 (T18) — `?space=` deep-link: the /admin/files "Open library"
// jump navigates to /files?space=dept:<id> and this space becomes active on
// arrival (design brief §5: "arrives on Surface A with the admin banner").
describe("<FilesPage /> — ?space= deep-link (WARP-1270)", () => {
  const FINANCE_DEPT: FileSpace = {
    id: "dept:finance",
    name: "Finance",
    root: "/Finance",
    kind: "department",
    state: "active",
    right: "contributor",
    isMember: true,
  };

  it("activates the space named in ?space= once spaces have loaded", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Afinance";
    render(<FilesPage />);
    expect(screen.getByRole("tab", { name: /finance/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ignores an unknown/stale space id — falls back to the default (My Files) rather than dead-ending", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Aarchived-long-ago";
    render(<FilesPage />);
    expect(screen.getByRole("tab", { name: /my files/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("no ?space= param leaves the default My Files space active", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "";
    render(<FilesPage />);
    expect(screen.getByRole("tab", { name: /my files/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switching away from the deep-linked space manually still works (one-shot apply, not sticky)", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Afinance";
    render(<FilesPage />);
    expect(screen.getByRole("tab", { name: /finance/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: /my files/i }));
    expect(screen.getByRole("tab", { name: /my files/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

// WARP-1547 — `(space, path)` is ONE address.
//
// The two params used to be applied by two effects: `?path=` seeded state on
// mount, then `?space=` landed once `spaces` resolved and reset the path to
// the library root — so `/files?space=dept:x&path=/Sub` reliably opened the
// library ROOT and no folder inside a library could be linked. The page also
// never wrote the URL at all, so in-page folder navigation produced no
// shareable link and browser Back left Files entirely.
describe("<FilesPage /> — (space, path) round-trip + URL write-back (WARP-1547)", () => {
  const FINANCE_DEPT: FileSpace = {
    id: "dept:finance",
    name: "Finance",
    root: "/Finance",
    kind: "department",
    state: "active",
    right: "contributor",
    isMember: true,
  };

  const CONTRACTS: FileEntryInfo = {
    name: "Contracts",
    path: "/Contracts",
    isDirectory: true,
    size: 0,
    mimeType: null,
    modifiedAt: "2026-04-16T00:00:00.000Z",
  };

  const crumbs = () => screen.getByRole("navigation", { name: /breadcrumbs/i });

  // ── URL → view ──────────────────────────────────────────────────────────

  it("lands on the deep-linked FOLDER inside the library, not the library root", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Afinance&path=%2FContracts%2F2026";
    render(<FilesPage />);

    // Both halves survive: the library is active AND the path is the linked
    // folder. Before the fix the space effect clobbered the path back to "/".
    expect(screen.getByRole("tab", { name: /finance/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(crumbs()).getByText("Contracts")).toBeInTheDocument();
    expect(within(crumbs()).getByText("2026")).toBeInTheDocument();
  });

  it("keeps failing safe on an unknown space id — no error surface, no existence leak", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Aarchived-long-ago&path=%2FContracts";
    render(<FilesPage />);

    expect(screen.getByRole("tab", { name: /my files/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Nothing that would confirm or deny the id: no alert, no space named.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/archived-long-ago/i)).not.toBeInTheDocument();
  });

  // ── view → URL ──────────────────────────────────────────────────────────

  it("writes the (space, path) pair back to the URL when a folder is opened", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Afinance";
    mockFiles = [CONTRACTS];
    render(<FilesPage />);

    fireEvent.click(screen.getByRole("button", { name: /folder contracts/i }));
    expect(pushMock).toHaveBeenCalledWith(
      "/files?space=dept%3Afinance&path=%2FContracts",
    );
  });

  it("keeps the plain /files?path= shape in the personal space (no redundant space param)", () => {
    mockFiles = [CONTRACTS];
    render(<FilesPage />);

    fireEvent.click(screen.getByRole("button", { name: /folder contracts/i }));
    expect(pushMock).toHaveBeenCalledWith("/files?path=%2FContracts");
  });

  it("writes a breadcrumb jump back to the URL too", () => {
    mockSearchParamsString = "path=%2FContracts%2F2026";
    render(<FilesPage />);

    fireEvent.click(within(crumbs()).getByRole("button", { name: /my files/i }));
    expect(pushMock).toHaveBeenLastCalledWith("/files");
  });

  it("switching space writes that space's ROOT — the old path never carries over", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "path=%2FDocs";
    render(<FilesPage />);
    expect(within(crumbs()).getByText("Docs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));
    expect(pushMock).toHaveBeenLastCalledWith("/files?space=dept%3Afinance");
    // Preserved behavior: the switch lands on the new space's root.
    expect(within(crumbs()).queryByText("Docs")).not.toBeInTheDocument();
  });

  // ── Back / Forward ──────────────────────────────────────────────────────
  //
  // The browser restoring an earlier entry re-renders the page with that
  // entry's params; the single URL→view effect is what turns that into a
  // folder move instead of Files losing its place.

  it("moves back up a folder when the browser restores the previous URL", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Afinance&path=%2FContracts%2F2026";
    const { rerender } = render(<FilesPage />);
    expect(within(crumbs()).getByText("2026")).toBeInTheDocument();

    mockSearchParamsString = "space=dept%3Afinance&path=%2FContracts";
    rerender(<FilesPage />);

    expect(within(crumbs()).getByText("Contracts")).toBeInTheDocument();
    expect(within(crumbs()).queryByText("2026")).not.toBeInTheDocument();
    // Still inside the library — Back moves within Files, it doesn't leave it.
    expect(screen.getByRole("tab", { name: /finance/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("restores the personal root when the browser goes back to the bare /files URL", () => {
    mockSpaces = [PERSONAL, FINANCE_DEPT];
    mockSearchParamsString = "space=dept%3Afinance&path=%2FContracts";
    const { rerender } = render(<FilesPage />);
    expect(screen.getByRole("tab", { name: /finance/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    mockSearchParamsString = "";
    rerender(<FilesPage />);

    expect(screen.getByRole("tab", { name: /my files/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(crumbs()).queryByText("Contracts")).not.toBeInTheDocument();
  });

  // ── one funnel ──────────────────────────────────────────────────────────

  it("funnels a search pick through the same navigation path as every other move", () => {
    // Was the second space setter: `onPickResult` called `setSpace` directly,
    // so a pick moved the listing without touching the URL.
    mockSearchResult = {
      name: "Trips",
      path: "/Household/Trips",
      isDirectory: true,
      size: 0,
      mimeType: null,
      modifiedAt: "2026-04-16T00:00:00.000Z",
    };
    render(<FilesPage />);

    fireEvent.click(screen.getByRole("button", { name: /pick search result/i }));

    expect(screen.getByRole("tab", { name: /household/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(pushMock).toHaveBeenCalledWith("/files?space=shared&path=%2FTrips");
  });

  it("funnels a picked FILE to its parent folder, in that file's space", () => {
    mockSearchResult = {
      name: "itinerary.pdf",
      path: "/Household/Trips/itinerary.pdf",
      isDirectory: false,
      size: 128,
      modifiedAt: "2026-04-16T00:00:00.000Z",
      mimeType: "application/pdf",
    };
    render(<FilesPage />);

    fireEvent.click(screen.getByRole("button", { name: /pick search result/i }));

    expect(pushMock).toHaveBeenCalledWith("/files?space=shared&path=%2FTrips");
  });
});

// WARP-1623 — browsing a department library.
//
// `currentPath` is space-root-relative (the page states this at the
// `homeRelativeCurrentPath` memo and again at the breadcrumb and Move/Copy
// call sites), and the server prefixes the mount for the declared space. Two
// helpers in the page still special-cased `shared` when the listing request
// itself dropped every `dept:` space, so the mismatch was invisible. Once the
// space reaches the wire, they become the bug — and with the WARP-1547 funnel
// writing the URL, a double-prefixed path would be baked into the link too.
describe("<FilesPage /> — department library browsing (WARP-1623)", () => {
  const FINANCE: FileSpace = {
    id: "dept:finance",
    name: "Finance",
    root: "/Finance",
    kind: "department",
    state: "active",
    right: "manager",
    isMember: true,
  };

  // Listing entries always carry HOME-relative paths, mount included.
  const FINANCE_ENTRIES: FileEntryInfo[] = [
    {
      name: "Q1",
      path: "/Finance/Q1",
      isDirectory: true,
      size: 0,
      modifiedAt: "2026-07-01T00:00:00.000Z",
      mimeType: "httpd/unix-directory",
    },
    {
      name: "budget.xlsx",
      path: "/Finance/budget.xlsx",
      isDirectory: false,
      size: 4096,
      modifiedAt: "2026-07-01T00:00:00.000Z",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ];

  beforeEach(() => {
    mockSpaces = [PERSONAL, FINANCE];
    mockFiles = FINANCE_ENTRIES;
    mockUser = { id: "u1", email: "family@example.com", role: "family" };
  });

  // NOT a pin on the WARP-1623 bug — a regression guard on the page contract
  // it depends on. `useFiles` is mocked wholesale here and the page has always
  // passed the real space into it; the drop happened one layer below, inside
  // `fetchFiles`. The wire-level pin lives in `lib/api.spaces.test.ts`. This
  // guards the other half: that a space switch still lands on the space ROOT
  // rather than carrying the previous space's path across.
  it("lands a space switch on the library root, carrying the space id", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));
    expect(mockFilesCalls.at(-1)).toEqual(["/", "dept:finance"]);
  });

  it("opening a folder asks for it relative to the library, not double-prefixed", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));
    fireEvent.click(screen.getByRole("button", { name: /^folder q1$/i }));
    // "/Finance/Q1" fed back verbatim would be re-prefixed server-side to
    // "/Finance/Finance/Q1" — the WARP-1140 double-prefix, which renders as a
    // silently empty folder.
    expect(mockFilesCalls.at(-1)).toEqual(["/Q1", "dept:finance"]);
  });

  // The WARP-1547 funnel writes the URL on every move, so a double-prefixed
  // path would not merely mislist — it would be baked into the shareable link.
  // Mirrors the Household assertion the 1547 suite already makes.
  it("writes a space-relative URL for a folder opened inside a library", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));
    fireEvent.click(screen.getByRole("button", { name: /^folder q1$/i }));
    expect(pushMock).toHaveBeenCalledWith("/files?space=dept%3Afinance&path=%2FQ1");
  });

  it("converts an entry path to space-relative form before a write", async () => {
    const { deleteFile } = await import("@/lib/api");
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete budget\.xlsx/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(deleteFile).toHaveBeenCalledWith("/budget.xlsx", "dept:finance");
  });

  // Must open a FOLDER: `handleRowOpen` only reaches the path translation on a
  // directory — a file routes to the preview modal instead, so clicking one
  // would assert nothing but the mount-time listing call.
  it("leaves the personal space home-relative — no prefix stripped", () => {
    mockSpaces = [PERSONAL, FINANCE];
    mockFiles = [
      {
        name: "Docs",
        path: "/Docs",
        isDirectory: true,
        size: 0,
        modifiedAt: "2026-07-01T00:00:00.000Z",
        mimeType: "httpd/unix-directory",
      },
    ];
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("button", { name: /^folder docs$/i }));
    expect(mockFilesCalls.at(-1)).toEqual(["/Docs", "personal"]);
  });
});

// WARP-1540 — Share in the selection toolbar.
//
// Sharing used to be reachable only from the single-file detail panel and a
// `disabled: !isSingle` context item, so a selection of several files had no
// way to share at all. Decision (Romain, 2026-07-24): loop `createShare` per
// selected path — no bulk endpoint, no zip. One selected file still opens the
// existing ShareDialog, unchanged.
describe("<FilesPage /> — Share from the selection toolbar (WARP-1540)", () => {
  const READER_TOOLTIP =
    "You can view and download here. Ask a manager for edit access.";
  const MANAGER_ONLY =
    "Only a manager can share from this library. Ask one to create the link.";

  const file = (name: string): FileEntryInfo => ({
    name,
    path: `/${name}`,
    isDirectory: false,
    size: 10,
    mimeType: "application/pdf",
    modifiedAt: "2026-04-16T00:00:00.000Z",
  });
  const folder = (name: string): FileEntryInfo => ({
    name,
    path: `/${name}`,
    isDirectory: true,
    size: 0,
    mimeType: null,
    modifiedAt: "2026-04-16T00:00:00.000Z",
  });

  // The toolbar label states the posture: "Share" for one item (ShareDialog
  // lets the user choose a person or a link), "Share publicly" for several
  // (the loop mints a public link per file with no intervening choice).
  const shareBtn = () =>
    screen.getByRole("button", { name: /^share( publicly)?$/i });

  it("offers Share as soon as one item is selected", () => {
    mockFiles = [file("a.pdf")];
    mockSelectedPaths = ["/a.pdf"];
    render(<FilesPage />);
    expect(shareBtn()).not.toBeDisabled();
  });

  it("opens the existing ShareDialog for a single file — same as the detail panel, no loop", () => {
    mockFiles = [file("a.pdf")];
    mockSelectedPaths = ["/a.pdf"];
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    expect(screen.getByTestId("share-dialog")).toHaveTextContent("a.pdf");
    expect(createShareMock).not.toHaveBeenCalled();
  });

  it("creates one link per file for a multi-selection, labeled with its filename", async () => {
    mockFiles = [file("a.pdf"), file("b.pdf"), file("c.pdf")];
    mockSelectedPaths = ["/a.pdf", "/b.pdf", "/c.pdf"];
    createShareMock.mockImplementation((path: string) =>
      Promise.resolve({ id: 1, url: `https://box/s/${path.slice(1)}`, token: "t" })
    );
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /shared 3 files — one public link each/i
      )
    );
    // N calls, one per selected path — the raw entry path the single-file
    // ShareDialog would have sent (POST /api/files/share takes no space).
    expect(createShareMock).toHaveBeenCalledTimes(3);
    expect(createShareMock.mock.calls.map((c) => c[0])).toEqual([
      "/a.pdf",
      "/b.pdf",
      "/c.pdf",
    ]);
    // Pin the GRANT, not just the paths. Omitting the options relied on
    // `createShare`'s `{ shareType: 3 }` default and the server's
    // `permissions` default of 1 — so widening either default would have
    // widened every bulk link with nothing here going red. shareType 3 =
    // public link, permissions 1 = read-only, and no password/expiry is set
    // by this path (that stays a per-share decision in ShareDialog).
    for (const call of createShareMock.mock.calls) {
      expect(call[1]).toEqual({ shareType: 3, permissions: 1 });
    }
    // Not a raw dump: each link is attached to its filename and copyable alone.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("a.pdf")).toBeInTheDocument();
    expect(within(dialog).getByText("https://box/s/c.pdf")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /copy link for b\.pdf/i })
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /copy all public links/i })
    ).not.toBeDisabled();
    // The single-file dialog is NOT what a multi-selection opens.
    expect(screen.queryByTestId("share-dialog")).toBeNull();
  });

  it("reports a mid-loop failure per target without hiding or undoing the successes", async () => {
    mockFiles = [file("a.pdf"), file("b.pdf"), file("c.pdf")];
    mockSelectedPaths = ["/a.pdf", "/b.pdf", "/c.pdf"];
    createShareMock.mockImplementation((path: string) =>
      path === "/b.pdf"
        ? Promise.reject(new Error("Share failed: 403"))
        : Promise.resolve({ id: 1, url: `https://box/s/${path.slice(1)}`, token: "t" })
    );
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/shared 2 of 3/i)
    );
    const dialog = screen.getByRole("dialog");
    // The failure did not stop the run: c.pdf, queued after it, still got a link.
    expect(within(dialog).getByText("https://box/s/a.pdf")).toBeInTheDocument();
    expect(within(dialog).getByText("https://box/s/c.pdf")).toBeInTheDocument();
    // …and the failed one is named, on its own row, beside the survivors.
    expect(within(dialog).getByText("b.pdf")).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /copy link for b\.pdf/i })
    ).toBeNull();
  });

  // Review B1 — a failed share CREATE used to render the file-LOADING
  // fallback ("We couldn't load those files right now. Try again in a
  // moment."): an action the user never performed, a cause that isn't the
  // cause, and retry advice for a deterministic policy rejection. That is the
  // exact WARP-1148 regression the `share` domain was added to end, and
  // ShareDialog already routes through it — so the same 403 gave two
  // different messages one click apart.
  it("renders share-domain copy on a failure, never the file-LOADING fallback", async () => {
    mockFiles = [file("a.pdf"), file("b.pdf")];
    mockSelectedPaths = ["/a.pdf", "/b.pdf"];
    createShareMock.mockRejectedValue(
      Object.assign(new Error("Sharing is disabled"), {
        code: "module_disabled",
      })
    );
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /none of the 2 files could be shared/i
      )
    );
    const dialog = screen.getByRole("dialog");
    // The module gate names itself, with the remedy — not "try again".
    expect(
      within(dialog).getAllByText(/file sharing is turned off on this droplet/i)
    ).toHaveLength(2);
    expect(within(dialog).queryByText(/couldn't load those files/i)).toBeNull();
  });

  it("keeps folders out of a bulk run and says which ones it skipped", async () => {
    mockFiles = [file("a.pdf"), folder("Trips"), file("c.pdf")];
    mockSelectedPaths = ["/a.pdf", "/Trips", "/c.pdf"];
    createShareMock.mockImplementation((path: string) =>
      Promise.resolve({ id: 1, url: `https://box/s/${path.slice(1)}`, token: "t" })
    );
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    await waitFor(() => expect(createShareMock).toHaveBeenCalledTimes(2));
    expect(createShareMock.mock.calls.map((c) => c[0])).toEqual([
      "/a.pdf",
      "/c.pdf",
    ]);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      /skipped 1 folder \(trips\)/i
    );
  });

  // Review B2 — the links this loop mints are live, public, unauthenticated
  // and no-expiry the instant each POST returns. Dismissing the panel
  // mid-run used to bump the generation ref and null the state, so a stray
  // click just outside left N public links in existence that were never
  // displayed to anyone, while the user believed they had cancelled. The only
  // way to find them is Files → Shared → Shared by me, which nothing in the
  // flow points at.
  //
  // Helper: a.pdf lands, b.pdf hangs — the panel is then observably in flight.
  const startStalledRun = () => {
    mockFiles = [file("a.pdf"), file("b.pdf"), file("c.pdf")];
    mockSelectedPaths = ["/a.pdf", "/b.pdf", "/c.pdf"];
    createShareMock.mockImplementation((path: string) =>
      path === "/b.pdf"
        ? new Promise(() => {})
        : Promise.resolve({
            id: 1,
            url: `https://box/s/${path.slice(1)}`,
            token: "t",
          })
    );
    render(<FilesPage />);
    fireEvent.click(shareBtn());
    return waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /creating public links… 1 of 3 done/i
      )
    );
  };

  it("ignores a backdrop click while links are still being created", async () => {
    await startStalledRun();

    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(backdrop);

    // Still mounted, still showing the link that already exists.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByText("https://box/s/a.pdf")
    ).toBeInTheDocument();
  });

  it("stops on Escape without hiding the public links it already created", async () => {
    await startStalledRun();

    // Escape is NOT covered by closeOnBackdrop — Dialog's key handler calls
    // onClose unconditionally — so the guard has to live in onClose too.
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /stopped\. 1 public link of 3 was already created and stays active/i
      )
    );
    const dialog = screen.getByRole("dialog");
    // The created link is still on screen and still copyable…
    expect(within(dialog).getByText("https://box/s/a.pdf")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /copy link for a\.pdf/i })
    ).toBeInTheDocument();
    // …and it says where to find it afterwards.
    expect(dialog).toHaveTextContent(/shared by me/i);
    // The rows never reached say so, rather than spinning forever.
    expect(
      within(dialog).getAllByText(/no link — stopped before this file/i)
    ).toHaveLength(2);
    // The loop really stopped: c.pdf was queued after the hung b.pdf.
    expect(createShareMock).toHaveBeenCalledTimes(2);
  });

  it("closes normally once the run has settled — never a trap", async () => {
    await startStalledRun();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/stopped/i)
    );

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refuses a selection over the bulk cap with an honest count, not an unbounded fan-out", () => {
    const many = Array.from({ length: 21 }, (_, i) => file(`f${i}.pdf`));
    mockFiles = many;
    mockSelectedPaths = many.map((f) => f.path);
    render(<FilesPage />);

    const btn = shareBtn();
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      "title",
      "You can share up to 20 files at once — 21 are selected."
    );
    fireEvent.click(btn);
    expect(createShareMock).not.toHaveBeenCalled();
  });

  it("disables Share for a reader in a library, with the reader tooltip", () => {
    mockSpaces = [
      PERSONAL,
      {
        id: "dept:finance",
        name: "Finance",
        root: "/Finance",
        kind: "department",
        state: "active",
        right: "reader",
        isMember: true,
      },
    ];
    mockFiles = [file("a.pdf")];
    mockSelectedPaths = ["/a.pdf"];
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));

    const btn = shareBtn();
    // Visible-but-disabled — never a silently missing button.
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", READER_TOOLTIP);
    fireEvent.click(btn);
    expect(createShareMock).not.toHaveBeenCalled();
  });

  it("disables Share for a CONTRIBUTOR in a library — the share bit is a manager right", () => {
    mockSpaces = [
      PERSONAL,
      {
        id: "dept:finance",
        name: "Finance",
        root: "/Finance",
        kind: "department",
        state: "active",
        right: "contributor",
        isMember: true,
      },
    ];
    mockFiles = [file("a.pdf")];
    mockSelectedPaths = ["/a.pdf"];
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));

    const btn = shareBtn();
    expect(btn).toBeDisabled();
    // Distinct from the reader copy: a contributor CAN write here, just not share.
    expect(btn).toHaveAttribute("title", MANAGER_ONLY);
  });

  it("leaves Share enabled for a manager in a library", () => {
    mockSpaces = [
      PERSONAL,
      {
        id: "dept:finance",
        name: "Finance",
        root: "/Finance",
        kind: "department",
        state: "active",
        right: "manager",
        isMember: true,
      },
    ];
    mockFiles = [file("a.pdf")];
    mockSelectedPaths = ["/a.pdf"];
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("tab", { name: /finance/i }));

    expect(shareBtn()).not.toBeDisabled();
  });
});
