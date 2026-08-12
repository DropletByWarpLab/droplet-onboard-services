/**
 * PortTable — WARP-1787 defect 1: the switch port table ran off the right
 * edge of the Network page at phone widths.
 *
 * Measured in Chrome at a 375px viewport against the production CSS bundle,
 * with the table in its real place inside a `.card` on a `.page-inner`
 * (content box 343px, table box 303px):
 *
 *   · the row's own content measured **391px in a 303px box** — 88px of it
 *     unreachable, because the wrapper is `overflow-hidden` with no scroll
 *     affordance. The Status chip ("online") ended at x=366 and the chevron
 *     at x=395 against a wrapper edge of x=340: both clipped mid-element.
 *   · the **Port column resolved to 0px** — the primary identifying column
 *     ("Office desk · 1/1") rendered at zero width, because it is the one
 *     column that carries `min-w-0` and so yields all of its space first.
 *   · the gap was **16px, not the 12px `gap-3` asks for** — `.droplet-shell
 *     .grid` is (0,2,0) and beats the (0,1,0) utility
 *     (`04-coding-standards/mobile-web-layout.md` §4). At 6 gaps that is 24px
 *     of the shortfall handed away for free.
 *
 * jsdom has no layout engine (mobile-web-layout §5), so these assert the
 * declarations that produce those numbers, not the numbers.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { SwitchPort } from "@/lib/types/switch";
import { PortTable } from "../PortTable";

const ports: SwitchPort[] = [
  {
    port: 1,
    label: "1/1",
    name: "Office desk",
    role: "client",
    link_up: true,
    speed: "1 Gb",
    is_sfp: false,
    vlan: 1,
    vlan_name: "LAN",
    poe: { delivering: true, power_w: 6.4, class: 4, max_power_w: 30 },
    status: "online",
    device: { mac: "00:c0:f2:00:00:01", ip: "192.168.20.11", name: "Office desk" },
    traffic: { rx_bytes: 812_345_678, tx_bytes: 91_234_567 },
  },
  {
    port: 7,
    label: "1/7",
    name: "Garage cam",
    role: "camera",
    link_up: true,
    speed: "1 Gb",
    is_sfp: false,
    vlan: 100,
    vlan_name: "Cameras",
    poe: { delivering: true, power_w: 4.0, class: 4, max_power_w: 30 },
    status: "warn",
  },
];

describe("PortTable — phone gutter (WARP-1787)", () => {
  it("pins its own column gap so the shell's `.grid { gap: 16px }` cannot widen the row", () => {
    const { container } = render(<PortTable ports={ports} onPick={() => {}} />);
    const rows = container.querySelectorAll<HTMLElement>(".grid");
    // Header row + one row per port.
    expect(rows).toHaveLength(ports.length + 1);
    for (const r of rows) expect(r.style.gap).toBe("12px");
  });

  it("contains its own horizontal overflow instead of clipping it away", () => {
    // The contract from mobile-web-layout §2a: a row that cannot fit either
    // wraps or scrolls. A six-attribute table cannot wrap, so it scrolls —
    // and the columns keep a floor so the Port column can't collapse to 0px.
    const { container } = render(<PortTable ports={ports} onPick={() => {}} />);
    const scroller = container.querySelector<HTMLElement>("[data-port-table-scroll]");
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("overflow-x-auto");
    expect(scroller!.className).toContain("overscroll-x-contain");

    const track = scroller!.firstElementChild as HTMLElement;
    expect(track.className).toMatch(/min-w-\[\d+px\]/);
    // Header and every row live on the same track, so they scroll together
    // and stay column-aligned.
    expect(track.querySelectorAll(".grid")).toHaveLength(ports.length + 1);
  });

  it("does not hide the scrollbar — it is the only hint the row scrolls", () => {
    // Sam's earlier sweep called this out explicitly on the tab strip; the
    // same reasoning applies here (mobile-layout-contract.test.ts).
    const { container } = render(<PortTable ports={ports} onPick={() => {}} />);
    const scroller = container.querySelector<HTMLElement>("[data-port-table-scroll]")!;
    expect(scroller.className).not.toContain("scrollbar-hide");
    expect(scroller.style.scrollbarWidth).not.toBe("none");
  });

  it("still renders every port row and its facts", () => {
    // Positive control — the layout assertions above are worthless if the
    // table stopped rendering.
    const { getByText, getAllByRole } = render(<PortTable ports={ports} onPick={() => {}} />);
    expect(getAllByRole("button")).toHaveLength(ports.length);
    expect(getByText("Office desk")).toBeTruthy();
    expect(getByText("Garage cam")).toBeTruthy();
  });
});
