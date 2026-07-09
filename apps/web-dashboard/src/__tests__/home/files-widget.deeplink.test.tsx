/**
 * Home FilesWidget — Recent-files rows deep-link into /files (WARP-1142/1143).
 *
 * Bug: the widget's rows were display-only <div>s — no click, no keyboard, no
 * accessible name. These tests pin the fix: rows are real <button>s that
 * navigate to the Files page — folders open at that folder, files open their
 * parent folder with `?preview=<path>` so the page selects + previews them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

const entry = (over: Partial<FileEntryInfo>): FileEntryInfo =>
  ({
    name: "x",
    path: "/x",
    size: 10,
    isDirectory: false,
    mimeType: "text/plain",
    modifiedAt: new Date().toISOString(),
    ...over,
  }) as FileEntryInfo;

const items: FileEntryInfo[] = [
  entry({ name: "report.pdf", path: "/docs/report.pdf", mimeType: "application/pdf" }),
  entry({ name: "photos", path: "/photos", isDirectory: true, mimeType: null }),
  entry({ name: "notes.txt", path: "/notes.txt" }),
];

vi.mock("@/lib/hooks/useRecents", () => ({
  useRecents: () => ({ items, error: null, isLoading: false, refresh: vi.fn() }),
}));

import { FilesWidget } from "@/components/home/widgets";

describe("Home FilesWidget rows (WARP-1142/1143)", () => {
  beforeEach(() => {
    cleanup();
    pushMock.mockReset();
  });

  it("renders each row as a focusable button named for the item", () => {
    render(<FilesWidget />);

    const fileRow = screen.getByRole("button", { name: "Open report.pdf" });
    const folderRow = screen.getByRole("button", { name: "Open folder photos" });
    expect(fileRow.tagName).toBe("BUTTON");
    expect(folderRow.tagName).toBe("BUTTON");
    // Native buttons are keyboard-focusable (Tab) and activate on Enter/Space.
    expect(fileRow.tabIndex).toBe(0);
  });

  it("clicking a file opens Files at its parent folder with ?preview=<path>", () => {
    render(<FilesWidget />);

    fireEvent.click(screen.getByRole("button", { name: "Open report.pdf" }));

    expect(pushMock).toHaveBeenCalledWith(
      "/files?path=%2Fdocs&preview=%2Fdocs%2Freport.pdf",
    );
  });

  it("clicking a root-level file targets the root listing", () => {
    render(<FilesWidget />);

    fireEvent.click(screen.getByRole("button", { name: "Open notes.txt" }));

    expect(pushMock).toHaveBeenCalledWith(
      "/files?path=%2F&preview=%2Fnotes.txt",
    );
  });

  it("clicking a folder opens Files at that folder (no preview param)", () => {
    render(<FilesWidget />);

    fireEvent.click(screen.getByRole("button", { name: "Open folder photos" }));

    expect(pushMock).toHaveBeenCalledWith("/files?path=%2Fphotos");
  });
});
