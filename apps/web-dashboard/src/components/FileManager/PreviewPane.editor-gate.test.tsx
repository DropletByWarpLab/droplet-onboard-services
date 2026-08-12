/**
 * WARP-882 / WS-4 — the gated "Edit" entry in PreviewPane.
 *
 * The Edit affordance must appear ONLY when (a) the document server reports
 * `ready` AND (b) the file is an editable Office MIME — never a dead button.
 * The status fetch is mocked so we drive both gates directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { FileEntryInfo, DocsStatus } from "@/lib/types";

const getDocsStatusMock = vi.fn();
vi.mock("@/lib/api", () => ({
  getDocsStatus: () => getDocsStatusMock(),
  getDownloadUrl: (p: string) => `/api/files/download?path=${encodeURIComponent(p)}`,
  getPreviewUrl: (p: string) =>
    `/api/files/download?path=${encodeURIComponent(p)}&disposition=inline`,
  getThumbnailUrl: (p: string) => `/api/files/thumbnail?path=${encodeURIComponent(p)}`,
}));

// authFetch is used by the text-preview path; stub it so it never dials.
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, text: async () => "" }),
}));

// ReindexButton makes its own calls; stub to a no-op so the suite stays focused.
vi.mock("./ReindexButton", () => ({ ReindexButton: () => null }));

import { PreviewPane } from "./PreviewPane";

function makeFile(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "report.docx",
    path: "/Documents/report.docx",
    isDirectory: false,
    size: 12345,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    modifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

const ready: DocsStatus = { state: "ready", engine: "onlyoffice" };
const unavailable: DocsStatus = { state: "unavailable", engine: "onlyoffice" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PreviewPane — gated Edit entry (WARP-882)", () => {
  it("shows Edit for an editable Office file when the engine is ready", async () => {
    getDocsStatusMock.mockResolvedValue(ready);
    render(<PreviewPane file={makeFile()} onClose={vi.fn()} onDownload={vi.fn()} onEdit={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /edit/i })).toBeInTheDocument();
  });

  it("does NOT show Edit when the engine is unavailable (no dead button)", async () => {
    getDocsStatusMock.mockResolvedValue(unavailable);
    render(<PreviewPane file={makeFile()} onClose={vi.fn()} onDownload={vi.fn()} onEdit={vi.fn()} />);
    // Give the status fetch a tick to resolve, then assert absence.
    await waitFor(() => expect(getDocsStatusMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("does NOT show Edit for a non-Office file even when the engine is ready", async () => {
    getDocsStatusMock.mockResolvedValue(ready);
    render(
      <PreviewPane
        file={makeFile({ name: "photo.png", path: "/photo.png", mimeType: "image/png" })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("does not even probe status for a non-Office file (no needless call)", async () => {
    getDocsStatusMock.mockResolvedValue(ready);
    render(
      <PreviewPane
        file={makeFile({ name: "clip.mp4", path: "/clip.mp4", mimeType: "video/mp4" })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(getDocsStatusMock).not.toHaveBeenCalled();
  });

  it("does not show Edit (and never probes) when no onEdit handler is wired", async () => {
    getDocsStatusMock.mockResolvedValue(ready);
    render(<PreviewPane file={makeFile()} onClose={vi.fn()} onDownload={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(getDocsStatusMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("fires onEdit when the Edit button is clicked", async () => {
    getDocsStatusMock.mockResolvedValue(ready);
    const onEdit = vi.fn();
    render(
      <PreviewPane file={makeFile()} onClose={vi.fn()} onDownload={vi.fn()} onEdit={onEdit} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalled();
  });
});
