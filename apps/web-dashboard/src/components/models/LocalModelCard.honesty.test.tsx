/**
 * WARP-1749 — the card never renders a fabricated zero, and explains a dash.
 *
 * The Models page is the WARP-836 "honest metrics" surface. Docker Model
 * Runner reports `size: 0` on /api/tags and never populates `size_vram` on
 * /api/ps, so a flipped box's payload is full of absences. Showing "0 B" for
 * those would be a confident wrong number on the one page whose selling point
 * is that it doesn't do that — worse than showing nothing.
 *
 * So: absent stays "—", and the tooltip says WHOSE limitation it is. The
 * Ollama cases below are the regression half — real numbers must render
 * exactly as they did before this ticket.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { LocalModelRow } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  benchmarkModel: vi.fn(),
}));

import { LocalModelCard } from "./LocalModelCard";

/** A row as an Ollama box produces it today — every number real. */
function ollamaRow(over: Partial<LocalModelRow> = {}): LocalModelRow {
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

/** A row as a DMR box produces it: resident, but with nothing measurable. */
function dmrRow(over: Partial<LocalModelRow> = {}): LocalModelRow {
  return {
    name: "ai/smollm2",
    family: "smollm2",
    provider: "ollama",
    contextLength: 8192,
    gbOnDisk: null,
    gbOnDiskState: "unsupported",
    role: null,
    status: "ready",
    tokensPerSec: null,
    diskBarPct: null,
    parameterSize: null,
    quantization: null,
    loaded: true,
    vramGb: null,
    vramState: "unsupported",
    benchmarkedAt: null,
    ...over,
  };
}

describe("<LocalModelCard /> — Ollama rendering is unchanged (WARP-1749)", () => {
  it("renders the measured numbers and the original tooltips", () => {
    render(<LocalModelCard model={ollamaRow()} />);
    expect(screen.getByText(/13\.8 GB/)).toBeInTheDocument();
    expect(screen.getByText(/20\.9B · MXFP4/)).toBeInTheDocument();
    expect(screen.getByText(/12\.7 GB in memory/)).toBeInTheDocument();
    expect(screen.getByTitle("On disk")).toBeInTheDocument();
    expect(screen.getByTitle("Graphics memory in use")).toBeInTheDocument();
  });

  it("renders identically when the orchestrator predates the state fields", () => {
    // Additive/optional on the wire: an older backend omits them and the card
    // falls back to inferring from the value, i.e. to today's output.
    const legacy = ollamaRow();
    delete legacy.gbOnDiskState;
    delete legacy.vramState;
    render(<LocalModelCard model={legacy} />);
    expect(screen.getByText(/13\.8 GB/)).toBeInTheDocument();
    expect(screen.getByTitle("On disk")).toBeInTheDocument();
    expect(screen.getByTitle("Graphics memory in use")).toBeInTheDocument();
  });

  it("says a size simply wasn't reported when the runtime could have reported it", () => {
    render(
      <LocalModelCard
        model={ollamaRow({ gbOnDisk: null, gbOnDiskState: "unreported", diskBarPct: null })}
      />,
    );
    expect(screen.getByTitle(/not reported for this model/)).toBeInTheDocument();
    // "not available yet" is right here — it may well arrive on the next poll.
    expect(screen.getByText(/On-disk usage not available yet/)).toBeInTheDocument();
  });
});

describe("<LocalModelCard /> — a runtime that can't report says so (WARP-1749)", () => {
  it("shows no zero anywhere for a DMR-shaped row", () => {
    const { container } = render(<LocalModelCard model={dmrRow()} />);
    // The whole defect in one assertion.
    expect(container.textContent).not.toMatch(/\b0(\.0)?\s?(B|GB)\b/);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("explains the missing disk size instead of leaving a bare dash", () => {
    render(<LocalModelCard model={dmrRow()} />);
    expect(
      screen.getByTitle(/runtime doesn.t report model file sizes/),
    ).toBeInTheDocument();
    // …and the meter caption drops "yet", which would promise a number that
    // is never coming.
    expect(
      screen.getByText(/On-disk usage isn.t reported by this box.s AI runtime/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not available yet/)).toBeNull();
  });

  it("still reports residency honestly — 'in memory' with no invented VRAM figure", () => {
    render(<LocalModelCard model={dmrRow()} />);
    // Residency IS knowable on DMR; the graphics-memory number behind it isn't.
    expect(screen.getByText("in memory")).toBeInTheDocument();
    expect(
      screen.getByTitle(/doesn.t report per-model graphics memory/),
    ).toBeInTheDocument();
  });

  it("still says 'on disk' for an unloaded model whose size is unknowable", () => {
    // The model is demonstrably installed — the probe read it out of the
    // installed listing — so a bare "—" here would under-report what we know.
    render(<LocalModelCard model={dmrRow({ loaded: false })} />);
    expect(screen.getByText("on disk")).toBeInTheDocument();
  });

  it("distinguishes 'this runtime never reports it' from 'not reported this time'", () => {
    render(<LocalModelCard model={dmrRow({ vramState: "unreported" })} />);
    expect(
      screen.getByTitle(/graphics memory use wasn.t reported for this model/),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/doesn.t report per-model graphics memory/)).toBeNull();
  });
});
