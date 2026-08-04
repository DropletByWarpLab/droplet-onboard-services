/**
 * WARP-292 — FileRow download / delete actions.
 *
 * The FileRow used to hide the per-row Download + Trash buttons behind
 * `opacity-0 group-hover:opacity-100`, leaving them unreachable for
 * touch + keyboard. WARP-298 owns the broader keyboard-nav story
 * (row tabIndex, arrow keys); WARP-292 only fixes the action buttons
 * so they're discoverable + targetable.
 *
 * Invariants:
 *   - Download + Delete buttons are always rendered (no opacity-0).
 *   - Each carries an aria-label naming the action + the file name.
 *   - p-2.5 hit-target.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { FileRow } from "@/components/FileManager/FileRow";
import type { FileEntryInfo } from "@/lib/types";

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

function renderRow(file: FileEntryInfo, overrides: Partial<React.ComponentProps<typeof FileRow>> = {}) {
  return render(
    <FileRow
      file={file}
      isSelected={false}
      isRenaming={false}
      onSelect={vi.fn()}
      onToggleSelect={vi.fn()}
      onOpen={vi.fn()}
      onDownload={vi.fn()}
      onDelete={vi.fn()}
      onRename={vi.fn()}
      onCancelRename={vi.fn()}
      onContextMenu={vi.fn()}
      {...overrides}
    />,
  );
}

describe("FileRow — per-row actions (WARP-292)", () => {
  it("Download + Delete buttons name the file in their aria-label", () => {
    renderRow(makeFile({ name: "report.pdf" }));

    expect(
      screen.getByRole("button", { name: /download report\.pdf/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete report\.pdf/i }),
    ).toBeInTheDocument();
  });

  it("Download + Delete buttons are not hidden behind opacity-0 hover", () => {
    renderRow(makeFile({ name: "report.pdf" }));

    const download = screen.getByRole("button", { name: /download report\.pdf/i });
    const del = screen.getByRole("button", { name: /delete report\.pdf/i });

    // Neither button nor its closest action-row container may sit on a
    // hover-gated opacity transform.
    expect(download.className).not.toMatch(/opacity-0/);
    expect(del.className).not.toMatch(/opacity-0/);
    expect(download.closest("div")?.className ?? "").not.toMatch(/opacity-0/);
    expect(del.closest("div")?.className ?? "").not.toMatch(/opacity-0/);

    // Hit-target floor.
    expect(download.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
    expect(del.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("directory rows expose Delete (no Download) named by directory", () => {
    renderRow(makeFile({ name: "Photos", isDirectory: true, mimeType: null as any }));

    // Directories aren't downloadable.
    expect(
      screen.queryByRole("button", { name: /download photos/i }),
    ).not.toBeInTheDocument();
    const del = screen.getByRole("button", { name: /delete photos/i });
    expect(del.className).not.toMatch(/opacity-0/);
    expect(del.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });
});
