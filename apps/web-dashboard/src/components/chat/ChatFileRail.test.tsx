/**
 * WARP-2205 — the chat file rail.
 *
 * The rail merges two sources that address files in DIFFERENT vocabularies,
 * and most of what can go wrong here is an adapter quietly producing a row
 * that looks fine and cannot open:
 *
 *   - a chat attachment is a BrainMemoryItem with NO files-tree path, so it
 *     must carry an explicit `source` pointing at /api/files/brain/:itemId;
 *   - a context pin's `ref` IS a files-tree path, so it must carry NO source
 *     and let the previewer derive its own URLs.
 *
 * Getting those backwards produces a 404 rather than a crash — the shape of
 * the WARP-859 bug — so the adapters are asserted directly, not just through
 * the rendered rail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ChatAttachment } from "@/lib/types";

const listContextPins = vi.fn();

vi.mock("@/lib/api", () => ({
  listContextPins: (...a: unknown[]) => listContextPins(...a),
  getDownloadUrl: (p: string) => `/api/files/download?path=${encodeURIComponent(p)}`,
  getPreviewUrl: (p: string) =>
    `/api/files/download?path=${encodeURIComponent(p)}&disposition=inline`,
  getThumbnailUrl: (p: string) => `/api/files/thumbnail?path=${encodeURIComponent(p)}`,
  getDocsStatus: vi.fn().mockResolvedValue({ state: "unavailable", engine: "collabora" }),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, text: async () => "", blob: async () => new Blob() }),
}));

vi.mock("@/components/FileManager/ReindexButton", () => ({ ReindexButton: () => null }));

import { ChatFileRail, attachmentToRail, pinToRail, buildRailFiles } from "./ChatFileRail";

function att(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    localId: "l1",
    itemId: "bmi-1",
    filename: "quote.pdf",
    bytes: 2048,
    mimeType: "application/pdf",
    status: "ready",
    ...overrides,
  } as ChatAttachment;
}

beforeEach(() => {
  cleanup();
  listContextPins.mockReset();
  listContextPins.mockResolvedValue({ pins: [] });
});

describe("adapters — the two vocabularies must not be crossed", () => {
  it("points an attachment at the brain endpoint, inline", () => {
    const row = attachmentToRail(att());
    expect(row.source?.previewUrl).toBe(
      "/api/files/brain/bmi-1/download?disposition=inline",
    );
    expect(row.source?.downloadUrl).toBe("/api/files/brain/bmi-1/download");
    expect(row.entry).not.toBeNull();
  });

  it("gives a pin NO source, so the previewer derives its own files-tree URLs", () => {
    const row = pinToRail("/Documents/contract.pdf");
    expect(row.source).toBeUndefined();
    expect(row.entry?.path).toBe("/Documents/contract.pdf");
    expect(row.name).toBe("contract.pdf");
  });

  // Bytes land on disk when the upload route returns 202 and mints the itemId.
  // "indexing" is about RAG extraction, not availability — gating on "ready"
  // would hide a file that is sitting right there.
  it("treats an indexing attachment as viewable", () => {
    expect(attachmentToRail(att({ status: "indexing" })).entry).not.toBeNull();
  });

  it("blocks an attachment that has no bytes yet, and says why", () => {
    const row = attachmentToRail(att({ status: "uploading", itemId: undefined }));
    expect(row.entry).toBeNull();
    expect(row.blockedReason).toBe("Still uploading");
  });

  it("surfaces a failed attachment's own error", () => {
    const row = attachmentToRail(att({ status: "failed", error: "Too large" }));
    expect(row.entry).toBeNull();
    expect(row.blockedReason).toBe("Too large");
    expect(row.failed).toBe(true);
  });

  it("de-dupes a file that is both attached and pinned", () => {
    const rows = buildRailFiles([att({ filename: "quote.pdf" })], ["/Docs/quote.pdf"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("attachment");
  });
});

describe("the rail", () => {
  it("renders nothing when the conversation has no files", () => {
    const { container } = render(<ChatFileRail sessionId="s1" attachments={[]} />);
    expect(container.querySelector("aside")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("renders its own aside, labelled, when there are files", () => {
    render(<ChatFileRail sessionId="s1" attachments={[att()]} />);
    const aside = screen.getByLabelText("Files in this conversation");
    expect(aside.tagName).toBe("ASIDE");
    // The stylesheet must not own `display` — the utilities do (WARP-1792).
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("lg:flex");
  });

  it("lists attachments and file pins together", async () => {
    listContextPins.mockResolvedValue({
      pins: [
        { id: "p1", sessionId: "s1", kind: "file", ref: "/Docs/notes.md", addedAt: "" },
        { id: "p2", sessionId: "s1", kind: "camera", ref: "cam-1", addedAt: "" },
      ],
    });
    render(<ChatFileRail sessionId="s1" attachments={[att()]} />);
    expect(await screen.findByText("notes.md")).toBeTruthy();
    expect(screen.getByText("quote.pdf")).toBeTruthy();
    // A camera pin is not a file and must not appear as one.
    expect(screen.queryByText("cam-1")).toBeNull();
  });

  it("does not make a row clickable while it is still uploading", () => {
    render(
      <ChatFileRail
        sessionId="s1"
        attachments={[att({ status: "uploading", itemId: undefined })]}
      />,
    );
    const row = screen.getByTitle("Still uploading");
    expect((row as HTMLButtonElement).disabled).toBe(true);
  });

  it("docks the previewer when a row is chosen", async () => {
    const { container } = render(<ChatFileRail sessionId="s1" attachments={[att()]} />);
    fireEvent.click(screen.getByTitle("Open quote.pdf"));
    await waitFor(() => {
      expect(container.querySelector("object")).not.toBeNull();
    });
    // Docked, not modal — no backdrop anywhere in the rail.
    expect(container.querySelector(".fixed.inset-0")).toBeNull();
    // And pointed at the brain endpoint, not a path-derived files URL.
    expect(container.querySelector("object")?.getAttribute("data")).toContain(
      "/api/files/brain/bmi-1/download",
    );
  });

  it("reports its count so the page can gate the mobile trigger", async () => {
    const onCountChange = vi.fn();
    render(
      <ChatFileRail sessionId="s1" attachments={[att()]} onCountChange={onCountChange} />,
    );
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
  });

  it("reports zero for an empty conversation, so no dead trigger renders", async () => {
    const onCountChange = vi.fn();
    render(
      <ChatFileRail sessionId="s1" attachments={[]} onCountChange={onCountChange} />,
    );
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
  });

  it("survives a pins outage — the attachments are the point", async () => {
    listContextPins.mockRejectedValue(new Error("pins down"));
    render(<ChatFileRail sessionId="s1" attachments={[att()]} />);
    expect(await screen.findByText("quote.pdf")).toBeTruthy();
  });

  it("does not ask for pins before the first turn mints a session", () => {
    render(<ChatFileRail sessionId={null} attachments={[att()]} />);
    expect(listContextPins).not.toHaveBeenCalled();
    expect(screen.getByText("quote.pdf")).toBeTruthy();
  });

  it("renders bare content in drawer mode — the Dialog owns the shell", () => {
    const { container } = render(
      <ChatFileRail sessionId="s1" attachments={[att()]} variant="drawer" />,
    );
    expect(container.querySelector("aside")).toBeNull();
    expect(screen.getByText("quote.pdf")).toBeTruthy();
  });
});
