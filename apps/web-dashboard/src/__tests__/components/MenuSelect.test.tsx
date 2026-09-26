/**
 * WARP-3043 — MenuSelect: the themed stand-in for a native <select> on /chat's
 * popovers and cards (Memory, Context pins, the interview's review card). The
 * browser paints a select's open list itself, outside every token; this is the
 * menu-button pattern over components/ui/pick-menu.css instead.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { MenuSelect, type MenuSelectOption } from "@/components/ui/MenuSelect";

type Audience = "family" | "admin" | "owner";
const OPTIONS: MenuSelectOption<Audience>[] = [
  { value: "family", label: "Everyone here" },
  { value: "admin", label: "Admins only" },
  { value: "owner", label: "Owner only", disabled: true },
];

function Harness({ onChange = vi.fn(), disabled = false }: { onChange?: (v: Audience) => void; disabled?: boolean }) {
  const [value, setValue] = useState<Audience>("family");
  return (
    <div data-testid="scroller">
      <MenuSelect
        label="Audience"
        value={value}
        options={OPTIONS}
        disabled={disabled}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: /^Audience:/ });

describe("MenuSelect (WARP-3043)", () => {
  it("is a menu button naming its value, never a native select", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector("select")).toBeNull();
    expect(trigger()).toHaveAccessibleName("Audience: Everyone here");
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveTextContent("Everyone here");
  });

  it("opens radio items with exactly one checked, and focuses it", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const menu = screen.getByRole("menu", { name: "Audience" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Everyone here", "Admins only", "Owner only"]);
    expect(items.filter((i) => i.getAttribute("aria-checked") === "true")).toEqual([items[0]]);
    expect(document.activeElement).toBe(items[0]);
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("picking an item reports it, closes, and returns focus to the trigger", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Admins only" }));
    expect(onChange).toHaveBeenCalledWith("admin");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger()).toHaveAccessibleName("Audience: Admins only");
    expect(document.activeElement).toBe(trigger());
  });

  it("picking the current value closes without reporting a change, as a select", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Everyone here" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a disabled option is shown but cannot be picked", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    const owner = screen.getByRole("menuitemradio", { name: "Owner only" });
    expect(owner).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(owner);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("arrow keys wrap and Escape closes back onto the trigger", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  // It lives inside scrolling popovers (Memory's fact list) and the message
  // scroller, which would clip an absolutely placed list: it is fixed, placed
  // from the trigger's box, and a scroll that moves the trigger closes it.
  it("places itself fixed and closes when an ancestor scrolls", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-placement", "fixed");
    expect(menu.style.top).not.toBe("");
    expect(menu.style.left).not.toBe("");
    // A scroll inside the menu itself keeps it open.
    fireEvent.scroll(menu);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a disabled control does not open", () => {
    render(<Harness disabled />);
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
