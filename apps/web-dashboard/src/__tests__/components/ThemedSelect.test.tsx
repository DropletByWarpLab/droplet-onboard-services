import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Dialog } from "@/components/Dialog";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Options() {
  return <>
    <option value="alpha">Alpha</option>
    <optgroup label="Unavailable" disabled>
      <option value="blocked">Blocked</option>
    </optgroup>
    <optgroup label="Available">
      <option value="bravo">Bravo</option>
      <option value="charlie" disabled>Charlie</option>
      <option value="delta">Delta</option>
    </optgroup>
  </>;
}

function Harness({ onChange = vi.fn(), disabled = false, children = <Options /> }: {
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const [value, setValue] = useState("alpha");
  return <div data-testid="scroller">
    <label htmlFor="choice">Choice</label>
    <ThemedSelect id="choice" value={value} disabled={disabled}
      onChange={(event) => { setValue(event.currentTarget.value); onChange(event); }}>
      {children}
    </ThemedSelect>
    <button type="button">Outside</button>
  </div>;
}

const trigger = () => screen.getByRole("combobox", { name: "Choice" }) as HTMLSelectElement;
const listbox = () => screen.getByRole("listbox", { name: "Choice" });
const option = (name: string) => within(listbox()).getByRole("option", { name });
const active = () => document.activeElement as HTMLElement;

describe("ThemedSelect", () => {
  it("keeps its native label, options and forwarded ref while exposing its themed listbox", () => {
    const ref = createRef<HTMLSelectElement>();
    render(<><label htmlFor="choice">Choice</label>
      <ThemedSelect id="choice" ref={ref} value="alpha" onChange={() => {}}><Options /></ThemedSelect></>);
    expect(ref.current).toBe(trigger());
    expect(trigger()).toBeInstanceOf(HTMLSelectElement);
    expect(Array.from(trigger().options).map((item) => item.value)).toEqual(["alpha", "blocked", "bravo", "charlie", "delta"]);
    ref.current!.focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(option("Alpha")).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", listbox().id);
    expect(active()).toBe(option("Alpha"));
    expect(option("Alpha")).toHaveAttribute("aria-selected", "true");
  });

  it("names a wrapping-label popup from the label without appending option text", () => {
    render(<label>Team
      <ThemedSelect defaultValue="finance"><option value="engineering">Engineering</option>
        <option value="finance">Finance</option></ThemedSelect>
    </label>);
    fireEvent.click(screen.getByRole("combobox"));
    const popup = screen.getByRole("listbox", { name: "Team" });
    expect(popup).toHaveAccessibleName("Team");
    expect(within(popup).getByRole("option", { name: "Finance" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toHaveAccessibleName("Team");
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: "Engineering" })).toHaveAttribute("aria-selected", "true");
  });

  it("lets an explicit accessible label name the popup ahead of its wrapping label", () => {
    render(<label>Team
      <ThemedSelect aria-label="Workspace team" defaultValue="finance">
        <option value="engineering">Engineering</option><option value="finance">Finance</option>
      </ThemedSelect>
    </label>);
    fireEvent.click(screen.getByRole("combobox", { name: "Workspace team" }));
    expect(screen.getByRole("listbox")).toHaveAccessibleName("Workspace team");
  });

  it("emits a real React change event with the select as target and currentTarget", () => {
    let observed: { target: EventTarget; currentTarget: EventTarget; value: string; nativeType: string } | undefined;
    const onChange = vi.fn((event: ChangeEvent<HTMLSelectElement>) => {
      observed = { target: event.target, currentTarget: event.currentTarget, value: event.currentTarget.value, nativeType: event.nativeEvent.type };
    });
    render(<Harness onChange={onChange} />);
    const select = trigger();
    fireEvent.click(select);
    fireEvent.click(option("Delta"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(observed).toEqual({ target: select, currentTarget: select, value: "delta", nativeType: "change" });
    expect(select).toHaveValue("delta");
    expect(select).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(select).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves direct native change-event contracts used by existing forms", () => {
    render(<Harness />);
    fireEvent.change(trigger(), { target: { value: "bravo" } });
    expect(trigger()).toHaveValue("bravo");
    fireEvent.click(trigger());
    expect(option("Bravo")).toHaveAttribute("aria-selected", "true");
  });

  it("retains required validity and named form submission after choosing a value", () => {
    function Form() {
      const [value, setValue] = useState("");
      return <form aria-label="Example form"><label htmlFor="choice">Choice</label>
        <ThemedSelect id="choice" name="choice" required value={value} onChange={(event) => setValue(event.currentTarget.value)}>
          <option value="">Choose a value</option><option value="delta">Delta</option>
        </ThemedSelect></form>;
    }
    render(<Form />);
    const form = screen.getByRole("form", { name: "Example form" }) as HTMLFormElement;
    expect(trigger().validity.valueMissing).toBe(true);
    fireEvent.click(trigger());
    fireEvent.click(option("Delta"));
    expect(trigger().checkValidity()).toBe(true);
    expect(new FormData(form).get("choice")).toBe("delta");
  });

  it("choosing the current value closes without emitting a change", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(option("Alpha"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("reads composite option components and exposes named option groups with visual headings", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    expect(within(listbox()).getAllByRole("option").map((item) => item.textContent)).toEqual(["Alpha", "Blocked", "Bravo", "Charlie", "Delta"]);
    const available = within(listbox()).getByRole("group", { name: "Available" });
    const unavailable = within(listbox()).getByRole("group", { name: "Unavailable" });
    expect(within(available).getAllByRole("option").map((item) => item.textContent)).toEqual(["Bravo", "Charlie", "Delta"]);
    expect(within(unavailable).getAllByRole("option").map((item) => item.textContent)).toEqual(["Blocked"]);
    for (const [group, label] of [[available, "Available"], [unavailable, "Unavailable"]] as const) {
      const heading = within(group).getByText(label);
      expect(heading).toBeVisible();
      expect(heading).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("prevents disabled options and optgroups from changing the value", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    for (const name of ["Blocked", "Charlie"]) {
      expect(option(name)).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(option(name));
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveValue("alpha");
    expect(listbox()).toBeInTheDocument();
  });

  it("does not open a disabled control", () => {
    render(<Harness disabled />);
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open controls inherited as disabled from a fieldset", () => {
    render(<fieldset disabled><Harness /></fieldset>);
    expect(trigger()).toBeDisabled();
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes if the control becomes disabled while its popup is open", () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(trigger());
    rerender(<Harness disabled />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when an ancestor fieldset becomes disabled", () => {
    const { rerender } = render(<fieldset><Harness /></fieldset>);
    fireEvent.click(trigger());
    rerender(<fieldset disabled><Harness /></fieldset>);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes a stale popup when asynchronously refreshed options change", () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(trigger());
    rerender(<Harness><option value="alpha">Alpha</option><option value="delta" disabled>Delta</option></Harness>);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger());
    expect(option("Delta")).toHaveAttribute("aria-disabled", "true");
  });

  it("excludes hidden options and hidden option groups", () => {
    render(<Harness><option value="alpha">Alpha</option><option hidden value="hidden">Hidden option</option>
      <optgroup label="Hidden group" hidden><option value="hidden-group">Hidden group option</option></optgroup>
      <option label="Alternate label" value="delta">Original text</option></Harness>);
    fireEvent.click(trigger());
    expect(within(listbox()).queryByRole("option", { name: "Hidden option" })).toBeNull();
    expect(within(listbox()).queryByRole("option", { name: "Hidden group option" })).toBeNull();
    expect(option("Alternate label")).toBeInTheDocument();
  });

  it("moves actual option focus with arrow navigation, wraps and skips disabled options", () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(active()).toBe(option("Alpha"));
    fireEvent.keyDown(active(), { key: "ArrowUp" });
    expect(active()).toBe(option("Delta"));
    fireEvent.keyDown(active(), { key: "ArrowDown" });
    expect(active()).toBe(option("Alpha"));
    fireEvent.keyDown(active(), { key: "ArrowDown" });
    expect(active()).toBe(option("Bravo"));
    expect(option("Bravo")).toHaveFocus();
    expect(trigger()).toHaveValue("alpha");
    fireEvent.keyDown(active(), { key: "Enter" });
    expect(trigger()).toHaveValue("bravo");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("starts navigation at an enabled boundary when the selected value is disabled", () => {
    render(<ThemedSelect aria-label="Choice" value="blocked" onChange={() => {}}><Options /></ThemedSelect>);
    fireEvent.click(trigger());
    expect(active()).toBe(option("Blocked"));
    fireEvent.keyDown(active(), { key: "ArrowUp" });
    expect(active()).toBe(option("Delta"));
  });

  it("uses Home and End to reach enabled boundaries", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(active(), { key: "End" });
    expect(active()).toBe(option("Delta"));
    fireEvent.keyDown(active(), { key: "Home" });
    expect(active()).toBe(option("Alpha"));
  });

  it("honors End when opening a closed popup", () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: "End" });
    expect(active()).toBe(option("Delta"));
    fireEvent.keyDown(active(), { key: " " });
    expect(trigger()).toHaveValue("delta");
  });

  it("supports typeahead in the open popup and commits with Enter", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(active(), { key: "d" });
    expect(active()).toBe(option("Delta"));
    fireEvent.keyDown(active(), { key: "e" });
    expect(active()).toBe(option("Delta"));
    fireEvent.keyDown(active(), { key: "Enter" });
    expect(trigger()).toHaveValue("delta");
  });

  it("uses the first printable key when opening a closed popup", () => {
    render(<Harness />);
    fireEvent.keyDown(trigger(), { key: "d" });
    expect(active()).toBe(option("Delta"));
    fireEvent.keyDown(active(), { key: "Enter" });
    expect(trigger()).toHaveValue("delta");
  });

  it("cycles repeated typeahead letters and skips disabled matches", () => {
    render(<Harness><option value="alpha">Alpha</option><option value="b1">Bravo</option>
      <option value="blocked" disabled>Blocked</option><option value="b2">Beta</option></Harness>);
    fireEvent.click(trigger());
    fireEvent.keyDown(active(), { key: "b" });
    expect(active()).toBe(option("Bravo"));
    fireEvent.keyDown(active(), { key: "b" });
    expect(active()).toBe(option("Beta"));
    fireEvent.keyDown(active(), { key: "b" });
    expect(active()).toBe(option("Bravo"));
  });

  it.each([false, true])("closes on Tab (shift=%s), restores native focus and permits normal navigation", (shiftKey) => {
    render(<Harness />);
    fireEvent.click(trigger());
    expect(option("Alpha")).toHaveFocus();
    expect(fireEvent.keyDown(active(), { key: "Tab", shiftKey })).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("closes when focus leaves the popup without pulling focus back or committing a choice", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(active(), { key: "ArrowDown" });
    expect(option("Bravo")).toHaveFocus();
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outside).toHaveFocus();
    expect(trigger()).toHaveValue("alpha");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps its popup inside the Dialog and consumes only the first Escape", () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} labelledBy="dialog-title"><h2 id="dialog-title">Example</h2><Harness /></Dialog>);
    fireEvent.click(trigger());
    expect(screen.getByRole("dialog", { name: "Example" })).toContainElement(listbox());
    expect(option("Alpha")).toHaveFocus();
    fireEvent.keyDown(active(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("places the popup above a low trigger and clamps it inside the viewport", () => {
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this instanceof HTMLSelectElement ? rect(950, 650, 160, 40) : rect(0, 0, 240, 200);
    });
    render(<Harness />);
    fireEvent.click(trigger());
    expect(listbox().style.top).toBe("442px");
    expect(listbox().style.left).toBe(`${window.innerWidth - 248}px`);
    expect(listbox().style.maxHeight).toBe("360px");
  });

  it("retains the popup while it scrolls, and closes when an ancestor scrolls", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.scroll(listbox());
    expect(listbox()).toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on outside pointer presses and resize without stealing focus", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outside).toHaveFocus();
    fireEvent.click(trigger());
    fireEvent.resize(window);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("lets a caller cancel opening through its click handler", () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<ThemedSelect aria-label="Choice" value="alpha" onChange={() => {}} onClick={onClick}><Options /></ThemedSelect>);
    fireEvent.click(trigger());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("leaves multiple and sized listboxes using native selection behavior", () => {
    render(<><ThemedSelect aria-label="Multiple" multiple value={["alpha"]} onChange={() => {}}><Options /></ThemedSelect>
      <ThemedSelect aria-label="Sized" size={4} value="alpha" onChange={() => {}}><Options /></ThemedSelect></>);
    for (const name of ["Multiple", "Sized"]) {
      const select = screen.getByRole("listbox", { name });
      expect(select).not.toHaveClass("themed-select");
      fireEvent.click(select);
    }
    expect(document.querySelector(".themed-select-popup")).toBeNull();
  });
});
