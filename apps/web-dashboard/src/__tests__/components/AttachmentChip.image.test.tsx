/**
 * Image-vision composer affordance: image attachments render a local
 * thumbnail (object URL owned by the chip), falling back to the image icon
 * when no File is present (rehydrated chips).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AttachmentChip } from "@/components/AttachmentChip";
import type { ChatAttachment } from "@/lib/types";

function imageAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    localId: "img-1",
    filename: "cat.png",
    bytes: 3,
    mimeType: "image/png",
    status: "ready",
    ...overrides,
  };
}

describe("AttachmentChip — image thumbnail", () => {
  beforeEach(() => {
    // jsdom doesn't implement the object-URL APIs.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
      () => "blob:mock-url",
    );
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  it("renders a thumbnail <img> for an image attachment with a File", () => {
    const file = new File(["x"], "cat.png", { type: "image/png" });
    const { container } = render(
      <AttachmentChip attachment={imageAttachment({ file })} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("blob:mock-url");
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
  });

  it("revokes the object URL on unmount (no leak)", () => {
    const file = new File(["x"], "cat.png", { type: "image/png" });
    const { unmount } = render(
      <AttachmentChip attachment={imageAttachment({ file })} />,
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("falls back to the image icon when there is no File (rehydrated chip)", () => {
    const { container } = render(
      <AttachmentChip attachment={imageAttachment()} />,
    );
    expect(container.querySelector("img")).toBeNull();
    // The lucide image icon renders as an SVG; createObjectURL is never called.
    expect(container.querySelector("svg")).not.toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("uses the document icon for non-image attachments", () => {
    const { container } = render(
      <AttachmentChip
        attachment={imageAttachment({
          filename: "notes.pdf",
          mimeType: "application/pdf",
        })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("attachment-chip")).toBeInTheDocument();
  });
});
