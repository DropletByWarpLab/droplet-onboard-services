/**
 * WARP-300 — FileListSimple per-row Star / Download / Remove actions.
 *
 * The shared FileListSimple listing (used by Favorites / Recents /
 * Shared-with-me) used to hide its per-row action group behind
 * `opacity-0 group-hover:opacity-100`, leaving touch + keyboard users
 * with no way to discover Download or Remove. Mirror of the WARP-220
 * / WARP-292 pattern already shipped on FileRow.
 *
 * Invariants:
 *   - Download + Remove buttons are always rendered (no opacity-0).
 *   - Each carries an aria-label that names the action AND the file.
 *   - p-2.5 hit-target token.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

import { FileListSimple } from "@/components/FileManager/FileListSimple";
import type { FileEntryInfo } from "@/lib/types";

// StarButton calls into the favorites API on mount/click — stub it.
vi.mock("@/components/FileManager/StarButton", () => ({
  StarButton: () => <button type="button">star</button>,
}));

// Thumbnail can resolve preview URLs; stub.
vi.mock("@/components/FileManager/Thumbnail", () => ({
  Thumbnail: () => <div data-testid="thumb" />,
}));

function makeFile(overrides: Partial<FileEntryInfo> = {}): FileEntryInfo {
  return {
    name: "report.pdf",
    path: "/files/report.pdf",
    size: 12_345,
    isDirectory: false,
    mimeType: "application/pdf",
    modifiedAt: new Date().toISOString(),
    ...overrides,
  } as FileEntryInfo;
}

describe("FileListSimple — per-row actions (WARP-300)", () => {
  it("Download button names the file and is always visible without hover", () => {
    render(
      <FileListSimple
        files={[makeFile({ name: "report.pdf" })]}
        isLoading={false}
        onOpen={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    const download = screen.getByRole("button", {
      name: /download report\.pdf/i,
    });
    expect(download).toBeInTheDocument();
    expect(download.className).not.toMatch(/opacity-0/);
    expect(download.closest("div")?.className ?? "").not.toMatch(/opacity-0/);
    expect(download.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("Remove button uses removeTooltip + file name in aria-label", () => {
    render(
      <FileListSimple
        files={[makeFile({ name: "shared-doc.pdf" })]}
        isLoading={false}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        removeTooltip="Remove from shared"
      />,
    );

    const remove = screen.getByRole("button", {
      name: /remove from shared shared-doc\.pdf/i,
    });
    expect(remove).toBeInTheDocument();
    expect(remove.className).not.toMatch(/opacity-0/);
    expect(remove.closest("div")?.className ?? "").not.toMatch(/opacity-0/);
    expect(remove.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("Remove aria-label falls back to 'Remove' + file name when removeTooltip is absent", () => {
    render(
      <FileListSimple
        files={[makeFile({ name: "report.pdf" })]}
        isLoading={false}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /remove report\.pdf/i }),
    ).toBeInTheDocument();
  });

  it("directory rows do not expose a Download button", () => {
    render(
      <FileListSimple
        files={[makeFile({ name: "Photos", isDirectory: true })]}
        isLoading={false}
        onOpen={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /download photos/i }),
    ).not.toBeInTheDocument();
  });
});
