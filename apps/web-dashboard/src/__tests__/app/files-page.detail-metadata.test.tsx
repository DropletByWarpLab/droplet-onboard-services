/**
 * Files — detail panel metadata block (WARP-1877).
 *
 * Bug (Samantha, QA 2026-08-11): selecting a .docx rendered the raw MIME
 * string in the Type row. At 71 characters it overflowed its column, ran into
 * the "Type" label with no gap ("Typeapplication/vnd.openxml…") and pushed
 * Size / Modified out of alignment.
 *
 * Contract asserted here:
 *   1. the raw MIME never appears as visible text — a friendly name does;
 *   2. the raw MIME is still reachable, as the value's tooltip;
 *   3. the value column is constrained (min-w-0 + truncate) and separated
 *      from the label by a token gap, so a long value can neither collide
 *      with the label nor escape the panel's padding;
 *   4. all three rows share the same label/value shape, so they stay aligned;
 *   5. a row gets a tooltip only where one adds information the visible text
 *      doesn't already carry (UX review N1);
 *   6. the Type row still names the file when the MIME is absent or opaque —
 *      driven through the panel, one case per step of the fallback chain.
 *
 * Mock scaffolding mirrors files-page.doubleclick-preview.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function makeFile(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "Freud Biography SR 1.28.docx",
    path: "/Freud Biography SR 1.28.docx",
    size: 45678,
    isDirectory: false,
    mimeType: DOCX_MIME,
    modifiedAt: new Date("2026-01-28T00:00:00Z").toISOString(),
    ...overrides,
  } as FileEntryInfo;
}

// The listing is per-test: the Type row's whole point is that it survives a
// MIME the server never sent, so the fallback chain has to be driven through
// the rendered panel and not just through labelForMime's own unit test.
let entries: FileEntryInfo[] = [makeFile()];

// next/navigation is mocked globally in src/__tests__/setup.ts.

vi.mock("@/lib/hooks/useFiles", () => ({
  useFiles: () => ({
    files: entries,
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useFileManager", () => ({
  useFileManager: () => ({
    selectedPaths: [],
    selectedCount: 0,
    clipboard: null,
    renamingPath: null,
    isSelected: () => false,
    toggleSelection: vi.fn(),
    selectOnly: vi.fn(),
    clearSelection: vi.fn(),
    clearClipboard: vi.fn(),
    beginRename: vi.fn(),
    endRename: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useFavorites", () => ({
  useFavorites: () => ({ items: [], refresh: vi.fn() }),
}));

vi.mock("@/lib/hooks/useFileRealtime", () => ({
  useFileRealtime: vi.fn(),
}));

vi.mock("@/lib/hooks/useSpaces", () => ({
  useSpaces: () => ({ spaces: [], sharedAvailable: false }),
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

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    uploadFiles: vi.fn(),
    deleteFile: vi.fn(),
    createDirectory: vi.fn(),
    getDownloadUrl: (p: string) => `/api/files/download?path=${p}`,
    getThumbnailUrl: (p: string) => `/api/files/thumbnail?path=${p}`,
    renameFile: vi.fn(),
    bulkDeleteFiles: vi.fn(),
    bulkMoveFiles: vi.fn(),
    bulkCopyFiles: vi.fn(),
    fetchShares: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    authFetch: vi.fn().mockResolvedValue({ text: () => Promise.resolve("") }),
    useAuth: () => ({
      user: { id: "u1", username: "owner", displayName: "Owner", role: "owner" },
      isLoading: false,
    }),
  };
});

import FilesPage from "@/app/files/page";

/** Select the listing's only file and hand back the detail panel's rows. */
function openDetailPanel(container: HTMLElement): HTMLElement[] {
  const row = screen.getByRole("button", { name: `File ${entries[0]!.name}` });
  fireEvent.click(row);
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-meta-row]")
  );
}

/** The Type row's value element, with the panel already open. */
function typeValue(container: HTMLElement): HTMLElement {
  return openDetailPanel(container)
    .find((r) => r.dataset.metaRow === "type")!
    .querySelector<HTMLElement>("[data-meta-value]")!;
}

describe("Files detail panel — metadata block (WARP-1877)", () => {
  beforeEach(() => {
    cleanup();
    entries = [makeFile()];
  });

  it("shows a friendly type name instead of the raw MIME string", () => {
    const { container } = render(<FilesPage />);
    openDetailPanel(container);

    expect(screen.getByText("Word document")).toBeInTheDocument();
    expect(screen.queryByText(DOCX_MIME)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("openxmlformats");
  });

  it("keeps the full MIME type available as the value's tooltip", () => {
    const { container } = render(<FilesPage />);
    const rows = openDetailPanel(container);

    const typeRow = rows.find((r) => r.dataset.metaRow === "type");
    expect(typeRow).toBeDefined();
    const value = typeRow!.querySelector<HTMLElement>("[data-meta-value]");
    expect(value).not.toBeNull();
    expect(value!.getAttribute("title")).toBe(DOCX_MIME);
  });

  it("gives a row a tooltip only when it carries more than its visible text", () => {
    const { container } = render(<FilesPage />);
    const rows = openDetailPanel(container);
    const valueOf = (id: string) =>
      rows
        .find((r) => r.dataset.metaRow === id)!
        .querySelector<HTMLElement>("[data-meta-value]")!;

    // Size is fully visible, so a tooltip would only repeat it — and a screen
    // reader would then read the same string twice.
    const size = valueOf("size");
    expect(size.getAttribute("title")).toBeNull();

    // Modified shows the date but drops the time of day, so its tooltip has
    // something to add: it must differ from the visible value.
    const modified = valueOf("modified");
    const modifiedTitle = modified.getAttribute("title");
    expect(modifiedTitle).toBeTruthy();
    expect(modifiedTitle).not.toBe(modified.textContent?.trim());
  });

  it("constrains the value column so a long value cannot collide or escape", () => {
    const { container } = render(<FilesPage />);
    const rows = openDetailPanel(container);

    const typeRow = rows.find((r) => r.dataset.metaRow === "type")!;
    const value = typeRow.querySelector<HTMLElement>("[data-meta-value]")!;
    const label = typeRow.querySelector<HTMLElement>("[data-meta-label]")!;

    // The value can shrink and clips inside its own box.
    expect(value.className).toContain("min-w-0");
    expect(value.className).toContain("truncate");
    // The label never shrinks away, so the two can never overlap.
    expect(label.className).toContain("shrink-0");
    // A spacing-scale gap sits between label and value (4/8/12/16 … px).
    expect(typeRow.className).toMatch(/\bgap-(1|2|3|4)\b/);
  });

  it("gives Size, Type and Modified the same row shape so they stay aligned", () => {
    const { container } = render(<FilesPage />);
    const rows = openDetailPanel(container);

    expect(rows.map((r) => r.dataset.metaRow)).toEqual([
      "size",
      "type",
      "modified",
    ]);
    const shapes = new Set(rows.map((r) => r.className));
    expect(shapes.size).toBe(1);
    for (const row of rows) {
      expect(row.querySelector("[data-meta-label]")).not.toBeNull();
      expect(row.querySelector("[data-meta-value]")).not.toBeNull();
    }
  });

  // The file-indexer skips Office documents as unknown_type when its MIME
  // tables are missing, so an absent or opaque mimeType is a shape this panel
  // renders in production. Each case below is driven through the panel, so
  // deleting a step of labelForMime's fallback chain turns one of them red.
  it("names the type from the file name when the listing sent no MIME", () => {
    entries = [makeFile({ name: "scan.pdf", path: "/scan.pdf", mimeType: null })];
    const { container } = render(<FilesPage />);
    const value = typeValue(container);

    expect(value.textContent).toBe("PDF document");
    // No raw MIME to reveal, so the row carries nothing the words don't.
    expect(value.getAttribute("title")).toBeNull();
  });

  it("says Unknown rather than naming a version number as a type", () => {
    // Nextcloud sends application/octet-stream when getcontenttype is absent;
    // "01" is a version segment, not a file type.
    entries = [
      makeFile({
        name: "Backup 2026.01",
        path: "/Backup 2026.01",
        mimeType: "application/octet-stream",
      }),
    ];
    const { container } = render(<FilesPage />);

    expect(typeValue(container).textContent).toBe("Unknown");
  });

  it("says Unknown for a file with neither MIME nor extension", () => {
    entries = [
      makeFile({ name: "Household notes", path: "/Household notes", mimeType: null }),
    ];
    const { container } = render(<FilesPage />);

    expect(typeValue(container).textContent).toBe("Unknown");
  });
});
