/**
 * WARP-2977 P2b (spec §8, §9 "HoursEditor") — the weekly opening hours.
 *
 * The rules this file pins:
 *   - a preset FILLS the draft and never saves (a curious click must not
 *     change when Droplet thinks the site is empty);
 *   - Save sends exactly seven days, Monday first, with the version the draft
 *     was read at — so someone else's newer save is refused, not undone;
 *   - a close earlier than the open says "the next day", equal times are an
 *     inline error that blocks Save;
 *   - the timezone is always on screen, the device's zone is only a
 *     suggestion, and a new site pre-selects the business's zone;
 *   - below manage there is no control at all, only text.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  COPY,
  HoursEditor,
  HoursPreview,
  BusinessProfileHint,
  buildHoursBody,
  crossesMidnight,
  dayProblem,
  describeDay,
  describeWindow,
  draftWeekFromView,
  initialZone,
  sameWeek,
  type HoursEditorProps,
} from "@/components/security/HoursEditor";
import type { SecurityHoursBody, SecurityHoursDay, SecurityHoursView } from "@/lib/types";

const ZONES = ["America/Chicago", "Asia/Tokyo", "Europe/Berlin", "Europe/London"];

const WEEK_9_5: SecurityHoursDay[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
  weekday <= 5
    ? { weekday, kind: "hours", opens: "09:00", closes: "17:00" }
    : { weekday, kind: "closed", opens: null, closes: null },
);

function view(over: Partial<SecurityHoursView> = {}): SecurityHoursView {
  return {
    state: "set",
    timezone: "Europe/London",
    version: 4,
    days: WEEK_9_5,
    exceptions: [],
    preview: [],
    hint: { workspaceTimezone: null, typicalDay: "" },
    ...over,
  };
}

const NOT_SET = view({
  state: "not_set",
  timezone: null,
  version: 0,
  days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, kind: "closed", opens: null, closes: null })),
});

function setup(over: Partial<HoursEditorProps> = {}) {
  const onSave = vi.fn<(body: SecurityHoursBody) => Promise<"saved" | "conflict" | "failed">>(async () => "saved");
  const onReload = vi.fn(async () => undefined);
  const props: HoursEditorProps = {
    hours: view(),
    canManage: true,
    deviceZone: "Europe/London",
    onSave,
    onReload,
    zones: ZONES,
    ...over,
  };
  const utils = render(<HoursEditor {...props} />);
  return { ...utils, props, onSave, onReload };
}

/** The day's card (one per weekday — the mobile layout's unit). */
const dayCard = (name: string) => screen.getByRole("listitem", { name });
const pill = (day: string, label: string) =>
  within(screen.getByRole("group", { name: `${day}: open or closed` })).getByRole("button", { name: label });
const opens = (day: string) => screen.getByLabelText(`Opens on ${day}`) as HTMLInputElement;
const closes = (day: string) => screen.getByLabelText(`Closes on ${day}`) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: COPY.save });

describe("HoursEditor — presets", () => {
  it("fills the editor from a preset without saving anything", () => {
    const { onSave } = setup({ hours: NOT_SET });
    expect(pill("Monday", "Open all day")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Weekdays 9–5" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(pill("Monday", "Open")).toHaveAttribute("aria-pressed", "true");
    expect(opens("Monday").value).toBe("09:00");
    expect(closes("Friday").value).toBe("17:00");
    expect(pill("Saturday", "Closed")).toHaveAttribute("aria-pressed", "true");
    expect(pill("Sunday", "Closed")).toHaveAttribute("aria-pressed", "true");
    // Filled, not applied: Save is now possible, and still the owner's call.
    expect(saveButton()).toBeEnabled();
    expect(screen.getByText(COPY.unsaved)).toBeInTheDocument();
  });

  it("offers exactly the four presets, each a different week", () => {
    setup({ hours: NOT_SET });
    const group = screen.getByRole("group", { name: COPY.presetsLabel });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Weekdays 9–5",
      "Mon–Sat 9–6",
      "Every day 8–8",
      "Always open",
    ]);

    fireEvent.click(within(group).getByRole("button", { name: "Mon–Sat 9–6" }));
    expect(closes("Saturday").value).toBe("18:00");
    expect(pill("Sunday", "Closed")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(group).getByRole("button", { name: "Every day 8–8" }));
    expect(opens("Sunday").value).toBe("08:00");
    expect(closes("Sunday").value).toBe("20:00");

    fireEvent.click(within(group).getByRole("button", { name: "Always open" }));
    for (const day of ["Monday", "Wednesday", "Sunday"]) {
      expect(pill(day, "Open all day")).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("offers no presets once hours are set", () => {
    setup();
    expect(screen.queryByRole("group", { name: COPY.presetsLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: "Weekdays 9–5" })).toBeNull();
  });

  it("says the site counts as open while no hours are set", () => {
    setup({ hours: NOT_SET });
    expect(screen.getByText(COPY.notSet)).toBeInTheDocument();
  });

  // The server sends seven `closed` rows for not_set. A draft seeded from them read "Closed" seven
  // times under "counts the site as open", and accepting the suggested zone armed a never-open Save.
  it("with no hours set the draft starts as what that means — open all day, every day — so a zone-only save changes nothing", async () => {
    const { onSave } = setup({ hours: { ...NOT_SET, hint: { workspaceTimezone: "Europe/Berlin", typicalDay: "" } }, deviceZone: "America/Chicago" });
    for (const day of ["Monday", "Wednesday", "Sunday"]) {
      expect(pill(day, "Open all day")).toHaveAttribute("aria-pressed", "true");
    }
    fireEvent.click(within(screen.getByTestId("tz-mismatch")).getByRole("button", { name: "Use that?" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const body = onSave.mock.calls[0]![0] as Extract<SecurityHoursBody, { state: "set" }>;
    expect(body.days.every((d) => d.kind === "open_all_day")).toBe(true);
  });
});

describe("HoursEditor — a day's hours", () => {
  it("renders seven day cards, Monday first, each with its own labelled inputs", () => {
    const { container } = setup();
    const cards = Array.from(container.querySelectorAll("li.card"));
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    // Every native time input is reachable by its <label htmlFor>.
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      expect(opens(day)).toHaveAttribute("type", "time");
      expect(closes(day)).toHaveAttribute("type", "time");
    }
    expect(screen.getByLabelText("Timezone").tagName).toBe("SELECT");
    expect(within(dayCard("Saturday")).queryByLabelText(/Opens/)).toBeNull();
  });

  it("says 'Closes at 2:00 AM the next day' when the close is earlier than the open", () => {
    setup();
    fireEvent.change(opens("Friday"), { target: { value: "18:00" } });
    fireEvent.change(closes("Friday"), { target: { value: "02:00" } });
    expect(within(dayCard("Friday")).getByText("Closes at 2:00 AM the next day")).toBeInTheDocument();
    expect(within(dayCard("Monday")).queryByText(/the next day/)).toBeNull();
    expect(saveButton()).toBeEnabled();
  });

  it("refuses equal times inline and blocks Save", () => {
    setup();
    fireEvent.change(closes("Monday"), { target: { value: "09:00" } });
    const alert = within(dayCard("Monday")).getByRole("alert");
    expect(alert).toHaveTextContent(COPY.sameTimes);
    expect(opens("Monday")).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();

    fireEvent.change(closes("Monday"), { target: { value: "17:30" } });
    expect(within(dayCard("Monday")).queryByRole("alert")).toBeNull();
    expect(saveButton()).toBeEnabled();
  });

  it("refuses a cleared time and blocks Save", () => {
    setup();
    fireEvent.change(opens("Tuesday"), { target: { value: "" } });
    // Shown, not announced: a native time input reports "" while it is being typed in.
    expect(within(dayCard("Tuesday")).getByText(COPY.missingTimes)).toBeInTheDocument();
    expect(within(dayCard("Tuesday")).queryByRole("alert")).toBeNull();
    expect(opens("Tuesday")).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();
  });

  it("gives a day switched to Open default times, and keeps them across Closed and back", () => {
    setup();
    fireEvent.click(pill("Saturday", "Open"));
    expect(opens("Saturday").value).toBe("09:00");
    expect(closes("Saturday").value).toBe("17:00");
    fireEvent.change(closes("Saturday"), { target: { value: "13:00" } });
    fireEvent.click(pill("Saturday", "Closed"));
    fireEvent.click(pill("Saturday", "Open"));
    expect(closes("Saturday").value).toBe("13:00");
  });
});

describe("HoursEditor — saving", () => {
  it("keeps Save off until something changes", () => {
    setup();
    expect(saveButton()).toBeDisabled();
  });

  it("PUTs exactly seven days, Monday first, with the draft's version", async () => {
    const { onSave } = setup();
    fireEvent.click(pill("Tuesday", "Closed"));
    fireEvent.click(pill("Wednesday", "Open all day"));
    fireEvent.change(opens("Friday"), { target: { value: "18:00" } });
    fireEvent.change(closes("Friday"), { target: { value: "02:00" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const body = onSave.mock.calls[0]![0];
    expect(body).toEqual({
      state: "set",
      timezone: "Europe/London",
      expectedVersion: 4,
      days: [
        { weekday: 1, kind: "hours", opens: "09:00", closes: "17:00" },
        { weekday: 2, kind: "closed" },
        { weekday: 3, kind: "open_all_day" },
        { weekday: 4, kind: "hours", opens: "09:00", closes: "17:00" },
        { weekday: 5, kind: "hours", opens: "18:00", closes: "02:00" },
        { weekday: 6, kind: "closed" },
        { weekday: 7, kind: "closed" },
      ],
    });
    // Times ride only on Open days — the server's schema is strict.
    expect(Object.keys((body as Extract<SecurityHoursBody, { state: "set" }>).days[1]!)).toEqual(["weekday", "kind"]);
  });

  it("re-syncs with the server's answer once saved", async () => {
    const { onSave, rerender, props } = setup();
    fireEvent.change(closes("Monday"), { target: { value: "18:00" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = view({
      version: 5,
      days: WEEK_9_5.map((d) => (d.weekday === 1 ? { ...d, closes: "18:00" } : d)),
    });
    rerender(<HoursEditor {...props} hours={saved} />);
    await waitFor(() => expect(screen.queryByText(COPY.unsaved)).toBeNull());
    expect(closes("Monday").value).toBe("18:00");
    expect(saveButton()).toBeDisabled();
  });

  it("keeps the draft on a conflict and loads the other person's hours only when asked", async () => {
    const onSave = vi.fn(async () => "conflict" as const);
    const { onReload, rerender, props } = setup({ onSave });
    fireEvent.change(closes("Monday"), { target: { value: "18:00" } });
    fireEvent.click(saveButton());

    expect(await screen.findByText(COPY.conflict)).toBeInTheDocument();
    expect(closes("Monday").value).toBe("18:00");

    // Their save arrives in the background: the draft still wins until asked.
    const theirs = view({
      version: 6,
      days: WEEK_9_5.map((d) => (d.weekday === 1 ? { ...d, opens: "10:00" } : d)),
    });
    rerender(<HoursEditor {...props} onSave={onSave} hours={theirs} />);
    expect(closes("Monday").value).toBe("18:00");
    expect(opens("Monday").value).toBe("09:00");
    // Their WEEK differs, so the conflict stands and the choice stays offered.
    expect(screen.getByText(COPY.conflict)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: COPY.showTheirs }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(opens("Monday").value).toBe("10:00"));
    expect(closes("Monday").value).toBe("17:00");
    expect(screen.queryByText(COPY.conflict)).toBeNull();
  });

  it("never lets a background refresh overwrite unsaved edits, and keeps the old version when the week moved", async () => {
    const { onSave, rerender, props } = setup();
    fireEvent.change(closes("Monday"), { target: { value: "18:00" } });
    const theirs = view({
      version: 7,
      days: WEEK_9_5.map((d) => (d.weekday === 2 ? { ...d, kind: "closed", opens: null, closes: null } : d)),
    });
    rerender(<HoursEditor {...props} hours={theirs} />);
    expect(closes("Monday").value).toBe("18:00");
    expect(pill("Tuesday", "Open")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // Their week differs from the one this draft started from: the save must
    // carry the OLD version so the server refuses it instead of undoing theirs.
    expect(onSave.mock.calls[0]![0].expectedVersion).toBe(4);
  });

  it("advances the version when only a special day moved it (the week is unchanged)", async () => {
    const { onSave, rerender, props } = setup();
    fireEvent.change(closes("Monday"), { target: { value: "18:00" } });
    const afterSpecialDay = view({
      version: 5,
      exceptions: [{ date: "2026-12-25", kind: "closed", opens: null, closes: null, note: "Christmas" }],
    });
    rerender(<HoursEditor {...props} hours={afterSpecialDay} />);
    expect(closes("Monday").value).toBe("18:00");
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].expectedVersion).toBe(5);
  });

  it("withdraws a conflict that only a special day caused, and the next Save carries the new version", async () => {
    const onSave = vi
      .fn<(body: SecurityHoursBody) => Promise<"saved" | "conflict" | "failed">>()
      .mockResolvedValueOnce("conflict")
      .mockResolvedValue("saved");
    const { rerender, props } = setup({ onSave });
    fireEvent.change(closes("Monday"), { target: { value: "18:00" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(COPY.conflict)).toBeInTheDocument();

    // The page's re-read: same week, a special day moved the version.
    const reread = view({
      version: 5,
      exceptions: [{ date: "2026-12-25", kind: "closed", opens: null, closes: null, note: "Christmas" }],
    });
    rerender(<HoursEditor {...props} onSave={onSave} hours={reread} />);
    await waitFor(() => expect(screen.queryByText(COPY.conflict)).toBeNull());
    expect(screen.queryByRole("button", { name: COPY.showTheirs })).toBeNull();
    expect(closes("Monday").value).toBe("18:00");

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[0]![0].expectedVersion).toBe(4);
    expect(onSave.mock.calls[1]![0].expectedVersion).toBe(5);
  });

  it("discarding after a conflict clears the conflict notice too", async () => {
    const onSave = vi.fn(async () => "conflict" as const);
    setup({ onSave });
    fireEvent.change(closes("Monday"), { target: { value: "18:00" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(COPY.conflict)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: COPY.discard }));
    expect(screen.queryByText(COPY.conflict)).toBeNull();
    expect(closes("Monday").value).toBe("17:00");
  });

  it("discards the draft back to the saved hours", () => {
    setup();
    fireEvent.change(closes("Monday"), { target: { value: "18:00" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.discard }));
    expect(closes("Monday").value).toBe("17:00");
    expect(saveButton()).toBeDisabled();
  });

  it("clears the hours only through a confirmation, with the read version", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: COPY.clear }));
    expect(onSave).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(COPY.clearTitle)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.clearConfirm }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ state: "not_set", expectedVersion: 4 }));
  });

  it("offers no Clear while nothing is set", () => {
    setup({ hours: NOT_SET });
    expect(screen.queryByRole("button", { name: COPY.clear })).toBeNull();
  });
});

describe("HoursEditor — timezone", () => {
  it("always shows the zone the times are in", () => {
    setup();
    expect(screen.getByText("Times are in Europe/London")).toBeInTheDocument();
  });

  it("offers the device's zone on a mismatch, and only fills the draft", async () => {
    const { onSave } = setup({ deviceZone: "America/Chicago" });
    const hint = screen.getByTestId("tz-mismatch");
    expect(hint).toHaveTextContent(/^Your device is on .*America\/Chicago.*\. Use that\?$/);
    fireEvent.click(within(hint).getByRole("button", { name: "Use that?" }));

    expect(onSave).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe("America/Chicago");
    expect(screen.getByText("Times are in America/Chicago")).toBeInTheDocument();
    expect(screen.queryByTestId("tz-mismatch")).toBeNull();

    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ timezone: "America/Chicago" });
  });

  it("pre-selects the business's zone for a new site, over the device's", () => {
    setup({
      hours: { ...NOT_SET, hint: { workspaceTimezone: "Europe/Berlin", typicalDay: "" } },
      deviceZone: "America/Chicago",
    });
    expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe("Europe/Berlin");
    expect(screen.getByText("Times are in Europe/Berlin")).toBeInTheDocument();
  });

  it("falls back to the device's zone when the business has none", () => {
    setup({ hours: NOT_SET, deviceZone: "Asia/Tokyo" });
    expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe("Asia/Tokyo");
  });

  it("keeps the saved zone over every hint", () => {
    setup({
      hours: view({ timezone: "Asia/Tokyo", hint: { workspaceTimezone: "Europe/Berlin", typicalDay: "" } }),
      deviceZone: "America/Chicago",
    });
    expect((screen.getByLabelText("Timezone") as HTMLSelectElement).value).toBe("Asia/Tokyo");
  });
});

describe("HoursEditor — below manage", () => {
  it("renders the week as text with no control at all", () => {
    const { container } = setup({ canManage: false, deviceZone: "America/Chicago" });
    expect(screen.getByText(COPY.readOnlyNote)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(screen.getByText("Times are in Europe/London")).toBeInTheDocument();
    const monday = screen.getByText("Monday").closest("li")!;
    expect(monday).toHaveTextContent("9:00 AM – 5:00 PM");
    expect(screen.getByText("Sunday").closest("li")).toHaveTextContent("Closed");
  });

  it("says no hours are set, with no presets, when nothing is set", () => {
    setup({ canManage: false, hours: NOT_SET });
    expect(screen.getByText(COPY.notSet)).toBeInTheDocument();
    expect(screen.getByText(COPY.readOnlyNote)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("buildHoursBody refuses anything but seven days", () => {
    const week = draftWeekFromView(WEEK_9_5);
    expect(() => buildHoursBody(week.slice(0, 6), "Europe/London", 1)).toThrow(RangeError);
    expect(buildHoursBody(week, "Europe/London", 1).state).toBe("set");
  });

  it("draftWeekFromView orders by weekday and reads a missing day as closed", () => {
    const shuffled = [...WEEK_9_5].reverse().filter((d) => d.weekday !== 3);
    const week = draftWeekFromView(shuffled);
    expect(week).toHaveLength(7);
    expect(week[0]).toEqual({ kind: "hours", opens: "09:00", closes: "17:00" });
    expect(week[2]).toEqual({ kind: "closed", opens: "", closes: "" });
  });

  it("dayProblem / crossesMidnight / describeDay", () => {
    expect(dayProblem({ kind: "hours", opens: "09:00", closes: "09:00" })).toBe("same");
    expect(dayProblem({ kind: "hours", opens: "09:00", closes: "" })).toBe("missing");
    expect(dayProblem({ kind: "closed", opens: "09:00", closes: "09:00" })).toBeNull();
    expect(crossesMidnight({ kind: "hours", opens: "18:00", closes: "02:00" })).toBe(true);
    expect(crossesMidnight({ kind: "hours", opens: "09:00", closes: "17:00" })).toBe(false);
    expect(describeDay({ kind: "hours", opens: "18:00", closes: "02:00" })).toBe("6:00 PM – 2:00 AM the next day");
    expect(describeDay({ kind: "open_all_day", opens: null, closes: null })).toBe("Open all day");
  });

  it("initialZone: saved zone, then the business's, then the device's, else empty — never UTC", () => {
    expect(initialZone(view(), "Asia/Tokyo")).toBe("Europe/London");
    expect(initialZone({ ...NOT_SET, hint: { workspaceTimezone: "Europe/Berlin", typicalDay: "" } }, "Asia/Tokyo")).toBe(
      "Europe/Berlin",
    );
    expect(initialZone(NOT_SET, "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(initialZone(NOT_SET, null)).toBe("");
  });

  it("sameWeek ignores the version and special days, not the week", () => {
    expect(sameWeek(view(), view({ version: 9, exceptions: [] }))).toBe(true);
    expect(sameWeek(view(), view({ timezone: "Asia/Tokyo" }))).toBe(false);
    expect(
      sameWeek(view(), view({ days: WEEK_9_5.map((d) => (d.weekday === 7 ? { ...d, kind: "open_all_day" } : d)) })),
    ).toBe(false);
  });

  it("describeWindow formats in the SITE zone, never the device's", () => {
    // 00:00Z–08:00Z on 2026-09-24 is 9:00 AM–5:00 PM in Tokyo, whatever TZ this process runs in.
    const w = { startsAt: "2026-09-24T00:00:00.000Z", endsAt: "2026-09-24T08:00:00.000Z" };
    expect(describeWindow(w, "Asia/Tokyo", "2026-09-24")).toEqual({ day: "Today", span: "9:00 AM – 5:00 PM" });
    expect(describeWindow(w, "Asia/Tokyo", "2026-09-23")).toEqual({ day: "Tomorrow", span: "9:00 AM – 5:00 PM" });
    expect(describeWindow(w, "Asia/Tokyo", "2026-09-21").day).toBe("Thu, Sep 24");
  });

  it("describeWindow says 'the next day' and 'Open all day' where they apply", () => {
    const late = { startsAt: "2026-09-25T17:00:00.000Z", endsAt: "2026-09-26T01:00:00.000Z" }; // London BST
    expect(describeWindow(late, "Europe/London", "2026-09-25")).toEqual({
      day: "Today",
      span: "6:00 PM – 2:00 AM the next day",
    });
    const allDay = { startsAt: "2026-09-27T23:00:00.000Z", endsAt: "2026-09-28T23:00:00.000Z" };
    expect(describeWindow(allDay, "Europe/London", "2026-09-25").span).toBe("Open all day");
    const twoDays = { startsAt: "2026-09-27T23:00:00.000Z", endsAt: "2026-09-29T23:00:00.000Z" };
    expect(describeWindow(twoDays, "Europe/London", "2026-09-25").span).toBe("Open all day through Tue, Sep 29");
  });

  // The server clips its preview to [now, now + 7 days): the window open now
  // starts at the server's clock, the last one ends at it. Neither cut is an
  // opening or a closing, and printing one as a time misstates the hours.
  describe("describeWindow — the server's cuts at now and at the 7-day horizon", () => {
    const LONDON = "Europe/London";
    const NOW = new Date("2026-09-23T09:32:17.123Z"); // Wed 10:32:17 BST
    const HORIZON = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    const TODAY = "2026-09-23";

    it("the window open now reads 'Open now, until …', never its cut start", () => {
      const cut = { startsAt: NOW.toISOString(), endsAt: "2026-09-23T16:00:00.000Z" };
      expect(describeWindow(cut, LONDON, TODAY, NOW)).toEqual({ day: "Today", span: "Open now, until 5:00 PM" });
      // Without a client clock (or one behind the server's), the cut alone says so.
      expect(describeWindow(cut, LONDON, TODAY)).toEqual({ day: "Today", span: "Open now, until 5:00 PM" });
      // An unclipped window that already opened reads the same — not "9:00 AM – 5:00 PM".
      const unclipped = { startsAt: "2026-09-23T08:00:00.000Z", endsAt: "2026-09-23T16:00:00.000Z" };
      expect(describeWindow(unclipped, LONDON, TODAY, NOW).span).toBe("Open now, until 5:00 PM");
      expect(describeWindow(unclipped, LONDON, TODAY).span).toBe("9:00 AM – 5:00 PM");
    });

    it("the last window, cut at the horizon, says when it opens and claims no closing time", () => {
      const last = { startsAt: "2026-09-30T08:00:00.000Z", endsAt: HORIZON };
      expect(describeWindow(last, LONDON, TODAY, NOW)).toEqual({ day: "Wed, Sep 30", span: "Opens at 9:00 AM" });
    });

    it("always open: one window cut at both ends", () => {
      const week = { startsAt: NOW.toISOString(), endsAt: HORIZON };
      expect(describeWindow(week, LONDON, TODAY, NOW).span).toBe("Open now, and for all of the next 7 days");
    });

    it("open now past midnight, until midnight, and all day through a later date", () => {
      const fri = new Date("2026-09-25T21:13:05.500Z"); // Fri 22:13 BST, a Fri 18:00–02:00 window
      expect(
        describeWindow({ startsAt: fri.toISOString(), endsAt: "2026-09-26T01:00:00.000Z" }, LONDON, "2026-09-25", fri)
          .span,
      ).toBe("Open now, until 2:00 AM the next day");
      expect(
        describeWindow({ startsAt: NOW.toISOString(), endsAt: "2026-09-23T23:00:00.000Z" }, LONDON, TODAY, NOW).span,
      ).toBe("Open now, until midnight");
      expect(
        describeWindow({ startsAt: NOW.toISOString(), endsAt: "2026-09-25T23:00:00.000Z" }, LONDON, TODAY, NOW).span,
      ).toBe("Open now, all day through Fri, Sep 25");
      expect(
        describeWindow({ startsAt: NOW.toISOString(), endsAt: "2026-09-25T16:00:00.000Z" }, LONDON, TODAY, NOW).span,
      ).toBe("Open now, until Fri, Sep 25, 5:00 PM");
    });
  });
});

describe("HoursPreview and the business profile hint", () => {
  it("lists the server's windows in the site zone", () => {
    render(
      <HoursPreview
        timezone="Asia/Tokyo"
        now={new Date("2026-09-23T23:30:00.000Z")} // Tokyo 8:30 AM, before the first window opens
        preview={[
          { startsAt: "2026-09-24T00:00:00.000Z", endsAt: "2026-09-24T08:00:00.000Z" },
          { startsAt: "2026-09-25T00:00:00.000Z", endsAt: "2026-09-25T08:00:00.000Z" },
        ]}
      />,
    );
    const rows = within(screen.getByTestId("hours-preview")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["Today9:00 AM – 5:00 PM", "Tomorrow9:00 AM – 5:00 PM"]);
    expect(screen.getByText("From the saved hours, in Asia/Tokyo.")).toBeInTheDocument();
  });

  it("renders the server's clipped week truthfully: open now first, no invented closing time last", () => {
    const now = new Date("2026-09-23T09:32:17.123Z"); // Wed 10:32 BST, weekdays 9–5
    const horizon = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    const day = (d: string) => ({ startsAt: `${d}T08:00:00.000Z`, endsAt: `${d}T16:00:00.000Z` });
    render(
      <HoursPreview
        timezone="Europe/London"
        now={now}
        preview={[
          { startsAt: now.toISOString(), endsAt: "2026-09-23T16:00:00.000Z" },
          day("2026-09-24"),
          day("2026-09-25"),
          day("2026-09-28"),
          day("2026-09-29"),
          { startsAt: "2026-09-30T08:00:00.000Z", endsAt: horizon },
        ]}
      />,
    );
    const rows = within(screen.getByTestId("hours-preview")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "TodayOpen now, until 5:00 PM",
      "Tomorrow9:00 AM – 5:00 PM",
      "Fri, Sep 259:00 AM – 5:00 PM",
      "Mon, Sep 289:00 AM – 5:00 PM",
      "Tue, Sep 299:00 AM – 5:00 PM",
      "Wed, Sep 30Opens at 9:00 AM",
    ]);
    expect(screen.getByTestId("hours-preview")).not.toHaveTextContent("10:32");
  });

  it("uses its clock for a window that opened before now, even when the server did not cut it", () => {
    render(
      <HoursPreview
        timezone="Europe/London"
        now={new Date("2026-09-23T09:32:17.123Z")}
        preview={[{ startsAt: "2026-09-23T08:00:00.000Z", endsAt: "2026-09-23T16:00:00.000Z" }]}
      />,
    );
    expect(within(screen.getByTestId("hours-preview")).getByRole("listitem")).toHaveTextContent(
      "TodayOpen now, until 5:00 PM",
    );
  });

  it("says the site is closed all week when there is no window", () => {
    render(<HoursPreview timezone="Europe/London" preview={[]} />);
    expect(screen.getByText(COPY.previewNone)).toBeInTheDocument();
  });

  it("shows the typical day read-only, with no copy button, and nothing when empty", () => {
    const { rerender } = render(<BusinessProfileHint typicalDay="  We open at 9 and close at 6, later on Fridays.  " />);
    const hint = screen.getByTestId("profile-hint");
    expect(within(hint).getByText(COPY.profileTitle)).toBeInTheDocument();
    expect(within(hint).getByText("We open at 9 and close at 6, later on Fridays.")).toBeInTheDocument();
    expect(within(hint).queryAllByRole("button")).toEqual([]);
    rerender(<BusinessProfileHint typicalDay="   " />);
    expect(screen.queryByTestId("profile-hint")).toBeNull();
  });
});
