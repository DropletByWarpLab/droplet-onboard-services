/**
 * WARP-1267 (T15) — reader posture on Upload. `disabled` makes the drop
 * target inert (no overlay, no upload) and the Upload button visibly
 * disabled with a caller-supplied tooltip. Both default to enabled so
 * every existing caller (My Files / Household, always writable) is
 * unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UploadZone, UploadButton } from "./UploadZone";

function makeFileListEvent(files: File[]) {
  return {
    dataTransfer: { files },
  } as unknown as React.DragEvent;
}

/**
 * WARP-1876 — a folder drop. A directory is only visible AS a directory
 * through `webkitGetAsEntry()`; in `dataTransfer.files` it is a zero-byte
 * File named after the folder.
 */
function makeFolderDropEvent(folder: string, fileNames: string[]) {
  const children = fileNames.map((name) => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (cb: (f: File) => void) => cb(new File(["x"], name)),
  }));
  let cursor = 0;
  const dirEntry = {
    isFile: false,
    isDirectory: true,
    name: folder,
    createReader: () => ({
      readEntries: (cb: (e: unknown[]) => void) => {
        const page = children.slice(cursor, cursor + 100);
        cursor += page.length;
        cb(page);
      },
    }),
  };
  return {
    dataTransfer: {
      items: [{ kind: "file", webkitGetAsEntry: () => dirEntry }],
      files: [],
    },
  } as unknown as React.DragEvent;
}

describe("UploadButton — reader posture (WARP-1267)", () => {
  it("is enabled by default", () => {
    render(<UploadButton onUpload={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Upload" });
    expect(btn).not.toBeDisabled();
  });

  it("disables with the supplied tooltip when disabled", () => {
    render(
      <UploadButton
        onUpload={vi.fn()}
        disabled
        title="You can view and download here. Ask a manager for edit access."
      />
    );
    // WARP-1876 — BOTH pickers take the reader posture, not just the
    // primary one; a disabled Upload beside a live Upload folder would be
    // a hole in the same gate.
    for (const name of ["Upload", "Upload folder"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute(
        "title",
        "You can view and download here. Ask a manager for edit access."
      );
    }
  });
});

describe("UploadButton — folder picker (WARP-1876)", () => {
  it("offers a keyboard-reachable folder picker beside the file picker", () => {
    render(<UploadButton onUpload={vi.fn()} />);
    // Drag-and-drop is mouse-only; the bulk path has to exist for a
    // keyboard user too.
    expect(screen.getByRole("button", { name: "Upload folder" })).toBeInTheDocument();
    const inputs = document.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].hasAttribute("webkitdirectory")).toBe(false);
    expect(inputs[1].hasAttribute("webkitdirectory")).toBe(true);
  });

  it("reports a multi-select as relative paths", () => {
    const onUpload = vi.fn();
    render(<UploadButton onUpload={onUpload} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.txt"), new File(["x"], "b.txt")] },
    });
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload.mock.calls[0][0].map((u: { relativePath: string }) => u.relativePath)).toEqual(
      ["a.txt", "b.txt"]
    );
  });

  it("preserves the folder tree from the directory picker", () => {
    const onUpload = vi.fn();
    render(<UploadButton onUpload={onUpload} />);
    const folderInput = document.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
    const f = new File(["x"], "jan.pdf");
    Object.defineProperty(f, "webkitRelativePath", { value: "Invoices/jan.pdf" });
    fireEvent.change(folderInput, { target: { files: [f] } });
    expect(onUpload.mock.calls[0][0][0].relativePath).toBe("Invoices/jan.pdf");
  });
});

describe("UploadZone — reader posture (WARP-1267)", () => {
  // WARP-1876: the drop handler expands folders before it reports, so it is
  // now async — these two assert after the walk settles.
  it("uploads dropped files by default", async () => {
    const onUpload = vi.fn();
    const { container } = render(
      <UploadZone onUpload={onUpload}>
        <div>drop target</div>
      </UploadZone>
    );
    const zone = container.firstChild as HTMLElement;
    const file = new File(["x"], "x.txt");
    fireEvent.drop(zone, makeFileListEvent([file]));
    await waitFor(() => expect(onUpload).toHaveBeenCalled());
  });

  it("ignores drops entirely when disabled", async () => {
    const onUpload = vi.fn();
    const { container } = render(
      <UploadZone onUpload={onUpload} disabled>
        <div>drop target</div>
      </UploadZone>
    );
    const zone = container.firstChild as HTMLElement;
    const file = new File(["x"], "x.txt");
    fireEvent.dragEnter(zone);
    fireEvent.drop(zone, makeFileListEvent([file]));
    await waitFor(() => expect(onUpload).not.toHaveBeenCalled());
    expect(screen.queryByText(/Drop files/i)).not.toBeInTheDocument();
  });
});

describe("UploadZone — bulk drop (WARP-1876)", () => {
  it("reports a flat drop as relative paths, not a raw FileList", async () => {
    const onUpload = vi.fn();
    const { container } = render(
      <UploadZone onUpload={onUpload}>
        <div>drop target</div>
      </UploadZone>
    );
    fireEvent.drop(
      container.firstChild as HTMLElement,
      makeFileListEvent([new File(["x"], "a.txt"), new File(["x"], "b.txt")])
    );

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0][0].map((u: { relativePath: string }) => u.relativePath)).toEqual(
      ["a.txt", "b.txt"]
    );
  });

  it("expands a dropped FOLDER into its files, keeping the tree", async () => {
    const onUpload = vi.fn();
    const { container } = render(
      <UploadZone onUpload={onUpload}>
        <div>drop target</div>
      </UploadZone>
    );
    fireEvent.drop(
      container.firstChild as HTMLElement,
      makeFolderDropEvent("Invoices", ["jan.pdf", "feb.pdf"])
    );

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0][0].map((u: { relativePath: string }) => u.relativePath)).toEqual(
      ["Invoices/jan.pdf", "Invoices/feb.pdf"]
    );
  });

  it("says folders are welcome on the drag-over affordance", () => {
    const { container } = render(
      <UploadZone onUpload={vi.fn()}>
        <div>drop target</div>
      </UploadZone>
    );
    fireEvent.dragEnter(container.firstChild as HTMLElement);
    expect(screen.getByText("Drop files or folders to upload")).toBeInTheDocument();
  });

  it("does not fire onUpload for an empty drop", async () => {
    const onUpload = vi.fn();
    const { container } = render(
      <UploadZone onUpload={onUpload}>
        <div>drop target</div>
      </UploadZone>
    );
    fireEvent.drop(container.firstChild as HTMLElement, makeFileListEvent([]));
    await waitFor(() => expect(onUpload).not.toHaveBeenCalled());
  });
});
