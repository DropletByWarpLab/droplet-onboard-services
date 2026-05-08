import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusChip } from "@/components/StatusChip";

describe("StatusChip", () => {
  it("renders 'Queued for transcription' for queued_for_transcription", () => {
    render(
      <StatusChip
        itemId="bmi-1"
        status="queued_for_transcription"
        onTranscribeNow={() => {}}
      />,
    );
    expect(screen.getByText(/Queued for transcription/i)).toBeInTheDocument();
  });

  it("shows the kebab overflow only on queued_for_transcription with handler", () => {
    const { rerender } = render(
      <StatusChip
        itemId="bmi-1"
        status="queued_for_transcription"
        onTranscribeNow={() => {}}
      />,
    );
    expect(screen.getByLabelText(/more actions/i)).toBeInTheDocument();

    rerender(
      <StatusChip
        itemId="bmi-1"
        status="indexing"
        onTranscribeNow={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/more actions/i)).toBeNull();

    rerender(
      <StatusChip itemId="bmi-1" status="ready" onTranscribeNow={() => {}} />,
    );
    expect(screen.queryByLabelText(/more actions/i)).toBeNull();
  });

  it("renders 'Indexing' for indexing", () => {
    render(<StatusChip itemId="bmi-1" status="indexing" />);
    expect(screen.getByText(/Indexing/i)).toBeInTheDocument();
  });

  it("returns null when status is ready (clean state)", () => {
    const { container } = render(<StatusChip itemId="bmi-1" status="ready" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 'Failed' for failed and shows the failureReason in tooltip", () => {
    render(
      <StatusChip
        itemId="bmi-1"
        status="failed"
        failureReason="ffmpeg exited with code 1"
      />,
    );
    expect(screen.getByText(/Failed/i)).toBeInTheDocument();
    expect(
      screen.getByTitle(/ffmpeg exited with code 1/i),
    ).toBeInTheDocument();
  });

  it("renders generic 'Processing' for unknown enum value (forward-compat)", () => {
    render(
      <StatusChip
        itemId="bmi-1"
        // @ts-expect-error — verifying forward-compat behavior with an unknown enum
        status="backfilling"
      />,
    );
    expect(screen.getByText(/Processing/i)).toBeInTheDocument();
  });

  it("calls onTranscribeNow when 'Transcribe now' is clicked from the kebab", () => {
    const onTranscribeNow = vi.fn();
    render(
      <StatusChip
        itemId="bmi-1"
        status="queued_for_transcription"
        onTranscribeNow={onTranscribeNow}
      />,
    );
    fireEvent.click(screen.getByLabelText(/more actions/i));
    fireEvent.click(screen.getByText(/Transcribe now/i));
    expect(onTranscribeNow).toHaveBeenCalledWith("bmi-1");
  });
});
