/**
 * The /admin console shell.
 *
 * /admin used to 404. Four pages lived under it, each carrying its own copy
 * of the same owner/admin predicate and its own denial card, and nothing in
 * the product linked to any of them.
 *
 * These pins hold three things: the layout gate refuses non-operators, it
 * shows neutral chrome while auth is hydrating rather than the page, and the
 * Overview reports "unknown" rather than a zero when a probe fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { NAV_GROUPS, visibleItems } from "@/components/nav-config";

const fetchSystemHealthMock = vi.fn();
const fetchUsersMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchSystemHealth: (...a: any[]) => fetchSystemHealthMock(...a),
  fetchUsers: (...a: any[]) => fetchUsersMock(...a),
  fetchDevices: vi.fn().mockResolvedValue([]),
  fetchHealth: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
  authFetch: vi.fn(),
}));

import AdminLayout from "@/app/admin/layout";
import AdminOverviewPage from "@/app/admin/page";

beforeEach(() => {
  fetchSystemHealthMock.mockReset();
  fetchUsersMock.mockReset();
  useAuthMock.mockReset();
  fetchSystemHealthMock.mockResolvedValue({
    status: "ok",
    components: [
      { name: "db", status: "ok", latencyMs: 1, lastCheckedAt: "" },
      { name: "redis", status: "ok", latencyMs: 1, lastCheckedAt: "" },
    ],
    uptime: 100,
    version: "0.2.0",
  });
  fetchUsersMock.mockResolvedValue({ users: [{ id: "a" }, { id: "b" }] });
});

describe("/admin — the console gate", () => {
  it("refuses someone who is not an operator", () => {
    useAuthMock.mockReturnValue({ user: { role: "family" }, isLoading: false });

    render(
      <AdminLayout>
        <div>secret console</div>
      </AdminLayout>,
    );

    expect(screen.getByText(/admin access required/i)).toBeInTheDocument();
    expect(screen.queryByText("secret console")).not.toBeInTheDocument();
  });

  it("lets an owner through to the page", () => {
    useAuthMock.mockReturnValue({ user: { role: "owner" }, isLoading: false });

    render(
      <AdminLayout>
        <div>secret console</div>
      </AdminLayout>,
    );

    expect(screen.getByText("secret console")).toBeInTheDocument();
    expect(screen.queryByText(/admin access required/i)).not.toBeInTheDocument();
  });

  it("shows neutral chrome while auth is still hydrating, not the page", () => {
    // The branch /admin/files was missing: with no loading state it rendered
    // its real content to whoever asked until the probe resolved.
    useAuthMock.mockReturnValue({ user: null, isLoading: true });

    render(
      <AdminLayout>
        <div>secret console</div>
      </AdminLayout>,
    );

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText("secret console")).not.toBeInTheDocument();
    expect(screen.queryByText(/admin access required/i)).not.toBeInTheDocument();
  });
});

describe("/admin — Overview", () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({ user: { role: "owner" }, isLoading: false });
  });

  it("reports the box state from endpoints that already exist", async () => {
    render(<AdminOverviewPage />);

    await waitFor(() => expect(screen.getByText("Healthy")).toBeInTheDocument());
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("says unknown when a probe fails, rather than reporting a zero", async () => {
    // A console that quietly renders "0" when it could not reach the box is
    // worse than one that admits it does not know.
    fetchSystemHealthMock.mockRejectedValue(new Error("unreachable"));
    fetchUsersMock.mockRejectedValue(new Error("unreachable"));

    render(<AdminOverviewPage />);

    // WARP-2696 — wait for the FAILED state, which is the thing under test.
    //
    // The obvious wait, `waitFor(getByText("Unknown"))`, is wrong twice over.
    // `page.tsx` renders the muted Unknown badge whenever `health.state !== "ok"`,
    // which includes the very first paint, so that wait is satisfied before
    // either probe has rejected — the assertion below then reads the LOADING
    // frame and cannot find the note (`node / web-dashboard`, run 34286523672).
    // Measured with the rejections delayed 10 ms: the note was absent at that
    // wait in 99 of 100 renders.
    //
    // And it could never have waited for the settled frame either: once BOTH
    // probes fail there are three "Unknown" nodes — the status badge plus the
    // two KPI notes — so `getByText` would throw "found multiple elements".
    // The spec only ever passed by landing its wait in the loading frame and
    // its assertion in the settled one.
    expect(await screen.findByText(/could not reach the box/i)).toBeInTheDocument();
    // Status badge + both KPI notes.
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("degrades one tile without blanking the other", async () => {
    fetchUsersMock.mockRejectedValue(new Error("roster down"));

    render(<AdminOverviewPage />);

    await waitFor(() => expect(screen.getByText("Healthy")).toBeInTheDocument());
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });
});

describe("/admin — nav entry", () => {
  const caps = { claudeActivity: true, ragEval: true };
  const allModulesOn = () => true;
  const adminGroup = () => NAV_GROUPS.find((g) => g.label === "Admin")!;

  it("is in the nav at all — it was reachable only by typing the URL", () => {
    const entry = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/admin");
    expect(entry).toBeDefined();
  });

  it("is visible to an operator", () => {
    const hrefs = visibleItems(adminGroup().items, "owner", caps, allModulesOn).map(
      (i) => i.href,
    );
    expect(hrefs).toContain("/admin");
  });

  it("is hidden from everyone else", () => {
    for (const role of ["family", "guest"] as const) {
      const hrefs = visibleItems(adminGroup().items, role, caps, allModulesOn).map(
        (i) => i.href,
      );
      expect(hrefs).not.toContain("/admin");
    }
  });

  it("does not claim its own child routes as a module gate", () => {
    // moduleForPath picks the longest matching href. An /admin entry with a
    // requiresModule would start claiming /admin/audit and /admin/files, and
    // ModuleRouteGuard would blank them both on a positive denial.
    const entry = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === "/admin")!;
    expect(entry.requiresModule).toBeUndefined();
  });
});
