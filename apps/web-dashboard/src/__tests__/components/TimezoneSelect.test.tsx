/**
 * WARP-2977 P2b (spec §6.4, §8) — the opening hours' timezone picker.
 *
 * A wrong site zone silently shifts every open and close, so the zone is
 * always on screen, the device's zone is only ever a suggestion, and the list
 * is the runtime's own IANA list (the names the server validates against).
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  COPY,
  TimezoneSelect,
  fill,
  sameZone,
  supportedTimeZones,
  zoneLabel,
} from "@/components/security/TimezoneSelect";

const ZONES = ["Europe/London", "America/Chicago", "Asia/Tokyo"];

describe("TimezoneSelect", () => {
  it("always says which zone the times are in", () => {
    render(<TimezoneSelect value="Europe/London" onChange={vi.fn()} deviceZone="Europe/London" zones={ZONES} />);
    expect(screen.getByText("Times are in Europe/London")).toBeInTheDocument();
    expect(screen.queryByTestId("tz-mismatch")).toBeNull();
  });

  it("is a labelled native select over the zone list, sorted", () => {
    render(<TimezoneSelect value="Europe/London" onChange={vi.fn()} deviceZone={null} zones={ZONES} />);
    const select = screen.getByLabelText(COPY.label) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["America/Chicago", "Asia/Tokyo", "Europe/London"]);
    expect(select.value).toBe("Europe/London");
  });

  it("defaults to the runtime's IANA list (Intl.supportedValuesOf)", () => {
    const all = supportedTimeZones();
    expect(all.length).toBeGreaterThan(300);
    expect(all).toContain("Europe/London");
    render(<TimezoneSelect value="Europe/London" onChange={vi.fn()} deviceZone={null} />);
    const select = screen.getByLabelText(COPY.label) as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThanOrEqual(all.length);
  });

  it("keeps a value, and the device's zone, that the list does not carry", () => {
    render(<TimezoneSelect value="Etc/GMT+5" onChange={vi.fn()} deviceZone="Pacific/Kiritimati" zones={ZONES} />);
    const values = Array.from((screen.getByLabelText(COPY.label) as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toContain("Etc/GMT+5");
    expect(values).toContain("Pacific/Kiritimati");
  });

  it("offers the device's zone on a mismatch, and hands it to onChange only when asked", () => {
    const onChange = vi.fn();
    render(<TimezoneSelect value="Europe/London" onChange={onChange} deviceZone="America/Chicago" zones={ZONES} />);
    const hint = screen.getByTestId("tz-mismatch");
    expect(hint).toHaveTextContent(`Your device is on ${zoneLabel("America/Chicago")}. Use that?`);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(hint).getByRole("button", { name: COPY.useDevice }));
    expect(onChange).toHaveBeenCalledWith("America/Chicago");
  });

  it("never tells a device on an alias of the site zone that it is somewhere else", () => {
    // The server stores Node's canonical spelling; a browser may report the other one.
    render(
      <TimezoneSelect value="Asia/Calcutta" onChange={vi.fn()} deviceZone="Asia/Kolkata" zones={["Asia/Calcutta"]} />,
    );
    expect(screen.getByText("Times are in Asia/Calcutta")).toBeInTheDocument();
    expect(screen.queryByTestId("tz-mismatch")).toBeNull();
  });

  it("sameZone: aliases are one zone; different zones and unknown ids are not", () => {
    expect(sameZone("Asia/Kolkata", "Asia/Calcutta")).toBe(true);
    expect(sameZone("Europe/Kyiv", "Europe/Kiev")).toBe(true);
    expect(sameZone("Europe/London", "Europe/London")).toBe(true);
    expect(sameZone("Europe/London", "Europe/Dublin")).toBe(false);
    expect(sameZone("Not/AZone", "Also/NotAZone")).toBe(false);
  });

  it("reports a pick from the list", () => {
    const onChange = vi.fn();
    render(<TimezoneSelect value="Europe/London" onChange={onChange} deviceZone={null} zones={ZONES} />);
    fireEvent.change(screen.getByLabelText(COPY.label), { target: { value: "Asia/Tokyo" } });
    expect(onChange).toHaveBeenCalledWith("Asia/Tokyo");
  });

  it("asks for a zone when none is known, and never shows a UTC default", () => {
    render(<TimezoneSelect value="" onChange={vi.fn()} deviceZone={null} zones={ZONES} />);
    expect(screen.getByText(COPY.noZone)).toBeInTheDocument();
    const select = screen.getByLabelText(COPY.label) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.queryByText(/Times are in/)).toBeNull();
    expect(screen.queryByTestId("tz-mismatch")).toBeNull();
  });

  it("read-only: shows the zone and the mismatch, with no control", () => {
    render(
      <TimezoneSelect value="Europe/London" onChange={vi.fn()} deviceZone="America/Chicago" readOnly zones={ZONES} />,
    );
    expect(screen.getByText("Times are in Europe/London")).toBeInTheDocument();
    expect(screen.getByTestId("tz-mismatch")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("zoneLabel names the zone with its id, and falls back to the id", () => {
    expect(zoneLabel("America/Chicago")).toMatch(/\(America\/Chicago\)$/);
    expect(zoneLabel("Not/AZone")).toBe("Not/AZone");
  });

  it("fill replaces known placeholders and leaves unknown ones", () => {
    expect(fill("Times are in {zone}", { zone: "Asia/Tokyo" })).toBe("Times are in Asia/Tokyo");
    expect(fill("{a} and {b}", { a: "x" })).toBe("x and {b}");
  });
});
