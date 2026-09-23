/**
 * WARP-2971 — the Workspace navigation shell.
 *
 * What these pin: the three rows render from the URL alone, gates flow
 * through to the DOM, the a11y contract (tablist / aria-current / roving
 * focus), and ⌥N jumps. Data hooks are stubbed the way the Sidebar suites
 * stub them, so the shell's gating is exercised against the same shapes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const pathnameRef = { current: "/" };
const pushMock = vi.fn();
vi.mock("next/navigation", async () => {
  const actual: any = await vi.importActual("next/navigation");
  return {
    ...actual,
    usePathname: () => pathnameRef.current,
    useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  };
});

const roleRef = { current: "owner" as string };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "ada",
      displayName: "Ada Lovelace",
      role: roleRef.current,
    },
    isLoading: false,
    logout: vi.fn(async () => {}),
  }),
}));

vi.mock("@/lib/hooks/useCapabilities", () => ({
  useCapabilities: () => ({ claudeActivity: false, ragEval: false }),
}));
const modulesRef = { current: {} as Record<string, boolean> };
vi.mock("@/lib/hooks/useModuleGate", () => ({
  useModuleGate: () => (id: string) => modulesRef.current[id] !== false,
}));
vi.mock("@/lib/hooks/useIntegrations", () => ({
  useIntegrations: () => ({
    entries: [],
    connected: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
const unreadRef = { current: 0 };
vi.mock("@/lib/hooks/useTeamChat", () => ({
  useTeamChatUnread: () => unreadRef.current,
}));
vi.mock("@/lib/hooks/useBoxAddress", () => ({
  useBoxAddress: () => "droplet.local",
}));
vi.mock("swr", () => ({
  default: () => ({ data: { status: "ok" }, error: undefined, isLoading: false }),
}));

import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

function renderAt(path: string) {
  pathnameRef.current = path;
  return render(
    <WorkspaceShell>
      <div data-testid="page">page</div>
    </WorkspaceShell>,
  );
}

beforeEach(() => {
  pushMock.mockReset();
  roleRef.current = "owner";
  modulesRef.current = {};
  unreadRef.current = 0;
});

describe("WorkspaceShell — structure", () => {
  it("renders no left rail and owns the skip-link target", () => {
    const { container } = renderAt("/");
    expect(screen.queryByLabelText("Primary navigation")).toBeNull();
    const main = container.querySelector("main#main");
    expect(main).not.toBeNull();
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(within(main as HTMLElement).getByTestId("page")).toBeInTheDocument();
  });

  it("renders the six spaces as a tablist, Home selected at /", () => {
    renderAt("/");
    const tablist = screen.getByRole("tablist", { name: "Spaces" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Home",
      "Work",
      "Business",
      "Operations",
      "Intelligence",
      "Admin",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    // Roving tabindex: only the selected tab is in the tab order.
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  });

  it("greets the person by first name, with the box address", () => {
    const { container } = renderAt("/");
    const greet = container.querySelector(".ws-greet") as HTMLElement;
    expect(greet.querySelector("b")).toHaveTextContent(", Ada");
    expect(greet.querySelector(".d")).toHaveTextContent(/^droplet\.local · /);
  });
});

describe("WorkspaceShell — the URL decides the space, the chips and the view", () => {
  it("/files/recents → Work tab, Files chip current, Recent pill current", () => {
    renderAt("/files/recents");
    const tabs = within(screen.getByRole("tablist", { name: "Spaces" })).getAllByRole("tab");
    expect(tabs.find((t) => t.textContent === "Work")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const chips = screen.getByRole("navigation", { name: "Destinations" });
    const files = within(chips).getByRole("link", { name: "Files" });
    expect(files).toHaveAttribute("aria-current", "page");
    expect(within(chips).getByRole("link", { name: "Email" })).not.toHaveAttribute(
      "aria-current",
    );
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(within(views).getByRole("link", { name: "Recent" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // WARP-2966 dropped the "All files" child (its href was the parent's), so
    // the section itself leads the view row instead.
    expect(within(views).getByRole("link", { name: "Files" })).toHaveAttribute(
      "href",
      "/files",
    );
  });

  it("/events → Operations, Events chip current, no Views row", () => {
    renderAt("/events");
    const chips = screen.getByRole("navigation", { name: "Destinations" });
    expect(within(chips).getByRole("link", { name: "Events" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(chips).getByRole("link", { name: "Cameras" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.queryByRole("navigation", { name: "Views" })).toBeNull();
  });

  it("/admin/audit → Admin, Audit log current — Console (exact) is not", () => {
    renderAt("/admin/audit");
    const chips = screen.getByRole("navigation", { name: "Destinations" });
    expect(within(chips).getByRole("link", { name: "Audit log" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(chips).getByRole("link", { name: "Console" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("a route no chip leads to keeps a chip row on screen", () => {
    renderAt("/clips");
    const chips = screen.getByRole("navigation", { name: "Destinations" });
    expect(within(chips).getAllByRole("link").length).toBeGreaterThan(0);
    expect(within(chips).queryByRole("link", { current: "page" })).toBeNull();
  });
});

describe("WorkspaceShell — gates reach the DOM", () => {
  it("a switched-off module removes its chip", () => {
    modulesRef.current = { cameras: false };
    renderAt("/network");
    const chips = screen.getByRole("navigation", { name: "Destinations" });
    expect(within(chips).queryByRole("link", { name: "Cameras" })).toBeNull();
    expect(within(chips).queryByRole("link", { name: "Events" })).toBeNull();
    expect(within(chips).getByRole("link", { name: "Network" })).toBeInTheDocument();
  });

  it("a guest with everything off loses the Business tab", () => {
    roleRef.current = "guest";
    modulesRef.current = new Proxy(
      {},
      { get: () => false },
    ) as Record<string, boolean>;
    renderAt("/");
    const tabs = within(screen.getByRole("tablist", { name: "Spaces" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).not.toContain("Business");
  });

  it("Knowledge and Context are Intelligence chips here (tucked in the sidebar)", () => {
    renderAt("/chat");
    const chips = screen.getByRole("navigation", { name: "Destinations" });
    expect(within(chips).getByRole("link", { name: "Knowledge" })).toBeInTheDocument();
    expect(within(chips).getByRole("link", { name: "Context" })).toBeInTheDocument();
  });

  it("an unread badge shows on the chip and dots its space", () => {
    unreadRef.current = 3;
    renderAt("/");
    const tabs = within(screen.getByRole("tablist", { name: "Spaces" })).getAllByRole("tab");
    const work = tabs.find((t) => t.textContent?.startsWith("Work")) as HTMLElement;
    expect(work.querySelector(".ws-attn")).not.toBeNull();
    const home = tabs[0];
    expect(home.querySelector(".ws-attn")).toBeNull();
    fireEvent.click(work);
    // Space click → first destination of that space.
    expect(pushMock).toHaveBeenCalledWith("/files");
  });
});

describe("WorkspaceShell — keyboard", () => {
  it("⌥N jumps to the Nth space's first destination", () => {
    renderAt("/");
    fireEvent.keyDown(window, { code: "Digit4", altKey: true });
    expect(pushMock).toHaveBeenCalledWith("/cameras");
  });

  it("⌥N is ignored while typing", () => {
    renderAt("/");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { code: "Digit2", altKey: true });
    expect(pushMock).not.toHaveBeenCalled();
    input.remove();
  });

  it("arrow keys rove focus across the space tabs without activating", () => {
    renderAt("/");
    const tabs = within(screen.getByRole("tablist", { name: "Spaces" })).getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    fireEvent.keyDown(tabs[tabs.length - 1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
