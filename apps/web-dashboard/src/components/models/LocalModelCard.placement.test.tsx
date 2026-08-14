/**
 * WARP-1827 — placement surfacing on the local model card.
 *
 * When the box reports a LOADED model is running on the CPU (or only partly
 * on the GPU), the card says so with a warning badge. Honesty cuts both ways:
 * absence of placement data is NOT a health signal, so a null/absent
 * placement renders NO badge — only an explicit "cpu"/"partial" warns, and a
 * healthy "gpu" placement adds nothing.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LocalModelRow } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  benchmarkModel: vi.fn(),
}));

import { LocalModelCard } from "./LocalModelCard";

function row(over: Partial<LocalModelRow> = {}): LocalModelRow {
  return {
    name: "gpt-oss:20b",
    family: "gpt-oss",
    provider: "ollama",
    contextLength: 131072,
    gbOnDisk: 13.8,
    gbOnDiskState: "measured",
    role: null,
    status: "ready",
    tokensPerSec: null,
    diskBarPct: 87,
    parameterSize: "20.9B",
    quantization: "MXFP4",
    loaded: true,
    vramGb: 12.7,
    vramState: "measured",
    benchmarkedAt: null,
    ...over,
  };
}

describe("<LocalModelCard /> placement badge (WARP-1827)", () => {
  it("placement 'cpu' → 'Running on CPU' warning badge", () => {
    render(
      <LocalModelCard
        model={row({ placement: "cpu", gpuFraction: 0, placementState: "measured" })}
      />,
    );
    expect(screen.getByText("Running on CPU")).toBeInTheDocument();
  });

  it("placement 'partial' → 'Partially on GPU' warning badge", () => {
    render(
      <LocalModelCard
        model={row({ placement: "partial", gpuFraction: 0.5, placementState: "measured" })}
      />,
    );
    expect(screen.getByText("Partially on GPU")).toBeInTheDocument();
  });

  it("placement 'gpu' → NO badge (healthy is quiet)", () => {
    render(
      <LocalModelCard
        model={row({ placement: "gpu", gpuFraction: 1, placementState: "measured" })}
      />,
    );
    expect(screen.queryByText(/Running on CPU|Partially on GPU/)).toBeNull();
  });

  it("placement null → NO badge (absence of data is not a health signal)", () => {
    render(
      <LocalModelCard
        model={row({ placement: null, gpuFraction: null, placementState: null })}
      />,
    );
    expect(screen.queryByText(/Running on CPU|Partially on GPU/)).toBeNull();
  });

  it("placement absent (older orchestrator) → NO badge", () => {
    render(<LocalModelCard model={row()} />);
    expect(screen.queryByText(/Running on CPU|Partially on GPU/)).toBeNull();
  });
});
