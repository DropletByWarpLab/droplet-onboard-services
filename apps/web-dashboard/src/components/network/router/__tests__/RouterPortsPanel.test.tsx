/**
 * RouterPortsPanel — WARP-1866.
 *
 * The panel's job is to say only what the backend measured. These tests pin
 * the four render paths apart, and in particular the two that are easy to
 * collapse into each other:
 *
 *   - "we can't reach the router"  (we asked, nobody answered)
 *   - "no port map on this shape"  (we asked, this router has no answer)
 *
 * Neither may render as a faceplate, because a faceplate with every jack dark
 * is a confident claim that the router has no cables in it.
 *
 * The port fixtures are the live RB5009 reading — three linked jacks, five
 * empty ones that report `admin_up: true`, and an SFP cage that reports
 * nothing at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { RouterPort, RouterPortMap } from "@/lib/types/router-ports";
import type { UseRouterPortsResult } from "@/lib/hooks/useRouterPorts";

const useRouterPortsMock = vi.fn();
vi.mock("@/lib/hooks/useRouterPorts", () => ({
  useRouterPorts: () => useRouterPortsMock(),
}));

import { RouterPortsPanel } from "../RouterPortsPanel";

function port(over: Partial<RouterPort> & { id: string }): RouterPort {
  return {
    role: "lan",
    networks: ["lan", "guest"],
    present: true,
    admin_up: true,
    link_up: false,
    speed: null,
    duplex: null,
    mac: null,
    is_sfp: false,
    traffic: null,
    status: "offline",
    ...over,
  };
}

const PORTS: RouterPort[] = [
  port({
    id: "p1", role: "wan", networks: ["wan", "wan6"], link_up: true,
    speed: "2.5 Gb", duplex: "full", status: "online",
    traffic: { rx_bytes: 63507437, tx_bytes: 210377086 },
  }),
  port({
    id: "p2", link_up: true, speed: "1 Gb", duplex: "full", status: "online",
    traffic: { rx_bytes: 24784447, tx_bytes: 22573095 },
  }),
  port({
    id: "p3", link_up: true, speed: "1 Gb", duplex: "full", status: "online",
    traffic: { rx_bytes: 205693124, tx_bytes: 49725610 },
  }),
  // Empty, but administratively up — the trap the whole feature turns on.
  ...["p4", "p5", "p6", "p7", "p8"].map((id) =>
    port({ id, traffic: { rx_bytes: 0, tx_bytes: 0 } }),
  ),
  port({
    id: "sfp", role: "unused", networks: [], present: false, admin_up: null,
    is_sfp: true, status: "absent",
  }),
];

const MAP: RouterPortMap = {
  supported: true,
  detail: null,
  model: "MikroTik RB5009",
  ports: PORTS,
};

function mockHook(over: Partial<UseRouterPortsResult> = {}) {
  useRouterPortsMock.mockReturnValue({
    map: MAP,
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
    ...over,
  });
}

beforeEach(() => {
  useRouterPortsMock.mockReset();
  mockHook();
});

describe("render paths", () => {
  it("shows a skeleton while the first read is in flight", () => {
    mockHook({ map: null, isLoading: true });
    render(<RouterPortsPanel />);
    expect(screen.getByTestId("router-ports-skeleton")).toBeInTheDocument();
  });

  it("says the router is unreachable rather than drawing dark ports", () => {
    mockHook({ map: null, error: new Error("Router ports: 503") });
    render(<RouterPortsPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent(/can't reach the router/i);
    expect(screen.queryByText("p1")).not.toBeInTheDocument();
  });

  it("relays the server's own reason when the shape has no port map", () => {
    mockHook({
      map: {
        supported: false,
        detail: "This router doesn't report a physical port map.",
        model: null,
        ports: [],
      },
    });
    render(<RouterPortsPanel />);
    expect(screen.getByText(/doesn't report a physical port map/i)).toBeInTheDocument();
    expect(screen.queryByText("p1")).not.toBeInTheDocument();
  });

  it("treats supported-but-empty as no port map, not as an all-dark faceplate", () => {
    mockHook({ map: { ...MAP, ports: [] } });
    render(<RouterPortsPanel />);
    expect(screen.getByText(/doesn't report a physical port map/i)).toBeInTheDocument();
  });
});

describe("the port map", () => {
  it("reports the model the board named, not a hardcoded one", () => {
    render(<RouterPortsPanel />);
    expect(screen.getByText("MikroTik RB5009")).toBeInTheDocument();
  });

  it("falls back to a generic name when the board reports no model", () => {
    mockHook({ map: { ...MAP, model: null } });
    render(<RouterPortsPanel />);
    expect(screen.getByText("Edge router")).toBeInTheDocument();
  });

  it("counts LINKED ports, not administratively-up ones", () => {
    // Five of the nine are `admin_up: true` with no cable. A count keyed off
    // admin state would say 8 of 9 and be wrong on a rack you can look at.
    render(<RouterPortsPanel />);
    expect(screen.getByText("3 of 9 ports connected")).toBeInTheDocument();
  });

  it("renders every physical port in the table view", () => {
    render(<RouterPortsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Port table" }));
    for (const p of PORTS) {
      // The cage's label carries a " · SFP" suffix in the same node.
      expect(screen.getByText(p.is_sfp ? `${p.id} · SFP` : p.id)).toBeInTheDocument();
    }
  });

  it("shows speed and traffic only for a port that actually has a link", () => {
    render(<RouterPortsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Port table" }));
    expect(screen.getByText("2.5 Gb")).toBeInTheDocument();
    const p1 = screen.getByText("p1").closest("div.grid") as HTMLElement;
    expect(within(p1).getByText("↓61 MB ↑201 MB")).toBeInTheDocument();
    // p4 is up-but-empty: no speed, and its zero counters are not shown as
    // though the port had been measured carrying nothing.
    const p4 = screen.getByText("p4").closest("div.grid") as HTMLElement;
    expect(within(p4).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(p4).queryByText(/↓/)).not.toBeInTheDocument();
    expect(within(p4).queryByText(/Gb|Mb/)).not.toBeInTheDocument();
  });

  it("labels an empty cage 'no module', never 'open' or 'down'", () => {
    render(<RouterPortsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Port table" }));
    const sfp = screen.getByText("sfp · SFP").closest("div.grid") as HTMLElement;
    expect(within(sfp).getByText("No module")).toBeInTheDocument();
    expect(within(sfp).getByText("no module")).toBeInTheDocument();
    expect(within(sfp).queryByText(/^open$/i)).not.toBeInTheDocument();
    expect(within(sfp).queryByText(/^down$/i)).not.toBeInTheDocument();
  });

  it("distinguishes an empty jack from an unreadable one", () => {
    render(<RouterPortsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Port table" }));
    const p4 = screen.getByText("p4").closest("div.grid") as HTMLElement;
    expect(within(p4).getByText("empty")).toBeInTheDocument();
    const sfp = screen.getByText("sfp · SFP").closest("div.grid") as HTMLElement;
    expect(within(sfp).getByText("no module")).toBeInTheDocument();
  });

  it("names the interfaces a jack carries, including a VLAN riding the bridge", () => {
    render(<RouterPortsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Port table" }));
    const p2 = screen.getByText("p2").closest("div.grid") as HTMLElement;
    expect(within(p2).getByText("lan · guest")).toBeInTheDocument();
    const p1 = screen.getByText("p1").closest("div.grid") as HTMLElement;
    expect(within(p1).getByText("wan · wan6")).toBeInTheDocument();
  });

  it("shows a dash, not an invented network, for a jack nothing claims", () => {
    render(<RouterPortsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Port table" }));
    const sfp = screen.getByText("sfp · SFP").closest("div.grid") as HTMLElement;
    // Both the link and the networks cell read "—": we measured neither.
    expect(within(sfp).getAllByText("—")).toHaveLength(2);
  });

  it("offers no write control — the panel is read-only", () => {
    render(<RouterPortsPanel />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Faceplate", "Port table"]);
  });
});

describe("layout toggle", () => {
  it("starts on the faceplate and switches to the table", () => {
    render(<RouterPortsPanel />);
    const face = screen.getByRole("button", { name: "Faceplate" });
    const table = screen.getByRole("button", { name: "Port table" });
    expect(face).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(table);
    expect(table).toHaveAttribute("aria-pressed", "true");
    expect(face).toHaveAttribute("aria-pressed", "false");
  });
});
