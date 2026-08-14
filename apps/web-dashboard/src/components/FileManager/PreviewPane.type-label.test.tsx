/**
 * WARP-1877 — the preview modal's type line.
 *
 * The Files detail panel names the type in words, but its own Preview button
 * opens this modal, whose header printed `file.mimeType` raw — so the 71-char
 * .docx MIME was still one click away from the panel that had just been fixed.
 * `labelForMime()` is the single source of truth for MIME → words; this suite
 * pins that the modal uses it, and that the fallback chain is reached through
 * the component and not only through the helper's own unit test.
 *
 * Mock scaffolding mirrors PreviewPane.editor-gate.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

vi.mock("@/lib/api", () => ({
  getDocsStatus: vi.fn().mockResolvedValue({ state: "unavailable", engine: "onlyoffice" }),
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
    name: "Freud Biography SR 1.28.docx",
    path: "/Freud Biography SR 1.28.docx",
    isDirectory: false,
    size: 45678,
    mimeType: DOCX_MIME,
    modifiedAt: new Date("2026-01-28T00:00:00Z").toISOString(),
    ...overrides,
  } as FileEntryInfo;
}

/** The type line sits directly under the filename in the modal header. */
function typeLine(): HTMLElement {
  const heading = screen.getByRole("heading", { level: 3 });
  return heading.parentElement!.querySelector<HTMLElement>("p")!;
}

describe("PreviewPane — type line (WARP-1877)", () => {
  beforeEach(() => {
    cleanup();
  });

  it("names the type in words instead of printing the raw MIME", () => {
    const { container } = render(
      <PreviewPane file={makeFile()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );

    expect(typeLine().textContent).toBe("Word document");
    expect(container.textContent).not.toContain("openxmlformats");
  });

  it("keeps the raw MIME reachable as the line's tooltip", () => {
    render(
      <PreviewPane file={makeFile()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );

    expect(typeLine().getAttribute("title")).toBe(DOCX_MIME);
  });

  it("names the type from the file name when the listing sent no MIME", () => {
    // The file-indexer skips Office docs as unknown_type when its MIME tables
    // are missing, so a null mimeType is a shape this modal actually sees.
    render(
      <PreviewPane
        file={makeFile({ name: "scan.pdf", path: "/scan.pdf", mimeType: null })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(typeLine().textContent).toBe("PDF document");
    // Nothing to add over the visible words, so no tooltip repeating them.
    expect(typeLine().getAttribute("title")).toBeNull();
  });

  it("says Unknown — never an empty line — when neither MIME nor name names it", () => {
    render(
      <PreviewPane
        file={makeFile({
          name: "Backup 2026.01",
          path: "/Backup 2026.01",
          mimeType: "application/octet-stream",
        })}
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(typeLine().textContent).toBe("Unknown");
  });
});
