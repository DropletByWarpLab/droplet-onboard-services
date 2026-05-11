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
});
