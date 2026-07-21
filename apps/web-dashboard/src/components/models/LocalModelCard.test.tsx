/**
 * WARP-836 — LocalModelCard: measured metrics + on-demand throughput.
 *
 * Pins the honest-metrics contract (disk/params/quant/resident VRAM render
 * real values) and the "Measure speed" flow: owners/admins can measure
 * tokens/sec; members see the last measurement but no button.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { LocalModelRow } from "@/lib/types";

const benchmarkModelMock = vi.fn();
vi.mock("@/lib/api", () => ({
  benchmarkModel: (name: string) => benchmarkModelMock(name),
}));

import { LocalModelCard } from "./LocalModelCard";

function row(over: Partial<LocalModelRow> = {}): LocalModelRow {
  return {
    name: "gpt-oss:20b",
    family: "gpt-oss",
    provider: "ollama",
    contextLength: 131072,
    gbOnDisk: 13.8,
    role: null,
    status: "ready",
    tokensPerSec: null,
    diskBarPct: 87,
    parameterSize: "20.9B",
    quantization: "MXFP4",
    loaded: true,
    vramGb: 12.7,
    benchmarkedAt: null,
    ...over,
  };
}

beforeEach(() => {
  benchmarkModelMock.mockReset();
  benchmarkModelMock.mockResolvedValue({
    tokensPerSec: 42.5,
    measuredAt: "2026-07-20T00:00:00.000Z",
  });
});

describe("<LocalModelCard />", () => {
  it("shows measured metrics (disk, params/quant, resident VRAM)", () => {
    render(<LocalModelCard model={row()} />);
    expect(screen.getByText(/13\.8 GB/)).toBeInTheDocument();
    expect(screen.getByText(/20\.9B · MXFP4/)).toBeInTheDocument();
    expect(screen.getByText(/12\.7 GB in memory/)).toBeInTheDocument();
  });

  it("shows an existing tokensPerSec and no button for members", () => {
    render(<LocalModelCard model={row({ tokensPerSec: 55 })} canManage={false} />);
    expect(screen.getByText(/55 tok\/s/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /measure/i })).toBeNull();
  });

  it("lets an admin measure speed → calls benchmarkModel + onBenchmarked, shows result", async () => {
    const onBenchmarked = vi.fn();
    render(<LocalModelCard model={row()} canManage onBenchmarked={onBenchmarked} />);
    expect(screen.getByText(/not measured/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /measure speed/i }));
    await waitFor(() =>
      expect(benchmarkModelMock).toHaveBeenCalledWith("gpt-oss:20b"),
    );
    await waitFor(() => expect(onBenchmarked).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/42\.5 tok\/s/)).toBeInTheDocument(),
    );
  });

  it("surfaces an error when measuring fails", async () => {
    benchmarkModelMock.mockRejectedValueOnce(
      new Error("Couldn’t measure this model's speed just now."),
    );
    render(<LocalModelCard model={row()} canManage />);
    fireEvent.click(screen.getByRole("button", { name: /measure speed/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t measure/i),
    );
  });
});
