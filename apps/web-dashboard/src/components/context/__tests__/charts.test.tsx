/**
 * WARP-225 — chart components smoke test.
 *
 * Recharts' ResponsiveContainer reads the parent's clientWidth, which
 * is 0 in jsdom. To keep these as smoke (renders-without-crashing)
 * tests, we wrap each chart in a fixed-size div and just assert the
 * test-id renders.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

import { ThroughputSparkline } from "../ThroughputSparkline";
import { CoverageDonut } from "../CoverageDonut";
import { BytesBySource } from "../BytesBySource";
import { PipelineHealth } from "../PipelineHealth";
import { RecentlyIndexed } from "../RecentlyIndexed";
import { EmptyState } from "../EmptyState";

const FIXED = (children: React.ReactNode) => (
  <div style={{ width: 400, height: 320 }}>{children}</div>
);

describe("<ThroughputSparkline />", () => {
  it("renders without crashing with 7 days of data", () => {
    const data = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-05-0${i + 1}`,
      count: i,
    }));
    const { getByTestId } = render(
      FIXED(<ThroughputSparkline data={data} />),
    );
    expect(getByTestId("throughput-sparkline")).toBeInTheDocument();
  });
});

describe("<CoverageDonut />", () => {
  it("renders 'No coverage yet' on empty data", () => {
    const { getByText } = render(FIXED(<CoverageDonut data={[]} />));
    expect(getByText(/No coverage yet/i)).toBeInTheDocument();
  });

  it("renders a non-empty donut with category legend", () => {
    const { getByTestId, getByText } = render(
      FIXED(
        <CoverageDonut
          data={[
            { category: "pdf", files: 3, bytes: 1024 },
            { category: "audio", files: 1, bytes: 2048 },
          ]}
        />,
      ),
    );
    expect(getByTestId("coverage-donut")).toBeInTheDocument();
    expect(getByText(/PDFs/i)).toBeInTheDocument();
    expect(getByText(/Audio/i)).toBeInTheDocument();
  });
});

describe("<BytesBySource />", () => {
  it("renders 'No bytes yet' on empty data", () => {
    const { getByText } = render(FIXED(<BytesBySource data={[]} />));
    expect(getByText(/No bytes yet/i)).toBeInTheDocument();
  });

  it("renders without crashing on real data", () => {
    const { getByTestId } = render(
      FIXED(
        <BytesBySource
          data={[{ category: "pdf", files: 3, bytes: 1024 }]}
        />,
      ),
    );
    expect(getByTestId("bytes-by-source")).toBeInTheDocument();
  });
});

describe("<PipelineHealth />", () => {
  it("renders an empty placeholder when no rows", () => {
    const { getByText } = render(FIXED(<PipelineHealth rows={[]} />));
    expect(getByText(/No extractor activity yet/i)).toBeInTheDocument();
  });

  it("renders a row per extractor with avg + failed counts", () => {
    const { getByText } = render(
      FIXED(
        <PipelineHealth
          rows={[
            {
              category: "pdf",
              files: 3,
              avgSecondsToReady: 0.85,
              failed: 0,
            },
            {
              category: "audio",
              files: 1,
              avgSecondsToReady: null,
              failed: 1,
            },
          ]}
        />,
      ),
    );
    expect(getByText(/PDF/i)).toBeInTheDocument();
    expect(getByText(/faster-whisper/i)).toBeInTheDocument();
    expect(getByText(/1 failed/i)).toBeInTheDocument();
  });
});

describe("<RecentlyIndexed />", () => {
  it("renders the empty hint when no items", () => {
    const { getByText } = render(FIXED(<RecentlyIndexed items={[]} />));
    expect(getByText(/Drop a file/i)).toBeInTheDocument();
  });

  it("renders one row per item", () => {
    const { getAllByTestId } = render(
      FIXED(
        <RecentlyIndexed
          items={[
            {
              id: "x",
              filename: "a.pdf",
              mimeType: "application/pdf",
              category: "pdf",
              indexedAt: new Date().toISOString(),
              chunkCount: 4,
            },
            {
              id: "y",
              filename: "b.mp3",
              mimeType: "audio/mpeg",
              category: "audio",
              indexedAt: new Date().toISOString(),
              chunkCount: 12,
            },
          ]}
        />,
      ),
    );
    expect(getAllByTestId("recently-indexed-item")).toHaveLength(2);
  });
});

describe("<EmptyState />", () => {
  it("renders the onboarding card with the chat CTA", () => {
    const { getByText, getByTestId } = render(<EmptyState />);
    expect(getByTestId("context-empty-state")).toBeInTheDocument();
    expect(getByText(/empty/i)).toBeInTheDocument();
    expect(getByText(/Open chat/i)).toBeInTheDocument();
  });
});
