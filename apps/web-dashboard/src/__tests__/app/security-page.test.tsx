/**
 * WARP-2977 P2b — /security wiring: the mode card sits on top, the area
 * select becomes `?zone=` on the feed's own request, and a mode write
 * refreshes the feed (whose useSWRInfinite keys a global mutate can't reach)
 * and its header.
 *
 * WARP-2978 (ADR-059 P3 §8, D32) — the page opens on Incidents; the P2a feed
 * is the Everything tab. The tab lives in the URL (`?tab=everything`), so Back
 * from an incident reached through "In an incident" returns to the feed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act as rtlAct, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { SECURITY_ZONES_PATH } from "@/lib/api";
import { ToastProvider } from "@/components/Toast";
import SecurityPage from "@/app/security/page";
import { COPY as FEED_COPY } from "@/components/security/SecurityFeed";
import { COPY as MODE_COPY } from "@/components/security/ModeCard";
import type { SecurityModeView, SecurityZoneView } from "@/lib/types";

const h = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  getSecurityIncidents: vi.fn(),
  getSecurityIncidentSummary: vi.fn(),
  authFetch: vi.fn(),
  getSecurityEvents: vi.fn(),
  getSecurityHealth: vi.fn(),
  getSecurityZones: vi.fn(),
  getSecurityMode: vi.fn(),
  postSecurityMode: vi.fn(),
  fetchCameras: vi.fn(),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, children }: { title?: string; children: ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {children}
    </div>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: h.replace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.search),
  usePathname: () => "/security",
}));

vi.mock("@/lib/auth", () => ({
  authFetch: h.authFetch,
  useAuth: () => ({ user: { id: "u1", role: "owner" } }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getSecurityEvents: h.getSecurityEvents,
  getSecurityHealth: h.getSecurityHealth,
  getSecurityZones: h.getSecurityZones,
  getSecurityMode: h.getSecurityMode,
  postSecurityMode: h.postSecurityMode,
  fetchCameras: h.fetchCameras,
  getSecurityIncidents: h.getSecurityIncidents,
  getSecurityIncidentSummary: h.getSecurityIncidentSummary,
}));

const MODE: SecurityModeView = {
  mode: "open",
  source: "schedule",
  manualEnd: "none",
  until: null,
  setBy: null,
  setAt: "2026-09-23T08:00:00.000Z",
  hours: { state: "not_set" },
  displayTimezone: null,
  stale: false,
  version: 1,
};

function zone(id: string, name: string, state: SecurityZoneView["state"] = "active"): SecurityZoneView {
  return { id, name, kind: "entry", state, version: 0, links: [] };
}

function Wrap({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider>{children}</ToastProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.search = "";
  h.getSecurityIncidents.mockResolvedValue({ incidents: [], nextCursor: null });
  h.getSecurityIncidentSummary.mockResolvedValue({ openAlerts: 0, openNotices: 0, latest: [], alertsReady: true });
  h.authFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      modules: [{ id: "security", effective: true }],
      effectiveForUser: [{ moduleId: "security", level: "manage" }],
    }),
  }));
  h.getSecurityEvents.mockResolvedValue({ events: [], nextCursor: null });
  h.getSecurityHealth.mockResolvedValue({ sources: [] });
  h.getSecurityZones.mockResolvedValue({ zones: [zone("z1", "Front door"), zone("z9", "Old shed", "archived")] });
  h.getSecurityMode.mockResolvedValue(MODE);
  h.fetchCameras.mockResolvedValue([]);
});

describe("/security — the Everything tab (the P2a feed)", () => {
  beforeEach(() => {
    h.search = "tab=everything";
  });

  it("puts the mode card above the feed", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    await screen.findByText(MODE_COPY.notSet);
    const titles = [...document.querySelectorAll(".card-h .ct")].map((t) => t.textContent);
    expect(titles[0]).toBe(MODE_COPY.title);
    expect(titles).toContain(FEED_COPY.feedTitle);
  });

  it("picking an area puts zone= on the feed's request; active areas only", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    const select = await screen.findByRole("combobox", { name: FEED_COPY.areaLabel });
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([FEED_COPY.allAreas, "Front door"]);
    expect(h.getSecurityEvents).toHaveBeenLastCalledWith(expect.not.objectContaining({ zone: expect.anything() }));

    fireEvent.change(select, { target: { value: "z1" } });
    await waitFor(() => expect(h.getSecurityEvents).toHaveBeenLastCalledWith(expect.objectContaining({ zone: "z1" })));

    // The network view's rows never sit in an area: it never sends one.
    fireEvent.click(screen.getByRole("button", { name: "Network and sign-in" }));
    await waitFor(() =>
      expect(h.getSecurityEvents).toHaveBeenLastCalledWith(expect.objectContaining({ kinds: ["threat"] })),
    );
    expect(h.getSecurityEvents.mock.lastCall?.[0]).not.toHaveProperty("zone");
  });

  it("an area no camera covers reads as not covered — never quiet — with the way to the Areas page at manage", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    fireEvent.change(await screen.findByRole("combobox", { name: FEED_COPY.areaLabel }), { target: { value: "z1" } });
    expect(await screen.findByText("No cameras cover Front door yet")).toBeInTheDocument();
    expect(document.querySelector("[data-empty]")).toHaveAttribute("data-empty", "not-covered");
    expect(await screen.findByRole("link", { name: FEED_COPY.openAreas })).toHaveAttribute("href", "/security/zones");
  });

  it("an area that disappears stops filtering instead of leaving an empty page", async () => {
    let swrMutate: ((key: string) => Promise<unknown>) | undefined;
    function Grab() {
      swrMutate = useSWRConfig().mutate as unknown as (key: string) => Promise<unknown>;
      return null;
    }
    render(
      <>
        <Grab />
        <SecurityPage />
      </>,
      { wrapper: Wrap },
    );
    fireEvent.change(await screen.findByRole("combobox", { name: FEED_COPY.areaLabel }), { target: { value: "z1" } });
    await waitFor(() => expect(h.getSecurityEvents).toHaveBeenLastCalledWith(expect.objectContaining({ zone: "z1" })));

    h.getSecurityZones.mockResolvedValue({ zones: [zone("z1", "Front door", "archived")] });
    await rtlAct(async () => {
      await swrMutate!(SECURITY_ZONES_PATH);
    });
    await waitFor(() => expect(screen.queryByRole("combobox", { name: FEED_COPY.areaLabel })).toBeNull());
    await waitFor(() => expect(h.getSecurityEvents.mock.lastCall?.[0]).not.toHaveProperty("zone"));
  });

  it("a mode write refreshes the feed and its header", async () => {
    h.postSecurityMode.mockResolvedValue({
      mode: { ...MODE, mode: "closed", source: "manual", manualEnd: "until_changed" },
      changed: true,
    });
    render(<SecurityPage />, { wrapper: Wrap });
    const closeUp = await screen.findByRole("button", { name: MODE_COPY.closeUp });
    await waitFor(() => expect(h.getSecurityEvents).toHaveBeenCalled());
    await waitFor(() => expect(h.getSecurityHealth).toHaveBeenCalled());
    await rtlAct(async () => {});
    const eventsBefore = h.getSecurityEvents.mock.calls.length;
    const healthBefore = h.getSecurityHealth.mock.calls.length;
    fireEvent.click(closeUp);
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "close" }));
    await waitFor(() => expect(h.getSecurityEvents.mock.calls.length).toBeGreaterThan(eventsBefore));
    await waitFor(() => expect(h.getSecurityHealth.mock.calls.length).toBeGreaterThan(healthBefore));
  });
});

describe("/security — Incidents (WARP-2978)", () => {
  it("opens on Incidents, asking for what needs attention; the feed isn't read until Everything is chosen", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Incidents", "Everything"]);
    expect(screen.getByRole("tab", { name: /Incidents/ })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(h.getSecurityIncidents).toHaveBeenCalledWith(expect.objectContaining({ state: "attention" })));
    expect(h.getSecurityEvents).not.toHaveBeenCalled();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { name: /Incidents/ }).id);
  });

  it("All asks for every incident", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    fireEvent.click(await screen.findByRole("button", { name: "All" }));
    await waitFor(() => expect(h.getSecurityIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ state: "all" })));
  });

  it("picking an area puts zone= on the incidents request", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    fireEvent.change(await screen.findByRole("combobox", { name: FEED_COPY.areaLabel }), { target: { value: "z1" } });
    await waitFor(() => expect(h.getSecurityIncidents).toHaveBeenLastCalledWith(expect.objectContaining({ zone: "z1" })));
  });

  it("choosing Everything shows the feed and puts the tab in the URL; Incidents takes it out", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    fireEvent.click(await screen.findByRole("tab", { name: "Everything" }));
    expect(screen.getByRole("tab", { name: "Everything" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(h.getSecurityEvents).toHaveBeenCalled());
    expect(h.replace).toHaveBeenLastCalledWith("/security?tab=everything", { scroll: false });
    fireEvent.click(screen.getByRole("tab", { name: /Incidents/ }));
    expect(h.replace).toHaveBeenLastCalledWith("/security", { scroll: false });
  });

  it("the tabs follow the arrow keys (the tabs pattern), and only the selected tab is in the tab order", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    const incidents = await screen.findByRole("tab", { name: /Incidents/ });
    expect(incidents).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Everything" })).toHaveAttribute("tabindex", "-1");
    incidents.focus();
    fireEvent.keyDown(incidents, { key: "ArrowRight" });
    const everything = screen.getByRole("tab", { name: "Everything" });
    expect(everything).toHaveAttribute("aria-selected", "true");
    expect(everything).toHaveFocus();
  });

  it("the Incidents tab counts what needs attention — never a 0", async () => {
    h.getSecurityIncidentSummary.mockResolvedValue({ openAlerts: 2, openNotices: 1, latest: [], alertsReady: true });
    render(<SecurityPage />, { wrapper: Wrap });
    await waitFor(() => expect(screen.getByRole("tab", { name: /Incidents/ })).toHaveTextContent("Incidents3"));
    // A screen reader hears what the number means.
    expect(screen.getByRole("tab", { name: "Incidents, 3 need attention" })).toBeInTheDocument();
  });

  it("no count on the tab when nothing needs attention", async () => {
    render(<SecurityPage />, { wrapper: Wrap });
    await waitFor(() => expect(h.getSecurityIncidentSummary).toHaveBeenCalled());
    await rtlAct(async () => {});
    expect(screen.getByRole("tab", { name: /Incidents/ }).textContent).toBe("Incidents");
  });

  it("the alerts line follows the summary: ready, not ready, and nothing while unknown", async () => {
    const { unmount } = render(<SecurityPage />, { wrapper: Wrap });
    expect(await screen.findByText(FEED_COPY.alertsLine)).toBeInTheDocument();
    unmount();

    h.getSecurityIncidentSummary.mockResolvedValue({ openAlerts: 0, openNotices: 0, latest: [], alertsReady: false });
    const second = render(<SecurityPage />, { wrapper: Wrap });
    expect(await screen.findByText(FEED_COPY.alertsNotReady)).toBeInTheDocument();
    second.unmount();

    h.getSecurityIncidentSummary.mockRejectedValue(Object.assign(new Error("x"), { code: "INCIDENTS_UNAVAILABLE", status: 503 }));
    render(<SecurityPage />, { wrapper: Wrap });
    await waitFor(() => expect(h.getSecurityIncidentSummary).toHaveBeenCalled());
    await rtlAct(async () => {});
    expect(screen.queryByText(FEED_COPY.alertsLine)).toBeNull();
    expect(screen.queryByText(FEED_COPY.alertsNotReady)).toBeNull();
  });
});
