/**
 * /support — capability gating, URL state, and the states of the three panes
 * (WARP-3528).
 *
 * The page is driven by the orchestrator's explicit `support` capability, never
 * by catching a 404. Its state — queue, desk, open ticket — lives in the URL, so
 * a ticket can be linked (`/support?t=SUP-12`) and back/forward work.
 *
 * ShellPage, the router and the data hooks are stubbed; the real queue rail,
 * list and modals render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: any) => (
    <div className="droplet-shell">
      <h1>{title}</h1>
      {sub ? <p data-testid="sub">{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => React.createElement("a", { href, ...props }, children),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const auth = { role: "owner" };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "ada", displayName: "Ada", role: auth.role }, isLoading: false }),
  authFetch: vi.fn(),
}));

const caps = { current: { projects: true, crm: false, contacts: false, support: true } };
vi.mock("@/lib/hooks/useAppCapabilities", () => ({ useAppCapabilities: () => caps.current }));

const nav = { push: vi.fn(), replace: vi.fn(), search: "" };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/support",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/components/support/TicketWorkspace", () => ({
  TicketWorkspace: (p: any) => (
    <div data-testid="workspace">
      <span>ticket {p.ticketRef}</span>
      <button type="button" onClick={p.onClose}>close it</button>
      <button type="button" onClick={() => p.onSelectTicket("SUP-9")}>other</button>
    </div>
  ),
}));

type Hook = Record<string, any>;
const desksHook: { current: Hook } = { current: {} };
const listHook: { current: Hook } = { current: {} };
const countsHook: { current: unknown } = { current: undefined };
const lastList: { args?: unknown } = {};
const revalidate = vi.fn();
vi.mock("@/components/support/useSupport", async () => {
  const actual = await vi.importActual<typeof import("@/components/support/useSupport")>("@/components/support/useSupport");
  return {
    ...actual,
    useDesks: () => desksHook.current,
    useAgents: () => ({ agents: [{ id: "u-2", displayName: "Bo" }] }),
    useQueueCounts: () => ({ counts: countsHook.current, mutate: vi.fn() }),
    useTicketList: (args: unknown) => {
      lastList.args = args;
      return listHook.current;
    },
    useRevalidateSupport: () => revalidate,
    useContactSearch: () => ({ contacts: [], isLoading: false }),
    supportActions: () => ({}),
  };
});

import SupportPage from "./page";
import { makeDesk, makeSummary } from "@/components/support/support.test-fixtures";

const COUNTS = { unassigned: 3, mine: 1, open: 7, pending: 2, solved_recent: 0, all: 12 };

const desks = (list = [makeDesk()]) => ({ desks: list, error: undefined, isLoading: false, mutate: vi.fn() });
const tickets = (list = [makeSummary()], over: Hook = {}) => ({
  tickets: list,
  total: list.length,
  error: undefined,
  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  loadMore: vi.fn(),
  mutate: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = "owner";
  caps.current = { projects: true, crm: false, contacts: false, support: true };
  nav.search = "";
  desksHook.current = desks();
  listHook.current = tickets();
  countsHook.current = COUNTS;
});

describe("capability gating", () => {
  it("renders the honest 'not enabled' state, and starts no reads, while the module is off", () => {
    caps.current = { ...caps.current, support: false };
    render(<SupportPage />);
    expect(screen.getByText("Support isn't enabled on this Droplet.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Ticket queues" })).toBeNull();
    expect(lastList.args).toBeUndefined();
  });

  it("renders the workspace when the module is on", () => {
    render(<SupportPage />);
    expect(screen.queryByText(/isn't enabled/)).toBeNull();
    expect(screen.getByRole("navigation", { name: "Ticket queues" })).toBeInTheDocument();
    expect(screen.getByText("Printer jams on page two")).toBeInTheDocument();
  });

  it("says how much is open in the page header", () => {
    render(<SupportPage />);
    expect(screen.getByTestId("sub")).toHaveTextContent("7 open · 3 unassigned");
  });
});

describe("URL state", () => {
  it("restores queue, desk and open ticket from the URL", () => {
    desksHook.current = desks([makeDesk(), makeDesk({ id: "desk-2", name: "IT", identifier: "IT" })]);
    nav.search = "queue=mine&desk=desk-2&t=SUP-3";
    render(<SupportPage />);
    expect(lastList.args).toEqual({ deskId: "desk-2", queue: "mine", q: "" });
    expect(screen.getByRole("button", { name: /^Mine/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("workspace")).toHaveTextContent("ticket SUP-3");
    expect((screen.getByRole("combobox", { name: "Service desk" }) as HTMLSelectElement).value).toBe("desk-2");
  });

  it("falls back to the Open queue for an unknown queue and ignores a desk that is not there", () => {
    nav.search = "queue=nonsense&desk=gone";
    render(<SupportPage />);
    expect(lastList.args).toEqual({ deskId: null, queue: "open", q: "" });
  });

  it("writes the ticket to the URL on selection, as a new history entry", () => {
    render(<SupportPage />);
    fireEvent.click(screen.getByRole("button", { name: /SUP-1/ }));
    expect(nav.push).toHaveBeenCalledWith("/support?t=SUP-1", { scroll: false });
  });

  it("removes the ticket from the URL on close, and keeps the rest", () => {
    nav.search = "queue=pending&t=SUP-1";
    render(<SupportPage />);
    fireEvent.click(screen.getByRole("button", { name: "close it" }));
    expect(nav.replace).toHaveBeenCalledWith("/support?queue=pending", { scroll: false });
  });

  it("follows a link from one ticket to another through the URL", () => {
    nav.search = "t=SUP-1";
    render(<SupportPage />);
    fireEvent.click(screen.getByRole("button", { name: "other" }));
    expect(nav.push).toHaveBeenCalledWith("/support?t=SUP-9", { scroll: false });
  });

  it("changing queue clears the open ticket", () => {
    nav.search = "t=SUP-1";
    render(<SupportPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Pending/ }));
    expect(nav.replace).toHaveBeenCalledWith("/support?queue=pending", { scroll: false });
  });

  it("marks the open ticket's row as the current one", () => {
    nav.search = "t=SUP-1";
    render(<SupportPage />);
    expect(screen.getByRole("button", { name: /SUP-1, Printer jams/ })).toHaveAttribute("aria-current", "true");
  });
});

describe("the empty states teach the model", () => {
  it("a box with no desk invites an owner to set one up", () => {
    desksHook.current = desks([]);
    render(<SupportPage />);
    expect(screen.getByText("No service desk yet.")).toBeInTheDocument();
    expect(screen.getByText("A desk is where customers' requests land. Set one up to start.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up a desk" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New ticket" })).toBeNull();
  });

  it("a box with no desk tells a member to ask, with no button", () => {
    auth.role = "family";
    desksHook.current = desks([]);
    render(<SupportPage />);
    expect(screen.getByText("Ask an owner or admin to set one up.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up a desk" })).toBeNull();
  });

  it("an empty desk says customers email you and tickets appear here", () => {
    listHook.current = tickets([]);
    nav.search = "queue=all";
    render(<SupportPage />);
    expect(screen.getByText("No tickets yet.")).toBeInTheDocument();
    expect(screen.getByText("Customers email you; tickets appear here.")).toBeInTheDocument();
  });

  it("each queue has its own empty line", () => {
    listHook.current = tickets([]);
    nav.search = "queue=mine";
    render(<SupportPage />);
    expect(screen.getByText("Nothing is assigned to you.")).toBeInTheDocument();
  });

  it("a search that finds nothing is not the same as an empty queue, and offers to clear", () => {
    listHook.current = tickets([]);
    render(<SupportPage />);
    fireEvent.change(screen.getByLabelText("Search tickets"), { target: { value: "zzz" } });
    expect(screen.getByText("No tickets match that search.")).toBeInTheDocument();
    expect(lastList.args).toEqual({ deskId: null, queue: "open", q: "zzz" });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Nothing open.")).toBeInTheDocument();
  });
});

describe("loading and failing", () => {
  it("shows skeleton rows while the list loads", () => {
    listHook.current = tickets([], { isLoading: true });
    render(<SupportPage />);
    expect(screen.getByLabelText("Loading tickets")).toBeInTheDocument();
  });

  it("says it couldn't load tickets and offers Try again", () => {
    const mutate = vi.fn();
    listHook.current = tickets([], { error: new Error("down"), mutate });
    render(<SupportPage />);
    expect(screen.getByText("Couldn't load tickets.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("says it couldn't load support at all when the desks cannot be read", () => {
    const mutate = vi.fn();
    desksHook.current = { desks: undefined, error: new Error("down"), isLoading: false, mutate };
    render(<SupportPage />);
    expect(screen.getByText("Couldn't load support.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mutate).toHaveBeenCalled();
  });
});

describe("who sees which controls", () => {
  it("gives an owner New ticket, Desk settings and New desk", () => {
    render(<SupportPage />);
    expect(screen.getByRole("button", { name: /New ticket/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desk settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New desk" })).toBeInTheDocument();
  });

  it("gives a member New ticket but no way to set up or change a desk", () => {
    auth.role = "family";
    render(<SupportPage />);
    expect(screen.getByRole("button", { name: /New ticket/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desk settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New desk" })).toBeNull();
  });

  it("opens the new-ticket dialog", () => {
    render(<SupportPage />);
    fireEvent.click(screen.getByRole("button", { name: /New ticket/ }));
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "New ticket" })).toBeInTheDocument();
  });

  it("with several desks and none chosen, edits none and names the desk on each row", () => {
    desksHook.current = desks([makeDesk(), makeDesk({ id: "desk-2", name: "IT", identifier: "IT" })]);
    render(<SupportPage />);
    expect(screen.queryByRole("button", { name: "Desk settings" })).toBeNull();
    const row = screen.getByRole("button", { name: /SUP-1, Printer jams/ });
    expect(within(row).getByText("Support")).toBeInTheDocument();
  });
});
