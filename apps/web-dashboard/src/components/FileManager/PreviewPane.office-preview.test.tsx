/**
 * WARP-1967 — Office documents must PREVIEW, not dead-end.
 *
 * Reported from a real session: Preview on a .docx showed the "No preview
 * available" empty state. The box was never the problem — richdocuments renders
 * a docx page image through Collabora in ~0.3s and the orchestrator already
 * proxies it at /api/files/thumbnail. `getKind()` simply had no Office branch,
 * so every Office file fell into "other" and nothing was ever requested.
 *
 * The assertions are on WHICH tag renders and WHICH url it loads, because that
 * is where the gap was: the modal itself always worked.
 *
 * Mock scaffolding mirrors PreviewPane.inline-preview.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  getDocsStatus: vi.fn().mockResolvedValue({ state: "unavailable", engine: "collabora" }),
  getDownloadUrl: (p: string) => `/api/files/download?path=${encodeURIComponent(p)}`,
  getPreviewUrl: (p: string) =>
    `/api/files/download?path=${encodeURIComponent(p)}&disposition=inline`,
  getThumbnailUrl: (p: string, x = 256, y = 256) =>
    `/api/files/thumbnail?path=${encodeURIComponent(p)}&x=${x}&y=${y}`,
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, text: async () => "" }),
}));

vi.mock("./ReindexButton", () => ({ ReindexButton: () => null }));

import { PreviewPane } from "./PreviewPane";

function makeFile(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "Framework agreement.docx",
    path: "/Documents/Framework agreement.docx",
    isDirectory: false,
    size: 42_000,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    modifiedAt: new Date("2026-08-13T00:00:00Z").toISOString(),
    ...overrides,
  } as FileEntryInfo;
}

function renderPane(file: FileEntryInfo) {
  return render(
    <PreviewPane file={file} onClose={() => {}} onDownload={() => {}} />,
  ).container;
}

describe("PreviewPane — Office documents render a page image", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders a .docx as an <img> from the thumbnail proxy", () => {
    const container = renderPane(makeFile());

    const img = container.querySelector("img");
    expect(img).not.toBeNull();

    const src = img!.getAttribute("src")!;
    expect(src).toContain("/api/files/thumbnail");
    expect(src).toContain("path=%2FDocuments%2FFramework%20agreement.docx");

    // THE REGRESSION, pinned: this is the state a .docx used to land in.
    expect(screen.queryByText("No preview available")).toBeNull();
  });

  // An <img> is deliberate, not incidental. <object>/<iframe> honour
  // Content-Disposition (the trap that broke the PDF branch) and an iframe
  // would additionally need an editing session.
  it("uses an <img>, never an <object> or <iframe>", () => {
    const container = renderPane(makeFile());
    expect(container.querySelector("object")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("asks for a large enough image to read (not the 256px row thumbnail)", () => {
    const container = renderPane(makeFile());
    const src = container.querySelector("img")!.getAttribute("src")!;
    expect(src).toContain("x=1024");
    expect(src).toContain("y=1024");
  });

  // Every Office type the Edit affordance admits — the two must not disagree
  // about what "an Office file" is.
  it.each([
    ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["notes.odt", "application/vnd.oasis.opendocument.text"],
    ["legacy.doc", "application/msword"],
  ])("previews %s", (name, mimeType) => {
    const container = renderPane(makeFile({ name, path: `/Documents/${name}`, mimeType }));
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.queryByText("No preview available")).toBeNull();
  });

  // The server-side render can legitimately be unavailable: the docs profile is
  // RAM-gated off on a small box, and the engine can be mid-restart. A broken
  // image icon would be a worse answer than the honest empty state.
  it("falls back to the empty state + Download when the image fails to load", () => {
    const container = renderPane(makeFile());
    const img = container.querySelector("img")!;

    fireEvent.error(img);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("No preview available")).toBeTruthy();
    // Scoped to the empty state on purpose: the modal header carries its own
    // Download control, so an unscoped role query matches two buttons.
    const emptyStateDownload = container.querySelector(".empty button");
    expect(emptyStateDownload).not.toBeNull();
    expect(emptyStateDownload!.textContent).toMatch(/download/i);
  });

  // The modal is reused across files, so a failure on one file must not
  // suppress the next one's preview.
  it("clears a previous failure when a different file is shown", () => {
    const { container, rerender } = render(
      <PreviewPane file={makeFile()} onClose={() => {}} onDownload={() => {}} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("No preview available")).toBeTruthy();

    rerender(
      <PreviewPane
        file={makeFile({ name: "other.docx", path: "/Documents/other.docx" })}
        onClose={() => {}}
        onDownload={() => {}}
      />,
    );

    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.queryByText("No preview available")).toBeNull();
  });

  // WARP-1990 — the failure must be keyed to the PATH that failed, not a bare
  // boolean reset in an effect. useEffect runs AFTER paint, so a boolean reset
  // painted one frame of the previous file's failure state under the NEW
  // file's name. Deriving it during render makes that unrepresentable.
  //
  // Asserted by going BACK to the failed file: with derived state its failure
  // is still correctly remembered, and the intervening file was never
  // contaminated. A boolean reset cannot express both.
  it("keys the failure to the file, so paging away and back stays correct", () => {
    const a = makeFile({ name: "a.docx", path: "/Documents/a.docx" });
    const b = makeFile({ name: "b.docx", path: "/Documents/b.docx" });
    const { container, rerender } = render(
      <PreviewPane file={a} onClose={() => {}} onDownload={() => {}} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("No preview available")).toBeTruthy();

    // B must render its image — never A's failure under B's name.
    rerender(<PreviewPane file={b} onClose={() => {}} onDownload={() => {}} />);
    expect(container.querySelector("img")).not.toBeNull();
    expect(screen.queryByText("No preview available")).toBeNull();

    // Back to A: its failure is still known, so we do not re-request a
    // thumbnail the server already refused.
    rerender(<PreviewPane file={a} onClose={() => {}} onDownload={() => {}} />);
    expect(screen.getByText("No preview available")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  // Guard the branch ORDER. A .csv is in the editable-Office set (so Edit can
  // open it in the spreadsheet editor) but the text branch must win: rendering
  // it as text is faithful and needs no round-trip to the engine.
  it("still renders a .csv as text, not as an Office page image", async () => {
    const container = renderPane(
      makeFile({ name: "readings.csv", path: "/Documents/readings.csv", mimeType: "text/csv" }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText("No preview available")).toBeNull();
    // The text branch fetches its content, so the <pre> lands on a later tick.
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
  });

  // Non-Office binaries are untouched by this change.
  it("leaves a non-Office binary in the empty state", () => {
    renderPane(
      makeFile({ name: "firmware.bin", path: "/Documents/firmware.bin", mimeType: "application/octet-stream" }),
    );
    expect(screen.getByText("No preview available")).toBeTruthy();
  });
});
