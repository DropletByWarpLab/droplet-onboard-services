import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState, type ChangeEvent, type InputHTMLAttributes } from "react";
import { Dialog } from "@/components/Dialog";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Harness({ initial = "2026-05-12", onChange = vi.fn(), ...props }: {
  initial?: string; type?: "date" | "datetime-local";
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "type" | "onChange">) {
  const [value, setValue] = useState(initial);
  return <><ThemedDateInput aria-label="Appointment date" {...props} value={value}
    onChange={(event) => { setValue(event.currentTarget.value); onChange(event); }} />
    <button type="button">Outside</button></>;
}

const input = () => screen.getByLabelText("Appointment date", { selector: "input" }) as HTMLInputElement;
const open = () => fireEvent.click(screen.getByRole("button", { name: "Choose Appointment date" }));
const popup = () => screen.getByRole("dialog", { name: "Choose Appointment date" });
const day = (date: string) => popup().querySelector<HTMLButtonElement>(`[data-date="${date}"]`)!;
const active = () => document.activeElement as HTMLButtonElement;

describe("ThemedDateInput", () => {
  it("retains the native input/ref/layout attributes and manual change contract", () => {
    const ref = createRef<HTMLInputElement>(); const change = vi.fn();
    render(<label>Appointment date<ThemedDateInput ref={ref} defaultValue="2026-05-12" name="day"
      className="flex-1 w-full px-3" style={{ maxWidth: 240 }} onChange={change} /></label>);
    expect(ref.current).toBe(input());
    expect(input()).toHaveAttribute("type", "date");
    expect(input()).toHaveClass("flex-1", "w-full", "px-3");
    expect(input().parentElement).toHaveClass("flex-1", "w-full");
    expect(input().parentElement).not.toHaveClass("px-3");
    expect(input().parentElement).toHaveStyle({ maxWidth: "240px" });
    fireEvent.change(input(), { target: { value: "2026-06-01" } });
    expect(input()).toHaveValue("2026-06-01");
    expect(change).toHaveBeenCalledTimes(1);
    open();
    expect(day("2026-06-01")).toHaveFocus();
  });

  it("dispatches one genuine React change with the native input as target/currentTarget", () => {
    let observed: { target: EventTarget; currentTarget: EventTarget; value: string } | undefined;
    const change = vi.fn((event: ChangeEvent<HTMLInputElement>) => {
      observed = { target: event.target, currentTarget: event.currentTarget, value: event.currentTarget.value };
    });
    render(<Harness onChange={change} />); const field = input();
    open(); expect(day("2026-05-12")).toHaveFocus();
    expect(day("2026-05-12").closest('[role="gridcell"]')).toHaveAttribute("aria-selected", "true");
    fireEvent.click(day("2026-05-15"));
    expect(change).toHaveBeenCalledTimes(1);
    expect(observed).toEqual({ target: field, currentTarget: field, value: "2026-05-15" });
    expect(field).toHaveValue("2026-05-15"); expect(field).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps form submission, required validity, and clearing on the native input", () => {
    render(<form aria-label="Booking"><ThemedDateInput aria-label="Appointment date" name="appointment" required defaultValue="2026-05-12" /></form>);
    open(); fireEvent.click(day("2026-05-15"));
    const form = screen.getByRole("form", { name: "Booking" }) as HTMLFormElement;
    expect(new FormData(form).get("appointment")).toBe("2026-05-15");
    expect(input().checkValidity()).toBe(true);
    open(); fireEvent.click(within(popup()).getByRole("button", { name: "Clear" }));
    expect(input()).toHaveValue(""); expect(input().validity.valueMissing).toBe(true);
  });

  it("does not emit a change when rechoosing the current date", () => {
    const change = vi.fn(); render(<Harness onChange={change} />);
    open(); fireEvent.click(day("2026-05-12"));
    expect(change).not.toHaveBeenCalled(); expect(input()).toHaveFocus();
  });

  it("preserves datetime minutes, seconds and fractional seconds while changing the date", () => {
    render(<Harness type="datetime-local" initial="2026-05-12T14:37:22.125" step="0.001" />);
    open(); fireEvent.click(day("2026-05-15"));
    expect(input()).toHaveValue("2026-05-15T14:37:22.125"); expect(input()).toHaveAttribute("step", "0.001");
  });

  it("uses a valid boundary time for a blank datetime, otherwise 09:00", () => {
    render(<Harness type="datetime-local" initial="" min="2026-05-12T14:37:22" max="2026-05-20T17:00" />);
    open(); expect(day("2026-05-12")).not.toHaveAttribute("aria-disabled", "true");
    const boundary = document.createElement("input"); boundary.type = "datetime-local"; boundary.value = "2026-05-12T14:37:22";
    fireEvent.click(day("2026-05-12")); expect(input()).toHaveValue(boundary.value);
    cleanup(); render(<Harness type="datetime-local" initial="" min="2026-05-12T14:00" max="2026-05-20T17:00" />);
    open(); fireEvent.click(day("2026-05-15")); expect(input()).toHaveValue("2026-05-15T09:00");
  });

  it("marks dates outside min/max and the native date step unavailable, with bounded month controls", () => {
    const change = vi.fn(); render(<Harness min="2026-05-12" max="2026-05-20" step={2} onChange={change} />);
    open();
    for (const key of ["2026-05-11", "2026-05-13", "2026-05-21"]) {
      expect(day(key)).toHaveAttribute("aria-disabled", "true"); fireEvent.click(day(key));
    }
    expect(change).not.toHaveBeenCalled();
    expect(within(popup()).getByRole("button", { name: "Previous month" })).toBeDisabled();
    expect(within(popup()).getByRole("button", { name: "Next month" })).toBeDisabled();
    const month = within(popup()).getByRole("combobox", { name: "Month" }) as HTMLSelectElement;
    expect(month.options[3].disabled).toBe(true); expect(month.options[4].disabled).toBe(false);
    fireEvent.click(day("2026-05-14")); expect(input()).toHaveValue("2026-05-14");
  });

  it("compares datetime bounds with equivalent omitted zero seconds correctly", () => {
    render(<Harness type="datetime-local" initial="2026-05-12T13:00" min="2026-05-12T13:00:00" max="2026-05-20T13:00:00" />);
    open(); expect(day("2026-05-12")).not.toHaveAttribute("aria-disabled", "true");
  });

  it("moves day/week/month/year focus with calendar keys without changing the value", () => {
    render(<Harness />); open();
    fireEvent.keyDown(active(), { key: "ArrowRight" }); expect(active()).toBe(day("2026-05-13"));
    fireEvent.keyDown(active(), { key: "ArrowDown" }); expect(active()).toBe(day("2026-05-20"));
    fireEvent.keyDown(active(), { key: "Home" }); expect(active()).toBe(day("2026-05-17"));
    fireEvent.keyDown(active(), { key: "End" }); expect(active()).toBe(day("2026-05-23"));
    fireEvent.keyDown(active(), { key: "PageDown" }); expect(active()).toBe(day("2026-06-23"));
    fireEvent.keyDown(active(), { key: "PageUp", shiftKey: true }); expect(active()).toBe(day("2025-06-23"));
    expect(input()).toHaveValue("2026-05-12");
    fireEvent.click(active()); expect(input()).toHaveValue("2025-06-23");
  });

  it("supports month and year jumps while keeping end-of-month dates valid", () => {
    render(<Harness initial="2024-01-31" />); open();
    fireEvent.change(within(popup()).getByRole("combobox", { name: "Month" }), { target: { value: "1" } });
    expect(active()).toBe(day("2024-02-29"));
    fireEvent.change(within(popup()).getByRole("combobox", { name: "Year" }), { target: { value: "2025" } });
    expect(active()).toBe(day("2025-02-28"));
    fireEvent.click(active()); expect(input()).toHaveValue("2025-02-28");
  });

  it.each(["disabled", "readOnly", "fieldset"] as const)("does not open a %s control", (kind) => {
    render(<fieldset disabled={kind === "fieldset"}><Harness disabled={kind === "disabled"} readOnly={kind === "readOnly"} /></fieldset>);
    open(); fireEvent.keyDown(input(), { key: "Enter" }); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("defers blur-driven commits inside the popup, restores input after picking, and commits on real blur", () => {
    const blur = vi.fn(); render(<Harness onBlur={blur} />); act(() => input().focus()); open();
    expect(blur).not.toHaveBeenCalled();
    fireEvent.click(day("2026-05-15")); expect(blur).not.toHaveBeenCalled(); expect(input()).toHaveFocus();
    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("forwards one native blur with the input as target when focus leaves an open popup", () => {
    let observed: EventTarget | null = null; const blur = vi.fn((event) => { observed = event.currentTarget; });
    render(<Harness onBlur={blur} />); open();
    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    expect(blur).toHaveBeenCalledTimes(1); expect(observed).toBe(input());
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("closes only the calendar on Escape inside a modal and restores input focus", () => {
    const close = vi.fn(); render(<Dialog open onClose={close} labelledBy="heading"><h2 id="heading">Booking</h2><Harness /></Dialog>);
    open(); expect(popup().closest('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    fireEvent.keyDown(active(), { key: "Escape" }); expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Choose Appointment date" })).toBeNull(); expect(input()).toHaveFocus();
  });

  it("lets caller keyboard hooks handle Enter before opening and keeps native segment arrows untouched", () => {
    const keys = vi.fn((event) => { if (event.key === "Enter") event.preventDefault(); });
    render(<Harness onKeyDown={keys} />);
    fireEvent.keyDown(input(), { key: "Enter" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(keys).toHaveBeenCalledTimes(1);
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    act(() => input().dispatchEvent(event)); expect(event.defaultPrevented).toBe(false);
    fireEvent.keyDown(input(), { key: "ArrowDown", altKey: true }); expect(popup()).toBeInTheDocument();
  });

  it("exits from the last popup control on Tab without preventing the browser's next focus step", () => {
    render(<Harness />); open(); const done = within(popup()).getByRole("button", { name: "Done" }); act(() => done.focus());
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => done.dispatchEvent(event)); expect(event.defaultPrevented).toBe(false);
    expect(input()).toHaveFocus(); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on outside pointer/scroll and preserves values", () => {
    render(<Harness />); open(); fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(input()).toHaveValue("2026-05-12");
    open(); fireEvent.scroll(window); expect(screen.queryByRole("dialog")).toBeNull();
  });
});
