/**
 * WARP-1394 — /context page empty-state gate.
 *
 * The onboarding card must only render when there is truly NO indexed
 * context anywhere: `files === 0 && chunks === 0`. A box can hold
 * serving chunks with zero countable file rows (e.g. a corpus indexed
 * before FileIndexStatus existed), and "your context is empty" over a
 * live index is exactly the lie this ticket removes. Data states are
 * driven through a mocked useContextStats module, same pattern as
 * tools/page.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ContextStatsFull } from "@/lib/types-context-stats";

const useFullMock = vi.fn();
vi.mock("@/lib/hooks/useContextStats", () => ({
  useContextStatsFull: () => useFullMock(),
  useContextStatsQueued: () => ({ queued: [], mutate: vi.fn() }),
  useContextStatsFailed: () => ({ failed: [], mutate: vi.fn() }),
}));

import ContextPage from "./page";

function denseWeek(): Array<{ day: string; count: number }> {
  const out: Array<{ day: string; count: number }> = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push({ day: d.toISOString().slice(0, 10), count: 0 });
  }
  return out;
}

function fullStats(over: Partial<ContextStatsFull> = {}): ContextStatsFull {
  return {
    files: 0,
    chunks: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
    bytesIndexed: 0,
    recentlyIndexed: [],
    byCategory: [],
    throughput7d: denseWeek(),
    pipelineHealth: [],
    ...over,
  };
}

beforeEach(() => {
  useFullMock.mockReset();
});

describe("/context empty-state gate (WARP-1394)", () => {
  it("renders stats — not the onboarding card — when chunks exist without file rows", () => {
    useFullMock.mockReturnValue({
      full: fullStats({ chunks: 371 }),
      isLoading: false,
      error: null,
    });
    render(<ContextPage />);
    expect(
      screen.queryByTestId("context-empty-state"),
    ).not.toBeInTheDocument();
    // Stat cards are up, showing the live chunk count.
    expect(screen.getByText("Chunks")).toBeInTheDocument();
  });

  it("renders the onboarding card only when files AND chunks are zero, and its copy covers synced files", () => {
    useFullMock.mockReturnValue({
      full: fullStats(),
      isLoading: false,
      error: null,
    });
    render(<ContextPage />);
    expect(screen.getByTestId("context-empty-state")).toBeInTheDocument();
    // Copy must mention BOTH ingestion paths — chat attachments and
    // synced files — not just "drop a file into a chat".
    expect(screen.getByText(/sync/i)).toBeInTheDocument();
  });
});
