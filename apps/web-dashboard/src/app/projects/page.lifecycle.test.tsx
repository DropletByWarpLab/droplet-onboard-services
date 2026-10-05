/**
 * /projects — archive, restore and delete-for-good (WARP-3370).
 *
 * "Delete project" used to be one button for anyone who could write: it removed
 * the project and every work item under it. It is now an Archive (reversible), a
 * Restore, and — for an owner or admin, on an archived project only, with the
 * project's identifier typed — a permanent delete. This drives the REAL page and
 * the REAL data hooks against a tiny in-memory server and asserts what each role
 * sees and what is sent.
 *
 * ShellPage is a passthrough (same rationale as page.gating.test.tsx); only the
 * network (`authFetch`), the toast, and the signed-in role are faked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";

const navigation = vi.hoisted(() => ({
  state: { p: null as string | null, view: null as string | null, item: null as string | null, v: null as string | null, f: null as string | null },
}));

vi.mock("@/components/projects/useProjectsUrl", () => ({
  useProjectsUrl: () => {
    const [state, setState] = React.useState(navigation.state);
    const go = (patch: Partial<typeof navigation.state>) => setState((current) => ({ ...current, ...patch }));
    return { state, go, openItem: (item: string) => go({ item }), closeItem: () => go({ item: null }) };
  },
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => React.createElement("a", { href, ...props }, children),
}));

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/lib/hooks/useAppCapabilities", () => ({ useAppCapabilities: () => ({ projects: true }) }));

const session = { role: "owner" };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada", role: session.role },
    isLoading: false,
  }),
  authFetch: vi.fn(async (url: string, init?: RequestInit) => serve(url, init)),
}));

const STATES = [
  { id: "s-todo", projectId: "p1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
];

const baseProject = {
  id: "p1",
  workspaceId: "w",
  workspaceSlug: "home",
  name: "Onboarding",
  identifier: "INBOX",
  description: null,
  icon: "board",
  color: "#6366f1",
  leadId: null,
  department: null,
  archived: false,
  openCount: 0,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

let projects: Array<typeof baseProject>;
let calls: Array<{ method: string; url: string; body?: Record<string, unknown> }>;
let deleteFails: { status: number; error: string } | null;

async function serve(url: string, init?: RequestInit) {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ method, url, body });
  const reply = (status: number, payload: unknown) =>
    ({ ok: status < 400, status, json: () => Promise.resolve(payload) }) as Response;

  if (url === "/api/pm/work-items/query") {
    return reply(200, { work_items: [], nextCursor: null, total: 0 });
  }
  if (url.startsWith("/api/pm/projects/p1/work-items")) {
    return reply(200, { work_items: [], nextCursor: null, total: 0 });
  }
  if (url === "/api/pm/projects/p1/states") return reply(200, { states: STATES });
  if (url === "/api/pm/projects/p1" && method === "PATCH") {
    projects = projects.map((p) => (p.id === "p1" ? { ...p, archived: Boolean(body?.archived) } : p));
    return reply(200, { project: projects[0] });
  }
  if (url === "/api/pm/projects/p1" && method === "DELETE") {
    if (deleteFails) return reply(deleteFails.status, { error: deleteFails.error });
    projects = projects.filter((p) => p.id !== "p1");
    return reply(200, { deleted: "p1" });
  }
  if (url.startsWith("/api/pm/projects")) {
    const includeArchived = url.includes("archived=1");
    return reply(200, { projects: projects.filter((p) => includeArchived || !p.archived) });
  }
  if (url.startsWith("/api/pm/summary")) {
    return reply(200, { summary: { activeProjects: projects.filter((p) => !p.archived).length, itemsOpen: 0, doneThisWeek: 0, overdue: 0 } });
  }
  if (url === "/api/pm/people") return reply(200, { people: [] });
  if (url === "/api/departments") return reply(200, { departments: [] });
  return reply(200, {});
}

import ProjectsPage from "./page";

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ProjectsPage />
    </SWRConfig>,
  );
}

const openProject = async () => fireEvent.click(await screen.findByRole("button", { name: "Onboarding, INBOX" }));
const openArchivedFilter = () => fireEvent.click(screen.getByRole("button", { name: "Archived" }));

beforeEach(() => {
  navigation.state = { p: null, view: null, item: null, v: null, f: null };
  session.role = "owner";
  projects = [{ ...baseProject }];
  calls = [];
  deleteFails = null;
  toast.mockClear();
});

describe("archiving an active project", () => {
  it("a MEMBER can archive: a quiet confirm, then PATCH archived:true and back to the index without it", async () => {
    session.role = "family";
    renderPage();
    await openProject();

    // Active project: Archive is offered, and nothing destructive is.
    expect(await screen.findByRole("button", { name: /archive project/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete permanently/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /archive project/i }));
    // The confirm is quiet and says it is reversible — no identifier to type.
    expect(await screen.findByText(/you can restore it any time from archived/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("INBOX")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === "/api/pm/projects/p1")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ archived: true });
    expect(toast).toHaveBeenCalledWith("Project archived", "success");
    // Back on the index, which no longer lists it.
    await waitFor(() => expect(screen.getByText("No projects yet.")).toBeInTheDocument());
  });

  it("a read-only role sees no Archive, Restore or Delete at all", async () => {
    session.role = "guest";
    renderPage();
    await openProject();
    await screen.findByRole("button", { name: /all projects/i });
    expect(screen.queryByRole("button", { name: /archive project/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete permanently/i })).toBeNull();
  });
});

describe("the Archived filter", () => {
  it("hides archived projects by default; the filter shows only them", async () => {
    projects = [{ ...baseProject }, { ...baseProject, id: "p2", name: "Old campaign", identifier: "OLD", archived: true }];
    renderPage();
    expect(await screen.findByRole("button", { name: "Onboarding, INBOX" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Old campaign, OLD" })).toBeNull();

    openArchivedFilter();
    expect(await screen.findByRole("button", { name: "Old campaign, OLD" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Onboarding, INBOX" })).toBeNull();
    expect(screen.getByRole("button", { name: "Archived" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says so when there is nothing archived", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Onboarding, INBOX" });
    openArchivedFilter();
    expect(await screen.findByText("No archived projects.")).toBeInTheDocument();
  });
});

describe("an archived project", () => {
  beforeEach(() => {
    projects = [{ ...baseProject, archived: true }];
  });

  async function openArchived() {
    renderPage();
    await screen.findByText("No projects yet.");
    openArchivedFilter();
    await openProject();
    return screen.findByRole("status");
  }

  it("says it is archived, and a MEMBER can restore it but is never offered a permanent delete", async () => {
    session.role = "family";
    const banner = await openArchived();
    expect(banner).toHaveTextContent("This project is archived.");
    expect(within(banner).getByRole("button", { name: /restore/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete permanently/i })).toBeNull();

    fireEvent.click(within(banner).getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ archived: false }));
    expect(toast).toHaveBeenCalledWith("Project restored", "success");
  });

  it("an OWNER deletes for good: the identifier must be typed exactly, and it is sent to the API", async () => {
    const banner = await openArchived();
    fireEvent.click(within(banner).getByRole("button", { name: /delete permanently/i }));

    expect(await screen.findByText(/this removes its work items and can.t be undone/i)).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "Delete" });
    expect(confirmButton).toBeDisabled();

    const input = screen.getByPlaceholderText("INBOX");
    fireEvent.change(input, { target: { value: "inbo" } });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(input, { target: { value: "inbox" } }); // case matters
    expect(confirmButton).toBeDisabled();
    fireEvent.change(input, { target: { value: "INBOX" } });
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe("/api/pm/projects/p1");
    expect(del.body).toEqual({ confirm_identifier: "INBOX" });
    expect(toast).toHaveBeenCalledWith("Project deleted", "success");
    // Back on the index, still on the Archived filter — and nothing is archived now.
    await waitFor(() => expect(screen.getByText("No archived projects.")).toBeInTheDocument());
  });

  it("an ADMIN may delete too", async () => {
    session.role = "admin";
    const banner = await openArchived();
    expect(within(banner).getByRole("button", { name: /delete permanently/i })).toBeInTheDocument();
  });

  it("a refusal from the API reads as plain words, never the wire code", async () => {
    deleteFails = { status: 409, error: "project_not_archived" };
    const banner = await openArchived();
    fireEvent.click(within(banner).getByRole("button", { name: /delete permanently/i }));
    fireEvent.change(await screen.findByPlaceholderText("INBOX"), { target: { value: "INBOX" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/archive it first/i), "error"));
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining("project_not_archived"), expect.anything());
    // The project is still there.
    expect(projects).toHaveLength(1);
  });
});
