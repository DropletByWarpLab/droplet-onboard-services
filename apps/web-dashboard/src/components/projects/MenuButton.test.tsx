// WARP-3520 — the shared action menu: ARIA menu-button pattern, keyboard model,
// and the Escape contract that keeps a menu inside a drawer from closing the
// drawer with it.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MenuButton, type MenuItemSpec } from "./MenuButton";

function items(over: Partial<Record<string, Partial<MenuItemSpec>>> = {}): MenuItemSpec[] {
  return [
    { id: "archive", label: "Archive", onSelect: vi.fn(), ...over.archive },
    { id: "restore", label: "Restore", onSelect: vi.fn(), ...over.restore },
    { id: "delete", label: "Delete", danger: true, onSelect: vi.fn(), ...over.delete },
  ];
}

describe("MenuButton", () => {
  it("renders a closed trigger that announces a menu", () => {
    render(<MenuButton label="Item actions" items={items()} />);
    const trigger = screen.getByRole("button", { name: "Item actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on click and moves focus to the first item", () => {
    render(<MenuButton label="Item actions" items={items()} />);
    const trigger = screen.getByRole("button", { name: "Item actions" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Archive",
      "Restore",
      "Delete",
    ]);
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
  });

  it("opens with ArrowDown on the trigger", () => {
    render(<MenuButton label="Item actions" items={items()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Item actions" }), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("wraps focus with ArrowDown / ArrowUp and jumps with Home / End", () => {
    render(<MenuButton label="Item actions" items={items()} />);
    fireEvent.click(screen.getByRole("button", { name: "Item actions" }));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Restore" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("runs the chosen action and closes", () => {
    const spec = items();
    render(<MenuButton label="Item actions" items={spec} />);
    fireEvent.click(screen.getByRole("button", { name: "Item actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(spec[2].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape closes, returns focus to the trigger and does NOT reach window (the drawer's own Escape)", () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    try {
      render(<MenuButton label="Item actions" items={items()} />);
      const trigger = screen.getByRole("button", { name: "Item actions" });
      fireEvent.click(trigger);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger).toHaveFocus();
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("closes on a press outside", () => {
    render(
      <div>
        <button type="button">elsewhere</button>
        <MenuButton label="Item actions" items={items()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Item actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("omits hidden entries and renders nothing when every entry is hidden", () => {
    const { rerender, container } = render(
      <MenuButton label="Item actions" items={items({ restore: { hidden: true } })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Item actions" }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Archive", "Delete"]);

    rerender(
      <MenuButton
        label="Item actions"
        items={items({ archive: { hidden: true }, restore: { hidden: true }, delete: { hidden: true } })}
      />,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
