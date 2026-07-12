import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

const getBrainMemoryItemsMock = vi.fn();
const approveBrainItemMock = vi.fn();
vi.mock("@/lib/api", () => ({
  getBrainMemoryItems: () => getBrainMemoryItemsMock(),
  approveBrainItem: (...args: any[]) => approveBrainItemMock(...args),
}));

const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: any[]) => authFetchMock(...args),
}));

import { BrainMemoryTab } from "@/app/knowledge/BrainMemoryTab";

describe("BrainMemoryTab", () => {
  beforeEach(() => {
    cleanup();
    getBrainMemoryItemsMock.mockReset();
    authFetchMock.mockReset();
    approveBrainItemMock.mockReset();
  });

  it("shows the persona-on-tone empty state when the brain route is unavailable", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({ items: [], unavailable: true });
    render(<BrainMemoryTab />);
    const empty = await screen.findByTestId("brain-memory-empty");
    expect(empty.textContent).toMatch(/No files indexed yet/);
  });

  it("shows the same empty state when the route is available but list is empty", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({ items: [] });
    render(<BrainMemoryTab />);
    const empty = await screen.findByTestId("brain-memory-empty");
    expect(empty).toBeInTheDocument();
  });

  it("renders items with delete + download affordances", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "abc-123",
          filename: "scratchpad.md",
          mimeType: "text/markdown",
          sizeBytes: 4096,
          uploadedAt: "2026-04-30T10:00:00Z",
          originatingChatId: "chat-1",
        },
      ],
    });
    render(<BrainMemoryTab />);
    const list = await screen.findByTestId("brain-memory-list");
    expect(list).toBeInTheDocument();
    expect(list.textContent).toContain("scratchpad.md");
    // Delete + download present
    expect(screen.getByTestId("brain-delete")).toBeInTheDocument();
    expect(screen.getByTestId("brain-download")).toBeInTheDocument();
    expect(screen.getByTestId("brain-export-all")).toBeInTheDocument();
  });

  it("surfaces a friendly 'coming soon' message when delete returns 404", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "x",
          filename: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          uploadedAt: "2026-04-30T10:00:00Z",
        },
      ],
    });
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
      blob: async () => new Blob(),
    });
    render(<BrainMemoryTab />);
    const deleteBtn = await screen.findByTestId("brain-delete");
    // WARP-291: clicking opens a ConfirmDialog; confirm to fire the DELETE.
    fireEvent.click(deleteBtn);
    const dialog = await screen.findByRole("dialog", { name: /Delete .*?brain memory/i });
    const confirmBtn = dialog.querySelector('button.danger') as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalled();
    });
    expect(
      await screen.findByRole("status")
    ).toHaveTextContent(/Delete will be online once/);
  });

  it("surfaces an 'Awaiting approval' affordance for a held item (WARP-905)", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "held-1",
          filename: "contract.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          uploadedAt: "2026-04-30T10:00:00Z",
          status: "indexing",
          ingestPolicy: "await_approval",
        },
      ],
    });
    render(<BrainMemoryTab />);
    expect(await screen.findByTestId("brain-awaiting-approval")).toHaveTextContent(
      /Awaiting approval/,
    );
    expect(screen.getByTestId("brain-approve")).toBeInTheDocument();
    // The "Indexing" status pill is suppressed while the item is held.
    expect(screen.queryByText("Indexing")).not.toBeInTheDocument();
  });

  it("approves a held item and swaps to the status pill (WARP-905)", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "held-1",
          filename: "contract.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          uploadedAt: "2026-04-30T10:00:00Z",
          status: "indexing",
          ingestPolicy: "await_approval",
        },
      ],
    });
    approveBrainItemMock.mockResolvedValue({
      itemId: "held-1",
      status: "indexing",
      ingestPolicy: "auto_embed",
    });
    render(<BrainMemoryTab />);
    const approveBtn = await screen.findByTestId("brain-approve");
    fireEvent.click(approveBtn);
    await waitFor(() => {
      expect(approveBrainItemMock).toHaveBeenCalledWith("held-1");
    });
    // Optimistically released: the awaiting-approval affordance is gone and the
    // status pill ("Indexing") takes over.
    await waitFor(() => {
      expect(
        screen.queryByTestId("brain-awaiting-approval"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Indexing")).toBeInTheDocument();
  });

  it("surfaces a friendly 'coming soon' message when export returns 404", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "x",
          filename: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          uploadedAt: "2026-04-30T10:00:00Z",
        },
      ],
    });
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
      blob: async () => new Blob(),
    });
    render(<BrainMemoryTab />);
    const exportBtn = await screen.findByTestId("brain-export-all");
    fireEvent.click(exportBtn);
    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalled();
    });
    expect(
      await screen.findByRole("status")
    ).toHaveTextContent(/Export will be online once/);
  });
});
