import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Copy, Trash2, Palette } from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

function setup(items: ContextMenuItem[]) {
  const onClose = vi.fn();
  render(
    <>
      <button>opener</button>
      <ContextMenu x={10} y={10} items={items} onClose={onClose} />
    </>
  );
  return { onClose, menu: screen.getByRole("menu") };
}

const basic = (): { items: ContextMenuItem[]; a: () => void; c: () => void } => {
  const a = vi.fn();
  const c = vi.fn();
  return {
    a,
    c,
    items: [
      { label: "Alpha", icon: Copy, onClick: a },
      { label: "Beta", icon: Copy, onClick: vi.fn(), disabled: true },
      { separator: true },
      { label: "Gamma", icon: Trash2, onClick: c, destructive: true },
    ],
  };
};

describe("ContextMenu keyboard", () => {
  it("focuses the first enabled item on open", () => {
    setup(basic().items);
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });

  it("ArrowDown/ArrowUp move between items, skipping disabled ones, and wrap", () => {
    setup(basic().items);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Alpha" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Gamma" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Alpha" }), { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
  });

  it("Home / End jump to the ends", () => {
    setup(basic().items);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Alpha" }), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Gamma" }), { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });

  it("Escape closes; Tab closes", () => {
    const { onClose } = setup(basic().items);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Alpha" }), { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("clicking an item runs it and closes; a disabled item does neither", () => {
    const { items, a } = basic();
    const { onClose } = setup(items);
    fireEvent.click(screen.getByRole("menuitem", { name: "Beta" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(a).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("hands focus back to the opener when it unmounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <ContextMenu x={0} y={0} items={basic().items} onClose={() => {}} />
    );
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe("ContextMenu swatch group", () => {
  const swatchItems = (onPick: (l: string) => void): ContextMenuItem[] => [
    { label: "Open", icon: Copy, onClick: () => {} },
    {
      label: "Color",
      icon: Palette,
      swatches: [
        { label: "No color", onSelect: () => onPick("none") },
        { label: "Red", css: "#f00", onSelect: () => onPick("red") },
        { label: "Blue", css: "#00f", selected: true, onSelect: () => onPick("blue") },
      ],
    },
  ];

  it("is collapsed until opened, and announces its state", () => {
    setup(swatchItems(() => {}));
    const group = screen.getByRole("menuitem", { name: "Color" });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    fireEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
  });

  it("ArrowRight opens it and focuses the currently selected swatch", () => {
    setup(swatchItems(() => {}));
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Open" }), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Color" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Color" }), { key: "ArrowRight" });
    expect(screen.getByRole("menuitemradio", { name: "Blue" })).toHaveFocus();
    expect(screen.getByRole("menuitemradio", { name: "Blue" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("arrows move across swatches; Escape collapses back to the group without closing", () => {
    const { onClose } = setup(swatchItems(() => {}));
    fireEvent.click(screen.getByRole("menuitem", { name: "Color" }));
    const none = screen.getByRole("menuitemradio", { name: "No color" });
    none.focus();
    fireEvent.keyDown(none, { key: "ArrowRight" });
    expect(screen.getByRole("menuitemradio", { name: "Red" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "Red" }), { key: "Escape" });
    expect(screen.getByRole("menuitem", { name: "Color" })).toHaveFocus();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("picking a swatch reports it and closes the menu", () => {
    const picked = vi.fn();
    const { onClose } = setup(swatchItems(picked));
    fireEvent.click(screen.getByRole("menuitem", { name: "Color" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Red" }));
    expect(picked).toHaveBeenCalledWith("red");
    expect(onClose).toHaveBeenCalled();
  });
});
