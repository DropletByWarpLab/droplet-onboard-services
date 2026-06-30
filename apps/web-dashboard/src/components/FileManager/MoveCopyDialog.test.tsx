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

  // ── Path-traversal guard (security — WARP-938 review finding 1/3) ──

  it.each(["../secret", "..", "foo/bar", "a/../../b", "/etc", "nested/.."])(
    "rejects a traversal/separator name (%s) without calling the API",
    async (name) => {
      renderDialog({ currentDir: "/Documents" });
      fireEvent.click(
        await screen.findByRole("button", { name: /new folder/i }),
      );

      const input = screen.getByPlaceholderText(/folder name/i);
      fireEvent.change(input, { target: { value: name } });
      fireEvent.keyDown(input, { key: "Enter" });

      // No mkdir call escaped the client, and a validation message is shown.
      expect(createDirectoryMock).not.toHaveBeenCalled();
      await screen.findByText(/can't contain|cannot contain|invalid/i);
    },
  );

  it("accepts a plain name with dots that is not a traversal", async () => {
    renderDialog({ currentDir: "/Documents" });
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));

    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "report.v2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(createDirectoryMock).toHaveBeenCalledWith("/Documents/report.v2"),
    );
  });

  // ── Forbidden-parent guard (correctness — WARP-938 review finding 4) ──

  it("does not create a folder inside a forbidden target", async () => {
    renderDialog({
      currentDir: "/Documents",
      forbiddenPrefixes: ["/Documents"],
    });
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));

    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "Invoices" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(createDirectoryMock).not.toHaveBeenCalled();
  });

  // ── Lazy-load preservation (correctness — WARP-938 review finding 2) ──
  //
  // Creating a folder under a parent that was never expanded must NOT mark that
  // parent as "loaded" — otherwise its real server-side siblings stay invisible
  // because toggleNode never fetches them.
  it("still lazy-loads a parent's real children after creating a folder in it", async () => {
    // Root has /Documents; /Documents (never expanded) has a pre-existing
    // sibling /Documents/Existing. After the new folder is created the server
    // listing includes it too — mirror that so the test reflects real backend
    // behaviour rather than a stale snapshot.
    let createdNew = false;
    fetchFilesMock.mockImplementation(async (p: string) => {
      if (p === "/") return [dir("/Documents", "Documents")];
      if (p === "/Documents") {
        const out = [dir("/Documents/Existing", "Existing")];
        if (createdNew) out.push(dir("/Documents/New", "New"));
        return out;
      }
      return [];
    });
    createDirectoryMock.mockImplementation(async () => {
      createdNew = true;
    });

    renderDialog({ currentDir: "/Documents" });
    // Wait for the root listing to surface /Documents.
    await screen.findByText("Documents");

    // Create a folder under /Documents WITHOUT ever expanding it first.
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));
    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // fetchFiles must be called for /Documents so its real children load, and
    // BOTH the pre-existing sibling and the new folder become visible — the
    // regression hid every server-side sibling because the optimistic insert
    // suppressed the lazy fetch.
    await waitFor(() => {
      expect(
        fetchFilesMock.mock.calls.some((c) => c[0] === "/Documents"),
      ).toBe(true);
    });
    await screen.findByText("Existing");
    await screen.findByText("New");
  });

  // ── Confirm button guarded during folder creation (WARP-938 finding 5) ──

  it("disables the confirm CTA while a folder is being created", async () => {
    // Hold createDirectory pending so we can observe the in-flight state.
    let resolveCreate: () => void = () => {};
    createDirectoryMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    renderDialog({ currentDir: "/Documents" });
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));
    const input = screen.getByPlaceholderText(/folder name/i);
    fireEvent.change(input, { target: { value: "Invoices" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Mid-creation: the destination CTA must be disabled so a click can't
    // confirm the wrong (parent) destination or set state after unmount.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /move here/i }),
      ).toBeDisabled(),
    );

    resolveCreate();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /move here/i }),
      ).not.toBeDisabled(),
    );
  });
});
