/**
 * WARP-3139 — the Settings navigation toggle keeps keyboard focus across
 * AuthGate's shell swap.
 *
 * AuthGate wraps the page in a different element per layout (`<main id=main>`
 * beside the Sidebar, or the Workspace shell), so choosing a layout remounts
 * the whole Settings page — the focused radio is removed and focus fell to
 * <body> on every arrow press. The sibling `auth-gate.nav-layout` suite mocks
 * the layout hook, so it can never see that remount; this one runs the REAL
 * provider, gate and toggle together. Only the shells' own chrome and the
 * gate's other dependencies are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/settings",
}));

vi.mock("@/components/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-shell" />,
}));
vi.mock("@/components/workspace/WorkspaceShell", () => ({
  WorkspaceShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="workspace-shell">{children}</div>
  ),
}));
vi.mock("@/components/help/HelpLauncher", () => ({
  HelpLauncher: () => <div data-testid="help-launcher" />,
}));
vi.mock("@/lib/hooks/useSecurity", () => ({
  WallModulesKeeper: () => <div data-testid="wall-modules-keeper" />,
}));
vi.mock("@/components/ModuleRouteGuard", () => ({
  ModuleRouteGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" },
    isLoading: false,
    setupState: { appliance: "ready", setupStep: "done", userTourCompleted: true },
    setupProbeError: null,
    setupAutoRetrying: false,
    retrySetupProbe: vi.fn(),
  }),
}));

import { AuthGate } from "@/components/AuthGate";
import { NavLayoutToggle } from "@/components/NavLayoutToggle";
import { NAV_LAYOUT_STORAGE_KEY, NavLayoutProvider } from "@/lib/nav-layout";

beforeEach(() => {
  localStorage.clear();
});

const renderSettings = () =>
  render(
    <NavLayoutProvider>
      <AuthGate>
        <NavLayoutToggle />
      </AuthGate>
    </NavLayoutProvider>,
  );
const radio = (name: string) => screen.getByRole("radio", { name });
const focusOn = (el: HTMLElement) => act(() => el.focus());
const expectCheckedAndFocused = (el: HTMLElement) => {
  expect(el).toHaveAttribute("aria-checked", "true");
  expect(document.activeElement).toBe(el);
};
const expectSidebarShell = () => {
  expect(screen.getByTestId("sidebar-shell")).toBeInTheDocument();
  expect(document.querySelector("main#main")).not.toBeNull();
};

describe("AuthGate + NavLayoutToggle — focus across the shell swap (WARP-3139)", () => {
  it("a keyboard person can keep moving: arrows swap the shell and focus follows", () => {
    renderSettings();
    expectSidebarShell();
    const sidebar = radio("Sidebar navigation");
    focusOn(sidebar);

    fireEvent.keyDown(sidebar, { key: "ArrowRight" });
    expect(screen.getByTestId("workspace-shell")).toBeInTheDocument();
    expect(document.querySelector("main#main")).toBeNull();
    // The shell swap remounted the page: the radio that had focus is gone.
    expect(sidebar.isConnected).toBe(false);
    const workspace = radio("Workspace tabs navigation");
    expectCheckedAndFocused(workspace);

    fireEvent.keyDown(workspace, { key: "ArrowLeft" });
    expectSidebarShell();
    expect(workspace.isConnected).toBe(false);
    expectCheckedAndFocused(radio("Sidebar navigation"));
  });

  it("End and Home land focus on the last and first radio across the swap", () => {
    renderSettings();
    const first = radio("Sidebar navigation");
    focusOn(first);

    fireEvent.keyDown(first, { key: "End" });
    expect(first.isConnected).toBe(false);
    const last = screen.getAllByRole("radio").at(-1)!;
    expectCheckedAndFocused(last);

    fireEvent.keyDown(last, { key: "Home" });
    expectSidebarShell();
    expect(last.isConnected).toBe(false);
    expectCheckedAndFocused(screen.getAllByRole("radio")[0]);
  });

  it.each([" ", "Enter"])(
    "%j on a focused, unchecked radio chooses it and focus stays on it across the swap",
    (key) => {
      renderSettings();
      const workspace = radio("Workspace tabs navigation");
      focusOn(workspace);

      fireEvent.keyDown(workspace, { key });
      expect(screen.getByTestId("workspace-shell")).toBeInTheDocument();
      expect(workspace.isConnected).toBe(false);
      expectCheckedAndFocused(radio("Workspace tabs navigation"));
    },
  );

  it("a click across the swap leaves focus on the clicked radio", () => {
    renderSettings();
    const workspace = radio("Workspace tabs navigation");

    fireEvent.click(workspace);
    expect(screen.getByTestId("workspace-shell")).toBeInTheDocument();
    expect(workspace.isConnected).toBe(false);
    expectCheckedAndFocused(radio("Workspace tabs navigation"));
  });

  it("a load that adopts a stored layout swaps the shell without taking focus", () => {
    localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, "workspace");
    renderSettings();
    expect(screen.getByTestId("workspace-shell")).toBeInTheDocument();
    expect(radio("Workspace tabs navigation")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(document.body);
  });
});
