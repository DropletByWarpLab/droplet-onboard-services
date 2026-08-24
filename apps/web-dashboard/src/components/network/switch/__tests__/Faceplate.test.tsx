/**
 * Faceplate — WARP-2165: the switch graphic must describe the unit in front
 * of the owner, not the first model we shipped.
 *
 * The legend was the literal string "copper 1–8 · SFP 9–10" and the optical
 * bank (a hairline divider plus a fixed 110px column) rendered unconditionally.
 * On the GS1900-8HP — which has lan1-8 and no optical cage at all, verified on
 * the live unit — that drew a stray divider beside an empty column and told
 * the owner they had two SFP ports they do not have.
 *
 * Both now derive from the ports actually passed in, so the graphic stays
 * correct on whatever hardware a unit ships with.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SwitchPort } from "@/lib/types/switch";
import { Faceplate } from "../Faceplate";

function port(n: number, is_sfp = false): SwitchPort {
  return {
    port: n,
    label: `1/${n}`,
    name: `Port ${n}`,
    role: "unknown",
    link_up: false,
    speed: "",
    is_sfp,
    vlan: 1,
    vlan_name: "LAN",
    poe: null,
    status: "offline",
  } as SwitchPort;
}

const EIGHT_PORT = Array.from({ length: 8 }, (_, i) => port(i + 1));
const TEN_PORT = [...EIGHT_PORT, port(9, true), port(10, true)];

describe("Faceplate legend", () => {
  it("names only the copper bank on a unit with no SFP cage", () => {
    render(<Faceplate ports={EIGHT_PORT} onPick={() => {}} />);
    expect(screen.getByText("copper 1–8")).toBeInTheDocument();
  });

  it("names both banks on a unit that has optical ports", () => {
    render(<Faceplate ports={TEN_PORT} onPick={() => {}} />);
    expect(screen.getByText("copper 1–8 · SFP 9–10")).toBeInTheDocument();
  });

  it("does not render a range for a single port", () => {
    render(<Faceplate ports={[port(3)]} onPick={() => {}} />);
    expect(screen.getByText("copper 3")).toBeInTheDocument();
  });

  it("reads the ends off the data, not off a 1..n assumption", () => {
    // A unit naming lan2/lan3/lan6 has a port 6 — the label must say so
    // rather than reporting "1–3" from a count.
    render(<Faceplate ports={[port(2), port(3), port(6)]} onPick={() => {}} />);
    expect(screen.getByText("copper 2–6")).toBeInTheDocument();
  });
});

describe("Faceplate optical bank", () => {
  it("omits the divider and the SFP column when there are none", () => {
    const { container } = render(<Faceplate ports={EIGHT_PORT} onPick={() => {}} />);
    // The divider is the only 1px-wide rule inside the chassis box.
    expect(container.querySelectorAll(".w-px").length).toBe(0);
  });

  it("keeps the divider when an optical bank exists", () => {
    const { container } = render(<Faceplate ports={TEN_PORT} onPick={() => {}} />);
    expect(container.querySelectorAll(".w-px").length).toBe(1);
  });
});
