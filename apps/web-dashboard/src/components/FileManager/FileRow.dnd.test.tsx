/**
 * Drag-to-move + folder colour on the list row and the grid tile. Both render
 * the same contract, so both are exercised through one table.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileRow } from "./FileRow";
import { FileTile } from "./FileTile";
import type { FileEntryInfo } from "@/lib/types";

const FOLDER: FileEntryInfo = {
  name: "Docs",
  path: "/Docs",
  isDirectory: true,
  size: 0,
  mimeType: null,
  modifiedAt: "2026-04-16T00:00:00.000Z",
};
const FILE: FileEntryInfo = { ...FOLDER, name: "a.txt", path: "/a.txt", isDirectory: false, mimeType: "text/plain" };

function dt(initial: Record<string, string> = {}) {
  const store = { ...initial };
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
const INTERNAL = "application/x-droplet-files";

const base = {
  isSelected: false,
  isRenaming: false,
  onSelect: () => {},
  onToggleSelect: () => {},
  onOpen: () => {},
  onDelete: () => {},
  onRename: () => {},
  onCancelRename: () => {},
  onContextMenu: () => {},
};

const variants = [
  [
    "FileRow",
    (p: Record<string, unknown>) => (
      <FileRow {...base} onDownload={() => {}} {...(p as object)} file={p.file as FileEntryInfo} />
    ),
  ],
  [
    "FileTile",
    (p: Record<string, unknown>) => <FileTile {...base} {...(p as object)} file={p.file as FileEntryInfo} />,
  ],
] as const;

describe.each(variants)("%s drag and drop", (_name, renderItem) => {
  it("is draggable only when a drag-start handler is supplied", () => {
    const { unmount } = render(renderItem({ file: FILE }));
    expect(screen.getByRole("button", { name: /file a\.txt/i })).not.toHaveAttribute(
      "draggable",
      "true"
    );
    unmount();
    render(renderItem({ file: FILE, onDragStartRow: () => {} }));
    expect(screen.getByRole("button", { name: /file a\.txt/i })).toHaveAttribute(
      "draggable",
      "true"
    );
  });

  it("forwards dragstart and dragend", () => {
    const onDragStartRow = vi.fn();
    const onDragEndRow = vi.fn();
    render(renderItem({ file: FILE, onDragStartRow, onDragEndRow }));
    const el = screen.getByRole("button", { name: /file a\.txt/i });
    fireEvent.dragStart(el, { dataTransfer: dt() });
    fireEvent.dragEnd(el);
    expect(onDragStartRow).toHaveBeenCalled();
    expect(onDragEndRow).toHaveBeenCalled();
  });

  it("a folder highlights on an internal dragenter and reports the dropped paths", () => {
    const onDropItems = vi.fn();
    render(renderItem({ file: FOLDER, onDropItems, canDropOn: () => true }));
    const el = screen.getByRole("button", { name: /folder docs/i });
    const data = dt({ [INTERNAL]: JSON.stringify(["/a.txt", "/b.txt"]) });
    fireEvent.dragEnter(el, { dataTransfer: data });
    expect(el).toHaveAttribute("data-drop-over", "1");
    fireEvent.drop(el, { dataTransfer: data });
    expect(onDropItems).toHaveBeenCalledWith(["/a.txt", "/b.txt"]);
    expect(el).not.toHaveAttribute("data-drop-over");
  });

  it("does not highlight or accept a drop the page vetoes (self / descendant)", () => {
    const onDropItems = vi.fn();
    render(renderItem({ file: FOLDER, onDropItems, canDropOn: () => false }));
    const el = screen.getByRole("button", { name: /folder docs/i });
    const data = dt({ [INTERNAL]: JSON.stringify(["/Docs"]) });
    fireEvent.dragEnter(el, { dataTransfer: data });
    expect(el).not.toHaveAttribute("data-drop-over");
    // dragover is not claimed either, so the browser never fires a drop.
    expect(fireEvent.dragOver(el, { dataTransfer: data })).toBe(true);
  });

  it("ignores an external file drag (left for the upload zone)", () => {
    const onDropItems = vi.fn();
    render(renderItem({ file: FOLDER, onDropItems, canDropOn: () => true }));
    const el = screen.getByRole("button", { name: /folder docs/i });
    const data = dt({ Files: "" });
    fireEvent.dragEnter(el, { dataTransfer: data });
    expect(el).not.toHaveAttribute("data-drop-over");
    fireEvent.drop(el, { dataTransfer: data });
    expect(onDropItems).not.toHaveBeenCalled();
  });

  it("a file is never a drop target", () => {
    const onDropItems = vi.fn();
    render(renderItem({ file: FILE, onDropItems }));
    const el = screen.getByRole("button", { name: /file a\.txt/i });
    fireEvent.drop(el, { dataTransfer: dt({ [INTERNAL]: JSON.stringify(["/x"]) }) });
    expect(onDropItems).not.toHaveBeenCalled();
  });

  it("tints a coloured folder and leaves others on the brand colour", () => {
    const { container, unmount } = render(renderItem({ file: FOLDER, folderColor: "red" }));
    expect(container.querySelector('[data-folder-color="red"]')).not.toBeNull();
    unmount();
    const plain = render(renderItem({ file: FOLDER }));
    expect(plain.container.querySelector("[data-folder-color]")).toBeNull();
  });
});
