// Project import and export UI (WARP-3527): the ⋯ menu, and the wizard from
// upload to summary against a faked /api/pm.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ImportAnalysis, ImportJob, ImportMapping } from "./types";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

type Call = { url: string; method: string; body?: unknown; form?: FormData };
const calls: Call[] = [];
let handler: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string>; blob?: Blob } | undefined;

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
    const call: Call = {
      url,
      method,
      body: init?.body && !isForm ? JSON.parse(String(init.body)) : undefined,
      form: isForm ? (init?.body as FormData) : undefined,
    };
    calls.push(call);
    const r = handler(call) ?? { status: 404, body: { error: "unhandled" } };
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(r.headers ?? {}),
      json: () => Promise.resolve(r.body ?? {}),
      blob: () => Promise.resolve(r.blob ?? new Blob(["x"])),
    } as Response;
  }),
}));

// Poll fast in tests (the production interval is one second).
vi.mock("./useImport", async (orig) => {
  const actual = await orig<typeof import("./useImport")>();
  return {
    ...actual,
    useJobPolling: (id: string | null, status: ImportJob["status"] | null, cb: (j: ImportJob) => void) =>
      actual.useJobPolling(id, status, cb, 5),
  };
});

import { ProjectMenu } from "./ProjectMenu";
import { ImportWizard } from "./ImportWizard";

const PROJECT = {
  id: "p1",
  workspaceId: "w",
  workspaceSlug: "home",
  name: "Payments",
  identifier: "PAY",
  description: null,
  icon: null,
  color: null,
  leadId: null,
  department: null,
  archived: false,
  openCount: 0,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const STATS = {
  begun: true, totalRows: 5, toProcess: 4, processed: 0, created: 0, updated: 0, skipped: 0,
  skippedReasons: {}, issues: [], issuesTruncated: false, unknownAssignees: [], createdStates: [], createdLabels: [],
};
const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: "job-1", projectId: "p1", source: "JIRA_CSV", status: "PREVIEWED", fileName: "jira.csv", fileBytes: 900,
  mapping: {}, stats: STATS, error: null, createdById: "u1", createdAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z", startedAt: null, finishedAt: null, ...over,
});

const MAPPING: ImportMapping = {
  columns: { name: ["Summary"], status: ["Status"], priority: ["Priority"], assignee: ["Assignee"], labels: ["Labels"], dueDate: ["Due date"] },
  dateOrder: "auto",
  listSeparator: ",",
  createMissingStates: true,
  createMissingLabels: true,
  statuses: {},
  priorities: {},
  people: {},
};
const analysis = (over: Partial<ImportAnalysis> = {}): ImportAnalysis => ({
  source: "JIRA_CSV",
  detected: "JIRA_CSV",
  sources: [
    { id: "CSV", label: "Other CSV", hint: "Any spreadsheet with one row per work item.", compatible: true },
    { id: "JIRA_CSV", label: "Jira CSV", hint: "Export from Jira with Export, then CSV (all fields).", compatible: true },
    { id: "TRELLO_JSON", label: "Trello JSON", hint: "Export as JSON.", compatible: false },
  ],
  columns: ["Summary", "Status", "Priority", "Assignee", "Labels", "Due date", "Description"],
  mapping: MAPPING,
  dateOrder: { order: "MDY", ambiguous: false, inferred: true },
  totalRows: 5,
  fileWarnings: ["1 blank row skipped."],
  states: [
    { id: "s-todo", name: "Todo", group: "unstarted" },
    { id: "s-done", name: "Done", group: "completed" },
  ],
  members: [{ id: "u-dana", name: "Dana Ortiz" }],
  statuses: [
    { key: "todo", value: "To Do", count: 2, decision: { kind: "state", stateId: "s-todo" }, auto: "name", group: "unstarted", stateName: "Todo" },
    { key: "inreview", value: "In Review", count: 1, decision: { kind: "create", name: "In Review", group: "started" }, auto: "create", group: "started" },
  ],
  priorities: [{ key: "high", value: "High", count: 2, priority: "high", known: true }],
  people: [
    { value: "Dana Ortiz", key: "danaortiz", userId: "u-dana", displayName: "Dana Ortiz", by: "name", count: 2 },
    { value: "Pat Nobody", key: "patnobody", userId: null, by: "ineligible", detail: "a guest account", count: 1 },
  ],
  newStates: [{ name: "In Review", group: "started" }],
  newLabels: ["frontend", "backend"],
  droppedLabels: [],
  counts: { create: 4, update: 0, skip: 1, parentsOutsideFile: 0 },
  notes: ["1 row will be skipped: the row has no title."],
  preview: [
    {
      row: 1, key: "PAY-1", name: "Checkout revamp", action: "create", skipReason: null,
      status: { text: "Todo", isNew: false }, priority: "high",
      assignees: [{ value: "Dana Ortiz", name: "Dana Ortiz", problem: null }],
      labels: ["frontend"], dueDate: "2024-03-31", parent: null, issues: [],
    },
    {
      row: 2, key: "PAY-2", name: "Add Apple Pay", action: "create", skipReason: null,
      status: { text: "In Review", isNew: true }, priority: null,
      assignees: [{ value: "Pat Nobody", name: null, problem: "a guest account" }],
      labels: [], dueDate: null, parent: "PAY-1", issues: [],
    },
    {
      row: 5, key: "PAY-5", name: "", action: "skip", skipReason: "The row has no title.",
      status: null, priority: null, assignees: [], labels: [], dueDate: null, parent: null, issues: [],
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  handler = () => undefined;
});

// ── the ⋯ menu ──────────────────────────────────────────────────────────────

describe("ProjectMenu", () => {
  const setup = (canImport = true) => {
    const onImport = vi.fn();
    render(<ProjectMenu projectId="p1" canImport={canImport} onImport={onImport} />);
    return { onImport, trigger: screen.getByRole("button", { name: "Project actions" }) };
  };

  it("is a collapsed menu button until opened", () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Import and both exports to someone who can import; focus lands on the first item", () => {
    const { trigger } = setup(true);
    fireEvent.click(trigger);
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent?.trim())).toEqual(["Import work items…", "Export as CSV", "Export as JSON"]);
    expect(items[0]).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("offers only the exports to a reader", () => {
    setup(false);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.queryByRole("menuitem", { name: /import/i })).toBeNull();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("arrow keys move, Home/End jump, Escape closes and gives focus back to the button", () => {
    const { trigger } = setup(true);
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(items[2], { key: "ArrowDown" });
    expect(items[0]).toHaveFocus(); // wraps
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(items[2], { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes on an outside click", () => {
    setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Import closes the menu and hands over to the wizard", () => {
    const { onImport } = setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /import work items/i }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Export as CSV downloads the file under the name the server chose", async () => {
    const created = vi.fn(() => "blob:x");
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    const clicked: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    handler = () => ({ headers: { "Content-Disposition": 'attachment; filename="PAY-work-items-2026-10-04.csv"' }, blob: new Blob(["key\r\n"]) });
    try {
      setup(true);
      fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /export as csv/i }));
      await waitFor(() => expect(clicked).toEqual(["PAY-work-items-2026-10-04.csv"]));
      expect(calls[0].url).toBe("/api/pm/projects/p1/export.csv");
      expect(created).toHaveBeenCalled();
      expect(revoked).toHaveBeenCalledWith("blob:x");
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/CSV file is in your downloads/), "success"));
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
  });

  it("an export that fails says why in plain words", async () => {
    handler = () => ({ status: 404, body: { error: "project_not_found" } });
    setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export as json/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("That project no longer exists.", "error"));
    expect(calls[0].url).toBe("/api/pm/projects/p1/export.json");
  });
});

// ── the wizard ──────────────────────────────────────────────────────────────

describe("ImportWizard", () => {
  const open = async (onFinished = vi.fn(), onClose = vi.fn()) => {
    render(<ImportWizard project={PROJECT} onClose={onClose} onFinished={onFinished} />);
    await screen.findByRole("heading", { name: "Choose a file" });
    return { onFinished, onClose };
  };
  const chooseFile = async (name = "jira.csv") => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["Summary\nA\n"], name, { type: "text/csv" })] } });
  };

  it("takes a file through every step to a summary, previewing exactly what the server planned", async () => {
    let polls = 0;
    handler = (c) => {
      if (c.url === "/api/pm/projects/p1/import-jobs") return { body: { jobs: [] } };
      if (c.url === "/api/pm/projects/p1/import" && c.method === "POST") return { status: 201, body: { job: job(), analysis: analysis() } };
      if (c.url === "/api/pm/import-jobs/job-1" && c.method === "PATCH") {
        const m = (c.body as { mapping?: ImportMapping }).mapping;
        return { body: { job: job(), analysis: analysis(m ? { mapping: m } : {}) } };
      }
      if (c.url === "/api/pm/import-jobs/job-1/run") return { status: 202, body: { job: job({ status: "PENDING" }) } };
      if (c.url === "/api/pm/import-jobs/job-1" && c.method === "GET") {
        polls += 1;
        return polls < 2
          ? { body: { job: job({ status: "RUNNING", stats: { ...STATS, processed: 2, created: 2 } }) } }
          : {
              body: {
                job: job({
                  status: "SUCCEEDED",
                  stats: {
                    ...STATS, processed: 4, created: 4, skipped: 1, skippedReasons: { missing_title: 1 },
                    createdStates: ["In Review"], createdLabels: ["frontend", "backend"],
                    unknownAssignees: [{ value: "Pat Nobody", count: 1, reason: "a guest account" }],
                    issues: [{ row: 2, key: "PAY-2", code: "assignee_ineligible", message: "Pat is a guest or deactivated account." }],
                  },
                  finishedAt: "2026-10-04T10:05:00.000Z",
                }),
              },
            };
      }
      return undefined;
    };
    const { onFinished, onClose } = await open();

    // 1 — upload
    await chooseFile();
    await screen.findByRole("heading", { name: "Where is this file from?" });
    const upload = calls.find((c) => c.url === "/api/pm/projects/p1/import")!;
    expect((upload.form!.get("file") as File).name).toBe("jira.csv");
    expect(upload.form!.get("source")).toBeNull();

    // 2 — source: the detected preset is selected and labelled; one that needs another format is disabled
    const jira = screen.getByRole("radio", { name: /Jira CSV/ });
    expect(jira).toHaveAttribute("aria-checked", "true");
    expect(within(jira).getByText("Looks like this file")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Trello JSON/ })).toBeDisabled();
    expect(screen.getByText("1 blank row skipped.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // 3 — mapping
    await screen.findByRole("heading", { name: "Match columns" });
    expect(screen.getByLabelText("Title")).toHaveValue("Summary");
    expect(screen.getByLabelText("Labels")).toHaveValue("Labels");
    expect(screen.getByLabelText("Assignee")).toHaveValue("Assignee");
    expect(screen.getByLabelText("Due date")).toHaveValue("Due date");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Description" } });
    await waitFor(() => {
      const patch = calls.filter((c) => c.method === "PATCH").pop()!;
      expect((patch.body as { mapping: ImportMapping }).mapping.columns.description).toEqual(["Description"]);
    });
    // a status row offers the existing states, a new state, and the default
    const statusSelect = screen.getByLabelText("State for status In Review");
    expect(within(statusSelect).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Todo", "Done", "Create “In Review” as a new state", "Use the project default",
    ]);
    fireEvent.change(statusSelect, { target: { value: "state:s-done" } });
    await waitFor(() => {
      const patch = calls.filter((c) => c.method === "PATCH").pop()!;
      expect((patch.body as { mapping: ImportMapping }).mapping.statuses.inreview).toEqual({ kind: "state", stateId: "s-done" });
    });
    // people: the unmatched person is reported with a reason, and can be pointed at a member
    expect(screen.getByText("a guest account")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Member for Pat Nobody"), { target: { value: "u-dana" } });
    await waitFor(() => {
      const patch = calls.filter((c) => c.method === "PATCH").pop()!;
      expect((patch.body as { mapping: ImportMapping }).mapping.people.patnobody).toBe("u-dana");
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to preview" }));

    // 4 — preview
    await screen.findByRole("heading", { name: "Check the preview" });
    const tiles = screen.getByText("To create").parentElement!;
    expect(within(tiles).getByText("4")).toBeInTheDocument();
    expect(screen.getByText(/New state: In Review/)).toBeInTheDocument();
    expect(screen.getByText("1 row will be skipped: the row has no title.")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Checkout revamp")).toBeInTheDocument();
    expect(within(table).getByText("New")).toBeInTheDocument(); // In Review is a new state
    expect(within(table).getByText(/Not matched — a guest account/)).toBeInTheDocument();
    expect(within(table).getByText("The row has no title.")).toBeInTheDocument();
    expect(screen.getByText("Showing the first 3 of 5 rows.")).toBeInTheDocument();
    expect(screen.getByText("Write · confirm to apply")).toBeInTheDocument();

    // 5 — run: 202, then progress, then the summary
    fireEvent.click(screen.getByRole("button", { name: "Start import" }));
    await screen.findByRole("progressbar", { name: "Import progress" });
    const run = calls.find((c) => c.url === "/api/pm/import-jobs/job-1/run")!;
    expect((run.body as { mapping: ImportMapping }).mapping.people.patnobody).toBe("u-dana");
    expect(onFinished).not.toHaveBeenCalled(); // not before it has finished
    await screen.findByRole("heading", { name: "Import finished" });
    expect(screen.getByText("Created").previousSibling).toHaveTextContent("4");
    expect(screen.getByText("1 had no title")).toBeInTheDocument();
    expect(screen.getByText("New states: In Review")).toBeInTheDocument();
    expect(screen.getByText("People we couldn’t match")).toBeInTheDocument();
    expect(screen.getByText("Pat Nobody")).toBeInTheDocument();
    expect(screen.getByText(/import the same file again to assign them/)).toBeInTheDocument();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses to leave the mapping step without a title column", async () => {
    handler = (c) => {
      if (c.url.endsWith("/import-jobs")) return { body: { jobs: [] } };
      if (c.url === "/api/pm/projects/p1/import") {
        return { status: 201, body: { job: job(), analysis: analysis({ mapping: { ...MAPPING, columns: {} } }) } };
      }
      return undefined;
    };
    await open();
    await chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Match columns" });
    expect(screen.getByRole("button", { name: "Continue to preview" })).toBeDisabled();
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("shows the server's plain-language reason when an upload is refused, and stays on the first step", async () => {
    handler = (c) => {
      if (c.url.endsWith("/import-jobs")) return { body: { jobs: [] } };
      if (c.url === "/api/pm/projects/p1/import") {
        return { status: 413, body: { error: "file_too_large", message: "That file is over 10 MB. Split it and import in parts." } };
      }
      return undefined;
    };
    await open();
    await chooseFile("huge.csv");
    expect(await screen.findByRole("alert")).toHaveTextContent("That file is over 10 MB. Split it and import in parts.");
    expect(screen.getByRole("heading", { name: "Choose a file" })).toBeInTheDocument();
  });

  it("lists what is wrong with a mapping instead of a bare error", async () => {
    handler = (c) => {
      if (c.url.endsWith("/import-jobs")) return { body: { jobs: [] } };
      if (c.url === "/api/pm/projects/p1/import") return { status: 201, body: { job: job(), analysis: analysis() } };
      if (c.method === "PATCH") {
        return { status: 422, body: { error: "invalid_import_mapping", problems: ['There is no column named "Gone" in this file.'] } };
      }
      return undefined;
    };
    await open();
    await chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Match columns" });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "" } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Part of the mapping doesn't match this file or project.");
    expect(alert).toHaveTextContent('There is no column named "Gone" in this file.');
  });

  it("opens straight onto the progress of an import that is already running, and can cancel it", async () => {
    handler = (c) => {
      if (c.url === "/api/pm/projects/p1/import-jobs") {
        return { body: { jobs: [job({ status: "RUNNING", stats: { ...STATS, processed: 25, toProcess: 50, created: 25 } })] } };
      }
      if (c.url === "/api/pm/import-jobs/job-1" && c.method === "GET") {
        return { body: { job: job({ status: "RUNNING", stats: { ...STATS, processed: 25, toProcess: 50, created: 25 } }) } };
      }
      if (c.url === "/api/pm/import-jobs/job-1/cancel") {
        return { body: { job: job({ status: "CANCELLED", stats: { ...STATS, processed: 30, toProcess: 50, created: 30 }, finishedAt: "2026-10-04T10:06:00.000Z" }) } };
      }
      return undefined;
    };
    const onFinished = vi.fn();
    render(<ImportWizard project={PROJECT} onClose={vi.fn()} onFinished={onFinished} />);
    const bar = await screen.findByRole("progressbar", { name: "Import progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText(/25 of 50 rows/)).toBeInTheDocument();
    expect(screen.getByText(/the import keeps running/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    await screen.findByRole("heading", { name: "Import cancelled" });
    expect(screen.getByText(/stopped after 30 of 50 rows/)).toBeInTheDocument();
    expect(screen.getByText(/Items\s+already imported stay in the project/)).toBeInTheDocument();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  });

  it("a failed import says what happened and offers to continue", async () => {
    let runs = 0;
    handler = (c) => {
      if (c.url === "/api/pm/projects/p1/import-jobs") {
        return { body: { jobs: [] } };
      }
      if (c.url === "/api/pm/projects/p1/import") return { status: 201, body: { job: job(), analysis: analysis() } };
      if (c.url === "/api/pm/import-jobs/job-1/run") {
        runs += 1;
        return { status: 202, body: { job: job({ status: runs === 1 ? "FAILED" : "PENDING", error: runs === 1 ? "The import was interrupted (the appliance restarted or the process stopped). Run it again to continue where it left off." : null, stats: { ...STATS, processed: 50, toProcess: 120 }, finishedAt: runs === 1 ? "2026-10-04T10:07:00.000Z" : null }) } };
      }
      return undefined;
    };
    await open();
    await chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue to preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start import" }));
    expect(await screen.findByRole("heading", { name: "The import stopped" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/interrupted/);
    expect(screen.getByText(/50 of 120 rows were handled and are kept/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await screen.findByRole("heading", { name: "Waiting to start" });
    expect(runs).toBe(2);
    // a resume sends no mapping: the cursor refers to the one it started with
    const second = calls.filter((c) => c.url === "/api/pm/import-jobs/job-1/run")[1];
    expect(second.body).toEqual({});
  });

  it("disables Start when there is nothing in the file to import", async () => {
    handler = (c) => {
      if (c.url.endsWith("/import-jobs")) return { body: { jobs: [] } };
      if (c.url === "/api/pm/projects/p1/import") {
        return { status: 201, body: { job: job(), analysis: analysis({ counts: { create: 0, update: 0, skip: 3, parentsOutsideFile: 0 } }) } };
      }
      return undefined;
    };
    await open();
    await chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue to preview" }));
    expect(await screen.findByRole("button", { name: "Start import" })).toBeDisabled();
  });

  it("changing the preset asks the server and shows its fresh analysis", async () => {
    handler = (c) => {
      if (c.url.endsWith("/import-jobs")) return { body: { jobs: [] } };
      if (c.url === "/api/pm/projects/p1/import") return { status: 201, body: { job: job(), analysis: analysis() } };
      if (c.method === "PATCH") {
        return { body: { job: job({ source: "CSV" }), analysis: analysis({ source: "CSV" }) } };
      }
      return undefined;
    };
    await open();
    await chooseFile();
    await screen.findByRole("heading", { name: "Where is this file from?" });
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: /Other CSV/ }));
    });
    await waitFor(() => expect(screen.getByRole("radio", { name: /Other CSV/ })).toHaveAttribute("aria-checked", "true"));
    expect((calls.filter((c) => c.method === "PATCH").pop()!.body as { source: string }).source).toBe("CSV");
  });
});
