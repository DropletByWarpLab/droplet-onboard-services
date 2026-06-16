import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Re-mock next/link as a real <a> element. The setup.ts global mock returns
// a string template, which doesn't compose with React children when the
// citation card needs to render fileName text inside the link.
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => {
    const React = require("react");
    return React.createElement("a", props, children);
  },
}));

import { CitationCard } from "../CitationCard";

const baseHit = {
  fileId: "f-1",
  filename: "x.pdf",
  mimeType: "application/pdf",
  chunkText: "snippet",
  score: 0.9,
};

describe("<CitationCard>", () => {
  it("renders PdfCitation when anchor.kind === 'pdf-page'", () => {
    render(
      <CitationCard
        hit={{ ...baseHit, anchor: { kind: "pdf-page", page: 4 } }}
      />,
    );
    const iframe = screen.getByTestId("pdf-iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("#page=4");
  });

  it("renders MediaCitation for media-timestamp on audio mimeType", () => {
    render(
      <CitationCard
        hit={{
          ...baseHit,
          mimeType: "audio/mpeg",
          filename: "rec.mp3",
          anchor: {
            kind: "media-timestamp",
            startMs: 1247400,
            endMs: 1253900,
          },
        }}
      />,
    );
    expect(screen.getByTestId("media-audio")).toBeTruthy();
  });

  it("renders EmailCitation for email-part anchor", () => {
    render(
      <CitationCard
        hit={{
          ...baseHit,
          mimeType: "message/rfc822",
          anchor: {
            kind: "email-part",
            messageId: "<m1@x>",
            partIndex: 1,
          },
        }}
      />,
    );
    expect(screen.getByTestId("email-card")).toBeTruthy();
  });

  it("renders ArchiveCitation for archive-member anchor", () => {
    render(
      <CitationCard
        hit={{
          ...baseHit,
          mimeType: "application/zip",
          anchor: { kind: "archive-member", member: "docs/x.pdf" },
        }}
      />,
    );
    expect(screen.getByTestId("archive-card")).toBeTruthy();
  });

  it("falls back to FileCitation when anchor is null (legacy)", () => {
    render(<CitationCard hit={{ ...baseHit, anchor: null }} />);
    expect(screen.getByTestId("file-card")).toBeTruthy();
  });

  it("falls back to FileCitation when anchor.kind is 'none'", () => {
    render(<CitationCard hit={{ ...baseHit, anchor: { kind: "none" } }} />);
    expect(screen.getByTestId("file-card")).toBeTruthy();
  });

  it("falls back to FileCitation for an unknown kind (deploy skew)", () => {
    render(
      <CitationCard
        hit={{ ...baseHit, anchor: { kind: "future" } as any }}
      />,
    );
    expect(screen.getByTestId("file-card")).toBeTruthy();
  });
});
