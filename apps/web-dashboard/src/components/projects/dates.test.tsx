// Where a date goes in and where it comes out of the Projects surface — the date
// a person types is the date everyone reads, in two zones (WARP-3372).
//
// date-only.test.ts pins the helper. This pins that the surface really goes
// through it: the New item form sends the date input's YYYY-MM-DD untouched
// (it used to send `new Date(value).toISOString()`, which the display then read
// back in local time), cards and list rows show that date, and no source file
// reaches for a Date to read a due or start date again.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NewItemModal } from "./modals";
import { ListView, WorkItemCard } from "./board";
import { DueChip, PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmProject, PmState, PmWorkItem } from "./types";
import { packagePath } from "../../__tests__/helpers/test-paths";

const posts: { url: string; body: Record<string, unknown> }[] = [];

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ work_item: { id: "w-new" } });
    }
    if (url.endsWith("/states")) return json({ states: [] });
    return json({});
  }),
}));

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const PROJECT: PmProject = {
  id: "p1",
  workspaceId: "w",
  workspaceSlug: "home",
  department: null,
  name: "Onboarding",
  identifier: "INBOX",
  description: null,
  icon: "board",
  color: "#6366f1",
  leadId: null,
  archived: false,
  openCount: 0,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const STATE: PmState = { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true };

const item = (over: Partial<PmWorkItem> = {}): PmWorkItem => ({
  id: "w1",
  projectId: "p1",
  sequenceId: 1,
  key: "INBOX-1",
  name: "Ship it",
  descriptionHtml: null,
  stateId: "s1",
  state: STATE,
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
  ...over,
});

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe.each([
  ["America/Los_Angeles", 420],
  ["Pacific/Auckland", -720],
])("Projects dates under TZ=%s (WARP-3372)", (zone, offset) => {
  beforeAll(() => {
    process.env.TZ = zone;
    expect(new Date(2026, 5, 25).getTimezoneOffset()).toBe(offset);
  });
  beforeEach(() => {
    posts.length = 0;
  });

  it("the New item form sends the date input's YYYY-MM-DD untouched", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <NewItemModal project={PROJECT} onClose={() => undefined} onCreated={() => undefined} />
      </SWRConfig>,
    );
    fireEvent.change(screen.getByPlaceholderText("What needs doing?"), { target: { value: "Ship it" } });
    // The Dialog renders in a portal, so look in the document, not the container.
    fireEvent.change(document.body.querySelector('input[type="date"]') as HTMLInputElement, {
      target: { value: "2026-06-25" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create item" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe("/api/pm/projects/p1/work-items");
    // Not "2026-06-25T00:00:00.000Z": that is an instant, and an instant is
    // what the display used to misread.
    expect(posts[0].body.due_date).toBe("2026-06-25");
  });

  it("leaves the date out of the request when none was picked", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <NewItemModal project={PROJECT} onClose={() => undefined} onCreated={() => undefined} />
      </SWRConfig>,
    );
    fireEvent.change(screen.getByPlaceholderText("What needs doing?"), { target: { value: "No date" } });
    fireEvent.click(screen.getByRole("button", { name: "Create item" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).not.toHaveProperty("due_date");
  });

  it("a card and a list row show the date that was entered, not the day before", () => {
    const due = item({ dueDate: "2026-06-25" });
    const { container, unmount } = render(
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
        <WorkItemCard item={due} />
      </PeopleContext.Provider>,
    );
    expect(container.querySelector(".pm-duechip")?.textContent).toContain("Jun 25");
    unmount();

    render(
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
        <ListView states={[STATE]} items={[due]} domain="populated" onOpen={() => undefined} />
      </PeopleContext.Provider>,
    );
    expect(screen.getByText("Jun 25")).toBeInTheDocument();
  });

  it("an item due before the viewer's today gets the overdue treatment; due today does not", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 5, 25, 15, 0, 0)); // 25 June, 15:00 on the viewer's wall clock
      const today = render(<DueChip item={item({ dueDate: "2026-06-25" })} />);
      expect(today.container.querySelector(".pm-duechip")?.className).toContain("info");
      today.unmount();
      const late = render(<DueChip item={item({ dueDate: "2026-06-24" })} />);
      expect(late.container.querySelector(".pm-duechip")?.className).toContain("warn");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("no Projects source reads a due or start date through a Date", () => {
  const roots = [packagePath("src/components/projects"), packagePath("src/app/projects")];
  const sources = roots.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
      .map((f) => ({ file: `${dir.split(/[\\/]/).slice(-2).join("/")}/${f}`, text: readFileSync(join(dir, f), "utf8") })),
  );

  it("scans the real sources (never a pass over an empty list)", () => {
    expect(sources.length).toBeGreaterThanOrEqual(10);
    expect(sources.some((s) => s.file.endsWith("date-only.ts"))).toBe(true);
  });

  it("no `new Date(...)` is built from a due/start date value", () => {
    const offenders = sources.flatMap(({ file, text }) =>
      text
        .split(/\r?\n/)
        .map((line, i) => ({ file, n: i + 1, line }))
        .filter(({ line }) => /new Date\([^)]*(dueDate|startDate|due_date|start_date|dueDate\b)/.test(line)),
    );
    expect(offenders.map((o) => `${o.file}:${o.n}  ${o.line.trim()}`)).toEqual([]);
  });

  it("the local-time getters live in date-only.ts alone (localToday is the one legitimate use)", () => {
    const offenders = sources
      .filter(({ file }) => !file.endsWith("date-only.ts"))
      .flatMap(({ file, text }) =>
        text
          .split(/\r?\n/)
          .map((line, i) => ({ file, n: i + 1, line }))
          .filter(({ line }) => /\.(getDate|getMonth|getFullYear)\(\)/.test(line)),
      );
    expect(offenders.map((o) => `${o.file}:${o.n}  ${o.line.trim()}`)).toEqual([]);
  });
});
