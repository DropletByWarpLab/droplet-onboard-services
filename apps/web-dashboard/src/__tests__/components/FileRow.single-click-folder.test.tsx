/**
 * WARP-309 — single-click on a folder opens it (no double-click required).
 *
 * The Files page previously needed two clicks to navigate into a folder,
 * which felt off in a web app where every other tree-style UI in the
 * dashboard (network groups, knowledge bases) navigates on a single click.
 * Folders open on single-click; files single-click-selects (showing the
 * info sidebar) and double-click "opens" — which now means the rich
 * PreviewPane modal (Samantha QA #bugs; the page routes a file's onOpen to
 * handlePreview). At the FileRow level the contract is unchanged: a file
 * double-click fires onOpen; WHERE that lands is the page's concern and is
 * covered by files-page.doubleclick-preview.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FileRow } from "@/components/FileManager/FileRow";
import type { FileEntryInfo } from "@/lib/types";

vi.mock("@/components/FileManager/StarButton", () => ({
  StarButton: () => <button type="button">star</button>,
}));

function makeFile(name: string, isDir: boolean): FileEntryInfo {
  return {
    path: `/${name}`,
    name,
    isDirectory: isDir,
    size: 100,
    modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    mimeType: isDir ? null : "text/plain",
  } as unknown as FileEntryInfo;
}

interface Handlers {
  onSelect: ReturnType<typeof vi.fn>;
  onOpen: ReturnType<typeof vi.fn>;
}

function makeHandlers(): Handlers {
  return { onSelect: vi.fn(), onOpen: vi.fn() };
}

function rowProps(file: FileEntryInfo, h: Handlers) {
  return {
    file,
    isSelected: false,
    isRenaming: false,
    onSelect: h.onSelect as never,
    onToggleSelect: vi.fn() as never,
    onOpen: h.onOpen as never,
    onDownload: vi.fn() as never,
    onDelete: vi.fn() as never,
    onRename: vi.fn() as never,
    onCancelRename: vi.fn() as never,
    onContextMenu: vi.fn() as never,
  };
}

describe("FileRow — single-click semantics (WARP-309)", () => {
  it("single-click on a folder opens it (no select)", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("docs", true), h)} />);
    fireEvent.click(screen.getByRole("button", { name: /folder docs/i }));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("single-click on a file selects (legacy behavior preserved)", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("notes.txt", false), h)} />);
    fireEvent.click(screen.getByRole("button", { name: /file notes.txt/i }));
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("Cmd-click on a folder toggles selection (does NOT navigate)", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("docs", true), h)} />);
    fireEvent.click(screen.getByRole("button", { name: /folder docs/i }), { metaKey: true });
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("Ctrl-click on a folder toggles selection (does NOT navigate)", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("docs", true), h)} />);
    fireEvent.click(screen.getByRole("button", { name: /folder docs/i }), { ctrlKey: true });
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("Shift-click on a folder extends selection (does NOT navigate)", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("docs", true), h)} />);
    fireEvent.click(screen.getByRole("button", { name: /folder docs/i }), { shiftKey: true });
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();
  });

  it("double-click on a file fires onOpen (page routes this to the rich preview)", () => {
    // Samantha QA #bugs: double-clicking a file should open the PreviewPane
    // modal. FileRow's job is unchanged — it fires onOpen on double-click and
    // does NOT fire onSelect; the page wires onOpen → handlePreview for files
    // (asserted in files-page.doubleclick-preview.test.tsx).
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("notes.txt", false), h)} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /file notes.txt/i }));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onSelect).not.toHaveBeenCalled();
  });
});
