/**
 * WARP-2971 — the Settings control for the navigation layout, and the
 * provider it drives: a radiogroup that persists like the theme, and a hook
 * that answers the default without a provider (AuthGate depends on that).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";

import { NavLayoutToggle } from "@/components/NavLayoutToggle";
import {
  NAV_LAYOUT_STORAGE_KEY,
  NavLayoutProvider,
  useNavLayout,
} from "@/lib/nav-layout";

beforeEach(() => {
  localStorage.clear();
});

describe("NavLayoutToggle", () => {
  it("is one radiogroup with Sidebar checked by default", () => {
    render(
      <NavLayoutProvider>
        <NavLayoutToggle />
      </NavLayoutProvider>,
    );
    const group = screen.getByRole("radiogroup", { name: "Navigation layout" });
    const radios = screen.getAllByRole("radio");
    expect(group).toContainElement(radios[0]);
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Sidebar navigation" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("radio", { name: "Workspace tabs navigation" }),
    ).toHaveAttribute("aria-checked", "false");
    // WARP-3062 — opt-in: offered, never the default.
    expect(
      screen.getByRole("radio", { name: "Assistant navigation" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("clicking Assistant persists the choice (WARP-3062)", () => {
    render(
      <NavLayoutProvider>
        <NavLayoutToggle />
      </NavLayoutProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Assistant navigation" }));
    expect(
      screen.getByRole("radio", { name: "Assistant navigation" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(NAV_LAYOUT_STORAGE_KEY)).toBe("assistant");
  });

  it("clicking Workspace tabs persists the choice", () => {
    render(
      <NavLayoutProvider>
        <NavLayoutToggle />
      </NavLayoutProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Workspace tabs navigation" }));
    expect(
      screen.getByRole("radio", { name: "Workspace tabs navigation" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(NAV_LAYOUT_STORAGE_KEY)).toBe("workspace");
  });

  it("arrow keys move through the group", () => {
    render(
      <NavLayoutProvider>
        <NavLayoutToggle />
      </NavLayoutProvider>,
    );
    const sidebar = screen.getByRole("radio", { name: "Sidebar navigation" });
    fireEvent.keyDown(sidebar, { key: "ArrowRight" });
    expect(localStorage.getItem(NAV_LAYOUT_STORAGE_KEY)).toBe("workspace");
    fireEvent.keyDown(
      screen.getByRole("radio", { name: "Workspace tabs navigation" }),
      { key: "ArrowRight" },
    );
    expect(localStorage.getItem(NAV_LAYOUT_STORAGE_KEY)).toBe("assistant");
    fireEvent.keyDown(
      screen.getByRole("radio", { name: "Assistant navigation" }),
      { key: "ArrowRight" },
    );
    expect(localStorage.getItem(NAV_LAYOUT_STORAGE_KEY)).toBe("sidebar");
  });
});

describe("NavLayoutProvider / useNavLayout", () => {
  it("adopts a stored choice after mount", () => {
    localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, "workspace");
    const { result } = renderHook(() => useNavLayout(), {
      wrapper: NavLayoutProvider,
    });
    expect(result.current.layout).toBe("workspace");
  });

  it("adopts a stored assistant choice (WARP-3062)", () => {
    localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, "assistant");
    const { result } = renderHook(() => useNavLayout(), {
      wrapper: NavLayoutProvider,
    });
    expect(result.current.layout).toBe("assistant");
  });

  it("ignores a value that is not a layout", () => {
    localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, "carousel");
    const { result } = renderHook(() => useNavLayout(), {
      wrapper: NavLayoutProvider,
    });
    expect(result.current.layout).toBe("sidebar");
  });

  it("answers the default outside a provider instead of throwing", () => {
    const { result } = renderHook(() => useNavLayout());
    expect(result.current.layout).toBe("sidebar");
  });
});
