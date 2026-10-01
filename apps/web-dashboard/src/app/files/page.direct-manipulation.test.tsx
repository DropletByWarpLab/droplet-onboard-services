/**
 * Files page — the "Finder/Explorer" layer: right-click menus, drag-to-move,
 * Icons/List view, folder colours. Mounts the real page with the data hooks
 * mocked (same seam as page.test.tsx) but the REAL `useFileManager`, so
 * selection and view-mode behave as shipped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { FileEntryInfo, FileSpace, FolderColor } from "@/lib/types";

let mockSearchParamsString = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/files",
}));

const toastSpy = vi.fn();
vi.mock("@/components/Toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Toast")>()),
  useToast: () => ({ toast: toastSpy }),
}));

const PERSONAL: FileSpace = { id: "personal", name: "My Files", root: "/" };
const SHARED: FileSpace = {
  id: "shared",
  name: "Household",
  root: "/Household",
  kind: "household",
  state: "active",
};
vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({
    spaces: [PERSONAL, SHARED],
    sharedAvailable: true,
    error: undefined,
    isLoading: false,
  }),
}));

let mockUser = { id: "u1", email: "f@example.com", role: "family" };
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, useAuth: () => ({ user: mockUser, isLoading: false }) };
});

const mk = (name: string, dir: string, isDirectory: boolean, ncFileId?: number): FileEntryInfo => ({
  name,
  path: `${dir === "/" ? "" : dir}/${name}`,
  isDirectory,
  size: isDirectory ? 0 : 10,
  mimeType: isDirectory ? null : "text/plain",
  modifiedAt: "2026-04-16T00:00:00.000Z",
  ...(ncFileId !== undefined ? { ncFileId } : {}),
});

let mockFiles: FileEntryInfo[] = [];
const refreshMock = vi.fn();
vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({ files: mockFiles, error: undefined, isLoading: false, refresh: refreshMock }),
}));

let mockColors = new Map<number, FolderColor>();
const refreshColorsMock = vi.fn();
vi.mock("@/lib/hooks/useFolderColors", () => ({
  useFolderColors: () => ({ colors: mockColors, refresh: refreshColorsMock }),
}));

vi.mock("@/lib/hooks/useDrives", () => ({
  useDrives: () => ({ drives: [], disks: [], isLoading: false, bridgeError: undefined, refresh: vi.fn() }),
}));
vi.mock("@/lib/hooks/usePools", () => ({
  usePools: () => ({ pools: [], isLoading: false, error: undefined, bridgeError: undefined, refresh: vi.fn() }),
}));
vi.mock("@/components/FileManager/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({ items: [], error: undefined, isLoading: false, refresh: vi.fn() }),
}));
vi.mock("@/lib/hooks/useFileRealtime", () => ({ useFileRealtime: () => undefined }));
vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: { id: "box-1", name: "Droplet", status: "online" },
    devices: [{ id: "box-1", name: "Droplet", status: "online" }],
    health: { status: "ok" },
    isLoading: false,
    error: undefined,
  }),
}));
vi.mock("@/components/FileManager/VolumesPanel", () => ({ VolumesPanel: () => null }));

const bulkMoveMock = vi.fn();
const setColorMock = vi.fn();
const clearColorMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchShares: vi.fn().mockResolvedValue([]),
    fetchSystemHealth: vi.fn().mockResolvedValue({ status: "ok" }),
    bulkMoveFiles: (...a: unknown[]) => bulkMoveMock(...a),
    setFolderColor: (...a: unknown[]) => setColorMock(...a),
    clearFolderColor: (...a: unknown[]) => clearColorMock(...a),
  };
});

import FilesPage from "./page";

const INTERNAL = "application/x-droplet-files";
/** A DataTransfer that carries what dragstart wrote through to dragover/drop. */
function sharedDT() {
  const store: Record<string, string> = {};
  return {
    get types() {
      return Object.keys(store);
    },
    setData: (k: string, v: string) => void (store[k] = v),
    getData: (k: string) => store[k] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

function drag(from: HTMLElement, onto: HTMLElement) {
  const dataTransfer = sharedDT();
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragEnter(onto, { dataTransfer });
  fireEvent.dragOver(onto, { dataTransfer });
  fireEvent.drop(onto, { dataTransfer });
  fireEvent.dragEnd(from);
  return dataTransfer;
}

const row = (kind: "File" | "Folder", name: string) =>
  screen.getByRole("button", { name: `${kind} ${name}` });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockSearchParamsString = "";
  mockUser = { id: "u1", email: "f@example.com", role: "family" };
  mockFiles = [mk("Docs", "/", true, 11), mk("Photos", "/", true, 12), mk("a.txt", "/", false, 13)];
  mockColors = new Map();
  bulkMoveMock.mockResolvedValue([{ path: "/a.txt", ok: true }]);
});

describe("drag to move", () => {
  it("moves a dragged file into the folder it is dropped on, then refreshes", async () => {
    render(<FilesPage />);
    drag(row("File", "a.txt"), row("Folder", "Docs"));
    await waitFor(() =>
      expect(bulkMoveMock).toHaveBeenCalledWith(["/a.txt"], "/Docs", false, "personal")
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("drags the whole selection when the dragged row is part of it", async () => {
    render(<FilesPage />);
    fireEvent.click(within(row("File", "a.txt")).getByRole("checkbox"));
    fireEvent.click(within(row("Folder", "Photos")).getByRole("checkbox"));
    drag(row("File", "a.txt"), row("Folder", "Docs"));
    await waitFor(() => expect(bulkMoveMock).toHaveBeenCalled());
    const [paths, target] = bulkMoveMock.mock.calls[0];
    expect([...paths].sort()).toEqual(["/Photos", "/a.txt"]);
    expect(target).toBe("/Docs");
  });

  it("dropping a folder on itself is a no-op", async () => {
    render(<FilesPage />);
    const docs = row("Folder", "Docs");
    drag(docs, docs);
    await new Promise((r) => setTimeout(r, 20));
    expect(bulkMoveMock).not.toHaveBeenCalled();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("does not highlight the dragged folder as its own drop target", () => {
    render(<FilesPage />);
    const docs = row("Folder", "Docs");
    const dataTransfer = sharedDT();
    fireEvent.dragStart(docs, { dataTransfer });
    fireEvent.dragEnter(docs, { dataTransfer });
    expect(docs).not.toHaveAttribute("data-drop-over");
    fireEvent.dragEnter(row("Folder", "Photos"), { dataTransfer });
    expect(row("Folder", "Photos")).toHaveAttribute("data-drop-over", "1");
  });

  it("moves into a parent via its breadcrumb", async () => {
    mockSearchParamsString = "path=%2FDocs%2FSub";
    mockFiles = [mk("b.txt", "/Docs/Sub", false, 21)];
    render(<FilesPage />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumbs" });
    drag(row("File", "b.txt"), within(nav).getByRole("button", { name: "Docs" }));
    await waitFor(() =>
      expect(bulkMoveMock).toHaveBeenCalledWith(["/Docs/Sub/b.txt"], "/Docs", false, "personal")
    );
  });

  it("moving to the root crumb sends '/'", async () => {
    mockSearchParamsString = "path=%2FDocs%2FSub";
    mockFiles = [mk("b.txt", "/Docs/Sub", false, 21)];
    render(<FilesPage />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumbs" });
    drag(row("File", "b.txt"), within(nav).getByRole("button", { name: "My files" }));
    await waitFor(() =>
      expect(bulkMoveMock).toHaveBeenCalledWith(["/Docs/Sub/b.txt"], "/", false, "personal")
    );
  });

  it("sends space-relative paths and the space inside a shared library", async () => {
    mockSearchParamsString = "space=shared";
    mockFiles = [mk("x.txt", "/Household", false, 31), mk("Trips", "/Household", true, 32)];
    render(<FilesPage />);
    await waitFor(() => expect(row("Folder", "Trips")).toBeInTheDocument());
    drag(row("File", "x.txt"), row("Folder", "Trips"));
    await waitFor(() =>
      expect(bulkMoveMock).toHaveBeenCalledWith(["/x.txt"], "/Trips", false, "shared")
    );
  });

  it("toasts a failed move", async () => {
    bulkMoveMock.mockResolvedValue([{ path: "/a.txt", ok: false, error: "exists" }]);
    render(<FilesPage />);
    drag(row("File", "a.txt"), row("Folder", "Docs"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(String(toastSpy.mock.calls[0][0])).toMatch(/a\.txt/);
  });

  it("toasts when the request itself fails", async () => {
    bulkMoveMock.mockRejectedValue(new Error("network"));
    render(<FilesPage />);
    drag(row("File", "a.txt"), row("Folder", "Docs"));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
  });

  it("ignores a payload this page never started dragging (another tab)", async () => {
    render(<FilesPage />);
    const dataTransfer = sharedDT();
    dataTransfer.setData(INTERNAL, JSON.stringify(["/a.txt"]));
    fireEvent.dragEnter(row("Folder", "Docs"), { dataTransfer });
    fireEvent.drop(row("Folder", "Docs"), { dataTransfer });
    await new Promise((r) => setTimeout(r, 20));
    expect(bulkMoveMock).not.toHaveBeenCalled();
  });

  it("is off for a guest (rows are not draggable)", () => {
    mockUser = { id: "g1", email: "g@example.com", role: "guest" };
    render(<FilesPage />);
    expect(row("File", "a.txt")).not.toHaveAttribute("draggable", "true");
  });
});

describe("right-click menus", () => {
  it("a folder menu offers the full set including Color", () => {
    render(<FilesPage />);
    fireEvent.contextMenu(row("Folder", "Docs"));
    const menu = screen.getByRole("menu");
    for (const name of ["Open", "Rename", "Move to…", "Copy to…", "Share link", "Color", "Delete"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
  });

  it("a file menu has no Color entry", () => {
    render(<FilesPage />);
    fireEvent.contextMenu(row("File", "a.txt"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Preview" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Color" })).toBeNull();
  });

  it("Shift+F10 opens the menu from the keyboard, focuses it, and Esc closes it", () => {
    render(<FilesPage />);
    const docs = row("Folder", "Docs");
    docs.focus();
    fireEvent.keyDown(docs, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(docs).toHaveFocus();
  });

  it("the list background offers New folder and Upload files", () => {
    render(<FilesPage />);
    fireEvent.contextMenu(screen.getByText("Name").closest(".card") as HTMLElement);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Upload files…" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Paste" })).toBeNull();
  });

  it("a right-click on a row opens the row menu, not the background one", () => {
    render(<FilesPage />);
    fireEvent.contextMenu(row("Folder", "Docs"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.queryByRole("menuitem", { name: "New folder" })).toBeNull();
  });

  it("New folder from the background menu opens the composer", () => {
    render(<FilesPage />);
    fireEvent.contextMenu(screen.getByText("Name").closest(".card") as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(screen.getByPlaceholderText("Folder name...")).toBeInTheDocument();
  });

  it("a guest gets only the read-only half (no Rename/Move/Share/Delete) plus Color", () => {
    mockUser = { id: "g1", email: "g@example.com", role: "guest" };
    render(<FilesPage />);
    fireEvent.contextMenu(row("Folder", "Docs"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Color" })).toBeInTheDocument();
    for (const name of ["Rename", "Move to…", "Copy to…", "Share link", "Delete"]) {
      expect(within(menu).queryByRole("menuitem", { name })).toBeNull();
    }
  });

  it("a guest gets no background menu", () => {
    mockUser = { id: "g1", email: "g@example.com", role: "guest" };
    render(<FilesPage />);
    fireEvent.contextMenu(screen.getByText("Name").closest(".card") as HTMLElement);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("folder colors", () => {
  it("picking a swatch stores the colour against the space-relative path", async () => {
    render(<FilesPage />);
    fireEvent.contextMenu(row("Folder", "Docs"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Color" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Red" }));
    await waitFor(() => expect(setColorMock).toHaveBeenCalledWith("/Docs", "red", "personal"));
    await waitFor(() => expect(refreshColorsMock).toHaveBeenCalled());
  });

  it("'No color' clears it", async () => {
    mockColors = new Map([[11, "blue"]]);
    render(<FilesPage />);
    fireEvent.contextMenu(row("Folder", "Docs"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Color" }));
    expect(screen.getByRole("menuitemradio", { name: "Blue" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "No color" }));
    await waitFor(() => expect(clearColorMock).toHaveBeenCalledWith("/Docs", "personal"));
  });

  it("guests may colour folders too", async () => {
    mockUser = { id: "g1", email: "g@example.com", role: "guest" };
    render(<FilesPage />);
    fireEvent.contextMenu(row("Folder", "Docs"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Color" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Green" }));
    await waitFor(() => expect(setColorMock).toHaveBeenCalledWith("/Docs", "green", "personal"));
  });

  it("colours every selected folder at once", async () => {
    render(<FilesPage />);
    fireEvent.click(within(row("Folder", "Docs")).getByRole("checkbox"));
    fireEvent.click(within(row("Folder", "Photos")).getByRole("checkbox"));
    fireEvent.contextMenu(row("Folder", "Docs"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Color" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Purple" }));
    await waitFor(() => expect(setColorMock).toHaveBeenCalledTimes(2));
    const paths = setColorMock.mock.calls.map((c) => c[0]).sort();
    expect(paths).toEqual(["/Docs", "/Photos"]);
  });

  it("renders the stored colour on the folder, keyed by ncFileId", () => {
    mockColors = new Map([[12, "orange"]]);
    render(<FilesPage />);
    expect(within(row("Folder", "Photos")).getByRole("checkbox").querySelector('[data-folder-color="orange"]')).not.toBeNull();
    expect(row("Folder", "Docs").querySelector("[data-folder-color]")).toBeNull();
  });

  it("toasts, and still refreshes, when saving fails", async () => {
    setColorMock.mockRejectedValue(new Error("nope"));
    render(<FilesPage />);
    fireEvent.contextMenu(row("Folder", "Docs"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Color" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Red" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(refreshColorsMock).toHaveBeenCalled();
  });
});

describe("Icons / List view", () => {
  it("defaults to list, switches to tiles, and remembers the choice", () => {
    const first = render(<FilesPage />);
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
    expect(first.container.querySelector("[data-filetile]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Icons view" }));
    expect(first.container.querySelectorAll("[data-filetile]")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Icons view" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Modified")).toBeNull();
    first.unmount();

    const second = render(<FilesPage />);
    expect(second.container.querySelectorAll("[data-filetile]")).toHaveLength(3);
  });

  it("tiles support drag-to-move and the right-click menu like rows", async () => {
    window.localStorage.setItem("droplet.files.viewMode", "grid");
    render(<FilesPage />);
    await waitFor(() => expect(row("Folder", "Docs")).toHaveAttribute("data-filetile"));
    fireEvent.contextMenu(row("Folder", "Docs"));
    expect(screen.getByRole("menuitem", { name: "Color" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    drag(row("File", "a.txt"), row("Folder", "Docs"));
    await waitFor(() =>
      expect(bulkMoveMock).toHaveBeenCalledWith(["/a.txt"], "/Docs", false, "personal")
    );
  });
});
