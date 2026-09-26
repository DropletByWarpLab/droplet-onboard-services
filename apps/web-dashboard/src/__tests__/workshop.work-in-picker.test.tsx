/**
 * WARP-2974 (ADR-056) — the composer's `Work in` chip is a themed menu.
 *
 * It replaced a native `<select>` whose open list the browser painted itself
 * (a light OS list on Windows, over the dark Workshop — Stefan, 2026-09-23).
 *   1. The composer renders no native select or combobox for the choice.
 *   2. The menu lists `No workspace` and the ACTIVE custom tools only, with
 *      exactly the current choice checked.
 *   3. Picking a row reports its id, closes the menu, returns focus.
 *   4. ArrowDown on the chip opens it on the checked row; arrows wrap;
 *      Escape closes and returns focus; a click outside closes it.
 *   5. A chosen workspace that is not active still names itself on the chip —
 *      the chip always says what Start would send.
 *   6. A locked composer cannot open it, and locking closes it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import React, { useState } from "react";

import { WorkInPicker } from "@/components/workshop/WorkInPicker";
import { Composer } from "@/components/workshop/Composer";
import type { WorkspaceSummary } from "@/components/workshop/workspaces/api";

function ws(id: string, name: string, status: string): WorkspaceSummary {
  return {
    id,
    name,
    template: "python-tool",
    status,
    proposedTag: null,
    proposedAt: null,
    createdAt: "2026-09-20T09:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    userId: "u1",
    lastRun: null,
  } as WorkspaceSummary;
}

const WORKSPACES = [ws("ws-a", "Word counter", "active"), ws("ws-p", "Old helper", "proposed"), ws("ws-b", "Booking reminders", "active")];

function Harness({ initial = "", disabled = false, onPick = vi.fn() }: { initial?: string; disabled?: boolean; onPick?: (id: string) => void }) {
  const [id, setId] = useState(initial);
  return (
    <>
      <button type="button">outside</button>
      <WorkInPicker
        workspaces={WORKSPACES}
        workspaceId={id}
        disabled={disabled}
        onWorkspaceId={(next) => {
          onPick(next);
          setId(next);
        }}
      />
    </>
  );
}

const chip = () => screen.getByTestId("workspace-picker");

afterEach(() => cleanup());

describe("Workshop — the Work in menu", () => {
  it("the composer renders no native select for the choice", () => {
    render(<Composer workspaces={WORKSPACES} workspaceId="" onWorkspaceId={() => {}} busy={false} onSubmit={async () => true} />);
    const pill = screen.getByRole("form", { name: "Start a run" });
    expect(pill.querySelector("select")).toBeNull();
    expect(within(pill).queryByRole("combobox")).toBeNull();
    expect(within(pill).getByRole("button", { name: "Work in: No workspace" })).toHaveAttribute("aria-haspopup", "menu");
  });

  it("lists No workspace and the active custom tools only, with the current choice checked", () => {
    render(<Harness initial="ws-b" />);
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip());
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Work in" });
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows.map((r) => r.querySelector(".pick-item-name")?.textContent)).toEqual(["No workspace", "Word counter", "Booking reminders"]);
    expect(rows.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Booking reminders"),
    ]);
    // It lands on the checked row.
    expect(document.activeElement).toBe(rows[2]);
  });

  it("picking a row reports its id, closes the menu and returns focus to the chip", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Word counter/ }));
    expect(onPick).toHaveBeenCalledWith("ws-a");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip()).toHaveAccessibleName("Work in: Word counter");
    expect(document.activeElement).toBe(chip());

    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("menuitemradio", { name: /No workspace/ }));
    expect(onPick).toHaveBeenLastCalledWith("");
    expect(chip()).toHaveAccessibleName("Work in: No workspace");
  });

  it("ArrowDown opens on the checked row, arrows wrap, Escape closes and returns focus", () => {
    render(<Harness initial="ws-a" />);
    chip().focus();
    fireEvent.keyDown(chip(), { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Work in" });
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("a click outside closes the menu", () => {
    render(<Harness />);
    fireEvent.click(chip());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a chosen workspace that is not active still names itself on the chip, and no row is checked", () => {
    render(<Harness initial="ws-p" />);
    expect(chip()).toHaveAccessibleName("Work in: Old helper");
    fireEvent.click(chip());
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows.some((r) => r.textContent?.includes("Old helper"))).toBe(false);
    expect(rows.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("a locked composer cannot open the menu, and locking closes an open one", () => {
    const { rerender } = render(<WorkInPicker workspaces={WORKSPACES} workspaceId="" onWorkspaceId={() => {}} />);
    fireEvent.click(chip());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    rerender(<WorkInPicker workspaces={WORKSPACES} workspaceId="" onWorkspaceId={() => {}} disabled />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip()).toBeDisabled();
    fireEvent.click(chip());
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
