// ModulesView (WARP-3521): the module grid, the detail with its work items, and
// the new / edit / add-items / delete flows. The orchestrator is faked at the
// authFetch seam (as detail.test.tsx does), so the real usePm hooks run and the
// assertions are on the exact requests that leave the browser.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { MAX_ADD, ModulesView, isModuleOverdue, moduleDates, validateModuleForm } from "./modules";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmModule, PmPlanningProgress, PmProject, PmState, PmWorkItem } from "./types";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}
const calls: Call[] = [];

interface World {
  modules: PmModule[];
  moduleItems: PmWorkItem[];
  projectItems: PmWorkItem[];
  failures: Record<string, { status: number; error: string }>;
}
let world: World;

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url}`;
    const refused = Object.entries(world.failures).find(([needle]) => key.includes(needle));
    if (refused) return reply({ error: refused[1].error }, refused[1].status);

    if (method === "GET") {
      if (url.endsWith("/projects/p/modules")) return reply({ modules: world.modules });
      if (/\/modules\/[^/]+\/work-items$/.test(url)) {
        return reply({ work_items: world.moduleItems, total: world.moduleItems.length });
      }
      if (url.split("?")[0].endsWith("/projects/p/work-items")) return reply({ work_items: world.projectItems, total: world.projectItems.length, nextCursor: null });
      if (url.endsWith("/pm/people")) {
        return reply({
          people: [
            { id: "u-alice", displayName: "Alice Adams", avatarUrl: null },
          ],
        });
      }
      return reply({});
    }
    if (method === "POST" && url.endsWith("/projects/p/modules")) {
      const m = module_({ id: "m-new", name: String(body?.name), status: (body?.status as PmModule["status"]) ?? "backlog" });
      world.modules.push(m);
      return reply({ module: m }, 201);
    }
    if (method === "POST" && /\/modules\/[^/]+\/work-items$/.test(url)) {
      const ids = (body?.work_item_ids as string[]) ?? [];
      world.moduleItems = [...world.moduleItems, ...world.projectItems.filter((i) => ids.includes(i.id))];
      return reply({ added: ids.length, module: world.modules[0] });
    }
    if (method === "DELETE" && /\/modules\/[^/]+\/work-items\/[^/]+$/.test(url)) {
      const itemId = url.split("/").pop()!;
      world.moduleItems = world.moduleItems.filter((i) => i.id !== itemId);
      return reply({ removed: 1, module: world.modules[0] });
    }
    if (method === "PATCH" && /\/modules\/[^/]+$/.test(url)) {
      return reply({ module: { ...world.modules[0], name: String(body?.name ?? world.modules[0].name) } });
    }
    if (method === "DELETE" && /\/modules\/[^/]+$/.test(url)) {
      world.modules = world.modules.filter((m) => !url.endsWith(m.id));
      return reply({ deleted: "x" });
    }
    return reply({});
  }),
}));

const STATES: PmState[] = [
  { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
];

const PROJECT: PmProject = {
  id: "p",
  workspaceId: "w",
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

const progress = (over: Partial<PmPlanningProgress> = {}): PmPlanningProgress => ({
  total: 0,
  completed: 0,
  cancelled: 0,
  totalEstimate: 0,
  completedEstimate: 0,
  cancelledEstimate: 0,
  ...over,
});

function module_(over: Partial<PmModule> = {}): PmModule {
  return {
    id: "m1",
    projectId: "p",
    name: "Spring launch",
    description: null,
    leadId: null,
    status: "in_progress",
    startDate: null,
    targetDate: null,
    progress: progress(),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function item(id: string, key: string): PmWorkItem {
  return {
    id,
    projectId: "p",
    sequenceId: 1,
    key,
    name: `Task ${key}`,
    descriptionHtml: null,
    stateId: "s1",
    state: STATES[0],
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
    sortOrder: 1,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function renderModules(opts: { readOnly?: boolean } = {}) {
  const onOpenItem = vi.fn();
  const onChanged = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, id === "u-alice" ? "Alice Adams" : "Tester")}>
        <ModulesView project={PROJECT} readOnly={!!opts.readOnly} onOpenItem={onOpenItem} onChanged={onChanged} />
      </PeopleContext.Provider>
    </SWRConfig>,
  );
  return { onOpenItem, onChanged };
}

async function openModule(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name},`) }));
  await screen.findByRole("button", { name: /All modules/ });
}

beforeEach(() => {
  calls.length = 0;
  toast.mockReset();
  world = { modules: [], moduleItems: [], projectItems: [], failures: {} };
});

// ── pure helpers ──────────────────────────────────────────────────────────────

describe("module helpers", () => {
  it("validateModuleForm: a name, and a target that is not before the start", () => {
    expect(validateModuleForm({ name: "x", start: "", target: "" })).toEqual({});
    expect(validateModuleForm({ name: " ", start: "", target: "" }).name).toBe("Name can't be empty.");
    expect(validateModuleForm({ name: "x", start: "2026-12-01", target: "2026-10-05" }).dates).toBe(
      "Target date can't be before the start date.",
    );
    expect(validateModuleForm({ name: "x", start: "2026-10-05", target: "2026-10-05" }).dates).toBeUndefined();
  });

  it("isModuleOverdue: past target and still open — never for a finished or dropped module", () => {
    const m = (status: PmModule["status"], targetDate: string | null) => ({ status, targetDate });
    expect(isModuleOverdue(m("in_progress", "2026-10-01"), "2026-10-05")).toBe(true);
    expect(isModuleOverdue(m("planned", "2026-10-05"), "2026-10-05")).toBe(false); // due today is not late
    expect(isModuleOverdue(m("completed", "2026-10-01"), "2026-10-05")).toBe(false);
    expect(isModuleOverdue(m("cancelled", "2026-10-01"), "2026-10-05")).toBe(false);
    expect(isModuleOverdue(m("backlog", null), "2026-10-05")).toBe(false);
  });

  it("moduleDates reads a target as a target, not as an end", () => {
    expect(moduleDates("2026-10-05", "2026-12-01")).toBe("Oct 5 – Dec 1");
    expect(moduleDates(null, "2026-12-01")).toBe("Target Dec 1");
    expect(moduleDates("2026-10-05", null)).toBe("Starts Oct 5");
    expect(moduleDates(null, null)).toBe("No dates set");
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe("ModulesView — list", () => {
  it("shows a skeleton while loading", () => {
    renderModules();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("shows each module's status, lead, target and progress", async () => {
    world.modules = [
      module_({ id: "m1", name: "Spring launch", leadId: "u-alice", targetDate: "2099-12-01", progress: progress({ total: 10, completed: 4, cancelled: 2 }) }),
      module_({ id: "m2", name: "Old migration", status: "completed", progress: progress({ total: 3, completed: 3 }) }),
    ];
    renderModules();
    const card = await screen.findByRole("button", { name: "Spring launch, In progress" });
    expect(within(card).getByText("In progress")).toBeInTheDocument();
    expect(within(card).getByText("Lead — Alice Adams")).toBeInTheDocument();
    expect(within(card).getByText("Target Dec 1")).toBeInTheDocument();
    expect(within(card).getByText("4 of 8 done · 2 cancelled")).toBeInTheDocument();
    expect(within(card).getByRole("progressbar", { name: "Spring launch progress" })).toHaveAttribute("aria-valuenow", "50");

    const done = screen.getByRole("button", { name: "Old migration, Completed" });
    expect(within(done).getByText("No lead")).toBeInTheDocument();
    expect(within(done).queryByText(/Target/)).toBeNull();
  });

  it("a card's lead and progress ride along as its description", async () => {
    world.modules = [module_({ leadId: "u-alice", progress: progress({ total: 4, completed: 1 }) })];
    renderModules();
    const card = await screen.findByRole("button", { name: "Spring launch, In progress" });
    const described = (card.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described.join(" ")).toContain("Lead — Alice Adams");
    expect(described.join(" ")).toContain("1 of 4 done");
  });

  it("flags a module past its target in words, not only in colour", async () => {
    world.modules = [module_({ targetDate: "2020-01-15" })];
    renderModules();
    expect(await screen.findByText(/Past target/)).toBeInTheDocument();
  });

  it("empty: calm copy with a New module CTA for writers", async () => {
    renderModules();
    expect(await screen.findByText("No modules yet.")).toBeInTheDocument();
    expect(screen.getByText("Group work into bigger efforts here.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /New module/ }).length).toBeGreaterThan(0);
  });

  it("read-only: no New module anywhere", async () => {
    renderModules({ readOnly: true });
    expect(await screen.findByText("No modules yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New module/ })).toBeNull();
  });

  it("error: says so and can be retried", async () => {
    world.failures["GET /api/pm/projects/p/modules"] = { status: 500, error: "boom" };
    renderModules();
    expect(await screen.findByText("Couldn't load modules.")).toBeInTheDocument();
    expect(screen.getByText("Check the appliance connection and try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("a card opens with Enter", async () => {
    world.modules = [module_()];
    renderModules();
    fireEvent.keyDown(await screen.findByRole("button", { name: "Spring launch, In progress" }), { key: "Enter" });
    expect(await screen.findByRole("button", { name: /All modules/ })).toBeInTheDocument();
  });
});

// ── new / edit ────────────────────────────────────────────────────────────────

describe("ModulesView — new module", () => {
  async function openNew() {
    fireEvent.click((await screen.findAllByRole("button", { name: /New module/ }))[0]);
    return screen.findByLabelText("Name");
  }

  it("names an empty name once the owner tries, and sends nothing", async () => {
    renderModules();
    await openNew();
    fireEvent.click(screen.getByRole("button", { name: "Create module" }));
    expect(await screen.findByText("Name can't be empty.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses a target before the start as the owner types", async () => {
    renderModules();
    fireEvent.change(await openNew(), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-12-01" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-10-05" } });
    expect(await screen.findByText("Target date can't be before the start date.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create module" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("offers the member-readable PM roster's local people as leads", async () => {
    renderModules();
    await openNew();
    const lead = screen.getByLabelText("Lead") as HTMLSelectElement;
    await waitFor(() => expect(within(lead).getAllByRole("option").length).toBe(2));
    expect(within(lead).getAllByRole("option").map((o) => o.textContent)).toEqual(["No lead", "Alice Adams"]);
  });

  it("sends the status, lead and dates exactly as chosen — dates verbatim, never through a Date", async () => {
    renderModules();
    fireEvent.change(await openNew(), { target: { value: " Spring launch " } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "planned" } });
    await waitFor(() => expect(within(screen.getByLabelText("Lead")).getAllByRole("option").length).toBe(2));
    fireEvent.change(screen.getByLabelText("Lead"), { target: { value: "u-alice" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-05" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Create module" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/projects/p/modules"))).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/projects/p/modules"))!.body).toEqual({
      name: "Spring launch",
      status: "planned",
      lead_id: "u-alice",
      start_date: "2026-10-05",
      target_date: "2026-12-01",
    });
    expect(toast).toHaveBeenCalledWith("Module created", "success");
    expect(await screen.findByRole("heading", { name: "Spring launch" })).toBeInTheDocument();
  });

  it("a refusal is a sentence, and the dialog stays", async () => {
    world.failures["POST /api/pm/projects/p/modules"] = { status: 422, error: "lead_is_guest" };
    renderModules();
    fireEvent.change(await openNew(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create module" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("A guest can't lead a module or a project. Pick someone on your team.", "error");
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
});

describe("ModulesView — edit module", () => {
  it("clearing the lead and the dates sends null", async () => {
    world.modules = [module_({ leadId: "u-alice", startDate: "2026-10-05", targetDate: "2026-12-01" })];
    renderModules();
    await openModule("Spring launch");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(within(screen.getByLabelText("Lead")).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("Lead"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Target date"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      name: "Spring launch",
      description: null,
      status: "in_progress",
      lead_id: null,
      start_date: null,
      target_date: null,
    });
  });
});

// ── detail ────────────────────────────────────────────────────────────────────

describe("ModulesView — detail", () => {
  beforeEach(() => {
    world.modules = [module_({ leadId: "u-alice", startDate: "2026-10-05", targetDate: "2099-12-01", progress: progress({ total: 2, completed: 1 }) })];
    world.moduleItems = [item("w1", "INBOX-1"), item("w2", "INBOX-2")];
    world.projectItems = [item("w1", "INBOX-1"), item("w2", "INBOX-2"), item("w3", "INBOX-3"), item("w4", "INBOX-4")];
  });

  it("lists the module's work items and hands one to the page's drawer", async () => {
    const { onOpenItem } = renderModules();
    await openModule("Spring launch");
    expect(await screen.findByText("INBOX-1")).toBeInTheDocument();
    expect(screen.getByText("Lead — Alice Adams")).toBeInTheDocument();
    expect(screen.getByText(/Oct 5 – Dec 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Task INBOX-2" }));
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "w2" }));
  });

  it("removing an item is one request, announced, and the list follows", async () => {
    const { onChanged } = renderModules();
    await openModule("Spring launch");
    const removeFirst = await screen.findByRole("button", { name: "Remove INBOX-1 from Spring launch" });
    removeFirst.focus();
    fireEvent.click(removeFirst);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/modules/m1/work-items/w1"))).toBe(true));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Removed INBOX-1 from Spring launch."));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("INBOX-1")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove INBOX-2 from Spring launch" })).toHaveFocus());
  });

  it("hands focus to the panel heading when removing the last item", async () => {
    world.moduleItems = [item("w1", "INBOX-1")];
    const { onChanged } = renderModules();
    await openModule("Spring launch");
    const remove = await screen.findByRole("button", { name: "Remove INBOX-1 from Spring launch" });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove INBOX-1 from Spring launch" })).toBeNull());
    const heading = screen.getByText(/^Work items/).closest(".pm-focus-target");
    expect(heading).toHaveFocus();
  });

  it("adding: offers only items not already in the module, filters by search, and posts the chosen ids", async () => {
    renderModules();
    await openModule("Spring launch");
    fireEvent.click(await screen.findByRole("button", { name: /Add work items/ }));
    const list = await screen.findByRole("group", { name: "Work items" });
    await within(list).findByText("INBOX-3");
    expect(within(list).queryByText("INBOX-1")).toBeNull(); // already in
    expect(within(list).getAllByRole("checkbox")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "INBOX-4" } });
    expect(within(list).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "" } });

    fireEvent.click(within(list).getByRole("checkbox", { name: /INBOX-3/ }));
    fireEvent.click(within(list).getByRole("checkbox", { name: /INBOX-4/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 items" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/modules/m1/work-items"))).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/modules/m1/work-items"))!.body).toEqual({
      work_item_ids: ["w3", "w4"],
    });
    expect(toast).toHaveBeenCalledWith("Added 2 items to Spring launch", "success");
  });

  it("the Add button says what it will do, and is off until something is picked", async () => {
    renderModules();
    await openModule("Spring launch");
    fireEvent.click(await screen.findByRole("button", { name: /Add work items/ }));
    await screen.findByRole("group", { name: "Work items" });
    expect(screen.getByRole("button", { name: "Add items" })).toBeDisabled();
  });

  it("an add is capped at the API's bound", () => {
    expect(MAX_ADD).toBe(200);
  });

  it("a search with no match is said plainly", async () => {
    renderModules();
    await openModule("Spring launch");
    fireEvent.click(await screen.findByRole("button", { name: /Add work items/ }));
    await screen.findByRole("group", { name: "Work items" });
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "zzz" } });
    expect(screen.getByText("No work items match that search.")).toBeInTheDocument();
  });

  it("does not claim the whole project is in the module when the picker hit its 100-item page cap", async () => {
    world.projectItems = Array.from({ length: 100 }, (_, i) => item(`cap-${i}`, `CAP-${i}`));
    world.moduleItems = [...world.projectItems];
    renderModules();
    await openModule("Spring launch");
    fireEvent.click(await screen.findByRole("button", { name: /Add work items/ }));
    expect(
      await screen.findByText("Showing the first 100 work items. All shown items are already in this module."),
    ).toBeInTheDocument();
  });

  it("an empty module says how to start it", async () => {
    world.moduleItems = [];
    renderModules();
    await openModule("Spring launch");
    expect(await screen.findByText("No work items in this module yet.")).toBeInTheDocument();
    expect(screen.getByText("Add some to start tracking progress.")).toBeInTheDocument();
  });

  it("delete asks first, then returns to the list", async () => {
    renderModules();
    await openModule("Spring launch");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete this module?")).toBeInTheDocument();
    expect(screen.getByText("Its work items stay where they are. This can't be undone.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete module" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/modules/m1"))).toBe(true));
    expect(toast).toHaveBeenCalledWith("Module deleted", "success");
    expect(await screen.findByText("No modules yet.")).toBeInTheDocument();
  });

  it("read-only: items are listed with no Add, Edit, Delete or Remove", async () => {
    renderModules({ readOnly: true });
    await openModule("Spring launch");
    expect(await screen.findByText("INBOX-1")).toBeInTheDocument();
    for (const name of [/Add work items/, "Edit", "Delete", /^Remove INBOX/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});
