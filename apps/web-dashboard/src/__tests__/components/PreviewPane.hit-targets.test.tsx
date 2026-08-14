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
 *
 * WARP-1066: the indigo conversion replaced the ad-hoc `p-2.5` Tailwind
 * utility with the shell's `.icon-btn` component class (36×36px, see
 * `droplet-shell.css`) — strictly larger than the ≥32px floor this test
 * guards. Assertions below check for `.icon-btn` instead of `p-2.5`; the
 * hit-target/aria-label intent is unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const authFetchMock = vi.fn().mockResolvedValue(new Response(""));
vi.mock("@/lib/auth", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock("@/lib/api", () => ({
  getDownloadUrl: (p: string) => `/api/files/download?path=${p}`,
  // The embedded tags load this one (WARP-1919) — the download URL sends
  // `Content-Disposition: attachment`, which <object> honours by downloading.
  getPreviewUrl: (p: string) => `/api/files/download?path=${p}&disposition=inline`,
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

  it("Close button uses aria-label (not title=) and ≥ 32 px hit-target (.icon-btn)", () => {
    render(
      <PreviewPane file={file()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );
    const close = screen.getByLabelText("Close preview");
    expect(close).toBeInTheDocument();
    expect(close.className).toMatch(/(^|\s)icon-btn(\s|$)/);
    // Regression guard: title="Close (Esc)" was the pre-WARP-301
    // affordance — screen readers don't reliably surface it. We keep
    // no title on the button.
    expect(close.getAttribute("title")).toBeNull();
  });

  it("Download button uses aria-label (not title=) and ≥ 32 px hit-target (.icon-btn)", () => {
    render(
      <PreviewPane file={file()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );
    const dl = screen.getByLabelText("Download");
    expect(dl).toBeInTheDocument();
    expect(dl.className).toMatch(/(^|\s)icon-btn(\s|$)/);
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

  // WARP-301 fold-in: the action row wrapping Close + Download used
  // `gap-1` (4 px). UX flagged this as too tight — bumped to `gap-1.5`
  // (6 px) for slightly more breathing room between the two icon
  // buttons.
  it("action row uses gap-1.5 between Close + Download (WARP-301)", () => {
    render(
      <PreviewPane file={file()} onClose={vi.fn()} onDownload={vi.fn()} />,
    );
    const close = screen.getByLabelText("Close preview");
    const row = close.parentElement;
    expect(row).not.toBeNull();
    expect(row!.className).toMatch(/(^|\s)gap-1\.5(\s|$)/);
    // Regression guard against the old tight spacing.
    expect(row!.className).not.toMatch(/(^|\s)gap-1(\s|$)/);
  });
});
