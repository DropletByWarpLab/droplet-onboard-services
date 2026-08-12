/**
 * The preview modal must EMBED the file, not download it.
 *
 * Reported from a real session: clicking Preview on a PDF raised the native
 * "Save As" dialog over an empty modal. Cause — every embedded tag loaded
 * `getDownloadUrl`, and that endpoint answers `Content-Disposition: attachment`,
 * which a browser honours inside `<object>` by downloading rather than
 * rendering. The fix points the embedded tags at `getPreviewUrl`
 * (`?disposition=inline`) while the Download BUTTON keeps the attachment URL —
 * the one place the download behaviour is wanted.
 *
 * These assertions are on the URL each tag loads, because that is exactly where
 * the regression lives: the modal rendered fine, it just pointed at a URL that
 * told the browser to save.
 *
 * Mock scaffolding mirrors PreviewPane.type-label.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { FileEntryInfo } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  getDocsStatus: vi.fn().mockResolvedValue({ state: "unavailable", engine: "collabora" }),
  getDownloadUrl: (p: string) => `/api/files/download?path=${encodeURIComponent(p)}`,
  getPreviewUrl: (p: string) =>
    `/api/files/download?path=${encodeURIComponent(p)}&disposition=inline`,
  getThumbnailUrl: (p: string) => `/api/files/thumbnail?path=${encodeURIComponent(p)}`,
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, text: async () => "" }),
}));

vi.mock("./ReindexButton", () => ({ ReindexButton: () => null }));

import { PreviewPane } from "./PreviewPane";

function makeFile(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "mini-rack-ears.pdf",
    path: "/Documents/mini-rack-ears.pdf",
    isDirectory: false,
    size: 120_000,
    mimeType: "application/pdf",
    modifiedAt: new Date("2026-08-12T00:00:00Z").toISOString(),
    ...overrides,
  } as FileEntryInfo;
}

function renderPane(file: FileEntryInfo) {
  return render(
    <PreviewPane file={file} onClose={() => {}} onDownload={() => {}} />,
  ).container;
}

describe("PreviewPane — embeds inline instead of downloading", () => {
  beforeEach(() => {
    cleanup();
  });

  it("loads a PDF through the inline URL, not the attachment URL", () => {
    const container = renderPane(makeFile());
    const data = container.querySelector("object")!.getAttribute("data")!;

    // The regression: this attribute used to be the bare download URL.
    expect(data).toContain("disposition=inline");
    expect(data).toContain("path=%2FDocuments%2Fmini-rack-ears.pdf");
    // `#toolbar=0` is the PDF viewer hint and must survive the URL swap.
    expect(data).toContain("#toolbar=0");
  });

  it("streams video through the inline URL", () => {
    const container = renderPane(
      makeFile({ name: "clip.mp4", path: "/Videos/clip.mp4", mimeType: "video/mp4" }),
    );
    expect(container.querySelector("video")!.getAttribute("src")).toContain(
      "disposition=inline",
    );
  });

  it("streams audio through the inline URL", () => {
    const container = renderPane(
      makeFile({ name: "voice.mp3", path: "/Music/voice.mp3", mimeType: "audio/mpeg" }),
    );
    expect(container.querySelector("audio")!.getAttribute("src")).toContain(
      "disposition=inline",
    );
  });

  it("falls back to the inline URL — never the attachment URL — when a thumbnail 404s", () => {
    const container = renderPane(
      makeFile({ name: "photo.jpg", path: "/Photos/photo.jpg", mimeType: "image/jpeg" }),
    );
    const img = container.querySelector("img")!;
    // Starts on the thumbnail API…
    expect(img.getAttribute("src")).toContain("/api/files/thumbnail");
    // …and its error fallback must not reintroduce the download URL.
    img.dispatchEvent(new Event("error"));
    expect(img.getAttribute("src")).toContain("disposition=inline");
  });

  it("keeps the Download button on the attachment URL — inline is for embedding only", () => {
    const onDownload = vi.fn();
    render(
      <PreviewPane file={makeFile()} onClose={() => {}} onDownload={onDownload} />,
    );
    // The button is a handler, not a link: it must still route through the
    // caller's download path so the file saves and the activity trail records it.
    screen.getByLabelText("Download").click();
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});
