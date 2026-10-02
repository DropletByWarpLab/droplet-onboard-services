/**
 * WARP-2977 P2b (spec §6.2, §8) — special days on the Opening hours page.
 *
 * A special day replaces only its own date's hours; the explainer says so.
 * Dates are the SITE's calendar dates, the form offers today up to a year
 * ahead, and below manage there is no form and no Remove.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  COPY,
  EXCEPTION_MAX_DAYS_AHEAD,
  ExceptionsEditor,
  buildExceptionInput,
  type ExceptionsEditorProps,
} from "@/components/security/ExceptionsEditor";
import { COPY as HOURS_COPY, formatSiteDate, ymdAddDays } from "@/components/security/HoursEditor";
import type { SecurityHoursException } from "@/lib/types";

const TODAY = "2026-09-23";

const XMAS: SecurityHoursException = { date: "2026-12-25", kind: "closed", opens: null, closes: null, note: "Christmas" };
const LATE: SecurityHoursException = { date: "2026-10-02", kind: "hours", opens: "18:00", closes: "02:00", note: "" };
const YESTERDAY: SecurityHoursException = { date: "2026-09-22", kind: "open_all_day", opens: null, closes: null, note: "" };

function setup(over: Partial<ExceptionsEditorProps> = {}) {
  const onSave = vi.fn(async () => true);
  const onDelete = vi.fn(async () => true);
  const props: ExceptionsEditorProps = {
    exceptions: [XMAS, LATE, YESTERDAY],
    hoursSet: true,
    today: TODAY,
    canManage: true,
    onSave,
    onDelete,
    ...over,
  };
  return { ...render(<ExceptionsEditor {...props} />), onSave, onDelete, props };
}

describe("ExceptionsEditor — the list", () => {
  it("explains what a special day replaces", () => {
    setup();
    expect(
      screen.getByText(
        "A special day replaces that date's normal hours. Late hours from the evening before still end when they normally would.",
      ),
    ).toBeInTheDocument();
  });

  it("lists upcoming special days in date order, from the site's today", () => {
    setup();
    const rows = within(screen.getByTestId("special-days")).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-date"))).toEqual(["2026-10-02", "2026-12-25"]);
    expect(rows[0]).toHaveTextContent("Fri, Oct 2");
    expect(rows[0]).toHaveTextContent("6:00 PM – 2:00 AM the next day");
    expect(rows[1]).toHaveTextContent("Fri, Dec 25");
    expect(rows[1]).toHaveTextContent("Closed · Christmas");
  });

  it("says when there are none", () => {
    setup({ exceptions: [] });
    expect(screen.getByText(COPY.empty)).toBeInTheDocument();
  });

  it("removes a special day by its date", async () => {
    const { onDelete } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove Fri, Dec 25" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("2026-12-25"));
  });
});

describe("ExceptionsEditor — Add a day", () => {
  it("adds a closed day with a note", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const form = screen.getByRole("form", { name: COPY.add });
    fireEvent.change(within(form).getByLabelText(COPY.date), { target: { value: "2026-11-26" } });
    fireEvent.change(within(form).getByLabelText(COPY.note), { target: { value: "  Thanksgiving  " } });
    fireEvent.click(within(form).getByRole("button", { name: COPY.save }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("2026-11-26", { kind: "closed", note: "Thanksgiving" }),
    );
    // Saved → the form closes.
    await waitFor(() => expect(screen.queryByRole("form", { name: COPY.add })).toBeNull());
  });

  it("adds a late night with its times, and says it runs into the next day", async () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const form = screen.getByRole("form", { name: COPY.add });
    fireEvent.change(within(form).getByLabelText(COPY.date), { target: { value: "2026-10-09" } });
    fireEvent.click(within(form).getByRole("button", { name: HOURS_COPY.kindHours }));
    fireEvent.change(within(form).getByLabelText(HOURS_COPY.opens), { target: { value: "20:00" } });
    fireEvent.change(within(form).getByLabelText(HOURS_COPY.closes), { target: { value: "01:00" } });
    expect(within(form).getByText("Closes at 1:00 AM the next day")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: COPY.save }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("2026-10-09", { kind: "hours", opens: "20:00", closes: "01:00" }),
    );
  });

  it("refuses equal times and keeps the form open when the save fails", async () => {
    const onSave = vi.fn(async () => false);
    setup({ onSave });
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const form = screen.getByRole("form", { name: COPY.add });
    fireEvent.change(within(form).getByLabelText(COPY.date), { target: { value: "2026-10-09" } });
    fireEvent.click(within(form).getByRole("button", { name: HOURS_COPY.kindHours }));
    fireEvent.change(within(form).getByLabelText(HOURS_COPY.closes), { target: { value: "09:00" } });
    expect(within(form).getByRole("alert")).toHaveTextContent(HOURS_COPY.sameTimes);
    expect(within(form).getByRole("button", { name: COPY.save })).toBeDisabled();

    fireEvent.change(within(form).getByLabelText(HOURS_COPY.closes), { target: { value: "12:00" } });
    fireEvent.click(within(form).getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.getByRole("form", { name: COPY.add })).toBeInTheDocument();
  });

  it("offers today up to a year ahead, and refuses a date outside it", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const form = screen.getByRole("form", { name: COPY.add });
    const date = within(form).getByLabelText(COPY.date);
    expect(date).toHaveAttribute("type", "date");
    expect(date).toHaveAttribute("min", TODAY);
    expect(date).toHaveAttribute("max", ymdAddDays(TODAY, EXCEPTION_MAX_DAYS_AHEAD));
    fireEvent.change(date, { target: { value: "2026-09-01" } });
    expect(within(form).getByRole("alert")).toHaveTextContent(COPY.dateRange);
    expect(within(form).getByRole("button", { name: COPY.save })).toBeDisabled();
  });

  it("warns that saving an existing date replaces it", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const form = screen.getByRole("form", { name: COPY.add });
    fireEvent.change(within(form).getByLabelText(COPY.date), { target: { value: "2026-12-25" } });
    expect(within(form).getByText(COPY.replaces)).toBeInTheDocument();
  });

  it("cancels without saving", () => {
    const { onSave } = setup();
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    fireEvent.click(screen.getByRole("button", { name: COPY.cancel }));
    expect(screen.queryByRole("form", { name: COPY.add })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("asks for usual hours first when none are set", () => {
    setup({ hoursSet: false, today: null, exceptions: [] });
    expect(screen.getByText(COPY.needsHours)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY.add })).toBeNull();
  });
});

describe("ExceptionsEditor — below manage", () => {
  it("lists special days with no Add and no Remove", () => {
    setup({ canManage: false });
    expect(within(screen.getByTestId("special-days")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByText(COPY.needsHours)).toBeNull();
  });
});

describe("pure helpers", () => {
  it("buildExceptionInput sends times only when Open, and a trimmed note only when there is one", () => {
    expect(buildExceptionInput({ kind: "closed", opens: "09:00", closes: "17:00" }, "   ")).toEqual({ kind: "closed" });
    expect(buildExceptionInput({ kind: "hours", opens: "09:00", closes: "13:00" }, " Half day ")).toEqual({
      kind: "hours",
      opens: "09:00",
      closes: "13:00",
      note: "Half day",
    });
    expect(buildExceptionInput({ kind: "open_all_day", opens: "", closes: "" }, "Stock\ttake")).toEqual({
      kind: "open_all_day",
      note: "Stocktake",
    });
  });

  // The server's rule for notes: no C1 controls, line separators or bidi overrides / isolates.
  it.each([
    ["a right-to-left override", "Holiday\u202E", "Holiday"],
    ["a bidi isolate", "Holi\u2067day", "Holiday"],
    ["a C1 control", "Holi\u0085day", "Holiday"],
    ["a line separator", "Holi\u2028day", "Holiday"],
  ])("buildExceptionInput drops %s the server would refuse", (_n, raw, note) => {
    expect(buildExceptionInput({ kind: "closed", opens: "", closes: "" }, raw)).toEqual({ kind: "closed", note });
  });

  it("formatSiteDate formats the calendar date itself, adding the year only across a year", () => {
    expect(formatSiteDate("2026-12-25", TODAY)).toBe("Fri, Dec 25");
    expect(formatSiteDate("2027-01-01", TODAY)).toBe("Fri, Jan 1, 2027");
  });

  it("ymdAddDays is calendar arithmetic across months and years", () => {
    expect(ymdAddDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(ymdAddDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
