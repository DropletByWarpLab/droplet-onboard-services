/**
 * MoveCopyDialog tests — WARP-938.
 *
 * The "Move to…" / "Copy to…" dialog gains a "New folder" affordance so a user
 * can create a destination folder at the currently-selected target and move/copy
 * into it without leaving the dialog. It reuses the existing folder-creation API
 * (`createDirectory` → POST /api/files/mkdir) — the same path the Files page uses.
 *
 * Covered:
 *   - a "New folder" affordance is present
 *   - activating it reveals a name input
 *   - submitting calls createDirectory() with the name joined under the selected target
 *   - on success the new folder is selected (Target updates) without leaving the dialog
 *   - the root ("/") is joined correctly (no leading double-slash)
 *   - an empty/whitespace name does not call the API
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  fetchFiles: vi.fn(),
  createDirectory: vi.fn(),
}));

vi.mock("@/lib/friendly-errors", () => ({
  translateError: (err: unknown) =>
    err instanceof Error ? err.message : "Something went wrong",
}));

import { fetchFiles, createDirectory } from "@/lib/api";
import { MoveCopyDialog } from "./MoveCopyDialog";

const fetchFilesMock = fetchFiles as unknown as ReturnType<typeof vi.fn>;
const createDirectoryMock = createDirectory as unknown as ReturnType<typeof vi.fn>;

function dir(path: string, name: string): FileEntryInfo {
  return {
    name,
    path,
    isDirectory: true,
    size: 0,
    mimeType: null,
    modifiedAt: "2026-04-16T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Root listing returns one folder by default.
  fetchFilesMock.mockResolvedValue([dir("/Documents", "Documents")]);
  createDirectoryMock.mockResolvedValue(undefined);
});

function renderDialog(
  props: Partial<React.ComponentProps<typeof MoveCopyDialog>> = {},
) {
  return render(
    <MoveCopyDialog
      mode="move"
      selectionLabels={["report.pdf"]}
      currentDir="/"
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      {...props}
    />,
  );
}

describe("WARP-938 — MoveCopyDialog new-folder affordance", () => {
  it("renders a New folder affordance", async () => {
    renderDialog();
    await screen.findByRole("button", { name: /new folder/i });
  });

  it("activating New folder reveals a name input", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));
    expect(
      screen.getByPlaceholderText(/folder name/i),
    ).toBeInTheDocument();
  });

  it("creates a folder under the selected target via createDirectory", async () => {
    // currentDir = /Documents so the dialog opens with that target selected.
    renderDialog({ currentDir: "/Documents" });
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));

    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "Invoices" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(createDirectoryMock).toHaveBeenCalledWith("/Documents/Invoices"),
    );
  });

  it("joins names at the root without a double slash", async () => {
    renderDialog({ currentDir: "/" });
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));

    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "Archive" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(createDirectoryMock).toHaveBeenCalledWith("/Archive"),
    );
  });

  it("selects the newly-created folder as the target (stays in the dialog)", async () => {
    renderDialog({ currentDir: "/" });
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));

    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "Archive" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Dialog stays open and the Target line now points at the new folder.
    await waitFor(() =>
      expect(screen.getByText("/Archive")).toBeInTheDocument(),
    );
    // The Move CTA is still present — we never left the dialog.
    expect(
      screen.getByRole("button", { name: /move here/i }),
    ).toBeInTheDocument();
  });

  it("does not call the API for an empty name", async () => {
    renderDialog({ currentDir: "/" });
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));

    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(createDirectoryMock).not.toHaveBeenCalled();
  });
});
