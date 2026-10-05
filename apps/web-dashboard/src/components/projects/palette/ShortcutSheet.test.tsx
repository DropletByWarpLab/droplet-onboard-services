/**
 * WARP-3537 — the `?` sheet. "Every shortcut has a test and is listed on the `?` sheet":
 * the sheet is drawn from the registry the handler matches against, so this walks the
 * registry and finds each entry on the page.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { ShortcutSheet } from "./ShortcutSheet";
import { SHORTCUTS } from "./shortcuts";

describe("ShortcutSheet", () => {
  it("renders nothing while closed", () => {
    render(<ShortcutSheet open={false} readOnly={false} onClose={() => undefined} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a dialog called 'Keyboard shortcuts'", () => {
    render(<ShortcutSheet open readOnly={false} onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("lists EVERY shortcut in the registry — its keys and what it does — for a person who can write", () => {
    render(<ShortcutSheet open readOnly={false} onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    for (const s of SHORTCUTS) {
      expect(within(dialog).getByText(s.label), s.id).toBeInTheDocument();
      for (const k of s.keys) expect(within(dialog).getAllByText(k).length, `${s.id} ${k}`).toBeGreaterThan(0);
    }
  });

  it("groups them: those that work anywhere, and those that work in the table", () => {
    render(<ShortcutSheet open readOnly={false} onClose={() => undefined} />);
    const anywhere = screen.getByRole("region", { name: "Anywhere" });
    const table = screen.getByRole("region", { name: "In the table" });
    expect(within(anywhere).getByText("Open the command palette")).toBeInTheDocument();
    expect(within(table).getByText("Move to the next row")).toBeInTheDocument();
  });

  it("shows a reader only what works for them — no create, edit, assign, state or priority", () => {
    render(<ShortcutSheet open readOnly onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    for (const s of SHORTCUTS) {
      if (s.write) expect(within(dialog).queryByText(s.label), s.id).toBeNull();
      else expect(within(dialog).getByText(s.label), s.id).toBeInTheDocument();
    }
  });

  it("says why ? is not Help here", () => {
    render(<ShortcutSheet open readOnly={false} onClose={() => undefined} />);
    expect(screen.getByText(/Elsewhere in Droplet/)).toBeInTheDocument();
  });

  it("closes on the Close button and on Escape", () => {
    const onClose = vi.fn();
    render(<ShortcutSheet open readOnly={false} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
