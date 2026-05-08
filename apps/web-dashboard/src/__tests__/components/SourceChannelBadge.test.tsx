import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourceChannelBadge } from "@/components/SourceChannelBadge";

describe("SourceChannelBadge", () => {
  it("renders 'transcribed by ASR' for asr_transcript", () => {
    render(<SourceChannelBadge subtitleSource="asr_transcript" warnings={[]} />);
    expect(screen.getByText(/transcribed by ASR/i)).toBeInTheDocument();
  });

  it("renders 'embedded subtitles' for embedded", () => {
    render(<SourceChannelBadge subtitleSource="embedded" warnings={[]} />);
    expect(screen.getByText(/embedded subtitles/i)).toBeInTheDocument();
  });

  it("renders 'text from video frames' for frame_ocr", () => {
    render(<SourceChannelBadge subtitleSource="frame_ocr" warnings={[]} />);
    expect(screen.getByText(/text from video frames/i)).toBeInTheDocument();
  });

  it("renders 'OCR · low confidence' when warnings include low_confidence_ocr", () => {
    const { container } = render(
      <SourceChannelBadge
        subtitleSource={null}
        warnings={["low_confidence_ocr"]}
      />,
    );
    expect(container.textContent).toContain("OCR · low confidence");
  });

  it("renders 'OCR' when warnings include ocr_used (not low confidence)", () => {
    render(
      <SourceChannelBadge subtitleSource={null} warnings={["ocr_used"]} />,
    );
    expect(screen.getByText(/^OCR$/)).toBeInTheDocument();
  });

  it("returns null when no signal applies (PDF text, plain text, etc.)", () => {
    const { container } = render(
      <SourceChannelBadge subtitleSource={null} warnings={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when subtitleSource is undefined and warnings empty", () => {
    const { container } = render(<SourceChannelBadge warnings={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
