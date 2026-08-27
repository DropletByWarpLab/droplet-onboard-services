/**
 * WARP-2204 — PreviewPane can be DOCKED, not only shown as a full-bleed modal.
 *
 * PreviewPane already renders every format the dashboard needs (image, pdf,
 * video, audio, text, Office page-image). The only thing stopping any surface
 * from hosting that previewer beside its own content was the hard-coded modal
 * chrome on the outermost element — `fixed inset-0 z-50 … bg-black/60`.
 *
 * `mode` splits that chrome off. The contract these tests pin:
 *
 *   - `mode` DEFAULTS to "modal", so every existing call site is untouched.
 *     The four sibling suites (editor-gate, inline-preview, office-preview,
 *     type-label) all render without a `mode` prop and must stay green — that
 *     is the real regression guard, and it is why the default matters more
 *     than the new branch.
 *   - "docked" drops the backdrop, the fixed positioning and the z-index, and
 *     hands dismissal to the HOST. So Escape must NOT close a docked pane:
 *     in a rail, Escape belongs to the rail's drawer, and a previewer that
 *     stole it would close the wrong thing.
 *   - The BODY is identical in both modes. Docking is a chrome decision, not
 *     a content one, so every getKind() branch keeps rendering the same tag
 *     against the same URL.
 *
 * Mock scaffolding mirrors PreviewPane.inline-preview.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

/** The modal backdrop is the element that owns the fixed full-viewport layer. */
function backdropOf(container: HTMLElement): Element | null {
  return container.querySelector(".fixed.inset-0");
}

describe("PreviewPane — docked mode (WARP-2204)", () => {
  beforeEach(() => {
    cleanup();
  });

  describe("mode defaults to modal — the existing call sites must not move", () => {
    it("renders the fixed full-viewport backdrop when no mode is given", () => {
      const { container } = render(
        <PreviewPane file={makeFile()} onClose={() => {}} onDownload={() => {}} />,
      );
      expect(backdropOf(container)).not.toBeNull();
    });

    it("closes on Escape when no mode is given", () => {
      const onClose = vi.fn();
      render(<PreviewPane file={makeFile()} onClose={onClose} onDownload={() => {}} />);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes when the backdrop itself is clicked", () => {
      const onClose = vi.fn();
      const { container } = render(
        <PreviewPane file={makeFile()} onClose={onClose} onDownload={() => {}} />,
      );
      fireEvent.click(backdropOf(container)!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does NOT close when the card inside the backdrop is clicked", () => {
      const onClose = vi.fn();
      render(<PreviewPane file={makeFile()} onClose={onClose} onDownload={() => {}} />);
      fireEvent.click(screen.getByText("mini-rack-ears.pdf"));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("mode=docked drops the modal chrome", () => {
    it("renders no backdrop", () => {
      const { container } = render(
        <PreviewPane
          file={makeFile()}
          onClose={() => {}}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      expect(backdropOf(container)).toBeNull();
    });

    it("does not position anything fixed to the viewport", () => {
      const { container } = render(
        <PreviewPane
          file={makeFile()}
          onClose={() => {}}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      expect(container.querySelector(".fixed")).toBeNull();
    });

    it("does not claim dialog semantics — a docked pane is not modal", () => {
      const { container } = render(
        <PreviewPane
          file={makeFile()}
          onClose={() => {}}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(container.querySelector("[aria-modal]")).toBeNull();
    });

    it("leaves Escape to the host — a docked pane must not steal it", () => {
      const onClose = vi.fn();
      render(
        <PreviewPane
          file={makeFile()}
          onClose={onClose}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("still offers an explicit Close control, since Escape no longer closes", () => {
      const onClose = vi.fn();
      render(
        <PreviewPane
          file={makeFile()}
          onClose={onClose}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      fireEvent.click(screen.getByLabelText("Close preview"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("the body is identical in both modes — docking is a chrome decision", () => {
    it("embeds a PDF through the inline URL when docked", () => {
      const { container } = render(
        <PreviewPane
          file={makeFile()}
          onClose={() => {}}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      const object = container.querySelector("object");
      expect(object?.getAttribute("data")).toContain("disposition=inline");
      expect(object?.getAttribute("data")).not.toMatch(/disposition=attachment/);
    });

    it("renders an Office document as a page image when docked", () => {
      const { container } = render(
        <PreviewPane
          file={makeFile({
            name: "quote.docx",
            path: "/Documents/quote.docx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          })}
          onClose={() => {}}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      const img = container.querySelector("img");
      expect(img?.getAttribute("src")).toContain("/api/files/thumbnail");
      expect(container.querySelector("iframe")).toBeNull();
    });

    it("keeps the header — name, type line and Download — when docked", () => {
      render(
        <PreviewPane
          file={makeFile()}
          onClose={() => {}}
          onDownload={() => {}}
          mode="docked"
        />,
      );
      expect(screen.getByText("mini-rack-ears.pdf")).toBeTruthy();
      expect(screen.getByText("PDF document")).toBeTruthy();
      expect(screen.getByLabelText("Download")).toBeTruthy();
    });

    it("fires onDownload from the docked header", () => {
      const onDownload = vi.fn();
      render(
        <PreviewPane
          file={makeFile()}
          onClose={() => {}}
          onDownload={onDownload}
          mode="docked"
        />,
      );
      fireEvent.click(screen.getByLabelText("Download"));
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
  });
});
