/**
 * ADR-055 P4b — the doors list: what it says, when it says it, and who may
 * change it.
 *
 * Two contracts carry the file:
 *
 *   1. A position is never shown without the time it was reported, and a
 *      report that has no time is unknown, never current. The box does not age
 *      a report into "unknown" itself (that waits for link supervision), so the
 *      age on screen is the only thing telling a reader how stale "Closed" is.
 *   2. Add / change / retire are the OWNER's. They are not rendered for anyone
 *      else, and a 403 that arrives anyway is a friendly toast that closes the
 *      form and withdraws the controls — never a raw message, never a crash.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { DoorView } from "@/lib/types";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  toast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: h.role } }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));

import { DoorsPanel, isRefusal, type DoorsQuery } from "./DoorsPanel";
import { COPY, shownPosition, whenText } from "./door-copy";

const NOW = new Date("2026-09-29T20:00:00.000Z");
const ZONE = "UTC";

function door(over: Partial<DoorView> = {}): DoorView {
  return {
    id: "d1",
    name: "Front door",
    doorPositionSource: "lock",
    heldOpenSeconds: 30,
    status: "active",
    retiredAt: null,
    position: "closed",
    positionSince: "2026-09-29T18:02:00.000Z",
    claims: { forcedDoor: "latch_witnessed", heldOpen: true },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function query(doors: DoorView[] | null, over: Partial<DoorsQuery> = {}): DoorsQuery {
  return {
    doors,
    error: undefined,
    mutate: vi.fn(async () => undefined) as unknown as DoorsQuery["mutate"],
    create: vi.fn(async (b) => ({ door: door({ name: b.name, doorPositionSource: b.doorPositionSource }) })),
    patch: vi.fn(async (_id, b) => ({ door: door({ name: b.name ?? "Front door" }) })),
    retire: vi.fn(async () => ({ door: door({ status: "retired" }) })),
    ...over,
  };
}

const renderPanel = (q: DoorsQuery) => render(<DoorsPanel q={q} now={NOW} timeZone={ZONE} />);
const apiError = (status: number, code?: string) => Object.assign(new Error(`raw server text ${status}`), { status, code });

beforeEach(() => {
  h.role = "owner";
  h.toast.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a door's position is shown WITH its age", () => {
  it("closed: the word, and 'since' its time, in a <time> that carries the exact instant", () => {
    renderPanel(query([door()]));
    const card = screen.getByRole("heading", { level: 3, name: "Front door" }).closest("li")!;
    expect(within(card).getByText("Closed")).toBeInTheDocument();
    const since = within(card).getByText("since 6:02 PM");
    expect(since.tagName).toBe("TIME");
    expect(since).toHaveAttribute("dateTime", "2026-09-29T18:02:00.000Z");
  });

  it("open, an earlier day: the day is in the age, so an old report cannot pass for a fresh one", () => {
    renderPanel(query([door({ position: "open", positionSince: "2026-09-27T09:15:00.000Z" })]));
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("since Sun 9:15 AM")).toBeInTheDocument();
  });

  it("a report more than a week old carries its date", () => {
    renderPanel(query([door({ position: "closed", positionSince: "2026-09-10T09:15:00.000Z" })]));
    expect(screen.getByText("since Sep 10, 9:15 AM")).toBeInTheDocument();
  });

  it("explains, once, that a position is the last report and keeps its last position", () => {
    renderPanel(query([door()]));
    expect(screen.getByText(COPY.positionNote)).toBeInTheDocument();
  });

  it("no report yet: 'Position unknown' and 'Nothing reported yet', never 'Closed'", () => {
    renderPanel(query([door({ position: "unknown", positionSince: null })]));
    expect(screen.getByText("Position unknown")).toBeInTheDocument();
    expect(screen.getByText(COPY.noReportYet)).toBeInTheDocument();
    expect(screen.queryByText("Closed")).toBeNull();
    expect(screen.queryByText(/^since /)).toBeNull();
  });

  it("the device stopped reporting: unknown since the time, and says what that means", () => {
    renderPanel(query([door({ position: "unknown", positionSince: "2026-09-29T19:30:00.000Z" })]));
    expect(screen.getByText("Position unknown")).toBeInTheDocument();
    expect(screen.getByText("since 7:30 PM")).toBeInTheDocument();
    expect(screen.getByText(COPY.stoppedReporting)).toBeInTheDocument();
  });

  it.each(["open", "closed"] as const)("a %s report that arrives with NO time reads as unknown, never as current", (position) => {
    renderPanel(query([door({ position, positionSince: null })]));
    expect(screen.getByText("Position unknown")).toBeInTheDocument();
    expect(screen.queryByText(position === "open" ? "Open" : "Closed")).toBeNull();
  });

  it("shownPosition is that rule, on its own", () => {
    expect(shownPosition({ position: "closed", positionSince: null })).toBe("unknown");
    expect(shownPosition({ position: "open", positionSince: "2026-09-29T18:02:00.000Z" })).toBe("open");
    expect(shownPosition({ position: "not_monitored", positionSince: null })).toBe("not_monitored");
    expect(shownPosition({ position: "unknown", positionSince: null })).toBe("unknown");
  });

  it("a door with no position source shows NO position at all, and says what Droplet can't tell", () => {
    renderPanel(query([door({ doorPositionSource: "none", position: "not_monitored", positionSince: null, claims: { forcedDoor: null, heldOpen: false } })]));
    expect(screen.getByText(COPY.notTracked)).toBeInTheDocument();
    for (const word of ["Open", "Closed", "Position unknown"]) expect(screen.queryByText(word)).toBeNull();
    expect(screen.queryByText(/^since /)).toBeNull();
  });

  it.each([
    ["lock", COPY.sourceLock],
    ["dp1", COPY.sourceSensor],
  ] as const)("says where a %s door's position comes from", (source, line) => {
    renderPanel(query([door({ doorPositionSource: source })]));
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it("says a door is in use", () => {
    renderPanel(query([door()]));
    expect(screen.getByText(COPY.statusActive)).toBeInTheDocument();
  });

  it("whenText: same day, another day this week, and further back", () => {
    expect(whenText("2026-09-29T18:02:00.000Z", NOW, ZONE)).toBe("6:02 PM");
    expect(whenText("2026-09-28T18:02:00.000Z", NOW, ZONE)).toBe("Mon 6:02 PM");
    expect(whenText("2026-09-01T18:02:00.000Z", NOW, ZONE)).toBe("Sep 1, 6:02 PM");
  });
});

describe("retired doors", () => {
  const retired = door({ id: "d9", name: "Old shed", status: "retired", retiredAt: "2026-09-20T10:00:00.000Z" });

  it("are filed apart, with their status, and show no position and no controls", () => {
    renderPanel(query([door(), retired]));
    const list = document.querySelector("[data-retired-doors]") as HTMLElement;
    expect(within(list).getByText("Old shed")).toBeInTheDocument();
    expect(within(list).getByText(COPY.statusRetired)).toBeInTheDocument();
    expect(within(list).getByText("Retired Sep 20, 10:00 AM")).toBeInTheDocument();
    expect(within(list).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 3 }).map((x) => x.textContent)).toEqual(["Front door"]);
  });

  it("no retired section when there are none", () => {
    renderPanel(query([door()]));
    expect(document.querySelector("[data-retired-doors]")).toBeNull();
  });
});

describe("the other states", () => {
  it("loading says nothing about doors yet", () => {
    renderPanel(query(null));
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(COPY.emptyTitle)).toBeNull();
  });

  it("empty, for the owner, says how to add one", () => {
    renderPanel(query([]));
    expect(screen.getByText(COPY.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(COPY.emptyOwner)).toBeInTheDocument();
  });

  it("empty, for an admin, says who adds them", () => {
    h.role = "admin";
    renderPanel(query([]));
    expect(screen.getByText(COPY.emptyOthers)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyOwner)).toBeNull();
  });

  it("a failed read is an alert that says it is not the same as no doors, with a way to retry", () => {
    const q = query(null, { error: apiError(503) });
    renderPanel(q);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(COPY.loadFailedTitle)).toBeInTheDocument();
    expect(within(alert).getByText(COPY.loadFailedBody)).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyTitle)).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: COPY.retryLabel }));
    expect(q.mutate).toHaveBeenCalled();
  });

  it("a failed refresh with doors already on screen keeps the doors", () => {
    renderPanel(query([door()], { error: apiError(503) }));
    expect(screen.getByRole("heading", { level: 3, name: "Front door" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("isRefusal: 404 and 403 only", () => {
    expect(isRefusal(apiError(404))).toBe(true);
    expect(isRefusal(apiError(403))).toBe(true);
    expect(isRefusal(apiError(503))).toBe(false);
    expect(isRefusal(apiError(401))).toBe(false);
    expect(isRefusal(new Error("Failed to fetch"))).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
  });
});

describe("who sees the controls (owner only)", () => {
  const ownerControls = () => [
    screen.queryByRole("button", { name: COPY.add }),
    screen.queryByRole("button", { name: COPY.edit }),
    screen.queryByRole("button", { name: COPY.retire }),
  ];

  it("the owner sees Add, Change and Retire", () => {
    renderPanel(query([door()]));
    expect(ownerControls().every((c) => c !== null)).toBe(true);
  });

  it.each(["admin", "family", "guest", "service"])("a %s sees none of them, and still sees the doors", (role) => {
    h.role = role;
    renderPanel(query([door()]));
    expect(ownerControls()).toEqual([null, null, null]);
    expect(screen.getByRole("heading", { level: 3, name: "Front door" })).toBeInTheDocument();
  });

  it("the Change and Retire buttons say which door they are for", () => {
    renderPanel(query([door(), door({ id: "d2", name: "Back door" })]));
    const card = screen.getByRole("heading", { level: 3, name: "Back door" }).closest("li")!;
    expect(within(card).getByRole("button", { name: COPY.edit })).toHaveAccessibleDescription("Back door");
    expect(within(card).getByRole("button", { name: COPY.retire })).toHaveAccessibleDescription("Back door");
  });
});

describe("retiring a door", () => {
  /** Owns the list, so a retire really removes the card, as it does with the hook. */
  function Harness({ q }: { q: DoorsQuery }) {
    const [doors, setDoors] = useState<DoorView[]>(q.doors ?? []);
    const retire: DoorsQuery["retire"] = async (id) => {
      await q.retire(id);
      setDoors((all) => all.map((d) => (d.id === id ? { ...d, status: "retired", retiredAt: NOW.toISOString() } : d)));
      return { door: door({ id, status: "retired" }) };
    };
    return <DoorsPanel q={{ ...q, doors, retire }} now={NOW} timeZone={ZONE} />;
  }
  const open = () => fireEvent.click(screen.getByRole("button", { name: COPY.retire }));

  it("asks first, in plain words, with Cancel as plain as Retire and nothing pre-decided", async () => {
    renderPanel(query([door()]));
    open();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Retire Front door?" })).toBeInTheDocument();
    expect(within(dialog).getByText(COPY.retireBody)).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual([COPY.cancel, COPY.retireConfirm]);
  });

  it("says what it does and does not do: events stay, and there is no way back from here", () => {
    expect(COPY.retireBody).toMatch(/stays in the activity list/);
    expect(COPY.retireBody).toMatch(/can't bring it back/);
  });

  it("Cancel changes nothing", async () => {
    const q = query([door()]);
    renderPanel(q);
    open();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: COPY.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(q.retire).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("Retire sends the write, says so, and puts focus on the list's heading (the card it came from is gone)", async () => {
    const q = query([door()]);
    render(<Harness q={q} />);
    open();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: COPY.retireConfirm }));
    await waitFor(() => expect(q.retire).toHaveBeenCalledWith("d1"));
    expect(h.toast).toHaveBeenCalledWith("Retired Front door.", "success");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: COPY.listTitle })));
    expect(document.querySelector("[data-retired-doors]")).not.toBeNull();
  });

  it("a 403 is a friendly toast, closes the dialog and takes the controls away", async () => {
    const q = query([door()], { retire: vi.fn(async () => Promise.reject(apiError(403))) as DoorsQuery["retire"] });
    renderPanel(q);
    open();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: COPY.retireConfirm }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    const [message, tone] = h.toast.mock.calls[0]!;
    expect(message).toBe("Only the owner can add, change or retire doors.");
    expect(message).not.toContain("raw server text");
    expect(tone).toBe("error");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: COPY.retire })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.add })).toBeNull();
    expect(q.mutate).toHaveBeenCalled();
    // The doors themselves are still there to read.
    expect(screen.getByRole("heading", { level: 3, name: "Front door" })).toBeInTheDocument();
  });

  it("any other failure keeps the dialog open to retry, with the friendly copy", async () => {
    const q = query([door()], { retire: vi.fn(async () => Promise.reject(apiError(503, "DOORS_UNAVAILABLE"))) as DoorsQuery["retire"] });
    renderPanel(q);
    open();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: COPY.retireConfirm }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(h.toast.mock.calls[0]![0]).toMatch(/not the same as there being none/);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: COPY.retireConfirm })).toBeInTheDocument();
  });
});

describe("adding and changing a door", () => {
  const addButton = () => screen.getByRole("button", { name: COPY.add });

  async function openAdd() {
    fireEvent.click(addButton());
    return within(await screen.findByRole("dialog"));
  }

  it("the add form asks for a name and a position source, with NO source chosen for you", async () => {
    renderPanel(query([]));
    const form = await openAdd();
    expect(form.getByRole("heading", { name: COPY.addTitle })).toBeInTheDocument();
    expect(form.getByLabelText(COPY.nameLabel)).toHaveValue("");
    const radios = form.getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["lock", "dp1", "none"]);
    expect(radios.some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(form.getByRole("group", { name: COPY.sourceLegend })).toBeInTheDocument();
  });

  it("adds a door with the name and the chosen source, says so, and closes", async () => {
    const q = query([]);
    renderPanel(q);
    const form = await openAdd();
    fireEvent.change(form.getByLabelText(COPY.nameLabel), { target: { value: "  Side   door " } });
    fireEvent.click(form.getByRole("radio", { name: /a door sensor/i }));
    fireEvent.click(form.getByRole("button", { name: COPY.addConfirm }));
    await waitFor(() => expect(q.create).toHaveBeenCalledWith({ name: "Side door", doorPositionSource: "dp1" }));
    expect(h.toast).toHaveBeenCalledWith("Added Side door.", "success");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not send an empty name or an unchosen source, and says which", async () => {
    const q = query([]);
    renderPanel(q);
    const form = await openAdd();
    fireEvent.click(form.getByRole("button", { name: COPY.addConfirm }));
    expect(form.getByRole("alert")).toHaveTextContent(COPY.nameRequired);
    expect(form.getByLabelText(COPY.nameLabel)).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(form.getByLabelText(COPY.nameLabel), { target: { value: "Side door" } });
    fireEvent.click(form.getByRole("button", { name: COPY.addConfirm }));
    expect(form.getByRole("alert")).toHaveTextContent(COPY.sourceRequired);
    expect(q.create).not.toHaveBeenCalled();
  });

  it("a name over 80 characters is refused before it is sent", async () => {
    const q = query([]);
    renderPanel(q);
    const form = await openAdd();
    const input = form.getByLabelText(COPY.nameLabel);
    // maxLength stops typing; a paste of emoji (two UTF-16 units each) can still overshoot the character count.
    fireEvent.change(input, { target: { value: "🚪".repeat(81) } });
    fireEvent.click(form.getByRole("radio", { name: /the lock/i }));
    fireEvent.click(form.getByRole("button", { name: COPY.addConfirm }));
    expect(form.getByRole("alert")).toHaveTextContent(COPY.nameTooLong);
    expect(q.create).not.toHaveBeenCalled();
  });

  it("a rejected add stays open with the friendly copy, and keeps what was typed", async () => {
    const q = query([], { create: vi.fn(async () => Promise.reject(apiError(400, "INVALID_NAME"))) as DoorsQuery["create"] });
    renderPanel(q);
    const form = await openAdd();
    fireEvent.change(form.getByLabelText(COPY.nameLabel), { target: { value: "Side door" } });
    fireEvent.click(form.getByRole("radio", { name: /nothing/i }));
    fireEvent.click(form.getByRole("button", { name: COPY.addConfirm }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    expect(h.toast.mock.calls[0]![0]).toMatch(/1 to 80 characters/);
    expect(h.toast.mock.calls[0]![0]).not.toContain("raw server text");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(form.getByLabelText(COPY.nameLabel)).toHaveValue("Side door");
  });

  it("a 403 on an add closes the form and withdraws the controls", async () => {
    const q = query([], { create: vi.fn(async () => Promise.reject(apiError(403))) as DoorsQuery["create"] });
    renderPanel(q);
    const form = await openAdd();
    fireEvent.change(form.getByLabelText(COPY.nameLabel), { target: { value: "Side door" } });
    fireEvent.click(form.getByRole("radio", { name: /the lock/i }));
    fireEvent.click(form.getByRole("button", { name: COPY.addConfirm }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Only the owner can add, change or retire doors.", "error"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: COPY.add })).toBeNull();
    expect(screen.getByText(COPY.emptyOthers)).toBeInTheDocument();
  });

  it("the change form is filled from the door, and sends only what changed", async () => {
    const q = query([door()]);
    renderPanel(q);
    fireEvent.click(screen.getByRole("button", { name: COPY.edit }));
    const form = within(await screen.findByRole("dialog"));
    expect(form.getByRole("heading", { name: COPY.editTitle })).toBeInTheDocument();
    expect(form.getByLabelText(COPY.nameLabel)).toHaveValue("Front door");
    expect(form.getByRole("radio", { name: /the lock/i })).toBeChecked();
    fireEvent.click(form.getByRole("radio", { name: /nothing/i }));
    fireEvent.click(form.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(q.patch).toHaveBeenCalledWith("d1", { doorPositionSource: "none" }));
    expect(h.toast).toHaveBeenCalledWith("Saved Front door.", "success");
  });

  it("saving with nothing changed sends nothing", async () => {
    const q = query([door()]);
    renderPanel(q);
    fireEvent.click(screen.getByRole("button", { name: COPY.edit }));
    const form = within(await screen.findByRole("dialog"));
    fireEvent.click(form.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(q.patch).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("the form's Close and Cancel both leave without writing", async () => {
    const q = query([door()]);
    renderPanel(q);
    fireEvent.click(screen.getByRole("button", { name: COPY.edit }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: COPY.edit }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: COPY.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(q.patch).not.toHaveBeenCalled();
  });
});
