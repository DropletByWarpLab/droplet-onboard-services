import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IconPicker, DEVICE_ICONS } from "../IconPicker";

describe("IconPicker", () => {
  it("renders 20 buttons with the correct aria-labels", () => {
    render(<IconPicker value={null} onSelect={() => {}} />);
    const buttons = screen.getAllByRole("radio");
    expect(buttons).toHaveLength(20);
    for (const name of DEVICE_ICONS) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
  });

  it("marks the selected icon with aria-checked and ring-2", () => {
    render(<IconPicker value="Tv" onSelect={() => {}} />);
    const tv = screen.getByLabelText("Tv");
    expect(tv.getAttribute("aria-checked")).toBe("true");
    expect(tv.className).toContain("ring-2");
  });

  it("calls onSelect with the clicked icon name", () => {
    const onSelect = vi.fn();
    render(<IconPicker value={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText("Tv"));
    expect(onSelect).toHaveBeenCalledWith("Tv");
  });

  it("ArrowRight moves focus to the next button", () => {
    render(<IconPicker value={null} onSelect={() => {}} />);
    const tv = screen.getByLabelText("Tv") as HTMLButtonElement;
    tv.focus();
    expect(document.activeElement).toBe(tv);
    fireEvent.keyDown(tv, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByLabelText("Smartphone"));
  });

  it("ArrowDown moves focus 5 buttons ahead (one row)", () => {
    render(<IconPicker value={null} onSelect={() => {}} />);
    const tv = screen.getByLabelText("Tv") as HTMLButtonElement;
    tv.focus();
    fireEvent.keyDown(tv, { key: "ArrowDown" });
    // Index 0 + 5 = index 5 → "Speaker"
    expect(document.activeElement).toBe(screen.getByLabelText("Speaker"));
  });
});
