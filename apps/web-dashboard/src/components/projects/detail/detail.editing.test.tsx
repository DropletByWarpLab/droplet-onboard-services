// WARP-3520 -- the drawer's editors: inline edit of every property, optimistic
// update with rollback and an inline message, custom fields, relations, the
// archive / delete menu, and read-only for readers. The network is a handler
// table behind a mocked `authFetch`; every assertion is on what the user sees and
// on the exact request the editor sent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DetailDrawer } from "../detail";
import { PeopleContext } from "../bits";
import { makePerson } from "../config";
import type { PmWorkItem } from "../types";

type Call = { url: string; method: string; body?: any };
type Reply = unknown | { __status: number; body: unknown };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; method: string; body?: any }>,
  handler: null as null | ((c: { url: string; method: string; body?: any }) => unknown),
  toast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", role: "owner" } }),
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

const STATES = [
  { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p", name: "In Progress", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false },
  { id: "s3", projectId: "p", name: "Done", group: "completed", color: "#22c55e", sortOrder: 3, isDefault: false },
];
const USERS = [
  { id: "nc-ana", userId: "u-ana", username: "ana", displayName: "Ana Lopez" },
  { id: "nc-bo", userId: "u-bo", username: "bo", displayName: "Bo Chen" },
  { id: "nc-x", userId: null, username: "x", displayName: "No Local Row" },
];
const PROPERTIES = [
  { id: "pf-text", projectId: "p", name: "Customer ref", type: "text", options: null, sortOrder: 0 },
  { id: "pf-num", projectId: "p", name: "Budget", type: "number", options: null, sortOrder: 1 },
  { id: "pf-date", projectId: "p", name: "Go live", type: "date", options: null, sortOrder: 2 },
  { id: "pf-bool", projectId: "p", name: "Billable", type: "boolean", options: null, sortOrder: 3 },
  {
    id: "pf-sel",
    projectId: "p",
    name: "Severity",
    type: "select",
    options: [
      { id: "o-low", label: "Low", color: null },
      { id: "o-high", label: "High", color: "#ef4444" },
    ],
    sortOrder: 4,
  },
  {
    id: "pf-multi",
    projectId: "p",
    name: "Platforms",
    type: "multi_select",
    options: [
      { id: "o-ios", label: "iOS", color: null },
      { id: "o-and", label: "Android", color: null },
    ],
    sortOrder: 5,
  },
  { id: "pf-who", projectId: "p", name: "Reviewer", type: "member", options: null, sortOrder: 6 },
];
const RELATIONS = [
  { id: "r1", kind: "BLOCKS", direction: "blocks", relatedId: "w9", relatedKey: "OPS-9", relatedName: "Deploy the box", relatedProjectId: "other", crossProject: true, createdById: null, createdAt: "2026-10-01T00:00:00.000Z" },
  { id: "r2", kind: "RELATES", direction: "symmetric", relatedId: "w3", relatedKey: "INBOX-3", relatedName: "Third task", relatedProjectId: "p", crossProject: false, createdById: null, createdAt: "2026-10-01T00:00:00.000Z" },
];
const SEARCH = [
  { id: "w2", projectId: "p", key: "INBOX-2", name: "Second task" },
  { id: "w9", projectId: "other", key: "OPS-9", name: "Deploy the box" },
  { id: "w1", projectId: "p", key: "INBOX-1", name: "First task" },
];

const ITEM: PmWorkItem = {
  id: "w1",
  projectId: "p",
  sequenceId: 1,
  key: "INBOX-1",
  name: "First task",
  descriptionHtml: "<p>Original</p>",
  stateId: "s1",
  state: STATES[0] as PmWorkItem["state"],
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
  type: "task",
  estimate: null,
  properties: {},
};

/** The default network: every read the drawer makes, and a happy write. */
function defaults(c: Call): Reply {
  const { url, method, body } = c;
  if (method === "GET") {
    if (url.endsWith("/attachments")) return { attachments: [], limits: { maxBytes: 26214400 } };
    if (url.endsWith("/states")) return { states: STATES };
    if (url.endsWith("/labels")) return { labels: [] };
    if (url.endsWith("/properties")) return { properties: PROPERTIES };
    if (url.endsWith("/relations")) return { relations: RELATIONS };
    if (url.endsWith("/comments")) return { comments: [] };
    if (url.endsWith("/activity")) return { activity: [] };
    if (url === "/api/pm/people") return { people: USERS.filter((u) => u.userId).map((u) => ({ id: u.userId, displayName: u.displayName, avatarUrl: null })) };
    if (url === "/api/departments") return { departments: [] };
    if (url.includes("?parent=")) return { work_items: [] };
    if (url.includes("/api/pm/work-items?q=")) return { work_items: SEARCH };
    if (/\/api\/pm\/work-items\/[^/]+$/.test(url)) return { work_item: { ...ITEM, id: "w7", key: "INBOX-7", name: "Parent task" } };
    return {};
  }
  if (method === "DELETE" && url.startsWith("/api/pm/relations/")) return { deleted: "r1" };
  if (method === "DELETE" && !url.includes("/properties/")) return { deleted: "w1" };
  if (method === "POST" && url.endsWith("/relations")) return { relation: RELATIONS[0] };
  if (method === "POST" && url.endsWith("/archive")) return { work_item: { ...ITEM, isArchived: true } };
  if (method === "POST" && url.endsWith("/restore")) return { work_item: { ...ITEM, isArchived: false } };
  return { work_item: { ...ITEM, ...(body ?? {}) } };
}

const fail = (status: number, error: string, details?: unknown) => ({ __status: status, body: { error, details } });

function renderDrawer(over: { item?: Partial<PmWorkItem>; readOnly?: boolean; canDelete?: boolean } = {}) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const item = { ...ITEM, ...over.item } as PmWorkItem;
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, USERS.find((u) => u.userId === id)?.displayName ?? "Tester")}>
        <DetailDrawer item={item} onClose={onClose} onChanged={onChanged} readOnly={over.readOnly} canDelete={over.canDelete} />
      </PeopleContext.Provider>
    </SWRConfig>,
  );
  return { onClose, onChanged };
}

// Presence heartbeats keep a drawer visible to colleagues; they do not edit its work item.
const writes = (method?: string) => h.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/presence") && (!method || c.method === method));
const lastWrite = () => writes().at(-1);
/** Hold a write open so the optimistic state can be observed, then settle it. */
function deferred(reply: Reply) {
  let resolve!: (r: Reply) => void;
  const promise = new Promise<Reply>((r) => (resolve = r));
  return { promise, settle: () => resolve(reply) };
}

beforeEach(() => {
  h.calls.length = 0;
  h.toast.mockReset();
  h.handler = defaults;
});

describe("read-only for readers", () => {
  it("shows plain values and none of the editors", async () => {
    renderDrawer({ readOnly: true, item: { priority: "high", estimate: 3, type: "bug", assignees: ["u-ana"] } });
    await screen.findByText("First task");
    expect(screen.queryByRole("button", { name: /edit title/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit description/i })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /add assignee/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add link/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Item actions" })).toBeNull();
    // …but the values are there.
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Bug")).toBeInTheDocument();
    expect(screen.getByText(/3 points/)).toBeInTheDocument();
    expect(screen.getByText("Ana Lopez")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("OPS-9")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /remove link/i })).toBeNull();
  });
});

describe("title", () => {
  it("saves on Enter with the name already shown, and sends exactly { name }", async () => {
    const gate = deferred({ work_item: { ...ITEM, name: "Renamed" } });
    h.handler = (c) => (c.method === "PATCH" ? gate.promise : defaults(c));
    const { onChanged } = renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title: First task" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/work-items/w1", method: "PATCH", body: { name: "Renamed" } }));
    // The field stays up while the write is open; the name is committed once it lands.
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Renamed");
    gate.settle();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Edit title: Renamed" })).toBeInTheDocument();
  });

  it("Escape cancels the edit without a write — and does not close the drawer", async () => {
    const { onClose } = renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title: First task" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit title: First task" })).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses an empty name inline and keeps the field open", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title: First task" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Name can't be empty.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("rolls the name back and says so when the write is refused", async () => {
    h.handler = (c) => (c.method === "PATCH" ? fail(500, "boom") : defaults(c));
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title: First task" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(screen.queryByText("Renamed", { selector: "h2" })).toBeNull();
    // Still editing, with what was typed, so a retry is one keystroke away.
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Renamed");
  });
});

describe("description", () => {
  it("edits as plain text and stores sanitized paragraphs", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    const box = screen.getByRole("textbox", { name: "Description" });
    expect(box).toHaveValue("Original");
    fireEvent.change(box, { target: { value: "First <b>line</b>\nsecond line\n\nNew paragraph" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastWrite()).toMatchObject({
        method: "PATCH",
        body: { description_html: "<p>First &lt;b&gt;line&lt;/b&gt;<br>second line</p><p>New paragraph</p>" },
      }),
    );
  });

  it("clears the description when emptied, and cancels with Escape without a write", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastWrite()?.body).toEqual({ description_html: null }));

    h.calls.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Description" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("warns before flattening formatting somebody else wrote", async () => {
    renderDrawer({ item: { descriptionHtml: "<p>Intro</p><ul><li>One</li><li>Two</li></ul>" } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    expect(screen.getByText(/formatting that can't be kept here/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("Intro\n\n- One\n- Two");
  });
});

describe("built-in properties write what the user chose", () => {
  it("priority: instant, PATCH { priority }; refused → back to the old value with a message", async () => {
    const gate = deferred(fail(500, "boom"));
    h.handler = (c) => (c.method === "PATCH" ? gate.promise : defaults(c));
    renderDrawer();
    const select = (await screen.findByRole("combobox", { name: "Priority" })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "high" } });
    expect(select.value).toBe("high");
    await waitFor(() => expect(lastWrite()?.body).toEqual({ priority: "high" }));
    gate.settle();
    await waitFor(() => expect(select.value).toBe("none"));
    expect(h.toast).toHaveBeenCalledWith(expect.any(String), "error");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("state: goes through transition, not PATCH", async () => {
    renderDrawer();
    const select = (await screen.findByRole("combobox", { name: "State" })) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    fireEvent.change(select, { target: { value: "s2" } });
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/work-items/w1/transition", method: "POST", body: { state_id: "s2" } }));
  });

  it("type and estimate", async () => {
    renderDrawer();
    fireEvent.change(await screen.findByRole("combobox", { name: "Type" }), { target: { value: "bug" } });
    await waitFor(() => expect(lastWrite()?.body).toEqual({ type: "bug" }));

    const est = screen.getByRole("spinbutton", { name: "Estimate" });
    fireEvent.change(est, { target: { value: "5" } });
    fireEvent.blur(est);
    await waitFor(() => expect(lastWrite()?.body).toEqual({ estimate: 5 }));
  });

  it("estimate: out of range is refused inline and never sent; empty clears", async () => {
    renderDrawer({ item: { estimate: 3 } });
    const est = await screen.findByRole("spinbutton", { name: "Estimate" });
    fireEvent.change(est, { target: { value: "2000" } });
    fireEvent.blur(est);
    expect(await screen.findByText("Estimate must be between 0 and 1000.")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);

    fireEvent.change(est, { target: { value: "" } });
    fireEvent.blur(est);
    await waitFor(() => expect(lastWrite()?.body).toEqual({ estimate: null }));
  });

  it("dates: sends YYYY-MM-DD, never a partial date, and clears only through the Clear button", async () => {
    renderDrawer({ item: { dueDate: "2026-10-09T00:00:00.000Z" } });
    const due = (await screen.findByLabelText("Due date")) as HTMLInputElement;
    expect(due.value).toBe("2026-10-09");

    // A partially typed date reads as "" and must revert, not clear.
    fireEvent.change(due, { target: { value: "" } });
    fireEvent.blur(due);
    expect(writes()).toHaveLength(0);
    expect(due.value).toBe("2026-10-09");

    fireEvent.change(due, { target: { value: "2026-11-02" } });
    fireEvent.blur(due);
    await waitFor(() => expect(lastWrite()?.body).toEqual({ due_date: "2026-11-02" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear due date" }));
    await waitFor(() => expect(lastWrite()?.body).toEqual({ due_date: null }));

    const start = screen.getByLabelText("Start date");
    fireEvent.change(start, { target: { value: "2026-10-01" } });
    fireEvent.keyDown(start, { key: "Enter" });
    await waitFor(() => expect(lastWrite()?.body).toEqual({ start_date: "2026-10-01" }));
  });

  it("an Escape with nothing being edited still closes the drawer", async () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(await screen.findByLabelText("Due date"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("department: choosing sets the override; the first option clears it", async () => {
    renderDrawer({
      item: { department: { id: "d1", name: "Clinical", kind: "DEPARTMENT", parentId: null, source: "project" } },
    });
    const select = (await screen.findByRole("combobox", { name: "Department" })) as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: "Project default (Clinical)" })).toBeInTheDocument();
    expect(select.value).toBe("");
    // Departments come from /api/departments (empty here) and the item itself; the
    // project default is the only one on offer, so choosing "" is an identity.
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(lastWrite()?.body).toEqual({ department_id: null }));
  });

  it("assignees: sends the COMPLETE set each time and only offers people with a local id", async () => {
    renderDrawer({ item: { assignees: ["u-ana"] } });
    fireEvent.click(await screen.findByRole("button", { name: "Add assignee" }));
    expect(await screen.findByRole("button", { name: /Bo Chen/ })).toBeInTheDocument();
    expect(h.calls.some((c) => c.url === "/api/pm/people")).toBe(true);
    expect(h.calls.some((c) => c.url === "/api/auth/users")).toBe(false);
    expect(screen.queryByText("No Local Row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Bo Chen/ }));
    await waitFor(() => expect(lastWrite()?.body).toEqual({ assignees: ["u-ana", "u-bo"] }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Ana Lopez" }));
    await waitFor(() => expect(lastWrite()?.body).toEqual({ assignees: ["u-bo"] }));
  });

  it("assignees: with the directory unavailable the current people can still be removed", async () => {
    h.handler = (c) => (c.url === "/api/pm/people" ? fail(403, "Forbidden") : defaults(c));
    renderDrawer({ item: { assignees: ["u-ana"] } });
    fireEvent.click(await screen.findByRole("button", { name: "Add assignee" }));
    expect(await screen.findByText("The people list isn't available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ana Lopez" }));
    await waitFor(() => expect(lastWrite()?.body).toEqual({ assignees: [] }));
  });

  it("Escape inside a picker closes the picker, not the drawer", async () => {
    const { onClose } = renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Add assignee" }));
    fireEvent.keyDown(await screen.findByRole("searchbox", { name: "Search people" }), { key: "Escape" });
    expect(screen.queryByRole("searchbox", { name: "Search people" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("parent", () => {
  it("searches the project, picks one and sends { parent_id }", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Set parent" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search for a parent" }), { target: { value: "INBOX" } });
    // Items in other projects, and the item itself, are not candidates.
    expect(await screen.findByRole("button", { name: /INBOX-2/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^OPS-9 / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^INBOX-1 / })).toBeNull();
    expect(screen.getByText("Sub-issues stay in the same project.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /INBOX-2/ }));
    await waitFor(() => expect(lastWrite()?.body).toEqual({ parent_id: "w2" }));
  });

  it("explains a refused loop in plain words and puts the field back", async () => {
    h.handler = (c) => (c.method === "PATCH" ? fail(422, "parent_cycle") : defaults(c));
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Set parent" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search for a parent" }), { target: { value: "INBOX" } });
    fireEvent.click(await screen.findByRole("button", { name: /INBOX-2/ }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/sub-item of one of its own sub-items/), "error"));
    expect(await screen.findByText("No parent")).toBeInTheDocument();
  });

  it("shows the current parent and removes it", async () => {
    renderDrawer({ item: { parentId: "w7" } });
    expect(await screen.findByText("Parent task")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove parent" }));
    await waitFor(() => expect(lastWrite()?.body).toEqual({ parent_id: null }));
  });
});

describe("custom fields", () => {
  const set = (id: string) => ({ url: `/api/pm/work-items/w1/properties/${id}`, method: "PUT" });

  it("renders one row per field, in order", async () => {
    renderDrawer();
    for (const name of ["Customer ref", "Budget", "Go live", "Billable", "Severity", "Platforms", "Reviewer"]) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }
  });

  it.each([
    ["text", "Customer ref", "textbox", "hello", "pf-text", { text: "hello" }],
    ["number", "Budget", "spinbutton", "12.5", "pf-num", { number: 12.5 }],
  ] as const)("%s: commits on blur as a tagged value", async (_t, name, role, typed, id, value) => {
    renderDrawer();
    const input = await screen.findByRole(role, { name });
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.blur(input);
    await waitFor(() => expect(lastWrite()).toMatchObject({ ...set(id), body: { value } }));
  });

  it("date, boolean, select and member send their tagged shapes", async () => {
    renderDrawer();
    const date = await screen.findByLabelText("Go live");
    fireEvent.change(date, { target: { value: "2026-12-01" } });
    fireEvent.blur(date);
    await waitFor(() => expect(lastWrite()).toMatchObject({ ...set("pf-date"), body: { value: { date: "2026-12-01" } } }));

    fireEvent.change(screen.getByRole("combobox", { name: "Billable" }), { target: { value: "yes" } });
    await waitFor(() => expect(lastWrite()).toMatchObject({ ...set("pf-bool"), body: { value: { boolean: true } } }));

    fireEvent.change(screen.getByRole("combobox", { name: "Severity" }), { target: { value: "o-high" } });
    await waitFor(() => expect(lastWrite()).toMatchObject({ ...set("pf-sel"), body: { value: { optionIds: ["o-high"] } } }));

    const who = screen.getByRole("combobox", { name: "Reviewer" });
    await waitFor(() => expect(within(who).getByRole("option", { name: "Bo Chen" })).toBeInTheDocument());
    fireEvent.change(who, { target: { value: "u-bo" } });
    await waitFor(() => expect(lastWrite()).toMatchObject({ ...set("pf-who"), body: { value: { userIds: ["u-bo"] } } }));
  });

  it("multi-select toggles chips and clears the field when the last one goes", async () => {
    renderDrawer({ item: { properties: { "pf-multi": { optionIds: ["o-ios"] } } } });
    const group = await screen.findByRole("group", { name: "Platforms" });
    // One write per control at a time: each click waits for the last write to land.
    fireEvent.click(within(group).getByRole("button", { name: /Android/ }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ ...set("pf-multi"), body: { value: { optionIds: ["o-ios", "o-and"] } } }));
    await waitFor(() => expect(within(group).getByRole("button", { name: /iOS/ })).toBeEnabled());
    fireEvent.click(within(group).getByRole("button", { name: /iOS/ }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ ...set("pf-multi"), body: { value: { optionIds: ["o-and"] } } }));
    await waitFor(() => expect(within(group).getByRole("button", { name: /Android/ })).toBeEnabled());
    fireEvent.click(within(group).getByRole("button", { name: /Android/ }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ method: "DELETE", url: "/api/pm/work-items/w1/properties/pf-multi" }));
  });

  it("emptying a text field clears it (DELETE), not a PUT of an empty string", async () => {
    renderDrawer({ item: { properties: { "pf-text": { text: "old" } } } });
    const input = await screen.findByRole("textbox", { name: "Customer ref" });
    expect(input).toHaveValue("old");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(lastWrite()).toMatchObject({ method: "DELETE", url: "/api/pm/work-items/w1/properties/pf-text" }));
  });

  it("shows the server's sentence under the field and rolls the value back", async () => {
    h.handler = (c) =>
      c.method === "PUT"
        ? fail(400, "invalid_value", { formErrors: [], fieldErrors: { value: ["Pick one of this field's options."] } })
        : defaults(c);
    renderDrawer();
    const sel = (await screen.findByRole("combobox", { name: "Severity" })) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "o-low" } });
    expect(await screen.findByText("Pick one of this field's options.")).toBeInTheDocument();
    expect(sel.value).toBe("");
  });

  it("read-only shows the values as text", async () => {
    renderDrawer({
      readOnly: true,
      item: { properties: { "pf-text": { text: "ACME-7" }, "pf-sel": { optionIds: ["o-high"] }, "pf-bool": { boolean: false } } },
    });
    expect(await screen.findByText("ACME-7")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });
});

describe("relations", () => {
  it("groups links by what they mean and badges cross-project ones", async () => {
    renderDrawer();
    expect(await screen.findByText("OPS-9")).toBeInTheDocument();
    expect(screen.getByText("Blocks")).toBeInTheDocument();
    expect(screen.getByText("Relates to")).toBeInTheDocument();
    expect(screen.getByText("Other project")).toBeInTheDocument();
    expect(screen.queryByText("Blocked by")).toBeNull();
  });

  it("removes a link at once, and puts it back if the server refuses", async () => {
    const gate = deferred(fail(500, "boom"));
    h.handler = (c) => (c.method === "DELETE" ? gate.promise : defaults(c));
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Remove link to OPS-9" }));
    await waitFor(() => expect(screen.queryByText("OPS-9")).toBeNull());
    expect(lastWrite()).toMatchObject({ method: "DELETE", url: "/api/pm/relations/r1" });
    gate.settle();
    expect(await screen.findByText("OPS-9")).toBeInTheDocument();
    expect(h.toast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("'is blocked by' is a BLOCKS link written from the OTHER item to this one", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByRole("combobox", { name: "This item" }), { target: { value: "blocked_by" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search for an item to link" }), { target: { value: "INBOX" } });
    fireEvent.click(await screen.findByRole("button", { name: /INBOX-2/ }));
    await waitFor(() =>
      expect(lastWrite()).toMatchObject({
        url: "/api/pm/work-items/w2/relations",
        method: "POST",
        body: { to_work_item_id: "w1", kind: "BLOCKS" },
      }),
    );
  });

  it("'blocks' is written from this item, and the item itself is never offered", async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByRole("combobox", { name: "This item" }), { target: { value: "blocks" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search for an item to link" }), { target: { value: "x" } });
    await screen.findByRole("button", { name: /^INBOX-2 / });
    expect(screen.queryByRole("button", { name: /^INBOX-1 / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /INBOX-2/ }));
    await waitFor(() =>
      expect(lastWrite()).toMatchObject({
        url: "/api/pm/work-items/w1/relations",
        body: { to_work_item_id: "w2", kind: "BLOCKS" },
      }),
    );
  });

  it("explains a refused blocker loop and keeps the picker open", async () => {
    h.handler = (c) => (c.method === "POST" ? fail(409, "relation_cycle") : defaults(c));
    renderDrawer();
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));
    fireEvent.change(screen.getByRole("combobox", { name: "This item" }), { target: { value: "blocks" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search for an item to link" }), { target: { value: "x" } });
    fireEvent.click(await screen.findByRole("button", { name: /INBOX-2/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/close a chain of blockers/);
    expect(screen.getByRole("searchbox", { name: "Search for an item to link" })).toBeInTheDocument();
  });
});

describe("item menu", () => {
  const open = async () => fireEvent.click(await screen.findByRole("button", { name: "Item actions" }));

  it("archives with one click, then closes the drawer", async () => {
    const { onChanged, onClose } = renderDrawer();
    await open();
    expect(screen.queryByRole("menuitem", { name: /Delete/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/work-items/w1/archive", method: "POST" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
  });

  it("offers Restore, not Archive, for an archived item — and shows it is archived", async () => {
    const { onClose } = renderDrawer({ item: { isArchived: true } });
    expect(await screen.findByText("Archived")).toBeInTheDocument();
    await open();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/work-items/w1/restore", method: "POST" }));
    // Restore keeps the drawer open: the item is back on the board.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("delete is owner/admin only and needs the key typed", async () => {
    const { onClose } = renderDrawer({ canDelete: true });
    await open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: /Delete this item/ });
    const confirm = within(dialog).getByRole("button", { name: "Delete item" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "INBOX-1" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(lastWrite()).toMatchObject({ url: "/api/pm/work-items/w1", method: "DELETE" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("says why when a delete is refused", async () => {
    h.handler = (c) => (c.method === "DELETE" ? fail(403, "Forbidden: role not permitted") : defaults(c));
    renderDrawer({ canDelete: true });
    await open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog", { name: /Delete this item/ });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "INBOX-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete item" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/couldn't save that change/i);
  });
});
