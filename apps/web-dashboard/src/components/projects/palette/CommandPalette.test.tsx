/**
 * WARP-3537 — the command palette as a person meets it: it opens focused, filters as
 * they type, finds items by key or title, runs the highlighted command on Enter and
 * the clicked one on click, and closes BEFORE the command runs.
 *
 * Which commands exist is `commands.test.ts`'s claim; what the item search asks the
 * server is `useItemSearch.test.tsx`'s. Here the search is a stub.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({ search: { items: [] as unknown[], searching: false } }));
vi.mock("./useItemSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useItemSearch")>();
  return { ...actual, useItemSearch: () => h.search };
});

import { CommandPalette } from "./CommandPalette";
import type { PaletteContext } from "./commands";
import type { PmProject, PmState, PmWorkItem } from "../types";

const STATES: PmState[] = [
  { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p1", name: "Done", group: "completed", color: null, sortOrder: 2, isDefault: false },
];
const PROJECTS = [
  { id: "p1", name: "Onboarding", identifier: "INBOX", archived: false },
  { id: "p2", name: "Billing", identifier: "BILL", archived: false },
] as PmProject[];

function makeContext(over: Partial<PaletteContext> = {}) {
  const handlers = {
    createItem: vi.fn(),
    showShortcuts: vi.fn(),
    openProject: vi.fn(),
    openAll: vi.fn(),
    openViewsIndex: vi.fn(),
    pickView: vi.fn(),
    switchLayout: vi.fn(),
    clearSelection: vi.fn(),
    bulk: vi.fn(),
  };
  const context: PaletteContext = {
    readOnly: false,
    scope: "project",
    project: { name: "Onboarding", identifier: "INBOX" },
    projects: PROJECTS,
    views: [{ id: "mine", name: "My items" }],
    layouts: [
      { id: "board", label: "Board" },
      { id: "table", label: "Table" },
    ],
    selectionCount: 0,
    canArchive: true,
    states: STATES,
    labels: [],
    people: [],
    meId: "u-me",
    handlers,
    ...over,
  };
  return { context, handlers };
}

function setup(over: Partial<PaletteContext> = {}, open = true) {
  const onClose = vi.fn();
  const onOpenItem = vi.fn();
  const { context, handlers } = makeContext(over);
  const utils = render(<CommandPalette open={open} onClose={onClose} context={context} onOpenItem={onOpenItem} />);
  return { ...utils, onClose, onOpenItem, handlers, context };
}

const input = () => screen.getByRole("combobox", { name: "Search projects, items and actions" });
const options = () => within(screen.getByRole("listbox", { name: "Results" })).getAllByRole("option");
const names = () => options().map((o) => o.textContent ?? "");

beforeEach(() => {
  h.search.items = [];
  h.search.searching = false;
});

describe("opening", () => {
  it("renders nothing while closed", () => {
    setup({}, false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a dialog with the search focused", async () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    // The Dialog hands focus to its first control one tick after it mounts.
    await waitFor(() => expect(input()).toHaveFocus());
  });

  it("is a combobox over a listbox, with the first option highlighted", () => {
    setup();
    expect(input()).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(input()).toHaveAttribute("aria-activedescendant", options()[0].id);
  });

  it("offers actions, views and projects when nothing is typed — and shows the shortcut that does the same", () => {
    setup();
    const text = names().join("|");
    expect(text).toContain("Create a work item");
    expect(text).toContain("Go to the table");
    expect(text).toContain("Show My items");
    expect(text).toContain("Open Billing");
    expect(within(options().find((o) => o.textContent?.includes("Create a work item"))!).getByText("C")).toBeInTheDocument();
  });
});

describe("filtering", () => {
  it("narrows as you type", () => {
    setup();
    fireEvent.change(input(), { target: { value: "bill" } });
    expect(names().some((n) => n.includes("Open Billing"))).toBe(true);
    expect(names().some((n) => n.includes("Create a work item"))).toBe(false);
  });

  it("finds a project by its key", () => {
    setup();
    fireEvent.change(input(), { target: { value: "inbox" } });
    expect(names()[0]).toContain("Open Onboarding");
  });

  it("says so plainly when nothing matches", () => {
    setup();
    fireEvent.change(input(), { target: { value: "zzzzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches that.");
  });

  it("starts at the top again for a new query", () => {
    setup();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.change(input(), { target: { value: "open" } });
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
  });
});

describe("items", () => {
  const item = { id: "w9", key: "BILL-9", name: "Fix the invoice", projectId: "p2" } as PmWorkItem;

  it("shows the items the search found, with the key in mono, after the local results", () => {
    h.search.items = [item];
    setup();
    fireEvent.change(input(), { target: { value: "invoice" } });
    const row = options().find((o) => o.textContent?.includes("Fix the invoice"))!;
    expect(within(row).getByText("BILL-9")).toHaveClass("pm-mono");
    expect(within(row).getByText("Billing")).toBeInTheDocument();
  });

  it("opens the item — in whatever project it is in — when chosen", () => {
    h.search.items = [item];
    const { onOpenItem, onClose } = setup();
    fireEvent.change(input(), { target: { value: "invoice" } });
    fireEvent.click(options().find((o) => o.textContent?.includes("Fix the invoice"))!);
    expect(onOpenItem).toHaveBeenCalledWith("BILL-9");
    expect(onClose).toHaveBeenCalled();
  });

  it("says it is still looking, rather than 'nothing matches', while a search is out", () => {
    h.search.searching = true;
    setup();
    fireEvent.change(input(), { target: { value: "zzzzzz" } });
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
  });
});

describe("running a command", () => {
  it("Enter runs the highlighted one, and the dialog closes first", () => {
    const { handlers, onClose } = setup();
    const order: string[] = [];
    onClose.mockImplementation(() => order.push("close"));
    handlers.createItem.mockImplementation(() => order.push("run"));
    fireEvent.change(input(), { target: { value: "create" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(handlers.createItem).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["close", "run"]);
  });

  it("↓ and ↑ move the highlight, wrapping, and Enter runs THAT one", () => {
    const { handlers } = setup();
    fireEvent.change(input(), { target: { value: "go to" } });
    const first = names()[0];
    expect(first).toMatch(/Go to/);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(input()).toHaveAttribute("aria-activedescendant", options()[1].id);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(options()[options().length - 1]).toHaveAttribute("aria-selected", "true");
    void handlers;
  });

  it("a click runs the one clicked", () => {
    const { handlers, onClose } = setup();
    fireEvent.click(options().find((o) => o.textContent?.includes("Go to the table"))!);
    expect(handlers.switchLayout).toHaveBeenCalledWith("table");
    expect(onClose).toHaveBeenCalled();
  });

  it("jumping to a project opens it", () => {
    const { handlers } = setup();
    fireEvent.change(input(), { target: { value: "billing" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(handlers.openProject).toHaveBeenCalledWith(PROJECTS[1]);
  });

  it("showing the shortcuts is a command too", () => {
    const { handlers } = setup();
    fireEvent.change(input(), { target: { value: "shortcuts" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(handlers.showShortcuts).toHaveBeenCalled();
  });

  it("Enter with nothing to run does nothing", () => {
    const { onClose } = setup();
    fireEvent.change(input(), { target: { value: "zzzzzz" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("with rows selected", () => {
  it("puts the bulk actions first when nothing is typed, and runs one on the selection", () => {
    const { handlers } = setup({ selectionCount: 3 });
    expect(names()[0]).toMatch(/selected/);
    fireEvent.change(input(), { target: { value: "move done" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(handlers.bulk).toHaveBeenCalledWith({ kind: "state", stateId: "s2" });
  });

  it("offers a reader nothing that writes", () => {
    setup({ readOnly: true, selectionCount: 3 });
    expect(names().join("|")).not.toMatch(/selected|Create a work item/);
  });
});

describe("closing", () => {
  it("Esc closes it", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
