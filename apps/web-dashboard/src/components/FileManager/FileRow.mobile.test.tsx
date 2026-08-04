/**
 * Touch reachability for the row context menu.
 *
 * The row menu (Preview, Rename, Cut/Copy, Move to…, Copy to…, Share link,
 * Delete) was reachable only through `onContextMenu` — fired by right-click
 * or the keyboard's Shift+F10 / ContextMenu key. A phone has neither, so
 * seven of the menu's nine actions were unreachable on touch while the row's
 * only visible controls were Download and Delete.
 *
 * The row now carries an explicit "More actions" button that opens the same
 * menu from the same anchor the keyboard path uses. It is `lg:hidden` —
 * desktop keeps right-click and is visually unchanged — so this test asserts
 * the button exists and dispatches, not that it is painted at a given width
 * (jsdom does not evaluate Tailwind breakpoints).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FileRow } from "./FileRow";
import type { FileEntryInfo } from "@/lib/types";

const FILE: FileEntryInfo = {
  name: "report.pdf",
  path: "/report.pdf",
  isDirectory: false,
  size: 2048,
  mimeType: "application/pdf",
  modifiedAt: "2026-04-16T00:00:00.000Z",
};

function renderRow(
  overrides: Partial<React.ComponentProps<typeof FileRow>> = {},
) {
  const onContextMenu = vi.fn();
  render(
    <FileRow
      file={FILE}
      isSelected={false}
      isRenaming={false}
      onSelect={() => {}}
      onToggleSelect={() => {}}
      onOpen={() => {}}
      onDownload={() => {}}
      onDelete={() => {}}
      onRename={() => {}}
      onCancelRename={() => {}}
      onContextMenu={onContextMenu}
      {...overrides}
    />,
  );
  return { onContextMenu };
}

describe("FileRow — touch reachability of the row menu", () => {
  it("renders a More-actions button naming the file", () => {
    renderRow();
    expect(
      screen.getByRole("button", { name: /more actions for report\.pdf/i }),
    ).toBeInTheDocument();
  });

  it("opens the same context menu the right-click path opens", () => {
    const { onContextMenu } = renderRow();
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for report\.pdf/i }),
    );
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    // Anchored to the button's own box, so the menu lands under the control
    // the user actually tapped rather than at the pointer's last position.
    expect(onContextMenu).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("does not select or open the row when the menu button is tapped", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    renderRow({ onSelect, onOpen });
    fireEvent.click(
      screen.getByRole("button", { name: /more actions for report\.pdf/i }),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("marks the trigger as opening a menu for assistive tech", () => {
    renderRow();
    expect(
      screen.getByRole("button", { name: /more actions for report\.pdf/i }),
    ).toHaveAttribute("aria-haspopup", "menu");
  });
});
