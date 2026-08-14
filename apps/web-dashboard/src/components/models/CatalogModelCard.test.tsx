/**
 * WARP-1827 — CatalogModelCard: one installable model from the eligible
 * catalog.
 *
 * Pins the read/write split: everyone sees the metadata (display name, maker,
 * description, capability chips, honest "~N GB download" only when the size is
 * known); ONLY owner/admin get the Download button — members get read-only
 * with no disabled-button noise. While a pull runs the card shows live
 * progress (determinate when the stream reports totals, indeterminate
 * otherwise) and other cards' buttons disable (one download at a time).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CatalogModelEntry } from "@/lib/types";

import { CatalogModelCard } from "./CatalogModelCard";

function entry(over: Partial<CatalogModelEntry> = {}): CatalogModelEntry {
  return {
    name: "qwen3:14b",
    pull_tag: "qwen3:14b",
    min_vram_gb: 12,
    class: "flagship",
    default: false,
    display_name: "Qwen3 14B",
    maker: "Alibaba",
    description: "A capable multilingual model.",
    capabilities: ["chat", "tools"],
    roles: ["chat"],
    disk_gb: 9,
    pulled: false,
    ...over,
  };
}

const idle = {
  pulling: false,
  pullBusy: false,
  progressPct: null as number | null,
  progressStatus: null as string | null,
  error: null as string | null,
};

describe("<CatalogModelCard /> (WARP-1827)", () => {
  it("renders the catalog metadata: display name, maker, description, chips, size", () => {
    render(
      <CatalogModelCard entry={entry()} canManage {...idle} onDownload={() => {}} />,
    );
    expect(screen.getByText("Qwen3 14B")).toBeInTheDocument();
    expect(screen.getByText(/Alibaba/)).toBeInTheDocument();
    expect(screen.getByText("A capable multilingual model.")).toBeInTheDocument();
    expect(screen.getByText("chat")).toBeInTheDocument();
    expect(screen.getByText("tools")).toBeInTheDocument();
    expect(screen.getByText(/~9 GB download/)).toBeInTheDocument();
  });

  it("falls back to the catalog name when display_name is absent", () => {
    render(
      <CatalogModelCard
        entry={entry({ display_name: null })}
        canManage
        {...idle}
        onDownload={() => {}}
      />,
    );
    expect(screen.getByText("qwen3:14b")).toBeInTheDocument();
  });

  it("omits the download-size line when disk_gb is unknown — never fabricated", () => {
    render(
      <CatalogModelCard
        entry={entry({ disk_gb: null })}
        canManage
        {...idle}
        onDownload={() => {}}
      />,
    );
    expect(screen.queryByText(/GB download/)).toBeNull();
  });

  it("owner/admin: Download button starts the pull", () => {
    const onDownload = vi.fn();
    render(
      <CatalogModelCard entry={entry()} canManage {...idle} onDownload={onDownload} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("member: NO button at all — read-only, no disabled-button noise", () => {
    render(
      <CatalogModelCard
        entry={entry()}
        canManage={false}
        {...idle}
        onDownload={() => {}}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("disables the button while ANOTHER pull runs (one download at a time)", () => {
    const onDownload = vi.fn();
    render(
      <CatalogModelCard
        entry={entry()}
        canManage
        {...idle}
        pullBusy
        onDownload={onDownload}
      />,
    );
    const button = screen.getByRole("button", { name: /download/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("while pulling: live progress bar + status text, no Download button", () => {
    render(
      <CatalogModelCard
        entry={entry()}
        canManage
        {...idle}
        pulling
        pullBusy
        progressPct={42}
        progressStatus="pulling 9f13bb"
        onDownload={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText(/pulling 9f13bb/)).toBeInTheDocument();
    expect(screen.getByText(/42%/)).toBeInTheDocument();
  });

  it("goes indeterminate (no aria-valuenow, no %) when the stream has no totals", () => {
    render(
      <CatalogModelCard
        entry={entry()}
        canManage
        {...idle}
        pulling
        pullBusy
        progressStatus="verifying sha256 digest"
        onDownload={() => {}}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText(/verifying sha256 digest/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("surfaces a terminal error as an alert", () => {
    render(
      <CatalogModelCard
        entry={entry()}
        canManage
        {...idle}
        error="Needs 9.0 GB free; 2.1 GB available."
        onDownload={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Needs 9.0 GB free; 2.1 GB available.",
    );
  });
});
