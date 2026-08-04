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

// WARP-1661 — the share-routing decisions that do NOT open a surface report
// themselves through a toast (folders-only, a skipped folder alongside a single
// shareable file). Nothing here mounts a ToastProvider, so without this spy
// those calls land on the context default and vanish. `importOriginal` keeps
// the module's other exports (ToastProvider) real for anything that needs them.
const toastSpy = vi.fn();
vi.mock("@/components/Toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Toast")>()),
  useToast: () => ({ toast: toastSpy }),
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

  // WARP-1659 — the run hardcodes `BULK_SHARE_OPTIONS` and the panel renders
  // no password field and no expiry picker. The `share` domain infers
  // PASSWORD_REJECTED from any OCS message containing "password", so on a box
  // with enforce-password-on-public-links turned on, EVERY row used to tell the
  // user their password didn't meet the rules — for a password they were never
  // asked for and cannot supply, which reads as "the app is broken" and points
  // away from the instance policy that is the actual cause.
  it("never blames the user's password for a rejection in a flow that has no password field", async () => {
    mockFiles = [file("a.pdf"), file("b.pdf")];
    mockSelectedPaths = ["/a.pdf", "/b.pdf"];
    createShareMock.mockRejectedValue(
      Object.assign(
        new Error("OCS share create: Passwords are enforced for link shares (403)"),
        { status: 403 }
      )
    );
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /none of the 2 files could be shared/i
      )
    );
    const dialog = screen.getByRole("dialog");
    // The ShareDialog's sentence, about a control this surface never showed.
    expect(
      within(dialog).queryByText(/that password doesn't meet/i)
    ).toBeNull();
    expect(within(dialog).queryByText(/longer, less common/i)).toBeNull();
    // …replaced by copy that is true here AND names a remedy that exists
    // without an admin — not the "try again in a moment" fallback, which is
    // wrong advice for a deterministic policy rejection.
    expect(
      within(dialog).getAllByText(/share this file on its own to add a password/i)
    ).toHaveLength(2);
    expect(within(dialog).queryByText(/try again in a moment/i)).toBeNull();
    // Raw OCS prose never reaches the panel.
    expect(within(dialog).queryByText(/OCS/)).toBeNull();
  });

  // WARP-1661 — routing used to be decided on the RAW selection count, before
  // folders were filtered out. One folder + one file is 2 entries, so the
  // single-file shortcut missed, the fan-out ran, the folder was dropped inside
  // it, and the user got the bulk panel with ONE row — hardcoded public link,
  // no permission preset, no expiry, no password — for what is a single-file
  // share. Its summary could even read "None of the 1 file could be shared."
  //
  // The count that decides the surface is the SHAREABLE count, so all three
  // routes are pinned here against the reorder.
  it("opens the ShareDialog when a selection holds exactly one shareable file, and names the skipped folder", () => {
    mockFiles = [folder("Trips"), file("a.pdf")];
    mockSelectedPaths = ["/Trips", "/a.pdf"];
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    // The single-file surface — with the controls the fan-out does not have.
    expect(screen.getByTestId("share-dialog")).toHaveTextContent("a.pdf");
    // Not the fan-out: no loop, no one-row panel.
    expect(createShareMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The folder is dropped, never silently — same sentence the panel uses.
    expect(toastSpy).toHaveBeenCalledWith(
      "Skipped 1 folder (Trips) — folders are shared one at a time.",
      "info"
    );
  });

  it("opens the ShareDialog for a lone file with nothing to skip and no note", () => {
    mockFiles = [file("a.pdf")];
    mockSelectedPaths = ["/a.pdf"];
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    expect(screen.getByTestId("share-dialog")).toHaveTextContent("a.pdf");
    expect(createShareMock).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  // The trap in the WARP-1661 reorder: routing purely on `shareable.length`
  // sends a folder selected ON ITS OWN to the folders-only toast — telling a
  // user who did exactly what the toast asks to go do it. A solo selection is
  // the deliberate single share the dialog exists for, folder included.
  it("opens the ShareDialog for a folder selected on its own", () => {
    mockFiles = [folder("Trips")];
    mockSelectedPaths = ["/Trips"];
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    expect(screen.getByTestId("share-dialog")).toHaveTextContent("Trips");
    expect(toastSpy).not.toHaveBeenCalled();
    expect(createShareMock).not.toHaveBeenCalled();
  });

  it("refuses a folders-only selection without opening either share surface", () => {
    mockFiles = [folder("Trips"), folder("Photos")];
    mockSelectedPaths = ["/Trips", "/Photos"];
    render(<FilesPage />);

    fireEvent.click(shareBtn());

    expect(toastSpy).toHaveBeenCalledWith(
      "Folders are shared one at a time — select a folder on its own."
    );
    expect(createShareMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("share-dialog")).toBeNull();
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
    // ONLY c.pdf was never dispatched. b.pdf's POST was already on the wire
    // when Escape landed, so calling it "stopped before this file" would deny
    // a link that may well exist — this used to assert 2 and pinned that bug.
    expect(
      within(dialog).getAllByText(/no link — stopped before this file/i)
    ).toHaveLength(1);
    expect(
      within(dialog).getByText(
        /stopped while this one was still being created — it may have a link/i
      )
    ).toBeInTheDocument();
    // The loop really stopped: c.pdf was queued after the hung b.pdf.
    expect(createShareMock).toHaveBeenCalledTimes(2);
  });

  it("shows the link when the in-flight share lands AFTER the user stopped", async () => {
    // The harm this fixes, end to end: b.pdf's POST is already on the wire when
    // Stop is pressed, and it succeeds. The link is live, public, no-expiry.
    // Discarding that result (the old run-token gate) left the panel stating
    // no link existed for b.pdf — an affirmative denial, which is worse than
    // silence because it says there is nothing to go clean up.
    let resolveB: (v: unknown) => void = () => {};
    mockFiles = [file("a.pdf"), file("b.pdf"), file("c.pdf")];
    mockSelectedPaths = ["/a.pdf", "/b.pdf", "/c.pdf"];
    createShareMock.mockImplementation((path: string) =>
      path === "/b.pdf"
        ? new Promise((res) => {
            resolveB = res;
          })
        : Promise.resolve({
            id: 1,
            url: `https://box/s/${path.slice(1)}`,
            token: "t",
          })
    );
    render(<FilesPage />);
    fireEvent.click(shareBtn());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /creating public links… 1 of 3 done/i
      )
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/stopped\./i)
    );

    // The hung request now settles — successfully.
    resolveB({ id: 2, url: "https://box/s/b.pdf", token: "t2" });

    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByText("https://box/s/b.pdf")).toBeInTheDocument()
    );
    // It is no longer described as "may have a link" — we now know it does.
    expect(
      within(dialog).queryByText(
        /stopped while this one was still being created/i
      )
    ).not.toBeInTheDocument();
    // And it is copyable, like any other created link.
    expect(
      within(dialog).getByRole("button", { name: /copy link for b\.pdf/i })
    ).toBeInTheDocument();
    // c.pdf was still never dispatched — stopping really did stop the loop.
    expect(createShareMock).toHaveBeenCalledTimes(2);
  });

  it("points at Shared by me when the ONLY in-flight share is left unknown", async () => {
    // ok === 0 with an unknown row: the old copy said "Stopped — no links were
    // created." and offered no recovery path at all.
    mockFiles = [file("a.pdf"), file("b.pdf"), file("c.pdf")];
    mockSelectedPaths = ["/a.pdf", "/b.pdf", "/c.pdf"];
    createShareMock.mockImplementation(() => new Promise(() => {}));
    render(<FilesPage />);
    fireEvent.click(shareBtn());
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /creating public links… 0 of 3 done/i
      )
    );

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /no links finished being created, but 1 was still in progress and may have one — check shared → shared by me/i
      )
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /no links were created\./i
    );
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

// WARP-1667 — the Spaces menu paints BEHIND the page content below it.
//
// Not a z-index-too-low bug in the menu itself. `droplet-shell.css` puts
// `animation: ds-rise 520ms var(--ease) both` on every `.page-inner > *`;
// ds-rise animates `transform`/`opacity` and `fill-mode: both` keeps it in
// its filling phase forever, so each `.page-inner` child is a PERMANENT
// stacking context. The menu's own `z-30` is therefore trapped inside the
// switcher's wrapper, and the wrapper — `z-index: auto` — simply loses to
// its later siblings (breadcrumbs, admin banner, volumes panel, file rows)
// in paint order.
//
// The search bar hit this exact wall in WARP-1139 and got `relative z-40`.
// These specs pin the equivalent lift on the switcher wrapper, and pin the
// ORDERING that makes `z-30` (not `z-40`) the right number: search results
// must keep painting over the space pills.
//
// jsdom evaluates no Tailwind stylesheet, so `getComputedStyle` reports no
// z-index — the utility class is the only observable. `zIndexOf` reads it.
describe("<FilesPage /> — Spaces menu layering (WARP-1667)", () => {
  const FINANCE: FileSpace = {
    id: "dept:finance",
    name: "Finance",
    root: "/Finance",
    kind: "department",
    state: "active",
    right: "contributor",
    isMember: true,
  };
  const LEGAL: FileSpace = { ...FINANCE, id: "dept:legal", name: "Legal", root: "/Legal" };
  const ENG: FileSpace = { ...FINANCE, id: "dept:eng", name: "Engineering", root: "/Eng" };

  // >3 active spaces forces the collapsed "Spaces" menu rather than the
  // plain segmented tablist — the only shape in which this bug exists.
  beforeEach(() => {
    mockSpaces = [PERSONAL, SHARED, FINANCE, LEGAL, ENG];
  });

  /** Tailwind's `z-<n>` utility as a number; no utility means `auto` → 0. */
  function zIndexOf(el: Element | null | undefined): number {
    const match = el?.className?.toString().match(/(?:^|\s)z-(\d+)(?:\s|$)/);
    return match ? Number(match[1]) : 0;
  }

  /** The `.page-inner` child that contains `el` — the stacking context it's trapped in. */
  function pageInnerAncestorOf(el: Element): Element {
    const inner = el.closest(".page-inner");
    expect(inner).not.toBeNull();
    const child = Array.from(inner!.children).find((c) => c.contains(el));
    expect(child).toBeDefined();
    return child!;
  }

  it("collapses to the Spaces menu and opens it", () => {
    render(<FilesPage />);
    const trigger = screen.getByRole("button", { name: /spaces/i });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: /spaces/i })).toBeInTheDocument();
  });

  it("raises the switcher's stacking context above every later page-inner sibling", () => {
    render(<FilesPage />);
    fireEvent.click(screen.getByRole("button", { name: /spaces/i }));

    const wrapper = pageInnerAncestorOf(screen.getByRole("tablist", { name: /file space/i }));
    const siblings = Array.from(wrapper.parentElement!.children);
    const later = siblings.slice(siblings.indexOf(wrapper) + 1);

    // Every one of these — breadcrumbs, banner, volumes panel, file rows —
    // is its own stacking context; the switcher has to outrank all of them.
    expect(later.length).toBeGreaterThan(0);
    for (const sibling of later) {
      expect(zIndexOf(sibling)).toBeLessThan(zIndexOf(wrapper));
    }
  });

  it("is positioned, so its z-index actually applies", () => {
    render(<FilesPage />);
    const wrapper = pageInnerAncestorOf(screen.getByRole("tablist", { name: /file space/i }));
    // `z-*` is inert on a `position: static` box.
    expect(wrapper.className).toMatch(/(?:^|\s)(relative|absolute|fixed|sticky)(?:\s|$)/);
  });

  it("stays BELOW the search wrapper — WARP-1139 is not regressed", () => {
    render(<FilesPage />);
    const switcher = pageInnerAncestorOf(screen.getByRole("tablist", { name: /file space/i }));
    // The real SearchBar is stubbed at the top of this file; the WRAPPER that
    // carries the WARP-1139 `relative z-40` is the page's own and is
    // unaffected by that stub.
    const search = pageInnerAncestorOf(
      screen.getByRole("button", { name: /pick search result/i })
    );

    // The search wrapper comes FIRST in DOM order, so a tie would hand the
    // win to the switcher and put the results popover back underneath it.
    expect(zIndexOf(switcher)).toBeLessThan(zIndexOf(search));
  });
});
