/**
 * WARP-2971 — the Settings control for the navigation layout, and the
 * provider it drives: a radiogroup that persists like the theme, and a hook
 * that answers the default without a provider (AuthGate depends on that).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";

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
    expect(radios).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Sidebar navigation" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("radio", { name: "Workspace tabs navigation" }),
    ).toHaveAttribute("aria-checked", "false");
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

// WARP-3139 — a keyboard person must be able to keep moving through the
// group: focus follows the choice, including when the choice remounts the
// control (AuthGate swaps the shell around the page on every layout change —
// pinned end to end in `auth-gate.nav-layout-focus.test.tsx`). Key handling is
// relative to the radio that received the key, not the checked one.
describe("NavLayoutToggle — focus follows the choice (WARP-3139)", () => {
  const renderToggle = () =>
    render(
      <NavLayoutProvider>
        <NavLayoutToggle />
      </NavLayoutProvider>,
    );
  const radio = (name: string) => screen.getByRole("radio", { name });
  const focusOn = (el: HTMLElement) => act(() => el.focus());
  const expectCheckedAndFocused = (el: HTMLElement) => {
    expect(el).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(el);
    // Roving tabindex: only the checked radio is in the tab order.
    for (const r of screen.getAllByRole("radio")) {
      expect(r.tabIndex).toBe(r === el ? 0 : -1);
    }
  };

  it("arrow keys move focus with the selection", () => {
    renderToggle();
    focusOn(radio("Sidebar navigation"));
    fireEvent.keyDown(radio("Sidebar navigation"), { key: "ArrowRight" });
    expectCheckedAndFocused(radio("Workspace tabs navigation"));
    fireEvent.keyDown(radio("Workspace tabs navigation"), { key: "ArrowLeft" });
    expectCheckedAndFocused(radio("Sidebar navigation"));
  });

  it("Home and End land focus on the first and last radio", () => {
    renderToggle();
    focusOn(radio("Sidebar navigation"));
    fireEvent.keyDown(radio("Sidebar navigation"), { key: "End" });
    expectCheckedAndFocused(screen.getAllByRole("radio").at(-1)!);
    fireEvent.keyDown(screen.getAllByRole("radio").at(-1)!, { key: "Home" });
    expectCheckedAndFocused(screen.getAllByRole("radio")[0]);
  });

  it.each([" ", "Enter"])(
    "%j on a focused, unchecked radio checks that radio and keeps focus there",
    (key) => {
      renderToggle();
      focusOn(radio("Workspace tabs navigation"));
      fireEvent.keyDown(radio("Workspace tabs navigation"), { key });
      expectCheckedAndFocused(radio("Workspace tabs navigation"));
      expect(localStorage.getItem(NAV_LAYOUT_STORAGE_KEY)).toBe("workspace");
    },
  );

  it("a click leaves focus on the clicked radio (Safari does not focus buttons on click)", () => {
    renderToggle();
    fireEvent.click(radio("Workspace tabs navigation"));
    expectCheckedAndFocused(radio("Workspace tabs navigation"));
  });

  it("focus survives the choice remounting the control", () => {
    // Stands in for AuthGate: a different element around the page per layout.
    function RemountOnLayout() {
      const { layout } = useNavLayout();
      return (
        <div key={layout}>
          <NavLayoutToggle />
        </div>
      );
    }
    render(
      <NavLayoutProvider>
        <RemountOnLayout />
      </NavLayoutProvider>,
    );
    const before = radio("Sidebar navigation");
    focusOn(before);
    fireEvent.keyDown(before, { key: "ArrowRight" });
    expect(before.isConnected).toBe(false);
    expectCheckedAndFocused(radio("Workspace tabs navigation"));
  });

  it("does not take focus on a load that adopts a stored layout", () => {
    localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, "workspace");
    renderToggle();
    expect(radio("Workspace tabs navigation")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus when the layout changes from elsewhere", () => {
    function Elsewhere() {
      const { setLayout } = useNavLayout();
      return (
        <button type="button" onClick={() => setLayout("workspace")}>
          elsewhere
        </button>
      );
    }
    render(
      <NavLayoutProvider>
        <NavLayoutToggle />
        <Elsewhere />
      </NavLayoutProvider>,
    );
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    focusOn(elsewhere);
    fireEvent.click(elsewhere);
    expect(radio("Workspace tabs navigation")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(elsewhere);
  });
});
