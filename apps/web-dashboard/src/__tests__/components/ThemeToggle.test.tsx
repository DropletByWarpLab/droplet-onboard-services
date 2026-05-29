/**
 * WARP-298 — ThemeToggle radiogroup pattern.
 *
 * The three options (Light / Auto / Dark) form a mutually-exclusive
 * group, so WAI-ARIA's radiogroup pattern fits exactly. The previous
 * implementation rendered three generic <button> elements, which SR
 * users heard as three unrelated controls. Now:
 *   - wrapper has role="radiogroup" + aria-label="Theme"
 *   - each option has role="radio" + aria-checked
 *   - Left/Right arrows move focus + activate the next option
 *   - Home/End jump to first/last option
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

const setThemeMock = vi.fn();
const themeRef = { current: "system" as "light" | "system" | "dark" };
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ theme: themeRef.current, setTheme: setThemeMock }),
}));

import { ThemeToggle } from "@/components/ThemeToggle";

describe("ThemeToggle WAI-ARIA radio group (WARP-298)", () => {
  beforeEach(() => {
    setThemeMock.mockClear();
    themeRef.current = "system";
  });

  it("wraps the options in role='radiogroup' with aria-label='Theme'", () => {
    render(<ThemeToggle />);
    const group = screen.getByRole("radiogroup", { name: /theme/i });
    expect(group).toBeInTheDocument();
  });

  it("renders three role='radio' options with aria-checked tracking the active theme", () => {
    themeRef.current = "dark";
    render(<ThemeToggle />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);

    const light = screen.getByRole("radio", { name: /light theme/i });
    const auto = screen.getByRole("radio", { name: /auto theme/i });
    const dark = screen.getByRole("radio", { name: /dark theme/i });

    expect(light).toHaveAttribute("aria-checked", "false");
    expect(auto).toHaveAttribute("aria-checked", "false");
    expect(dark).toHaveAttribute("aria-checked", "true");
  });

  it("only the active radio carries tabIndex=0; siblings are tabIndex=-1", () => {
    themeRef.current = "light";
    render(<ThemeToggle />);
    const light = screen.getByRole("radio", { name: /light theme/i });
    const auto = screen.getByRole("radio", { name: /auto theme/i });
    const dark = screen.getByRole("radio", { name: /dark theme/i });

    expect(light).toHaveAttribute("tabindex", "0");
    expect(auto).toHaveAttribute("tabindex", "-1");
    expect(dark).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowRight on the active radio activates the next option", () => {
    themeRef.current = "light";
    render(<ThemeToggle />);
    const light = screen.getByRole("radio", { name: /light theme/i });
    fireEvent.keyDown(light, { key: "ArrowRight" });
    expect(setThemeMock).toHaveBeenCalledWith("system");
  });

  it("ArrowLeft on the active radio activates the previous option (wraps)", () => {
    themeRef.current = "light";
    render(<ThemeToggle />);
    const light = screen.getByRole("radio", { name: /light theme/i });
    fireEvent.keyDown(light, { key: "ArrowLeft" });
    // Wraps to last: dark.
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });

  it("Home jumps to first option, End to last", () => {
    themeRef.current = "system";
    render(<ThemeToggle />);
    const auto = screen.getByRole("radio", { name: /auto theme/i });
    fireEvent.keyDown(auto, { key: "Home" });
    expect(setThemeMock).toHaveBeenLastCalledWith("light");

    fireEvent.keyDown(auto, { key: "End" });
    expect(setThemeMock).toHaveBeenLastCalledWith("dark");
  });

  it("click still works (mouse users)", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: /dark theme/i }));
    expect(setThemeMock).toHaveBeenCalledWith("dark");
  });
});
