/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4) — the add-expected-activity side
 * panel.
 *
 * Pins: every control is reachable by its label and the choice groups are
 * named fieldsets; the form opens at the SITE's hour; "All day" is midnight to
 * midnight (From goes to 12 AM and locks); the site date it ends is shown
 * under "For how long" before saving; the body sent is exactly route 33's
 * (target by kind, trimmed reason, codes in the page's order); only a person
 * can be quieted for staying longer (long_dwell is disabled and dropped for
 * anything else); a missing flag or reason, or a reason with characters the
 * server refuses, blocks the save with words that describe the control at
 * fault, which takes focus; a 400/404/409/503 shows the security domain's
 * friendly words — never the server's — and the panel stays open; the
 * problem line is readable text ink in both themes; the labelled Close
 * control and Escape both close it; a reopened panel starts fresh; and no
 * Security source hides a bidi or zero-width character.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { packagePath } from "../helpers/test-paths";
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
/** The panel has taken focus (the Dialog does it one tick after opening), as it has long before anyone can press Add. */
const focusedIn = () => waitFor(() => expect(screen.getByRole("dialog", { name: D.title }).contains(document.activeElement)).toBe(true));

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
    expect([...until.options].map((o) => o.text)).toEqual(["A week", "A month", "3 months", "A year"]);
    expect(until.value).toBe("30");
  });

  it("shows the site date it ends under For how long, before anything is saved", () => {
    renderDialog();
    const until = screen.getByLabelText(D.until);
    // 22:30 on Sep 24 at the site: 30 days on is 22:30 on Oct 24 there (Oct 25 in UTC).
    expect(until).toHaveAccessibleDescription("Ends Oct 24");
    fireEvent.change(until, { target: { value: "7" } });
    expect(until).toHaveAccessibleDescription("Ends Oct 1");
    fireEvent.change(until, { target: { value: "365" } });
    expect(until).toHaveAccessibleDescription("Ends Sep 24, 2027");
  });

  it("starts at the site's hour, not the device's", () => {
    renderDialog();
    expect((screen.getByLabelText(D.from) as HTMLSelectElement).value).toBe("22");
    expect((screen.getByLabelText(D.for) as HTMLSelectElement).value).toBe("1");
  });

  it("All day is midnight to midnight: From goes to 12 AM and locks, and that is what is sent", async () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Weekdays" }));
    fireEvent.change(screen.getByLabelText(D.for), { target: { value: "24" } });
    const from = screen.getByLabelText(D.from) as HTMLSelectElement;
    expect(from.value).toBe("0");
    expect(from).toBeDisabled();
    setReason("Stocktake week");
    save();
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ days: "weekdays", hourFrom: 0, hourCount: 24 }));
  });

  it("a shorter window unlocks From again", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(D.for), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText(D.for), { target: { value: "3" } });
    expect(screen.getByLabelText(D.from)).toBeEnabled();
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
  it("no flag chosen: the flag group is described by the problem and takes focus; the reason field is not", async () => {
    const { props } = renderDialog();
    await focusedIn();
    fireEvent.click(flag("out_of_place"));
    setReason("Stocktake");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(D.needFlag);
    expect(screen.getByRole("group", { name: D.flags })).toHaveAccessibleDescription(D.needFlag);
    expect(flag("out_of_place")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(flag("out_of_place")).toHaveFocus());
    expect(screen.getByLabelText(D.reason)).not.toHaveAttribute("aria-describedby");
    expect(screen.getByLabelText(D.reason)).toHaveAttribute("aria-invalid", "false");
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("no reason (spaces only): the reason field is described by the problem and takes focus; the flag group is not", async () => {
    const { props } = renderDialog();
    await focusedIn();
    setReason("   ");
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent(D.needReason);
    expect(screen.getByLabelText(D.reason)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(D.reason)).toHaveAccessibleDescription(D.needReason);
    await waitFor(() => expect(screen.getByLabelText(D.reason)).toHaveFocus());
    expect(screen.getByRole("group", { name: D.flags })).not.toHaveAttribute("aria-describedby");
    expect(flag("out_of_place")).not.toHaveAttribute("aria-invalid");
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["a bidi override", "Cleaner \u202eevenings"],
    ["a bidi embedding", "Cleaner \u202aevenings"],
    ["a bidi isolate", "Cleaner \u2066evenings"],
    ["a pop directional isolate", "Cleaner \u2069evenings"],
    ["a zero-width no-break space", "Cleaner \ufeffevenings"],
    ["a control character", "Cleaner\u0007"],
    ["a line separator", "Cleaner\u2028evenings"],
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
    // Not about the reason or the flags: neither is described by it or marked invalid.
    expect(screen.getByLabelText(D.reason)).not.toHaveAttribute("aria-describedby");
    expect(screen.getByLabelText(D.reason)).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("group", { name: D.flags })).not.toHaveAttribute("aria-describedby");
  });
});

describe("ExpectedActivityDialog — the problem line is readable in both themes", () => {
  const tokens = readFileSync(packagePath("src/components/shell/indigo-tokens.css"), "utf8");
  const patternsCss = readFileSync(packagePath("src/components/security/patterns.css"), "utf8");
  /** A custom property's value in the first block whose selector starts with `selector`. */
  const token = (selector: string, name: string): string => {
    const at = tokens.indexOf(`${selector}`);
    const block = tokens.slice(at, tokens.indexOf("}", at));
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (!m) throw new Error(`${name} not found under ${selector}`);
    return m[1]!;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it("uses the text-ink class, never an inline colour", async () => {
    renderDialog();
    save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("expected-problem");
    expect(alert.getAttribute("style")).toBeNull();
    expect(patternsCss).toMatch(/\.droplet-shell \.expected-problem \{[^}]*color: var\(--danger-ink\);/);
  });

  it.each([
    ["light", ".droplet-shell,"],
    ["dark", ".dark .droplet-shell,"],
  ])("--danger-ink clears 4.5:1 on the panel's card in %s mode", (_theme, selector) => {
    expect(contrast(token(selector, "--danger-ink"), token(selector, "--card-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(selector, "--danger-ink"), token(selector, "--surface"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("ExpectedActivityDialog — even targets, 44 px on a phone", () => {
  const css = readFileSync(packagePath("src/components/security/patterns.css"), "utf8");

  it("every select in the form is as tall as the text field (40 px) on a desktop", () => {
    renderDialog();
    const selects = screen.getByRole("dialog", { name: D.title }).querySelectorAll("select");
    expect(selects).toHaveLength(5);
    for (const select of selects) expect(select).toHaveClass("expected-select");
    expect(css).toMatch(/\.droplet-shell \.expected-select \{ height: 40px; \}/);
    expect(css).toMatch(/\.droplet-shell \.expected-input \{[^}]*height: 40px;/);
  });

  it("at ≤ 720 px every choice, select and field is 44 px, as the shell's controls are", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(phone).toMatch(/^@media \(max-width: 720px\) \{\s*\.droplet-shell \.expected-choice \{ min-height: 44px; \}/);
    expect(phone).toMatch(/^@media[^@]*\.droplet-shell \.expected-select,\s*\.droplet-shell \.expected-input \{ height: 44px; \}/);
  });
});

describe("no Security source hides an invisible character (Trojan Source)", () => {
  it("components/security spells bidi controls and U+FEFF as \\u escapes", () => {
    const dir = packagePath("src/components/security");
    const files = readdirSync(dir).filter((f) => /\.(tsx?|css)$/.test(f));
    expect(files).toContain("ExpectedActivityDialog.tsx");
    const hidden = files.filter((f) => /[\u202A-\u202E\u2066-\u2069\uFEFF]/.test(readFileSync(`${dir}/${f}`, "utf8")));
    expect(hidden).toEqual([]);
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
