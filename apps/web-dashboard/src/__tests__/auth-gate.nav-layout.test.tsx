/**
 * WARP-2971 — AuthGate picks the shell from the person's nav layout.
 *
 * Both shells are stubbed to markers (each pulls in a wide provider tree);
 * what is under test is the switch itself and its default. Everything
 * earlier in the gate's ladder — setup, tour, change-password, the loading
 * hold — is pinned by the sibling auth-gate suites and is not repeated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

let pathnameValue = "/";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => pathnameValue,
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
vi.mock("@/components/ModuleRouteGuard", () => ({
  ModuleRouteGuard: ({ children }: { children: React.ReactNode }) => <div data-testid="module-guard">{children}</div>,
}));

const layoutRef = { current: "sidebar" as "sidebar" | "workspace" };
vi.mock("@/lib/nav-layout", () => ({
  useNavLayout: () => ({ layout: layoutRef.current, setLayout: vi.fn() }),
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

beforeEach(() => {
  pathnameValue = "/";
  layoutRef.current = "sidebar";
});

describe("AuthGate — nav layout switch (WARP-2971)", () => {
  it("renders the sidebar shell by default, with the page in <main id=main>", () => {
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByTestId("sidebar-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-shell")).toBeNull();
    const main = document.querySelector("main#main");
    expect(main).not.toBeNull();
    expect(main).toHaveTextContent("page");
  });

  it("renders the Workspace shell — and no sidebar — when chosen", () => {
    layoutRef.current = "workspace";
    render(<AuthGate>page</AuthGate>);
    expect(screen.getByTestId("workspace-shell")).toHaveTextContent("page");
    expect(screen.queryByTestId("sidebar-shell")).toBeNull();
    // The workspace shell owns its own <main>; the gate must not add a second.
    expect(document.querySelector("main#main")).toBeNull();
  });

  it("the takeovers still win over either layout", () => {
    layoutRef.current = "workspace";
    pathnameValue = "/tour";
    // Tour completed → AuthGate redirects; either way no shell renders for
    // the takeover route.
    render(<AuthGate>page</AuthGate>);
    expect(screen.queryByTestId("workspace-shell")).toBeNull();
    expect(screen.queryByTestId("sidebar-shell")).toBeNull();
  });
});

describe("AuthGate — the Security wall has no chrome, but keeps the module guard (WARP-2981)", () => {
  it.each(["sidebar", "workspace"] as const)("on /security/wall with the %s layout: no shell, no <main>, no help — the guard wraps the page", (layout) => {
    layoutRef.current = layout;
    pathnameValue = "/security/wall";
    render(<AuthGate>wall page</AuthGate>);
    expect(screen.queryByTestId("sidebar-shell")).toBeNull();
    expect(screen.queryByTestId("workspace-shell")).toBeNull();
    expect(screen.queryByTestId("help-launcher")).toBeNull();
    expect(document.querySelector("main#main")).toBeNull();
    expect(screen.getByTestId("module-guard")).toHaveTextContent("wall page");
  });

  it("…and /security itself still gets the shell and the help launcher", () => {
    pathnameValue = "/security";
    render(<AuthGate>security page</AuthGate>);
    expect(screen.getByTestId("sidebar-shell")).toBeInTheDocument();
    expect(screen.getByTestId("help-launcher")).toBeInTheDocument();
    expect(document.querySelector("main#main")).toHaveTextContent("security page");
  });
});
