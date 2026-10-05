// WARP-3520 -- project settings and the Archived items list, driven through the
// project header's menu exactly as a person would: roles decide what is offered,
// every write is the exact request the owner's click implies, and a refused
// write is said plainly with the screen left as the server holds it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ProjectMenu } from "./ProjectMenu";
import { PeopleContext } from "../bits";
import { makePerson } from "../config";
import type { PmProject } from "../types";

type Call = { url: string; method: string; body?: any };
type Reply = unknown | { __status: number; body: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; body?: any }>,
  handler: null as null | ((c: { url: string; method: string; body?: any }) => unknown),
  toast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const call = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    h.calls.push(call);
    const out = (await h.handler!(call)) as Reply;
    const wrapped = out !== null && typeof out === "object" && "__status" in (out as object);
    const status = wrapped ? (out as { __status: number }).__status : 200;
    const body = wrapped ? (out as { body: unknown }).body : out;
    return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
  }),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));

const state = (id: string, name: string, group: string, sortOrder: number, isDefault = false, color = "#6366f1") => ({
  id,
  projectId: "p1",
  name,
  group,
  color,
  sortOrder,
  isDefault,
});
const STATES = [
  state("s-back", "Backlog", "backlog", 0, false, "#94a3b8"),
  state("s-todo", "Todo", "unstarted", 1, true),
  state("s-prog", "In Progress", "started", 2, false, "#f59e0b"),
  state("s-done", "Done", "completed", 3, false, "#22c55e"),
];
const LABELS = [
  { id: "l-bug", projectId: "p1", name: "bug", color: "#ef4444" },
  { id: "l-ui", projectId: "p1", name: "frontend", color: "#6366f1" },
];
const PROPS = [
  { id: "f-text", projectId: "p1", name: "Customer ref", type: "text", options: null, sortOrder: 0 },
  {
    id: "f-sev",
    projectId: "p1",
    name: "Severity",
    type: "select",
    options: [
      { id: "o-low", label: "Low", color: null },
      { id: "o-high", label: "High", color: "#ef4444" },
    ],
    sortOrder: 1,
  },
];
const USERS = [
  { id: "nc-ana", userId: "u-ana", username: "ana", displayName: "Ana Lopez" },
  { id: "nc-bo", userId: "u-bo", username: "bo", displayName: "Bo Chen" },
];
const DEPARTMENTS = [
  { id: "d-clin", name: "Clinical", kind: "DEPARTMENT", parentId: null },
  { id: "d-home", name: "Household", kind: "HOUSEHOLD", parentId: null },
];
const COMPANIES = [{ id: "c-acme", name: "ACME Dental" }];
const ARCHIVED = [
  { id: "w-old", projectId: "p1", key: "INBOX-4", name: "Old plan", type: "task", archivedAt: "2026-10-01T00:00:00.000Z", isArchived: true },
  { id: "w-bug", projectId: "p1", key: "INBOX-9", name: "Retired bug", type: "bug", archivedAt: "2026-10-02T00:00:00.000Z", isArchived: true },
];

const PROJECT: PmProject = {
  id: "p1",
  workspaceId: "ws1",
  workspaceSlug: "home",
  name: "Inbox",
  identifier: "INBOX",
  description: "Where work lands",
  icon: "board",
  color: "#6366f1",
  leadId: "u-ana",
  department: null,
  companyId: null,
  archived: false,
  openCount: 0,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

function defaults(c: Call): Reply {
  const { url, method } = c;
  if (method === "GET") {
    if (url.endsWith("/states")) return { states: STATES };
    if (url.endsWith("/labels")) return { labels: LABELS };
    if (url.endsWith("/properties")) return { properties: PROPS };
    if (url.includes("archived=only")) return { work_items: ARCHIVED };
    if (url === "/api/pm/people") return { people: USERS.filter((u) => u.userId).map((u) => ({ id: u.userId, displayName: u.displayName, avatarUrl: null })) };
    if (url === "/api/departments") return { departments: DEPARTMENTS };
    if (url.startsWith("/api/crm/companies")) return { companies: COMPANIES, total: 1 };
    return {};
  }
  if (method === "DELETE") return { deleted: "x" };
  if (url.endsWith("/properties") && method === "POST") return { property: { ...PROPS[1], id: "f-new", name: "Phase", options: [] } };
  return { project: PROJECT, state: STATES[0], label: LABELS[0], property: PROPS[0], states: STATES, properties: PROPS };
}
const fail = (status: number, error: string) => ({ __status: status, body: { error } });

function renderMenu(over: { readOnly?: boolean; canDeleteItems?: boolean; canManageFields?: boolean; project?: Partial<PmProject> } = {}) {
  const onProjectChanged = vi.fn();
  const onItemsChanged = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, USERS.find((u) => u.userId === id)?.displayName ?? "Tester")}>
        <ProjectMenu
          project={{ ...PROJECT, ...over.project }}
          readOnly={over.readOnly ?? false}
          canDeleteItems={over.canDeleteItems ?? true}
          canManageFields={over.canManageFields ?? true}
          onProjectChanged={onProjectChanged}
          onItemsChanged={onItemsChanged}
        />
      </PeopleContext.Provider>
    </SWRConfig>,
  );
  return { onProjectChanged, onItemsChanged };
}

const writes = () => h.calls.filter((c) => c.method !== "GET");
const lastWrite = () => writes().at(-1);
async function openSettings(tab?: string) {
  fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Project settings" }));
  const dialog = await screen.findByRole("dialog", { name: /Project settings/ });
  if (tab) fireEvent.click(within(dialog).getByRole("tab", { name: tab }));
  return dialog;
}
async function openArchived() {
  fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Archived items" }));
  return screen.findByRole("dialog", { name: "Archived items" });
}

beforeEach(() => {
  h.calls.length = 0;
  h.toast.mockReset();
  h.handler = defaults;
});

describe("the project menu", () => {
  it("offers settings and archived items to a writer", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Project settings", "Archived items"]);
  });

  it("offers only archived items to a reader — settings are absent, not disabled", () => {
    renderMenu({ readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Archived items"]);
  });

  it("returns focus to the menu button when a dialog opened from it closes", async () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Project actions" });
    await openSettings();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Project settings/ })).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("settings dialog tabs", () => {
  it("is the ARIA tab pattern: roving focus with Arrow, Home and End", async () => {
    renderMenu();
    const dialog = await openSettings();
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Details", "States", "Labels", "Fields"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveFocus();
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(tabs[3]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs[3], { key: "ArrowRight" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel")).toBeInTheDocument();
  });
});

describe("details", () => {
  it("saves only what changed", async () => {
    const { onProjectChanged } = renderMenu();
    const dialog = await openSettings();
    const save = within(dialog).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Front office" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/projects/p1", method: "PATCH", body: { name: "Front office" } }));
    await waitFor(() => expect(onProjectChanged).toHaveBeenCalled());
    expect(h.toast).toHaveBeenCalledWith("Project updated.", "success");
  });

  it("sends null to clear, and the wire names for lead, department and customer", async () => {
    renderMenu();
    const dialog = await openSettings();
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "  " } });
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "Bo Chen" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText("Lead"), { target: { value: "u-bo" } });
    fireEvent.change(within(dialog).getByLabelText("Department"), { target: { value: "d-clin" } });
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "ACME Dental" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText("Customer"), { target: { value: "c-acme" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "doc" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Amber" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(lastWrite()?.body).toEqual({
        description: null,
        icon: "doc",
        color: "#f59e0b",
        leadId: "u-bo",
        department_id: "d-clin",
        company_id: "c-acme",
      }),
    );
  });

  it("never offers Household as a department (the API refuses it)", async () => {
    renderMenu();
    const dialog = await openSettings();
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "Clinical" })).toBeInTheDocument());
    expect(within(dialog).queryByRole("option", { name: "Household" })).toBeNull();
  });

  it("refuses an empty name inline and keeps Save off", async () => {
    renderMenu();
    const dialog = await openSettings();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  " } });
    expect(within(dialog).getByText("Name can't be empty.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("says plainly when the save is refused and stays dirty", async () => {
    h.handler = (c) => (c.method === "PATCH" ? fail(422, "lead_is_guest") : defaults(c));
    renderMenu();
    const dialog = await openSettings();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Front office" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(h.toast).toHaveBeenCalledWith(expect.any(String), "error");
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("without the people list the lead is shown but cannot be changed; without the CRM there is no customer field", async () => {
    h.handler = (c) =>
        c.url === "/api/pm/people" || c.url.startsWith("/api/crm/") ? fail(404, "module_disabled") : defaults(c);
    renderMenu();
    const dialog = await openSettings();
    const lead = within(dialog).getByLabelText("Lead") as HTMLSelectElement;
    expect(within(lead).getByRole("option", { name: "Ana Lopez" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Customer")).toBeNull();
  });
});

describe("states", () => {
  it("lists the states in order with their group and the default marked", async () => {
    renderMenu();
    const dialog = await openSettings("States");
    const items = await within(dialog).findAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(items[1]).getByText("Default")).toBeInTheDocument();
    expect(within(items[0]).getByText("Backlog", { selector: ".pm-tag" })).toBeInTheDocument();
    expect(within(items[3]).getByText("Done", { selector: ".pm-tag" })).toBeInTheDocument();
  });

  it("renames on blur and refreshes the board", async () => {
    const { onItemsChanged } = renderMenu();
    const dialog = await openSettings("States");
    const input = await within(dialog).findByLabelText("Name of Backlog");
    fireEvent.change(input, { target: { value: "Ideas" } });
    fireEvent.blur(input);
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/states/s-back", method: "PATCH", body: { name: "Ideas" } }));
    await waitFor(() => expect(onItemsChanged).toHaveBeenCalled());
  });

  it("recolours from the swatch picker", async () => {
    renderMenu();
    const dialog = await openSettings("States");
    fireEvent.click(await within(dialog).findByRole("button", { name: /Color of Backlog/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Pink" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/states/s-back", body: { color: "#ec4899" } }));
  });

  it("makes another state the default — and not a done one", async () => {
    renderMenu();
    const dialog = await openSettings("States");
    await within(dialog).findByLabelText("Name of Todo");
    expect(within(dialog).getByRole("button", { name: "Make Done the default" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make In Progress the default" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/states/s-prog", method: "PATCH", body: { isDefault: true } }));
  });

  it("reorders in one request listing every state, and the new order is shown at once", async () => {
    let settle!: () => void;
    const gate = new Promise<void>((r) => (settle = r));
    h.handler = (c) => (c.url.endsWith("/states/reorder") ? gate.then(() => ({ states: STATES })) : defaults(c));
    renderMenu();
    const dialog = await openSettings("States");
    await within(dialog).findByLabelText("Name of Todo");
    fireEvent.click(within(dialog).getByRole("button", { name: "Move Todo up" }));
    await waitFor(() =>
      expect(lastWrite()).toMatchObject({
        url: "/api/pm/projects/p1/states/reorder",
        method: "POST",
        body: { state_ids: ["s-todo", "s-back", "s-prog", "s-done"] },
      }),
    );
    // Optimistic: Todo is already first while the write is still open.
    const names = within(dialog).getAllByRole("listitem").map((li) => within(li).getAllByRole("textbox")[0].getAttribute("aria-label"));
    expect(names).toEqual(["Name of Todo", "Name of Backlog", "Name of In Progress", "Name of Done"]);
    settle();
  });

  it("cannot delete the default state, and says how to", async () => {
    renderMenu();
    const dialog = await openSettings("States");
    await within(dialog).findByLabelText("Name of Todo");
    const del = within(dialog).getByRole("button", { name: "Delete Todo" });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", "Make another state the default first.");
  });

  it("deletes with a chosen place for the items to go, defaulting to the default state", async () => {
    renderMenu();
    const dialog = await openSettings("States");
    await within(dialog).findByLabelText("Name of In Progress");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete In Progress" }));
    const confirm = await screen.findByRole("dialog", { name: /Delete .In Progress/ });
    const target = within(confirm).getByLabelText("Move its items to") as HTMLSelectElement;
    expect(target.value).toBe("s-todo");
    expect(within(target).queryByRole("option", { name: "In Progress" })).toBeNull();
    fireEvent.change(target, { target: { value: "s-done" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete state" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/states/s-prog?reassign_to=s-done", method: "DELETE" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Delete .In Progress/ })).toBeNull());
  });

  it("adds a state at the end with its group and colour", async () => {
    renderMenu();
    const dialog = await openSettings("States");
    await within(dialog).findByLabelText("Name of Todo");
    fireEvent.change(within(dialog).getByLabelText("New state name"), { target: { value: "Review" } });
    fireEvent.change(within(dialog).getByLabelText("New state group"), { target: { value: "started" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /New state color/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Violet" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add state" }));
    await waitFor(() =>
      expect(lastWrite()).toMatchObject({
        url: "/api/pm/projects/p1/states",
        method: "POST",
        body: { name: "Review", group: "started", color: "#8b5cf6", sortOrder: 4 },
      }),
    );
  });

  it("explains a refusal in plain words", async () => {
    h.handler = (c) => (c.method === "DELETE" ? fail(409, "state_is_last") : defaults(c));
    renderMenu();
    const dialog = await openSettings("States");
    await within(dialog).findByLabelText("Name of In Progress");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete In Progress" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: /Delete .In Progress/ })).getByRole("button", { name: "Delete state" }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/needs at least one column/), "error"));
  });
});

describe("labels", () => {
  it("renames, recolours and creates", async () => {
    renderMenu();
    const dialog = await openSettings("Labels");
    const input = await within(dialog).findByLabelText("Name of label bug");
    fireEvent.change(input, { target: { value: "defect" } });
    fireEvent.blur(input);
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/labels/l-bug", method: "PATCH", body: { name: "defect" } }));

    fireEvent.click(within(dialog).getByRole("button", { name: /Color of frontend/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Green" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/labels/l-ui", body: { color: "#22c55e" } }));

    fireEvent.change(within(dialog).getByLabelText("New label name"), { target: { value: "urgent" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add label" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/projects/p1/labels", method: "POST", body: { name: "urgent", color: "#6366f1" } }));
  });

  it("confirms before deleting, and says what it does to the items", async () => {
    renderMenu();
    const dialog = await openSettings("Labels");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Delete label bug" }));
    const confirm = await screen.findByRole("dialog", { name: /Delete the label/ });
    expect(within(confirm).getByText(/removed from every item that has it/i)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete label" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/labels/l-bug", method: "DELETE" }));
  });

  it("shows an empty state", async () => {
    h.handler = (c) => (c.url.endsWith("/labels") ? { labels: [] } : defaults(c));
    renderMenu();
    const dialog = await openSettings("Labels");
    expect(await within(dialog).findByText("No labels in this project yet.")).toBeInTheDocument();
  });
});

describe("fields", () => {
  it("lets a manager rename, reorder, add and delete", async () => {
    renderMenu();
    const dialog = await openSettings("Fields");
    const name = await within(dialog).findByLabelText("Name of field Customer ref");
    fireEvent.change(name, { target: { value: "Ref" } });
    fireEvent.blur(name);
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/properties/f-text", method: "PATCH", body: { name: "Ref" } }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Move Severity up" }));
    await waitFor(() =>
      expect(lastWrite()).toMatchObject({
        url: "/api/pm/projects/p1/properties/reorder",
        body: { property_ids: ["f-sev", "f-text"] },
      }),
    );

    fireEvent.change(within(dialog).getByLabelText("New field name"), { target: { value: "Budget" } });
    fireEvent.change(within(dialog).getByLabelText("New field type"), { target: { value: "number" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/projects/p1/properties", method: "POST", body: { name: "Budget", type: "number" } }));
  });

  it("gives a new select field an options editor straight away", async () => {
    renderMenu();
    const dialog = await openSettings("Fields");
    await within(dialog).findByLabelText("New field name");
    fireEvent.change(within(dialog).getByLabelText("New field name"), { target: { value: "Phase" } });
    fireEvent.change(within(dialog).getByLabelText("New field type"), { target: { value: "select" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ method: "POST", body: { name: "Phase", type: "select", options: [] } }));
  });

  it("edits options, warns before an option is removed, and sends the whole list", async () => {
    renderMenu();
    const dialog = await openSettings("Fields");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Edit options of Severity" }));
    const save = within(dialog).getByRole("button", { name: "Save options" });
    expect(save).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove option High" }));
    expect(within(dialog).getByText(/Removing 1 option clears it from every item that uses it/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add option" }));
    fireEvent.change(within(dialog).getByLabelText("Option 2 name"), { target: { value: "Critical" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(lastWrite()).toMatchObject({
        url: "/api/pm/properties/f-sev",
        method: "PATCH",
        body: { options: [{ id: "o-low", label: "Low", color: null }, { label: "Critical", color: null }] },
      }),
    );
  });

  it("confirms before deleting a field and says its values go too", async () => {
    renderMenu();
    const dialog = await openSettings("Fields");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Delete field Severity" }));
    const confirm = await screen.findByRole("dialog", { name: /Delete the field/ });
    expect(within(confirm).getByText(/values are removed from every item/i)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete field" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/properties/f-sev", method: "DELETE" }));
  });

  it("shows a non-manager the fields and why they cannot change them", async () => {
    renderMenu({ canManageFields: false });
    const dialog = await openSettings("Fields");
    expect(await within(dialog).findByText("Customer ref")).toBeInTheDocument();
    expect(within(dialog).getByText(/Only owners, admins and the project lead can change fields/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("New field name")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Delete field/ })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: /Name of field/ })).toBeNull();
  });

  it("says so when the name is taken", async () => {
    h.handler = (c) => (c.method === "POST" ? fail(409, "property_name_taken") : defaults(c));
    renderMenu();
    const dialog = await openSettings("Fields");
    await within(dialog).findByLabelText("New field name");
    fireEvent.change(within(dialog).getByLabelText("New field name"), { target: { value: "Severity" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This project already has a field with that name.");
  });
});

describe("archived items", () => {
  it("walks later cursor pages and keeps the first page visible while they load", async () => {
    let release!: (body: unknown) => void;
    const tail = new Promise((resolve) => { release = resolve; });
    h.handler = (c) => {
      if (!c.url.includes("archived=only")) return defaults(c);
      return new URL(c.url, "http://localhost").searchParams.has("cursor")
        ? tail
        : { work_items: [ARCHIVED[0]], total: 2, nextCursor: "archive-tail" };
    };
    renderMenu();
    const dialog = await openArchived();
    expect(await within(dialog).findByText("Old plan")).toBeInTheDocument();
    expect(await within(dialog).findByText("Showing 1 of 2 archived items.")).toBeInTheDocument();
    await act(async () => { release({ work_items: [ARCHIVED[1]], total: 2, nextCursor: null }); });
    expect(await within(dialog).findByText("Retired bug")).toBeInTheDocument();
    expect(within(dialog).getByText("Old plan")).toBeInTheDocument();
    expect(h.calls.some((c) => c.url.includes("cursor=archive-tail") && c.url.includes("archived=only"))).toBe(true);
  });

  it("retains a partial archive after a later page fails and retries that page", async () => {
    let tails = 0;
    h.handler = (c) => {
      if (!c.url.includes("archived=only")) return defaults(c);
      if (new URL(c.url, "http://localhost").searchParams.has("cursor")) {
        return ++tails === 1 ? fail(500, "boom") : { work_items: [ARCHIVED[1]], total: 2, nextCursor: null };
      }
      return { work_items: [ARCHIVED[0]], total: 2, nextCursor: "archive-tail" };
    };
    renderMenu();
    const dialog = await openArchived();
    expect(await within(dialog).findByText("Some archived items couldn't be loaded.")).toBeInTheDocument();
    expect(within(dialog).getByText("Old plan")).toBeInTheDocument();
    expect(within(dialog).queryByText("Nothing is archived.")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("Retired bug")).toBeInTheDocument();
    expect(within(dialog).getByText("Old plan")).toBeInTheDocument();
  });

  it("lists them with when they were archived, and restores one", async () => {
    const { onItemsChanged } = renderMenu();
    const dialog = await openArchived();
    expect(await within(dialog).findByText("Old plan")).toBeInTheDocument();
    expect(within(dialog).getByText("INBOX-9")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore INBOX-4" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/work-items/w-old/restore", method: "POST" }));
    await waitFor(() => expect(onItemsChanged).toHaveBeenCalled());
  });

  it("deletes for good only for an owner/admin, and only after the key is typed", async () => {
    renderMenu();
    const dialog = await openArchived();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Delete INBOX-9" }));
    const confirm = await screen.findByRole("dialog", { name: /Delete this item/ });
    const button = within(confirm).getByRole("button", { name: "Delete item" });
    expect(button).toBeDisabled();
    fireEvent.change(within(confirm).getByRole("textbox"), { target: { value: "INBOX-9" } });
    fireEvent.click(button);
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/work-items/w-bug", method: "DELETE" }));
  });

  it("hides restore from a reader and delete from anyone but an owner/admin", async () => {
    renderMenu({ readOnly: true, canDeleteItems: false });
    const dialog = await openArchived();
    expect(await within(dialog).findByText("Old plan")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("has an empty state", async () => {
    h.handler = (c) => (c.url.includes("archived=only") ? { work_items: [] } : defaults(c));
    renderMenu();
    const dialog = await openArchived();
    expect(await within(dialog).findByText("Nothing is archived.")).toBeInTheDocument();
  });

  it("says when the list cannot be loaded and retries", async () => {
    let attempts = 0;
    h.handler = (c) => {
      if (c.url.includes("archived=only")) return ++attempts === 1 ? fail(500, "boom") : { work_items: ARCHIVED };
      return defaults(c);
    };
    renderMenu();
    const dialog = await openArchived();
    expect(await within(dialog).findByText("Couldn't load archived items.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("Old plan")).toBeInTheDocument();
  });
});
