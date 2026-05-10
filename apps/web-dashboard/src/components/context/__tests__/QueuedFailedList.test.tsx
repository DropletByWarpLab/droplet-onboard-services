/**
 * WARP-225 — QueuedList + FailedList smoke tests.
 *
 * Asserts:
 *   - Empty arrays render nothing (the component no-ops).
 *   - Non-empty arrays render the expected row count + buttons.
 *   - Network mocks for transcribe-now / retry surface 429 + 202
 *     correctly inline.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

import { QueuedList } from "../QueuedList";
import { FailedList } from "../FailedList";

const mockTranscribeNow = vi.fn();
const mockRetry = vi.fn();
vi.mock("@/lib/api", () => ({
  transcribeNowBrainItem: (...args: unknown[]) =>
    mockTranscribeNow(...args),
  retryFailedContextItem: (...args: unknown[]) => mockRetry(...args),
}));

describe("<QueuedList />", () => {
  it("returns null on empty array (parent gates rendering)", () => {
    const { container } = render(<QueuedList items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a row + Run-now button per queued item", () => {
    render(
      <QueuedList
        items={[
          {
            id: "q-1",
            filename: "interview.mp3",
            mimeType: "audio/mpeg",
            category: "audio",
            uploadedAt: new Date().toISOString(),
            reason: "audio file, scheduled for nightly transcription",
          },
        ]}
      />,
    );
    expect(screen.getByText("interview.mp3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run extractor now/i })).toBeInTheDocument();
  });

  it("calls transcribeNowBrainItem on click and renders 429 inline", async () => {
    mockTranscribeNow.mockResolvedValue({
      ok: false,
      status: 429,
      retryAfterSeconds: 600,
    });
    render(
      <QueuedList
        items={[
          {
            id: "q-2",
            filename: "x.mp3",
            mimeType: "audio/mpeg",
            category: "audio",
            uploadedAt: new Date().toISOString(),
            reason: "audio file",
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Run extractor now/i }));
    await waitFor(() => {
      expect(screen.getByText(/Retry available in 10 mins/i)).toBeInTheDocument();
    });
  });
});

describe("<FailedList />", () => {
  it("returns null on empty array", () => {
    const { container } = render(<FailedList items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders failureReason + recentAttemptCount in the row", () => {
    render(
      <FailedList
        items={[
          {
            id: "f-1",
            filename: "broken.eml",
            mimeType: "message/rfc822",
            category: "email",
            failureReason: "no_chunks",
            lastAttemptedAt: new Date().toISOString(),
            recentAttemptCount: 2,
          },
        ]}
      />,
    );
    expect(screen.getByText("broken.eml")).toBeInTheDocument();
    expect(screen.getByText(/no_chunks/i)).toBeInTheDocument();
    expect(screen.getByText(/2\/3 retries this hour/i)).toBeInTheDocument();
  });

  it("renders 'Retry queued' on a 202 response", async () => {
    
    mockRetry.mockResolvedValue({ ok: true, status: 202 });
    render(
      <FailedList
        items={[
          {
            id: "f-2",
            filename: "x.mp3",
            mimeType: "audio/mpeg",
            category: "audio",
            failureReason: "extractor_unavailable",
            lastAttemptedAt: null,
            recentAttemptCount: 0,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Retry indexing/i }));
    await waitFor(() => {
      expect(screen.getByText(/Retry queued/i)).toBeInTheDocument();
    });
  });

  it("surfaces 429 inline as a friendly message", async () => {
    
    mockRetry.mockResolvedValue({
      ok: false,
      status: 429,
      retryAfterSeconds: 1800,
    });
    render(
      <FailedList
        items={[
          {
            id: "f-3",
            filename: "x.mp3",
            mimeType: "audio/mpeg",
            category: "audio",
            failureReason: "no_chunks",
            lastAttemptedAt: null,
            recentAttemptCount: 3,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Retry indexing/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/Retry available in 30 mins/i),
      ).toBeInTheDocument();
    });
  });
});
