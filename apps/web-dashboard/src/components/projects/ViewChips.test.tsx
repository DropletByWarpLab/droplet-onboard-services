// WARP-3522 — saved views in the project header (brief §3.9): the built-ins, the
// saved ones, "+ Save view", its cap, and the quiet rename / delete.

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { VIEW_LIMIT_NOTE, ViewChips, type ViewChipItem, type ViewChipsProps } from "./ViewChips";

const BUILTIN: ViewChipItem[] = [
  { id: "all", name: "All", scope: "BUILTIN", canEdit: false },
  { id: "mine", name: "My items", scope: "BUILTIN", canEdit: false },
  { id: "active", name: "Active", scope: "BUILTIN", canEdit: false },
  { id: "overdue", name: "Overdue", scope: "BUILTIN", canEdit: false },
  { id: "noassignee", name: "No assignee", scope: "BUILTIN", canEdit: false },
];
const MINE_SAVED: ViewChipItem = { id: "v1", name: "My bugs", scope: "PERSONAL", canEdit: true };
const TEAM_SAVED: ViewChipItem = { id: "v2", name: "Team board", scope: "SHARED", canEdit: false };

function props(over: Partial<ViewChipsProps> = {}): ViewChipsProps {
  return {
    views: BUILTIN,
    activeId: "all",
    readOnly: false,
    canShare: false,
    personalFull: false,
    sharedFull: false,
    onPick: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const view = (p: ViewChipsProps) => render(<div className="pm-scope"><ViewChips {...p} /></div>);

describe("the chip row", () => {
  it("with nothing saved shows only the built-ins and Save view — no empty 'your views' section", () => {
    view(props());
    const group = screen.getByRole("group", { name: "Views" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "All",
      "My items",
      "Active",
      "Overdue",
      "No assignee",
      "Save view",
    ]);
    expect(group.querySelector(".pm-vsep")).toBeNull();
  });

  it("marks the active view with aria-current, and only that one", () => {
    view(props({ activeId: "overdue" }));
    expect(screen.getByRole("button", { name: /Overdue/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /My items/ })).not.toHaveAttribute("aria-current");
  });

  it("shows each view's count", () => {
    view(props({ counts: { all: 12, mine: 3 } }));
    expect(screen.getByRole("button", { name: "All 12" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My items 3" })).toBeInTheDocument();
    // A view with no count yet shows none rather than a 0.
    expect(screen.getByRole("button", { name: "Active" })).toBeInTheDocument();
  });

  it("lists saved views after the built-ins, a shared one named as shared to a screen reader", () => {
    view(props({ views: [...BUILTIN, MINE_SAVED, TEAM_SAVED] }));
    const group = screen.getByRole("group", { name: "Views" });
    expect(group.querySelector(".pm-vsep")).not.toBeNull();
    expect(screen.getByRole("button", { name: "My bugs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Team board (shared)" })).toBeInTheDocument();
  });

  it("picking a chip reports its id", () => {
    const p = props({ views: [...BUILTIN, MINE_SAVED] });
    view(p);
    fireEvent.click(screen.getByRole("button", { name: "My bugs" }));
    expect(p.onPick).toHaveBeenCalledWith("v1");
  });

  it("offers no Save view to someone who cannot write", () => {
    view(props({ readOnly: true }));
    expect(screen.queryByRole("button", { name: /Save view/ })).toBeNull();
  });
});

describe("Save view", () => {
  it("asks for a name, saves a personal view, and closes", async () => {
    const p = props();
    view(p);
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  My open bugs " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalledWith({ name: "My open bugs", scope: "PERSONAL" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save view" })).toBeNull());
  });

  it("refuses an empty name, in words, without calling the server", async () => {
    const p = props();
    view(p);
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Give this view a name.");
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and says why when the server refuses (a taken name)", async () => {
    const p = props({ onSave: vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "view_name_taken", status: 409 })) });
    view(p);
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Mine" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A view with that name already exists. Pick another.");
    expect(screen.getByRole("dialog", { name: "Save view" })).toBeInTheDocument();
    // …and typing clears the complaint.
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Mine 2" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("offers 'who can see it' only to someone who may share", () => {
    view(props());
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    expect(screen.queryByText("Who can see it")).toBeNull();
  });

  it("lets an editor save a SHARED view", async () => {
    const p = props({ canShare: true });
    view(p);
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    fireEvent.click(within(dialog).getByLabelText(/Everyone who can see this project/));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Team" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalledWith({ name: "Team", scope: "SHARED" }));
  });

  it("at the cap, Save view stays focusable but inert, and says why", () => {
    view(props({ personalFull: true }));
    const chip = screen.getByRole("button", { name: /Save view/ });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip).toHaveAttribute("title", VIEW_LIMIT_NOTE);
    expect(VIEW_LIMIT_NOTE).toBe("You've reached the saved-view limit — delete one to add another.");
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a person at their personal cap who may share can still share, and the dialog starts there", () => {
    view(props({ personalFull: true, canShare: true }));
    const chip = screen.getByRole("button", { name: /Save view/ });
    expect(chip).not.toHaveAttribute("aria-disabled");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    expect(within(dialog).getByLabelText(/Only me/)).toBeDisabled();
    expect(within(dialog).getByLabelText(/Everyone who can see this project/)).toBeChecked();
  });

  it("both caps reached is the cap", () => {
    view(props({ personalFull: true, sharedFull: true, canShare: true }));
    expect(screen.getByRole("button", { name: /Save view/ })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("rename and delete (the chip's menu)", () => {
  it("a view you cannot change has no menu", () => {
    view(props({ views: [...BUILTIN, TEAM_SAVED] }));
    expect(screen.queryByRole("button", { name: /^Options for/ })).toBeNull();
  });

  it("the built-ins have no menu either", () => {
    view(props());
    expect(screen.queryByRole("button", { name: /^Options for/ })).toBeNull();
  });

  it("Rename opens the name dialog prefilled and renames", async () => {
    const p = props({ views: [...BUILTIN, MINE_SAVED] });
    view(p);
    const kebab = screen.getByRole("button", { name: "Options for My bugs" });
    expect(kebab).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(kebab);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dialog = screen.getByRole("dialog", { name: "Rename view" });
    const input = within(dialog).getByLabelText("Name");
    expect(input).toHaveValue("My bugs");
    fireEvent.change(input, { target: { value: "My open bugs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(p.onRename).toHaveBeenCalledWith("v1", "My open bugs"));
  });

  it("Delete is a quiet confirm in the menu — one more click, not the red dialog — and Cancel backs out", async () => {
    const p = props({ views: [...BUILTIN, MINE_SAVED] });
    view(p);
    fireEvent.click(screen.getByRole("button", { name: "Options for My bugs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu", { name: "Options for My bugs" });
    expect(menu).toHaveTextContent("Delete “My bugs”?");
    fireEvent.click(within(menu).getByRole("button", { name: "Cancel" }));
    expect(p.onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Options for My bugs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(p.onDelete).toHaveBeenCalledWith("v1"));
  });

  it("Escape closes the menu and returns focus to its button", () => {
    view(props({ views: [...BUILTIN, MINE_SAVED] }));
    const kebab = screen.getByRole("button", { name: "Options for My bugs" });
    fireEvent.click(kebab);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(kebab);
  });
});

describe("'you've changed this view'", () => {
  const dirty = (over: Partial<NonNullable<ViewChipsProps["dirty"]>> = {}) => ({
    name: "My bugs",
    canUpdate: true,
    onUpdate: vi.fn().mockResolvedValue(undefined),
    onReset: vi.fn(),
    ...over,
  });

  it("is absent until the view is changed", () => {
    view(props({ views: [...BUILTIN, MINE_SAVED], activeId: "v1" }));
    expect(screen.queryByText(/You've changed/)).toBeNull();
  });

  it("offers Update view, Save as new and Reset for a view you can change", async () => {
    const d = dirty();
    view(props({ views: [...BUILTIN, MINE_SAVED], activeId: "v1", dirty: d }));
    expect(screen.getByRole("status")).toHaveTextContent("You've changed “My bugs”.");
    fireEvent.click(screen.getByRole("button", { name: "Update view" }));
    await waitFor(() => expect(d.onUpdate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(d.onReset).toHaveBeenCalledTimes(1);
  });

  it("Save as new opens the same dialog", () => {
    view(props({ views: [...BUILTIN, MINE_SAVED], activeId: "v1", dirty: dirty() }));
    fireEvent.click(screen.getByRole("button", { name: "Save as new" }));
    expect(screen.getByRole("dialog", { name: "Save view" })).toBeInTheDocument();
  });

  it("a view you cannot change only offers Save as new and Reset", () => {
    view(props({ views: [...BUILTIN, TEAM_SAVED], activeId: "v2", dirty: dirty({ name: "Team board", canUpdate: false }) }));
    expect(screen.queryByRole("button", { name: "Update view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save as new" })).toBeInTheDocument();
  });

  it("at the cap there is no Save as new", () => {
    view(props({ views: [...BUILTIN, MINE_SAVED], activeId: "v1", personalFull: true, dirty: dirty() }));
    expect(screen.queryByRole("button", { name: "Save as new" })).toBeNull();
    expect(screen.getByRole("button", { name: "Update view" })).toBeInTheDocument();
  });
});
