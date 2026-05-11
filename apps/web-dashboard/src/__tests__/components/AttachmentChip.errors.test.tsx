import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { AttachmentChip } from "@/components/AttachmentChip";
import type { ChatAttachment } from "@/lib/types";

/**
 * WARP-294 — failed-attachment chips never echo the raw `error`
 * string the orchestrator returned. Instead the chip renders a
 * friendly chat-domain translation.
 */
describe("AttachmentChip — failed status (WARP-294)", () => {
  it("never renders the raw error string verbatim", () => {
    const SECRET = "ECONNREFUSED indexer-stalled-413";
    const attachment: ChatAttachment = {
      localId: "att-1",
      filename: "notes.pdf",
      bytes: 4096,
      status: "failed",
      error: SECRET,
    };

    render(<AttachmentChip attachment={attachment} />);

    // Filename still shows.
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();
    // Raw secret must not be on screen.
    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/413/)).not.toBeInTheDocument();
  });

  it("renders a friendly chat-domain fallback for unknown failures", () => {
    const attachment: ChatAttachment = {
      localId: "att-2",
      filename: "movie.mp4",
      bytes: 1024,
      status: "failed",
      error: "GIBBERISH_CODE_NOBODY_KNOWS",
    };

    render(<AttachmentChip attachment={attachment} />);

    expect(
      screen.queryByText(/GIBBERISH_CODE_NOBODY_KNOWS/),
    ).not.toBeInTheDocument();
    // The chip status label "Failed" is still present.
    expect(screen.getAllByText(/Failed/).length).toBeGreaterThan(0);
  });

  it("exposes the friendly translation as a tooltip on the truncated error span (and never the raw error)", () => {
    // The translated span uses `truncate` which clips on narrow screens.
    // The `title` attribute must mirror the friendly copy so users on
    // small viewports can still read the full message on hover — and
    // it must NOT carry the raw `error` token.
    const RAW = "ECONNREFUSED indexer-stalled-413";
    const attachment: ChatAttachment = {
      localId: "att-3",
      filename: "notes.pdf",
      bytes: 4096,
      status: "failed",
      error: RAW,
    };

    const { container } = render(<AttachmentChip attachment={attachment} />);

    // Find the friendly-translation span (the one with `truncate`).
    const truncated = container.querySelector("span.truncate.text-label-tertiary");
    expect(truncated).not.toBeNull();
    const title = truncated!.getAttribute("title");
    expect(title).not.toBeNull();
    expect(title!.length).toBeGreaterThan(0);
    // Tooltip carries the friendly translation, not the raw orchestrator
    // string.
    expect(title).not.toContain(RAW);
    expect(title).not.toContain("ECONNREFUSED");
    expect(title).not.toContain("413");
    // Visible text and tooltip text agree (modulo the leading "— ").
    expect(truncated!.textContent).toContain(title!);
  });
});
