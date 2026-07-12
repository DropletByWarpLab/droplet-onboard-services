/**
 * WARP-1267 (T15) — reader posture on Upload. `disabled` makes the drop
 * target inert (no overlay, no upload) and the Upload button visibly
 * disabled with a caller-supplied tooltip. Both default to enabled so
 * every existing caller (My Files / Household, always writable) is
 * unaffected.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UploadZone, UploadButton } from "./UploadZone";

function makeFileListEvent(files: File[]) {
  return {
    dataTransfer: { files },
  } as unknown as React.DragEvent;
}

describe("UploadButton — reader posture (WARP-1267)", () => {
  it("is enabled by default", () => {
    const onClick = vi.fn();
    render(<UploadButton onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /upload/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("disables with the supplied tooltip when disabled", () => {
    const onClick = vi.fn();
    render(
      <UploadButton
        onClick={onClick}
        disabled
        title="You can view and download here. Ask a manager for edit access."
      />
    );
    const btn = screen.getByRole("button", { name: /upload/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      "title",
      "You can view and download here. Ask a manager for edit access."
    );
  });
});

describe("UploadZone — reader posture (WARP-1267)", () => {
  it("uploads dropped files by default", () => {
    const onUpload = vi.fn();
    const { container } = render(
      <UploadZone onUpload={onUpload}>
        <div>drop target</div>
      </UploadZone>
    );
    const zone = container.firstChild as HTMLElement;
    const file = new File(["x"], "x.txt");
    fireEvent.drop(zone, makeFileListEvent([file]));
    expect(onUpload).toHaveBeenCalled();
  });

  it("ignores drops entirely when disabled", () => {
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
    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.queryByText("Drop files to upload")).not.toBeInTheDocument();
  });
});
