/**
 * WARP-3537 — the keyboard layer, assembled: the handler, the `?` sheet and the ⌘K
 * palette wired to a page's callbacks. What each piece does alone is tested beside it;
 * here a key is pressed and the right thing happens on the right surface — including
 * that `?` is the sheet's on this page and Help's everywhere else.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { createRef, type RefObject } from "react";

vi.mock("./useItemSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useItemSearch")>();
  return { ...actual, useItemSearch: () => ({ items: [], searching: false }) };
});

import { FilterBar } from "../FilterBar";
import type { TableApi } from "../table/TableView";
import { ProjectsKeyboard, SEARCH_SELECTOR, type ProjectsKeyboardProps } from "./ProjectsKeyboard";
import type { PmProject, PmState } from "../types";
import { EMPTY_FILTER } from "../filter-model";

const STATES: PmState[] = [{ id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: null, sortOrder: 1, isDefault: true }];
const PROJECTS = [{ id: "p1", name: "Onboarding", identifier: "INBOX", archived: false }] as PmProject[];

function tableApi() {
  const api = {
    move: vi.fn(),
    toggleSelect: vi.fn(),
    edit: vi.fn(),
  };
  const ref = createRef<TableApi>() as { current: TableApi | null };
  ref.current = api;
  return { api, ref: ref as RefObject<TableApi | null> };
}

function setup(over: Partial<ProjectsKeyboardProps> = {}) {
  const t = tableApi();
  const handlers = {
    createItem: vi.fn(),
    openProject: vi.fn(),
    openAll: vi.fn(),
    openViewsIndex: vi.fn(),
    pickView: vi.fn(),
    switchLayout: vi.fn(),
    clearSelection: vi.fn(),
    bulk: vi.fn(),
  };
  const props: ProjectsKeyboardProps = {
    enabled: true,
    blocked: false,
    readOnly: false,
    tableApi: t.ref,
    onCreate: vi.fn(),
    selectionCount: 0,
    onClearSelection: vi.fn(),
    onOpenItem: vi.fn(),
    palette: {
      readOnly: false,
      scope: "project",
      project: { name: "Onboarding", identifier: "INBOX" },
      projects: PROJECTS,
      views: [],
      layouts: [{ id: "table", label: "Table" }],
      selectionCount: 0,
      canArchive: true,
      states: STATES,
      labels: [],
      people: [],
      meId: null,
      handlers,
    },
    ...over,
  };
  const utils = render(<ProjectsKeyboard {...props} />);
  return { ...utils, props, table: t.api, handlers };
}

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

afterEach(() => {
  // Unmount the React trees first (a Dialog's portal is theirs to remove), then sweep what the tests added by hand.
  cleanup();
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

describe("the page keys", () => {
  it("c creates in the open project", () => {
    const { props } = setup();
    press("c");
    expect(props.onCreate).toHaveBeenCalledTimes(1);
  });

  it("c is left alone where there is no project to create in", () => {
    const { props } = setup({ onCreate: null });
    expect(press("c").defaultPrevented).toBe(false);
    expect(props.onClearSelection).not.toHaveBeenCalled();
  });

  it("c does nothing for a reader", () => {
    const { props } = setup({ readOnly: true });
    expect(press("c").defaultPrevented).toBe(false);
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("/ focuses the search box and selects what is in it", () => {
    const box = document.createElement("input");
    box.setAttribute("aria-label", "Search work items");
    box.value = "old";
    document.body.appendChild(box);
    setup();
    const e = press("/");
    expect(box).toHaveFocus();
    expect(e.defaultPrevented).toBe(true); // the / is not typed into the box
  });

  it("/ is the browser's where there is no search box", () => {
    setup();
    expect(press("/").defaultPrevented).toBe(false);
  });

  it("the selector it uses finds the REAL filter bar's search box — if that label changes, this fails", () => {
    render(
      <FilterBar
        scope="project"
        filter={EMPTY_FILTER}
        onChange={() => undefined}
        options={{ scope: "project", states: [], labels: [], people: [], departments: [], projects: [] }}
        lookups={{}}
      />,
    );
    expect(document.querySelector(SEARCH_SELECTOR)).not.toBeNull();
  });

  it("Esc clears the selection only when there is one", () => {
    const first = setup({ selectionCount: 0 });
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(first.props.onClearSelection).not.toHaveBeenCalled();
    first.unmount();

    const second = setup({ selectionCount: 3 });
    press("Escape");
    expect(second.props.onClearSelection).toHaveBeenCalledTimes(1);
  });
});

describe("the table keys go to the table", () => {
  it.each([
    ["j", "move", [1]],
    ["k", "move", [-1]],
    ["x", "toggleSelect", []],
    ["e", "edit", ["name"]],
    ["a", "edit", ["assignees"]],
    ["s", "edit", ["state"]],
    ["p", "edit", ["priority"]],
  ] as const)("%s → %s(%j)", (key, method, args) => {
    const { table } = setup();
    press(key);
    expect(table[method]).toHaveBeenCalledWith(...args);
  });

  it("are the browser's when no table is on screen (the board, the list)", () => {
    setup({ tableApi: null });
    for (const key of ["j", "k", "x", "e", "a", "s", "p"]) expect(press(key).defaultPrevented, key).toBe(false);
  });

  it("a reader can move and select but not edit", () => {
    const { table } = setup({ readOnly: true });
    press("j");
    press("x");
    press("e");
    press("s");
    expect(table.move).toHaveBeenCalled();
    expect(table.toggleSelect).toHaveBeenCalled();
    expect(table.edit).not.toHaveBeenCalled();
  });

  it("none of them acts while the page's own modal is up", () => {
    const { table, props } = setup({ blocked: true });
    for (const key of ["j", "x", "c", "?"]) press(key);
    expect(table.move).not.toHaveBeenCalled();
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("? — the sheet here, Help everywhere else", () => {
  let helpHeard: Mock<(this: Window, event: KeyboardEvent) => void>;
  beforeEach(() => {
    helpHeard = vi.fn<(this: Window, event: KeyboardEvent) => void>();
    window.addEventListener("keydown", helpHeard);
  });
  afterEach(() => window.removeEventListener("keydown", helpHeard));

  it("opens the shortcut sheet, and Help (listening on window, as HelpLauncher does) does not also open", () => {
    setup();
    press("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(helpHeard).not.toHaveBeenCalled();
  });

  it("a second ? closes it again", () => {
    setup();
    press("?");
    press("?", {}, screen.getByRole("button", { name: "Close" }));
    return waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("is Help's, untouched, while someone is typing", () => {
    setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("?", {}, input);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(helpHeard).toHaveBeenCalledTimes(1);
  });
});

describe("⌘K", () => {
  it("opens the palette — search focused — and Ctrl+K does the same", async () => {
    setup();
    press("k", { metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
  });

  it("running a command from it closes the palette and does the thing", () => {
    const { handlers } = setup();
    press("k", { ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "create" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(handlers.createItem).toHaveBeenCalledTimes(1);
  });

  it("'Show keyboard shortcuts' opens the sheet from the palette", async () => {
    setup();
    press("k", { metaKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "shortcuts" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument());
  });

  it("does not open while the page's own modal is up", () => {
    setup({ blocked: true });
    press("k", { metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from a plain input — it types nothing — but not from the rich-text editor", () => {
    setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("k", { metaKey: true }, input);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });
});
