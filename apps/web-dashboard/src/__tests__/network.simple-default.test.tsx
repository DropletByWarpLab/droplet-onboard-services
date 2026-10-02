/**
 * WARP-2962 — where the Network page opens.
 *
 * `mode` (Simple ⟷ Advanced) and `activeTab` are independent pieces of state,
 * so the two halves of this story can only be proven together on the mounted
 * page: bare `/network` must open in Simple, and a URL that names a tab must
 * still open the Advanced tab surface with that tab selected. A source-level
 * pin (see network.tabs-a11y.test.tsx) cannot see that interaction.
 *
 * The page pulls a tower of hooks, so its data sources and the panel children
 * are stubbed — what's under test is which surface renders, not their content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const searchMock = vi.fn(() => new URLSearchParams());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => searchMock(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("@/lib/hooks/useNetwork", () => ({
  useNetwork: () => ({
    overview: { interfaces: {}, system: {}, wirelessRadios: undefined },
    firewall: undefined,
    isLoading: false,
    isRefreshing: false,
    error: null,
    routerConnected: true,
    routerErrorCode: undefined,
    routerErrorMessage: undefined,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getNetworkTopology: vi.fn(async () => null),
}));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/network/NetworkSimple", () => ({
  NetworkSimple: () => <div data-testid="network-simple" />,
}));
// The Advanced System panel and the two always-on port maps fetch on mount —
// stub them out, they are not what this file is about.
for (const [mod, name] of [
  ["@/components/network/SshAccessCard", "SshAccessCard"],
  ["@/components/network/DhcpReservationForm", "DhcpReservationForm"],
  ["@/components/network/DnsServersForm", "DnsServersForm"],
  ["@/components/network/StaticDnsCard", "StaticDnsCard"],
  ["@/components/network/SystemControlsCard", "SystemControlsCard"],
  ["@/components/network/InterfacesTable", "InterfacesTable"],
  ["@/components/network/AiAgentAccessCard", "AiAgentAccessCard"],
  ["@/components/network/DhcpPoolForm", "DhcpPoolForm"],
  ["@/components/network/DnsOverTlsCard", "DnsOverTlsCard"],
  ["@/components/network/MaintenanceCards", "MaintenanceCards"],
  ["@/components/network/router/RouterPortsPanel", "RouterPortsPanel"],
  ["@/components/network/switch/SwitchPanel", "SwitchPanel"],
] as const) {
  vi.doMock(mod, () => ({ [name]: () => null }));
}

import NetworkPage from "@/app/network/page";

beforeEach(() => {
  searchMock.mockReturnValue(new URLSearchParams());
});

describe("Network page — where it opens (WARP-2962)", () => {
  it("opens bare /network in Simple: no tab strip, the Simple view instead", () => {
    render(<NetworkPage />);

    expect(screen.getByTestId("network-simple")).toBeInTheDocument();
    // `hidden` takes the tab strip out of the accessibility tree entirely.
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("opens /network?tab=system in Advanced with System selected", () => {
    searchMock.mockReturnValue(new URLSearchParams("tab=system"));

    render(<NetworkPage />);

    expect(screen.getByRole("tablist", { name: "Network view tabs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /System/, selected: true })).toBeInTheDocument();
    expect(screen.queryByTestId("network-simple")).toBeNull();
  });

  it("stays in Advanced when the Overview tab is clicked from a deep link", () => {
    searchMock.mockReturnValue(new URLSearchParams("tab=system"));
    const { rerender } = render(<NetworkPage />);

    fireEvent.click(screen.getByRole("tab", { name: /Overview/ }));
    // router.push is mocked, so play its landing by hand: the Overview tab's
    // href IS the bare /network path. The deep-link rule is one-directional —
    // losing the `?tab=` must not drop the user out of the tab surface.
    searchMock.mockReturnValue(new URLSearchParams());
    rerender(<NetworkPage />);

    expect(screen.getByRole("tablist", { name: "Network view tabs" })).toBeInTheDocument();
    expect(screen.queryByTestId("network-simple")).toBeNull();
  });
});
