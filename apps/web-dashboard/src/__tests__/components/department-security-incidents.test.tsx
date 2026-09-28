/**
 * WARP-2978 (ADR-059 P3 §8, D38) — Security on the department home and the
 * Business overview.
 *
 *   · the `security-incidents` widget (GET /api/security/incidents/summary):
 *     `2 open alerts · 1 notice`, up to three incidents, `Open Security`;
 *   · the `open_incidents` headline: `2 open alerts` / `Nothing needs attention`.
 *
 * Both hold the P1 rule for figures: never a zero they did not read. A read
 * that fails says so ("Couldn't load incidents"); Security switched off says
 * so; alerts that can't fire yet say what they need.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import type { Department, DepartmentProfile, IncidentSummary, IncidentsSummary } from "@/lib/types";

const h = vi.hoisted(() => ({ getSecurityIncidentSummary: vi.fn(), fetchCameras: vi.fn() }));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getSecurityIncidentSummary: h.getSecurityIncidentSummary,
  fetchCameras: h.fetchCameras,
}));
vi.mock("@/lib/security-time", async (orig) => ({
  ...(await orig<typeof import("@/lib/security-time")>()),
  deviceTimeZone: () => "Europe/London",
}));

import { DEPARTMENT_WIDGETS, type DepartmentWidgetProps } from "@/components/Departments/department-widgets";
import { HeadlineFigure } from "@/components/Departments/HeadlineFigure";
import { OPEN_INCIDENTS_COPY } from "@/components/Departments/department-sources";

const at = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`;

function incident(over: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id: "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f",
    scope: "area",
    zone: { id: "z1", name: "Stock room", kind: "restricted" },
    camera: null,
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence"],
    grouping: "closed",
    openedInMode: "closed",
    firstActivityAt: at("01:14"),
    lastActivityAt: at("01:20"),
    eventCount: 3,
    labels: { person: 3 },
    lastAck: null,
    ...over,
  };
}

function summary(over: Partial<IncidentsSummary> = {}): IncidentsSummary {
  return { openAlerts: 0, openNotices: 0, latest: [], alertsReady: true, ...over };
}

function typedError(status: number, body: unknown): Error {
  return Object.assign(new Error("raw"), { status, body, code: undefined });
}

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

const Widget = DEPARTMENT_WIDGETS["security-incidents"].Component;
const widgetProps = (): DepartmentWidgetProps => ({
  department: { id: "d-sec", name: "Security" } as Department,
  profile: { template: "security" } as DepartmentProfile,
  reachable: [],
  canEdit: false,
  size: "m",
});

beforeEach(() => {
  vi.clearAllMocks();
  h.fetchCameras.mockResolvedValue([]);
});

describe("the security-incidents widget", () => {
  it("counts open alerts and notices, lists the latest, and links to Security", async () => {
    h.getSecurityIncidentSummary.mockResolvedValue(
      summary({ openAlerts: 2, openNotices: 1, latest: [incident({ id: "a" }), incident({ id: "b" }), incident({ id: "c" })] }),
    );
    const { container } = render(<Widget {...widgetProps()} />, { wrapper: Wrap });
    await waitFor(() => expect(container.querySelector(".dept-figure")).toHaveTextContent("2 open alerts · 1 notice"));
    const links = screen.getAllByRole("link");
    expect(links.filter((l) => l.getAttribute("href")?.startsWith("/security/incidents/"))).toHaveLength(3);
    expect(screen.getByRole("link", { name: OPEN_INCIDENTS_COPY.openSecurity })).toHaveAttribute("href", "/security");
  });

  it("only notices: `1 open notice` — never `0 open alerts`", async () => {
    h.getSecurityIncidentSummary.mockResolvedValue(summary({ openNotices: 1, latest: [incident({ severity: "notice", reasonCodes: ["camera_offline"] })] }));
    const { container } = render(<Widget {...widgetProps()} />, { wrapper: Wrap });
    await waitFor(() => expect(container.querySelector(".dept-figure")).toHaveTextContent("1 open notice"));
    expect(container.querySelector(".dept-figure")).not.toHaveTextContent(/\b0\b/);
  });

  it("nothing open: Nothing needs attention", async () => {
    h.getSecurityIncidentSummary.mockResolvedValue(summary());
    render(<Widget {...widgetProps()} />, { wrapper: Wrap });
    expect(await screen.findByText(OPEN_INCIDENTS_COPY.nothing)).toBeInTheDocument();
  });

  it("alerts not ready: says what they need", async () => {
    h.getSecurityIncidentSummary.mockResolvedValue(summary({ alertsReady: false }));
    render(<Widget {...widgetProps()} />, { wrapper: Wrap });
    expect(await screen.findByText("Alerts need opening hours and an Inside area")).toBeInTheDocument();
  });

  it("can't read: Couldn't load incidents — never a zero", async () => {
    h.getSecurityIncidentSummary.mockRejectedValue(typedError(503, { error: { code: "INCIDENTS_UNAVAILABLE" } }));
    render(<Widget {...widgetProps()} />, { wrapper: Wrap });
    expect(await screen.findByText("Couldn't load incidents")).toBeInTheDocument();
    expect(screen.queryByText(OPEN_INCIDENTS_COPY.nothing)).toBeNull();
  });

  it("Security switched off under the page (404 module_disabled): says so", async () => {
    h.getSecurityIncidentSummary.mockRejectedValue(typedError(404, { error: "module_disabled", module: "security" }));
    render(<Widget {...widgetProps()} />, { wrapper: Wrap });
    expect(await screen.findByText("Security is off on this box")).toBeInTheDocument();
  });
});

describe("the open_incidents headline", () => {
  const on = () => true;

  it("counts open alerts", async () => {
    h.getSecurityIncidentSummary.mockResolvedValue(summary({ openAlerts: 2 }));
    render(<HeadlineFigure figure="open_incidents" departmentId="d-sec" isModuleOn={on} />, { wrapper: Wrap });
    await waitFor(() => expect(document.querySelector(".dept-figure")).toHaveTextContent("2 open alerts"));
  });

  it("nothing open: Nothing needs attention", async () => {
    h.getSecurityIncidentSummary.mockResolvedValue(summary());
    render(<HeadlineFigure figure="open_incidents" departmentId="d-sec" isModuleOn={on} />, { wrapper: Wrap });
    expect(await screen.findByText(OPEN_INCIDENTS_COPY.nothing)).toBeInTheDocument();
  });

  it("module off: Security is off on this box, and the box isn't asked", async () => {
    render(<HeadlineFigure figure="open_incidents" departmentId="d-sec" isModuleOn={(m) => m !== "security"} />, { wrapper: Wrap });
    expect(screen.getByText("Security is off on this box")).toBeInTheDocument();
    expect(h.getSecurityIncidentSummary).not.toHaveBeenCalled();
  });

  it("a failed read says so — never a zero", async () => {
    h.getSecurityIncidentSummary.mockRejectedValue(typedError(503, {}));
    render(<HeadlineFigure figure="open_incidents" departmentId="d-sec" isModuleOn={on} />, { wrapper: Wrap });
    expect(await screen.findByText("Couldn't load incidents")).toBeInTheDocument();
  });
});
