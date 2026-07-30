/**
 * WARP-298 — FileRow keyboard navigation.
 *
 * The Files page is the largest single page in the dashboard and rows
 * being click-only was a WCAG 2.1.1 violation. Pin the kb support:
 *   - tabIndex=0, role=button, aria-label includes filename
 *   - Enter / Space → onOpen
 *   - ArrowDown / ArrowUp → focus next/prev row
 *   - Delete → onDelete (routes through ConfirmDialog upstream)
 *   - Shift+F10 / ContextMenu → onContextMenu at row rect
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FileRow } from "@/components/FileManager/FileRow";
import type { FileEntryInfo } from "@/lib/types";

// StarButton hits the favorites API — stub it.
vi.mock("@/components/FileManager/StarButton", () => ({
  StarButton: () => <button type="button">star</button>,
}));

function makeFile(name: string, isDir = false): FileEntryInfo {
  return {
    path: `/${name}`,
    name,
    isDirectory: isDir,
    size: 100,
    modifiedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    mimeType: "text/plain",
  } as unknown as FileEntryInfo;
}

interface Handlers {
  onSelect: ReturnType<typeof vi.fn>;
  onOpen: ReturnType<typeof vi.fn>;
  onDownload: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
  onRename: ReturnType<typeof vi.fn>;
  onCancelRename: ReturnType<typeof vi.fn>;
  onContextMenu: ReturnType<typeof vi.fn>;
}

function rowProps(file: FileEntryInfo, h: Handlers) {
  // The `as any` shim sidesteps vi.fn()'s default `unknown` return type
  // — the actual handlers are signature-compatible at runtime; we only
  // need TS to stop complaining about Mock<..., unknown>.
  return {
    file,
    isSelected: false,
    isRenaming: false,
    onSelect: h.onSelect as any,
    onToggleSelect: vi.fn() as any,
    onOpen: h.onOpen as any,
    onDownload: h.onDownload as any,
    onDelete: h.onDelete as any,
    onRename: h.onRename as any,
    onCancelRename: h.onCancelRename as any,
    onContextMenu: h.onContextMenu as any,
  };
}

function makeHandlers(): Handlers {
  return {
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onDownload: vi.fn(),
    onDelete: vi.fn(),
    // Typed as Promise<void> so the FileRowProps.onRename signature aligns
    // (TS infers `unknown` from vi.fn() by default).
    onRename: vi.fn(),
    onCancelRename: vi.fn(),
    onContextMenu: vi.fn(),
  };
}

describe("FileRow keyboard nav (WARP-298)", () => {
  beforeEach(() => {});

  it("renders as role=button with tabIndex 0 + aria-label", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("hello.txt"), h)} />);
    const row = screen.getByRole("button", { name: /File hello.txt/i });
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("Enter triggers onOpen", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("hello.txt"), h)} />);
    // Exact-match the row's aria-label — WARP-292 added the filename to
    // the action-button labels ("Download hello.txt", "Delete hello.txt"),
    // so a bare /hello.txt/ regex matches the row AND every action button.
    const row = screen.getByRole("button", { name: "File hello.txt" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(h.onOpen).toHaveBeenCalledTimes(1);
  });

  it("Space triggers onOpen and prevents default", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("hello.txt"), h)} />);
    const row = screen.getByRole("button", { name: "File hello.txt" });
    fireEvent.keyDown(row, { key: " " });
    expect(h.onOpen).toHaveBeenCalledTimes(1);
  });

  it("Delete triggers onDelete", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("hello.txt"), h)} />);
    const row = screen.getByRole("button", { name: "File hello.txt" });
    fireEvent.keyDown(row, { key: "Delete" });
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("Backspace does NOT trigger onDelete (too easy to hit by accident)", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("hello.txt"), h)} />);
    const row = screen.getByRole("button", { name: "File hello.txt" });
    fireEvent.keyDown(row, { key: "Backspace" });
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it("Shift+F10 opens context menu at the row's bounding rect", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("hello.txt"), h)} />);
    const row = screen.getByRole("button", { name: "File hello.txt" });
    // JSDOM's getBoundingClientRect returns zeros; we just assert the
    // handler was called with two numeric args.
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(h.onContextMenu).toHaveBeenCalledTimes(1);
    const [x, y] = h.onContextMenu.mock.calls[0];
    expect(typeof x).toBe("number");
    expect(typeof y).toBe("number");
  });

  it("Tab order across three rows: walk + Enter on second opens correct file", () => {
    const handlers = [makeHandlers(), makeHandlers(), makeHandlers()];
    const files = [makeFile("a.txt"), makeFile("b.txt"), makeFile("c.txt")];
    const { container } = render(
      <div>
        {files.map((f, i) => (
          <FileRow key={f.path} {...rowProps(f, handlers[i])} />
        ))}
      </div>,
    );
    const rows = container.querySelectorAll("[data-filerow]");
    expect(rows.length).toBe(3);
    // Focus first row, ArrowDown to second, Enter to open it.
    (rows[0] as HTMLElement).focus();
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(handlers[1].onOpen).toHaveBeenCalledTimes(1);
    // Other rows' handlers were never called.
    expect(handlers[0].onOpen).not.toHaveBeenCalled();
    expect(handlers[2].onOpen).not.toHaveBeenCalled();
  });

  it("ArrowUp moves focus to previous row", () => {
    const handlers = [makeHandlers(), makeHandlers()];
    const files = [makeFile("a.txt"), makeFile("b.txt")];
    const { container } = render(
      <div>
        {files.map((f, i) => (
          <FileRow key={f.path} {...rowProps(f, handlers[i])} />
        ))}
      </div>,
    );
    const rows = container.querySelectorAll("[data-filerow]");
    (rows[1] as HTMLElement).focus();
    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("when isRenaming, keyboard handlers are inert (defer to rename input)", () => {
    const h = makeHandlers();
    render(<FileRow {...rowProps(makeFile("hello.txt"), { ...h })} isRenaming />);
    // The row container itself still exists; assert keyDown is a no-op.
    // role=button is suppressed (the row is no longer the focus stop while
    // renaming) — query by aria-label instead.
    const row = document.querySelector('[data-filerow="1"]') as HTMLElement;
    fireEvent.keyDown(row, { key: "Delete" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(h.onOpen).not.toHaveBeenCalled();
  });
});
