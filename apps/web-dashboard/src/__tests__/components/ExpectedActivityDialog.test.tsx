/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4) — the add-expected-activity side
 * panel.
 *
 * Pins: every control is reachable by its label and the choice groups are
 * named fieldsets; the form opens at the SITE's hour; the body sent is exactly
 * route 33's (target by kind, trimmed reason, codes in the page's order); only
 * a person can be quieted for staying longer (long_dwell is disabled and
 * dropped for anything else); a missing flag or reason, or a reason with
 * characters the server refuses, blocks the save with words; a 400/404/409/503
 * shows the security domain's friendly words — never the server's — and the
 * panel stays open; the labelled Close control and Escape both close it; and
 * a reopened panel starts fresh.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExpectedActivityDialog, EXPECTED_REASON_MAX, type ExpectedActivityDialogProps } from "@/components/security/ExpectedActivityDialog";
import { EXPECTED_DIALOG_COPY as D, PATTERN_NAME } from "@/components/security/patterns-copy";
import type { SecurityPatternsOverview } from "@/lib/types";

const TZ = "America/New_York";
/** 22:30 on Sep 24 at the site (02:30 UTC on Sep 25). */
const NOW = new Date("2026-09-25T02:30:00.000Z");

const KEYS: SecurityPatternsOverview["keys"] = [
  { zoneKey: "zone:z-stock", kind: "area", zoneId: "z-stock", name: "Stock room", cameras: ["stock"], labels: ["person", "car"], learning: false },
  { zoneKey: "camera:back", kind: "camera", zoneId: null, name: "Back camera", cameras: ["back"], labels: ["car", "dog"], learning: false },
];

function renderDialog(over: Partial<ExpectedActivityDialogProps> = {}) {
  const props: ExpectedActivityDialogProps = {
    open: true,
    onClose: vi.fn(),
    keys: KEYS,
    timezone: TZ,
    now: NOW,
    onCreate: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  const utils = render(<ExpectedActivityDialog {...props} />);
  return { ...utils, props };
}

const flag = (code: keyof typeof PATTERN_NAME) => screen.getByRole("checkbox", { name: PATTERN_NAME[code] });
const save = () => fireEvent.click(screen.getByRole("button", { name: D.save }));
const setReason = (value: string) => fireEvent.change(screen.getByLabelText(D.reason), { target: { value } });

describe("ExpectedActivityDialog — the form", () => {
  it("is a titled, described dialog whose controls are reachable by their labels", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: D.title });
    expect(dialog).toHaveAccessibleDescription(D.intro);
    for (const label of [D.where, D.what, D.from, D.for, D.reason, D.until]) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: D.days })).getAllByRole("radio")).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: D.flags })).getAllByRole("checkbox")).toHaveLength(3);
  });

  it("offers areas then cameras, grouped, and the lengths the server accepts", () => {
    renderDialog();
    const where = screen.getByLabelText(D.where);
    expect(within(where).getByRole("group", { name: "Areas" })).toHaveTextContent("Stock room");
    expect(within(where).getByRole("group", { name: "Cameras" })).toHaveTextContent("Back camera");
    const until = screen.getByLabelText(D.until) as HTMLSelectElement;
    expect([...until.options].map((o) => o.value)).toEqual(["7", "30", "90", "365"]);
    expect(until.value).toBe("30");
  });

  it("starts at the site's hour, not the device's", () => {
    renderDialog();
    expect((screen.getByLabelText(D.from) as HTMLSelectElement).value).toBe("22");
    expect((screen.getByLabelText(D.for) as HTMLSelectElement).value).toBe("1");
  });

  it("sends exactly route 33's body for an area: trimmed reason, codes in the page's order", async () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Weekdays" }));
    fireEvent.change(screen.getByLabelText(D.from), { target: { value: "21" } });
    fireEvent.change(screen.getByLabelText(D.for), { target: { value: "3" } });
    fireEvent.click(flag("long_dwell"));
    fireEvent.click(flag("unusual_volume"));
    setReason("  The cleaner comes on weekday evenings  ");
    fireEvent.change(screen.getByLabelText(D.until), { target: { value: "90" } });
    save();
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(props.onCreate).toHaveBeenCalledWith({
      target: { kind: "area", zoneId: "z-stock" },
      label: "person",
      days: "weekdays",
      hourFrom: 21,
      hourCount: 3,
      codes: ["out_of_place", "unusual_volume", "long_dwell"],
      reason: "The cleaner comes on weekday evenings",
      expiresInDays: 90,
    });
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  });

  it("names a camera by its Frigate name, and keeps the label only if the camera has it", async () => {
    const { props } = renderDialog();
    fireEvent.change(screen.getByLabelText(D.what), { target: { value: "car" } });
    fireEvent.change(screen.getByLabelText(D.where), { target: { value: "camera:back" } });
    expect((screen.getByLabelText(D.what) as HTMLSelectElement).value).toBe("car");
    setReason("Deliveries");
    save();
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "camera", camera: "back" }, label: "car" }));
  });

  it("switches to the new place's first label when the old one isn't seen there", () => {
    renderDialog();
    expect((screen.getByLabelText(D.what) as HTMLSelectElement).value).toBe("person");
    fireEvent.change(screen.getByLabelText(D.where), { target: { value: "camera:back" } });
    expect((screen.getByLabelText(D.what) as HTMLSelectElement).value).toBe("car");
  });
});

describe("ExpectedActivityDialog — only a person can stay longer than usual", () => {
  it("disables and drops Stayed longer than usual for anything but a person, and says why", async () => {
    const { props } = renderDialog();
    fireEvent.click(flag("long_dwell"));
    expect(flag("long_dwell")).toBeChecked();
    fireEvent.change(screen.getByLabelText(D.what), { target: { value: "car" } });
    expect(flag("long_dwell")).toBeDisabled();
    expect(flag("long_dwell")).not.toBeChecked();
    expect(flag("long_dwell")).toHaveAccessibleDescription(D.dwellPersonOnly);
    setReason("Deliveries");
    save();
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(vi.mocked(props.onCreate).mock.calls[0][0].codes).toEqual(["out_of_place"]);
  });

  it("enables it again for a person", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(D.what), { target: { value: "car" } });
    fireEvent.change(screen.getByLabelText(D.what), { target: { value: "person" } });
    expect(flag("long_dwell")).toBeEnabled();
  });
});

describe("ExpectedActivityDialog — what blocks a save", () => {
  it("no flag chosen", async () => {
    const { props } = renderDialog();
    fireEvent.click(flag("out_of_place"));
    setReason("Stocktake");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(D.needFlag);
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("no reason (spaces only)", async () => {
    const { props } = renderDialog();
    setReason("   ");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(D.needReason);
    expect(screen.getByLabelText(D.reason)).toHaveAttribute("aria-invalid", "true");
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["a bidi override", "Cleaner ‮evenings"],
    ["a control character", "Cleaner\u0007"],
    ["a line separator", "Cleaner evenings"],
    ["more than 120 characters", "x".repeat(EXPECTED_REASON_MAX + 1)],
  ])("a reason with %s", async (_what, reason) => {
    const { props } = renderDialog();
    setReason(reason);
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(D.badReason);
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("120 characters counted as people count them (an emoji is one) is fine", async () => {
    const { props } = renderDialog();
    setReason("🧹".repeat(EXPECTED_REASON_MAX));
    save();
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
  });

  it("typing again clears the reason's problem", async () => {
    renderDialog();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(D.needReason);
    setReason("S");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ExpectedActivityDialog — a refusal keeps the panel open, in friendly words", () => {
  it.each([
    ["VALIDATION_ERROR", 400, "Some of that isn't quite right. Check what you entered and try again."],
    ["SUPPRESSION_TARGET_NOT_FOUND", 404, "That area or camera isn't there any more. Refresh the page."],
    ["SUPPRESSION_LIMIT", 409, "There can be up to 100 expected activities at a time. Remove one first. Nothing was changed."],
    ["ZONE_ARCHIVED", 409, "That area was removed. Restore it before changing it."],
    ["SUPPRESSIONS_UNAVAILABLE", 503, "Droplet couldn't load expected activity right now."],
  ])("%s (%i)", async (code, status, words) => {
    const onCreate = vi.fn().mockRejectedValue(Object.assign(new Error("raw server words"), { code, status }));
    const { props } = renderDialog({ onCreate });
    setReason("Stocktake");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(screen.queryByText(/raw server words/)).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: D.save })).toBeEnabled());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(D.reason)).toHaveValue("Stocktake");
  });
});

describe("ExpectedActivityDialog — closing and reopening", () => {
  it("renders a labelled Close control (a phone sheet has no backdrop to tap)", () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes it", () => {
    const { props } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the panel when it opens", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: D.title });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("starts fresh when reopened", () => {
    const { props, rerender } = renderDialog();
    setReason("Stocktake");
    fireEvent.click(screen.getByRole("radio", { name: "Weekends" }));
    rerender(<ExpectedActivityDialog {...props} open={false} />);
    rerender(<ExpectedActivityDialog {...props} open />);
    expect(screen.getByLabelText(D.reason)).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Every day" })).toBeChecked();
  });
});
