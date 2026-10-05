/**
 * /projects?view=time (WARP-3526) — the time view is a view of the Projects page,
 * not a new nav row (the sidebar is at its row cap): addressable by URL, reached
 * from the header and from a project's view tabs, with the running-timer chip in
 * the header of every view.
 *
 * The real page, the real usePm hooks and the real time components, over the
 * stateful fake of the orchestrator (src/__tests__/helpers/fake-time-api.ts).
 * ShellPage is a passthrough, as in page.gating.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createFakeTimeApi, ITEM_1, worklog } from "@/__tests__/helpers/fake-time-api";
import type { PmTimesheet } from "@/components/projects/time/types";
import type { PmProject } from "@/components/projects/types";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: { title?: string; sub?: string; children: React.ReactNode; actions?: React.ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const api = vi.hoisted(() => ({
  handler: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
  user: null as null | { id: string; username: string; displayName: string; role: string },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: api.user, isLoading: false }),
  authFetch: (url: string, init?: RequestInit) => api.handler!(url, init),
}));
vi.mock("@/lib/hooks/useAppCapabilities", () => ({
  useAppCapabilities: () => ({ projects: true }),
}));

import ProjectsPage from "./page";

const PROJECT: PmProject = {
  id: "p1",
  workspaceId: "ws",
  workspaceSlug: "home",
  name: "Inbox",
  identifier: "INBOX",
  description: null,
  icon: null,
  color: null,
  leadId: null,
  department: null,
  archived: false,
  openCount: 0,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const SHEET: PmTimesheet = {
  userId: "u-me",
  tz: "UTC",
  weekStart: "2026-09-28",
  days: ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
  rows: [{ workItem: ITEM_1, minutes: [30, 0, 0, 0, 0, 0, 0], totalMinutes: 30 }],
  dayTotals: [30, 0, 0, 0, 0, 0, 0],
  totalMinutes: 30,
  entries: [{ ...worklog({ id: "mine", minutes: 30, userId: "u-me" }), workItem: ITEM_1 }],
};

let fake: ReturnType<typeof createFakeTimeApi>;
const replace = vi.fn();

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectsPage />
    </SWRConfig>,
  );
}

beforeEach(() => {
  toast.mockReset();
  replace.mockReset();
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn(), replace, back: vi.fn() } as never);
  api.user = { id: "u-me", username: "me", displayName: "Mia Member", role: "family" };
  fake = createFakeTimeApi({ timesheet: SHEET, projects: [PROJECT] });
  api.handler = fake.handler;
});

describe("/projects?view=time", () => {
  it("opens straight onto the time view — titled Time, with the way back — instead of the project index", async () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams("view=time") as never);
    renderPage();
    expect(await screen.findByRole("tab", { name: /Timesheet/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { level: 1, name: "Time" })).toBeInTheDocument();
    expect(screen.getByText("Timesheet and report")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All projects/ })).toBeInTheDocument();
    expect(screen.queryByText("Active projects")).toBeNull();
    // A time view opened with no project has no project tabs to show.
    expect(screen.queryByRole("tab", { name: "Board" })).toBeNull();
  });

  it("is reached from the index by a Time button, and writes the address", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Time$/ }));
    expect(await screen.findByRole("tab", { name: /Timesheet/ })).toBeInTheDocument();
    expect(replace).toHaveBeenLastCalledWith("/projects?view=time", { scroll: false });
  });

  it("goes back to the index and takes the address with it", async () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams("view=time") as never);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /All projects/ }));
    expect(await screen.findByText("Active projects")).toBeInTheDocument();
    expect(replace).toHaveBeenLastCalledWith("/projects", { scroll: false });
    expect(screen.queryByRole("tab", { name: /Timesheet/ })).toBeNull();
  });

  it("does not touch the address for any other view", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Inbox")); // open the project: the board
    await screen.findByRole("tab", { name: "Board" });
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(replace).not.toHaveBeenCalled();
  });

  it("is a tab of a project too: the report starts filtered to that project, and Board brings the address back", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("Inbox"));
    fireEvent.click(await screen.findByRole("tab", { name: "Time" }));

    expect(await screen.findByRole("tab", { name: /Timesheet/ })).toBeInTheDocument();
    expect(replace).toHaveBeenLastCalledWith("/projects?view=time", { scroll: false });
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Report/ }));
    const project = (await screen.findByRole("combobox", { name: "Project" })) as HTMLSelectElement;
    expect(project.value).toBe("p1");

    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    await waitFor(() => expect(replace).toHaveBeenLastCalledWith("/projects", { scroll: false }));
  });

  it("hands the signed-in person to the time surface: a member may edit their own entry, a guest-level role may not", async () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams("view=time") as never);
    const first = renderPage();
    const list = await screen.findByRole("list", { name: "Time entries" });
    expect(within(list).getByRole("button", { name: /^Edit/ })).toBeInTheDocument();
    first.unmount();

    api.user = { id: "u-me", username: "me", displayName: "Mia Member", role: "guest" };
    renderPage();
    const readOnly = await screen.findByRole("list", { name: "Time entries" });
    expect(within(readOnly).queryByRole("button", { name: /^Edit/ })).toBeNull();
  });
});

describe("the running-timer chip in the header", () => {
  const running = {
    userId: "u-me",
    workItemId: "w1",
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    workItem: ITEM_1,
  };

  it("shows nothing while no timer runs, so a box that never tracks time sees no new control", async () => {
    renderPage();
    await screen.findByText("Active projects");
    expect(screen.queryByRole("group", { name: /Timer running/ })).toBeNull();
  });

  it.each([
    ["the index", async () => undefined],
    ["a project", async () => void fireEvent.click(await screen.findByText("Inbox"))],
    ["the time view", async () => void fireEvent.click(await screen.findByRole("button", { name: /^Time$/ }))],
  ])("is present on %s while a timer runs", async (_where, go) => {
    fake.state.timer = running;
    renderPage();
    await go();
    expect(await screen.findByRole("group", { name: "Timer running on INBOX-1" })).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(/^00:0[45]:\d\d$/);
  });

  it("stops the timer from the header and goes away", async () => {
    fake.state.timer = running;
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Stop the timer on INBOX-1" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Logged 25m on INBOX-1.", "success"));
    await waitFor(() => expect(screen.queryByRole("group", { name: /Timer running/ })).toBeNull());
  });
});
