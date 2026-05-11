/**
 * WARP-301: hit-target audit pass — PreviewPane header actions.
 *
 * The Download + Close icons in the file-preview modal were `p-1.5`
 * (~28 px) and used `title=` for their labels. Two regressions vs.
 * the audit:
 *
 *   1. `title=` is mouse-only — screen readers don't announce it
 *      reliably and touch users never see it. Swap for `aria-label`.
 *   2. 28 px is sub-WCAG. Bumped to `p-2.5` (≈ 32 px) so both clear
 *      the floor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const authFetchMock = vi.fn().mockResolvedValue(new Response(""));
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("@/lib/api", () => ({
  getDownloadUrl: (p: string) => `/api/files/download?path=${p}`,
  getThumbnailUrl: (p: string) =>
    `/api/files/thumbnail?path=${p}`,
}));

import { PreviewPane } from "@/components/FileManager/PreviewPane";
import type { FileEntryInfo } from "@/lib/types";

function file(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "photo.png",
    path: "/photos/photo.png",
    mimeType: "image/png",
    size: 1024,
    modifiedAt: new Date().toISOString(),
    isDirectory: false,
    ...overrides,
  } as FileEntryInfo;
}

describe("PreviewPane header actions (WARP-301)", () => {
  beforeEach(() => {
    cleanup();
    authFetchMock.mockClear();
  });

  it("Close button uses aria-label (not title=) and ≥ 32 px hit-target (p-2.5)", () => {
    render(
      <PreviewPane file={file()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );
    const close = screen.getByLabelText("Close preview");
    expect(close).toBeInTheDocument();
    expect(close.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
    // Regression guard: title="Close (Esc)" was the pre-WARP-301
    // affordance — screen readers don't reliably surface it. We keep
    // no title on the button.
    expect(close.getAttribute("title")).toBeNull();
  });

  it("Download button uses aria-label (not title=) and ≥ 32 px hit-target (p-2.5)", () => {
    render(
      <PreviewPane file={file()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );
    const dl = screen.getByLabelText("Download");
    expect(dl).toBeInTheDocument();
    expect(dl.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
    expect(dl.getAttribute("title")).toBeNull();
  });

  it("clicking Close fires onClose", () => {
    const onClose = vi.fn();
    render(
      <PreviewPane file={file()} onClose={onClose} onDownload={vi.fn()} />,
    );
    screen.getByLabelText("Close preview").click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking Download fires onDownload", () => {
    const onDownload = vi.fn();
    render(
      <PreviewPane file={file()} onClose={vi.fn()} onDownload={onDownload} />,
    );
    screen.getByLabelText("Download").click();
    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});
