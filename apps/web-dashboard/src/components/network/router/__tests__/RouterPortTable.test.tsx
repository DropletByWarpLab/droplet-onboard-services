/**
 * RouterPortTable — the switch port table's defect, byte-identical, on the
 * same page (WARP-1787 follow-up).
 *
 * `PortTable` (switch) and this table are siblings: same `.card`, same
 * `.page-inner`, same type scale, rendered one above the other on /network.
 * The switch table was fixed for three things measured in Chrome at 375px
 * against the production CSS bundle; this table reproduced all three verbatim
 * and was left untouched, which is worse than either state — the two port maps
 * on one page behaved differently.
 *
 *   · `gap-3` never applied. `.droplet-shell .grid { gap: 16px }` is (0,2,0)
 *     and beats the (0,1,0) utility (`04-coding-standards/mobile-web-layout.md`
 *     §4). Over four gaps that is 16px of a phone's width handed away.
 *   · the Port column is the only one carrying `min-w-0`, so it absorbs the
 *     whole shortfall on its own and collapses first — on the switch table the
 *     same arrangement measured **0px**, losing the label identifying the row.
 *   · the wrapper was `overflow-hidden`, which throws the excess away with no
 *     scrollbar and no hint anything is missing.
 *
 * This table is not optional on a phone: `RouterPortsPanel` renders it under
 * `md:hidden` even when the Faceplate layout is selected, so it IS the phone
 * view of the router port map.
 *
 * jsdom has no layout engine (mobile-web-layout §5), so these assert the
 * declarations that produce those numbers, not the numbers. They deliberately
 * mirror `../../switch/__tests__/PortTable.test.tsx` assertion for assertion.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { RouterPort } from "@/lib/types/router-ports";
import { RouterPortTable } from "../RouterPortTable";

function port(over: Partial<RouterPort> & { id: string }): RouterPort {
  return {
    role: "lan",
    networks: ["lan", "guest"],
    present: true,
    admin_up: true,
    link_up: false,
    speed: null,
    duplex: null,
    mac: null,
    is_sfp: false,
    traffic: null,
    status: "offline",
    ...over,
  };
}

const ports: RouterPort[] = [
  port({
    id: "p1",
    role: "wan",
    networks: ["wan", "wan6"],
    link_up: true,
    speed: "2.5 Gb",
    duplex: "full",
    status: "online",
    traffic: { rx_bytes: 63_507_437, tx_bytes: 210_377_086 },
  }),
  port({ id: "p4", traffic: { rx_bytes: 0, tx_bytes: 0 } }),
  port({
    id: "sfp",
    role: "unused",
    networks: [],
    present: false,
    admin_up: null,
    is_sfp: true,
    status: "absent",
  }),
];

describe("RouterPortTable — phone gutter (WARP-1787)", () => {
  it("pins its own column gap so the shell's `.grid { gap: 16px }` cannot widen the row", () => {
    const { container } = render(<RouterPortTable ports={ports} />);
    const rows = container.querySelectorAll<HTMLElement>(".grid");
    // Header row + one row per port.
    expect(rows).toHaveLength(ports.length + 1);
    for (const r of rows) expect(r.style.gap).toBe("12px");
  });

  it("uses the same pinned gap as the switch table it sits beside", () => {
    // Two port maps on one page that disagree about their column rhythm read
    // as a bug even when neither is clipped.
    const { container } = render(<RouterPortTable ports={ports} />);
    const header = container.querySelector<HTMLElement>(".grid")!;
    expect(header.style.gap).toBe("12px");
    expect(header.className).not.toContain("gap-3");
  });

  it("contains its own horizontal overflow instead of clipping it away", () => {
    const { container } = render(<RouterPortTable ports={ports} />);
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
    const { container } = render(<RouterPortTable ports={ports} />);
    const scroller = container.querySelector<HTMLElement>("[data-port-table-scroll]")!;
    expect(scroller.className).not.toContain("scrollbar-hide");
    expect(scroller.style.scrollbarWidth).not.toBe("none");
  });

  it("still renders every port row and its facts", () => {
    // Positive control — the layout assertions above are worthless if the
    // table stopped rendering.
    const { getByText, container } = render(<RouterPortTable ports={ports} />);
    expect(container.querySelectorAll(".grid").length).toBe(ports.length + 1);
    expect(getByText("p1")).toBeTruthy();
    expect(getByText("sfp · SFP")).toBeTruthy();
    expect(getByText("2.5 Gb")).toBeTruthy();
    expect(getByText("↓61 MB ↑201 MB")).toBeTruthy();
  });
});
