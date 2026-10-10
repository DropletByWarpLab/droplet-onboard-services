/**
 * TopologyPanel — the render paths and the access-point card.
 *
 * Where each cable hangs is the model's business (topology-model.test.ts);
 * this file pins what the panel does with the answer: which state it draws
 * (skeleton / unavailable / tree), that the tree is a labelled nested list, and
 * that an access point shows its live wireless client count — or, when its
 * radios don't answer, says exactly that and shows no number.
 *
 * The four data hooks and RBAC are mocked, the way RouterPortsPanel.test.tsx
 * does it, so the panel renders against deterministic reads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ApDeviceInfo } from "@/lib/types";
import type { ApWirelessDetail } from "@/lib/api";
import type { RouterPort, RouterPortMap } from "@/lib/types/router-ports";
import type { SwitchPort, SwitchStatus } from "@/lib/types/switch";

const useRouterPortsMock = vi.fn();
vi.mock("@/lib/hooks/useRouterPorts", () => ({
  useRouterPorts: () => useRouterPortsMock(),
}));

const useSwitchMock = vi.fn();
vi.mock("@/lib/hooks/useSwitch", () => ({
  useSwitch: () => useSwitchMock(),
}));

const useCoverageApsMock = vi.fn();
const useApRadiosMock = vi.fn();
vi.mock("@/lib/hooks/useCoverageAps", () => ({
  useCoverageAps: (opts?: unknown) => useCoverageApsMock(opts),
  useApRadios: (mac: string, enabled: boolean) => useApRadiosMock(mac, enabled),
}));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));

import { TopologyPanel } from "../TopologyPanel";

// ── Fixtures: the lab fabric ──────────────────────────────────────────

function jack(over: Partial<RouterPort> & { id: string }): RouterPort {
  return {
    role: "lan",
    networks: ["lan"],
    present: true,
    admin_up: true,
    link_up: false,
    speed: null,
    duplex: null,
    mac: null,
    is_sfp: false,
    traffic: null,
    status: "offline",
    disable_guard: null,
    ...over,
  };
}

const MAP: RouterPortMap = {
  supported: true,
  detail: null,
  model: "MikroTik RB5009",
  ports: [
    jack({ id: "p1", role: "wan", networks: ["wan"], link_up: true, speed: "2.5 Gb", status: "online" }),
    jack({ id: "p2", link_up: true, speed: "1 Gb", status: "online" }),
    ...["p3", "p4", "p5", "p6", "p7", "p8"].map((id) => jack({ id })),
  ],
};

const STATUS: SwitchStatus = {
  connected: true,
  model: "Zyxel GS1900-10HP",
  firmware: "v2.80",
  auto_managed: true,
  vlan_profile: "flat-lan",
  last_provisioned_at: null,
  protected_port: 1,
  poe_budget_w: 77,
  poe_used_w: 14.2,
  poe_ports_active: 3,
};

function swPort(port: number, role: SwitchPort["role"], over: Partial<SwitchPort> = {}): SwitchPort {
  return {
    port,
    label: `1/${port}`,
    name: null,
    role,
    link_up: true,
    speed: "1 Gb",
    is_sfp: false,
    vlan: 1,
    vlan_name: "LAN",
    poe: null,
    status: "online",
    ...over,
  };
}

const poe = (power_w: number) => ({ delivering: true, power_w, class: 4, max_power_w: 30 });

const PORTS: SwitchPort[] = [
  swPort(1, "uplink"),
  swPort(2, "ap", { poe: poe(6.2) }),
  swPort(3, "camera", { poe: poe(4) }),
  swPort(4, "client"),
];

const AP: ApDeviceInfo = {
  mac: "80:ea:0b:39:ae:23",
  displayName: "Office AP",
  model: "NWA50BE",
  serial: null,
  version: null,
  lastIp: "192.168.9.20",
  hostname: null,
  status: "ONLINE",
  backend: "DROPLET_IMAGE",
  vendor: null,
  failureReason: null,
  approvedSsid: null,
  firstSeen: "2026-08-01T10:00:00Z",
  lastSeen: "2026-10-09T10:00:00Z",
  approvedAt: null,
  approvedBy: null,
  decommissionedAt: null,
  lastOperationId: null,
};

function radio(over: Partial<ApWirelessDetail["radios"][number]>): ApWirelessDetail["radios"][number] {
  return {
    section: "radio0",
    radio: "radio0",
    band: "2g",
    ssid: "Office",
    encryption: "psk2",
    channel: "auto",
    htmode: "HE20",
    disabled: false,
    primary: true,
    ifname: "phy0-ap0",
    up: true,
    live_channel: 6,
    live_htmode: "HE20",
    clients: 0,
    ...over,
  };
}

const DETAIL: ApWirelessDetail = {
  mac: AP.mac,
  supported: true,
  radios: [radio({ clients: 11 }), radio({ section: "radio1", band: "5g", clients: 15 })],
};

function mockReads(over: {
  router?: object;
  switch?: object;
  aps?: object;
  radios?: object;
  role?: string;
} = {}) {
  useRouterPortsMock.mockReturnValue({
    map: MAP,
    isLoading: false,
    error: undefined,
    refresh: vi.fn(),
    setPortEnabled: vi.fn(),
    ...over.router,
  });
  useSwitchMock.mockReturnValue({
    status: STATUS,
    ports: PORTS,
    vlans: [],
    isLoading: false,
    error: undefined,
    portsLoading: false,
    portsError: undefined,
    connected: true,
    ...over.switch,
  });
  useCoverageApsMock.mockReturnValue({ aps: [AP], isLoading: false, error: undefined, ...over.aps });
  useApRadiosMock.mockReturnValue({ detail: DETAIL, error: undefined, ...over.radios });
  useAuthMock.mockReturnValue({ user: { id: "u1", username: "ada", displayName: "Ada", role: over.role ?? "owner" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReads();
});

// ── Render paths ──────────────────────────────────────────────────────

describe("render paths", () => {
  it("shows a skeleton while the router's first read is in flight", () => {
    mockReads({ router: { map: null, isLoading: true } });
    render(<TopologyPanel />);

    expect(screen.getByTestId("topology-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("holds the skeleton until the switch and AP list have answered once", () => {
    mockReads({ switch: { status: null, isLoading: true, connected: false } });
    const { rerender } = render(<TopologyPanel />);
    expect(screen.getByTestId("topology-skeleton")).toBeInTheDocument();

    mockReads({ aps: { aps: [], isLoading: true } });
    rerender(<TopologyPanel />);
    expect(screen.getByTestId("topology-skeleton")).toBeInTheDocument();
    // Neither draws a half-built tree whose router cables would move.
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("holds the skeleton while the switch's ports are still on their way", () => {
    // Status and ports are two reads. With status in and ports not, the tree
    // would read "No ports reported" and then re-hang every cable.
    mockReads({ switch: { ports: [], portsLoading: true } });
    render(<TopologyPanel />);

    expect(screen.getByTestId("topology-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("No ports reported")).not.toBeInTheDocument();
  });

  it("says so when the switch's ports can't be read, rather than calling that 'no ports'", () => {
    mockReads({ switch: { ports: [], portsError: new Error("Switch ports: 502") } });
    render(<TopologyPanel />);

    expect(screen.queryByTestId("topology-skeleton")).not.toBeInTheDocument();
    expect(screen.getByText("Ports unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No ports reported")).not.toBeInTheDocument();
    expect(
      screen.getByText("We couldn't read the switch's ports, so what's plugged into it isn't shown."),
    ).toBeInTheDocument();
  });

  it("says the topology is unavailable, quietly, when the router read fails", () => {
    mockReads({ router: { map: null, error: new Error("Router ports: 503") } });
    render(<TopologyPanel />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Topology unavailable — router not reporting its ports",
    );
    // Not an alert: the port map below already raises the alarm.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("gives the server's reason when the router shape has no port map", () => {
    mockReads({
      router: { map: { supported: false, detail: "This router shape has no physical port map.", model: null, ports: [] } },
    });
    render(<TopologyPanel />);

    expect(screen.getByRole("status")).toHaveTextContent("Topology unavailable");
    expect(screen.getByText("This router shape has no physical port map.")).toBeInTheDocument();
  });

  it("is labelled like its sibling port maps", () => {
    render(<TopologyPanel />);

    expect(screen.getByRole("heading", { name: "Topology", level: 4 })).toBeInTheDocument();
  });
});

// ── The tree ──────────────────────────────────────────────────────────

describe("the tree", () => {
  it("is a nested list labelled 'Network topology', Internet at the root", () => {
    render(<TopologyPanel />);

    const tree = screen.getByRole("list", { name: "Network topology" });
    const [root] = within(tree).getAllByRole("listitem");
    expect(within(root).getByText("Internet")).toBeInTheDocument();
    expect(within(root).getByText("2.5 Gb · p1")).toBeInTheDocument();
    // Router → switch → its ports are each a list inside the listitem above.
    const router = within(root).getByText("MikroTik RB5009").closest("li")!;
    const sw = within(router).getByText("Zyxel GS1900-10HP").closest("li")!;
    expect(within(sw).getAllByRole("list")).toHaveLength(1);
    for (const text of ["Office AP", "Camera", "PoE 4.0 W", "port 4 · 1 Gb"]) {
      expect(within(sw).getByText(text)).toBeInTheDocument();
    }
  });

  it("puts the switch on the router's one cabled jack", () => {
    render(<TopologyPanel />);

    expect(screen.getByText("router p2 ↔ port 1 · 1 Gb")).toBeInTheDocument();
  });

  it("draws router → devices only when there's no switch", () => {
    mockReads({ switch: { status: null, ports: [], connected: false }, aps: { aps: [] } });
    render(<TopologyPanel />);

    expect(screen.queryByText("Zyxel GS1900-10HP")).not.toBeInTheDocument();
    const router = screen.getByText("MikroTik RB5009").closest("li")!;
    expect(within(router).getByText("Wired device")).toBeInTheDocument();
    expect(within(router).getByText("router p2")).toBeInTheDocument();
    // A switch that was never there isn't a problem worth a footnote.
    expect(screen.queryByText(/switch/i)).not.toBeInTheDocument();
  });

  it("reads 'Upstream router' first behind another router", () => {
    render(<TopologyPanel posture="DOWNSTREAM_ROUTER" />);

    const tree = screen.getByRole("list", { name: "Network topology" });
    const [root] = within(tree).getAllByRole("listitem");
    expect(within(root).getByText("Upstream router")).toBeInTheDocument();
    expect(screen.queryByText("Internet")).not.toBeInTheDocument();
  });

  it("keeps a footnote for what it could not read", () => {
    mockReads({
      switch: { status: null, ports: [], connected: false, error: new Error("Switch status: 502") },
      aps: { aps: [], error: new Error("Failed to fetch extender APs: 500") },
    });
    render(<TopologyPanel />);

    expect(screen.getByText("We can't reach the switch, so its ports aren't shown.")).toBeInTheDocument();
    expect(
      screen.getByText("We couldn't read your access points, so they may be missing."),
    ).toBeInTheDocument();
    // The router half still draws.
    expect(screen.getByText("MikroTik RB5009")).toBeInTheDocument();
  });

  it("explains the dot colours without relying on them", () => {
    render(<TopologyPanel />);

    for (const label of ["connected", "needs a look", "no cable", "problem"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

// ── The access point ──────────────────────────────────────────────────

describe("the access point", () => {
  const apCard = () => screen.getByText("Office AP").closest("div")!;

  it("shows its live wireless client count and where it plugs in", () => {
    render(<TopologyPanel />);

    expect(useCoverageApsMock).toHaveBeenCalledWith({ paused: false });
    expect(useApRadiosMock).toHaveBeenCalledWith(AP.mac, true);
    expect(within(apCard()).getByText("26 clients")).toBeInTheDocument();
    expect(within(apCard()).getByText("port 2 · PoE 6.2 W")).toBeInTheDocument();
  });

  it("says its radios aren't reporting, and shows no number, when the read fails", () => {
    mockReads({ radios: { detail: undefined, error: new Error("Failed to fetch access point radios: 502") } });
    render(<TopologyPanel />);

    expect(within(apCard()).getByText("Radios not reporting")).toBeInTheDocument();
    expect(within(apCard()).queryByText(/client/)).not.toBeInTheDocument();
    // Still on the tree, still on its jack.
    expect(within(apCard()).getByText("port 2 · PoE 6.2 W")).toBeInTheDocument();
  });

  it("says the same when the AP answers that it has no wireless state", () => {
    mockReads({ radios: { detail: { ...DETAIL, supported: false, radios: [] } } });
    render(<TopologyPanel />);

    expect(within(apCard()).getByText("Radios not reporting")).toBeInTheDocument();
  });

  it("doesn't call a read in flight an outage", () => {
    mockReads({ radios: { detail: undefined, error: undefined } });
    render(<TopologyPanel />);

    expect(within(apCard()).getByText("Checking radios…")).toBeInTheDocument();
  });

  it("doesn't ask for per-AP radios as a viewer who can't read them", () => {
    mockReads({ role: "family", radios: { detail: undefined } });
    render(<TopologyPanel />);

    expect(useApRadiosMock).toHaveBeenCalledWith(AP.mac, false);
    // No per-AP detail to go on, and the rollup raises nothing.
    expect(within(apCard()).getByText("Online")).toBeInTheDocument();
  });

  it("falls back to the fabric rollup for that viewer", () => {
    mockReads({ role: "family", radios: { detail: undefined } });
    render(
      <TopologyPanel
        radios={{ router: 0, ap: 0, total: 0, active: 0, apsNotReporting: 1 }}
      />,
    );

    expect(within(apCard()).getByText("Radios not reporting")).toBeInTheDocument();
  });

  it("stops reading the access points while the page hides the panel", () => {
    render(<TopologyPanel paused />);

    expect(useCoverageApsMock).toHaveBeenCalledWith({ paused: true });
    expect(useApRadiosMock).toHaveBeenCalledWith(AP.mac, false);
  });

  it("leaves a third-party AP at 'Online' — there are no radios to read", () => {
    mockReads({ aps: { aps: [{ ...AP, backend: "UNIFI" }] } });
    render(<TopologyPanel />);

    expect(within(apCard()).getByText("Online")).toBeInTheDocument();
    expect(useApRadiosMock).not.toHaveBeenCalled();
  });
});
