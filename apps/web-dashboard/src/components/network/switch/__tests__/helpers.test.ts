/**
 * WARP-1716 — a switch port must never claim to be "Open" while it is lit.
 *
 * Both dashboard fallbacks used to answer "Open" for anything unnamed or
 * unroled — and the backend hardcoded `name: null` with an empty provision
 * config, so that was every port on every switch. A port with link up, PoE
 * delivering and traffic flowing still read "Open".
 *
 * "Open" is a claim about the CABLE. These tests pin it to link state, which is
 * the fact we actually hold.
 */
import { describe, it, expect } from "vitest";
import { portName, roleLabel, formatBytes, ROLE } from "../helpers";
import type { SwitchPort } from "@/lib/types/switch";

type NameArgs = Pick<SwitchPort, "name" | "link_up" | "device">;

const linked = (over: Partial<NameArgs> = {}): NameArgs => ({
  name: null,
  link_up: true,
  device: null,
  ...over,
});

describe("portName", () => {
  it("says 'In use' for a linked port it cannot name — never 'Open'", () => {
    expect(portName(linked())).toBe("In use");
  });

  it("says 'Open' only when the link is actually down", () => {
    expect(portName(linked({ link_up: false }))).toBe("Open");
  });

  it("prefers the joined device name over everything else", () => {
    expect(
      portName(linked({ name: "Camera", device: { mac: "aa:bb", name: "Front door" } })),
    ).toBe("Front door");
  });

  it("falls back to the port's own name when no device is joined", () => {
    expect(portName(linked({ name: "Uplink" }))).toBe("Uplink");
  });

  it("treats a blank device name as no name and keeps walking the chain", () => {
    expect(portName(linked({ name: "Camera", device: { mac: "aa:bb", name: "   " } }))).toBe(
      "Camera",
    );
    expect(portName(linked({ name: "  ", device: { mac: "aa:bb", name: null } }))).toBe("In use");
  });

  it("still names a DOWN port that has one — a label isn't a link claim", () => {
    expect(portName(linked({ name: "Camera", link_up: false }))).toBe("Camera");
  });
});

describe("roleLabel", () => {
  it("reports an unresolved role by link state, not as 'Open'", () => {
    expect(roleLabel({ role: "unknown", link_up: true })).toBe("Connected");
    expect(roleLabel({ role: "unknown", link_up: false })).toBe("Open");
  });

  it("passes a known role straight through", () => {
    expect(roleLabel({ role: "ap", link_up: true })).toBe("AP");
    expect(roleLabel({ role: "camera", link_up: false })).toBe("Camera");
    expect(roleLabel({ role: "client", link_up: true })).toBe("Client");
    expect(roleLabel({ role: "uplink", link_up: true })).toBe("Uplink");
  });

  it("no longer carries 'Open' in the role map itself", () => {
    // The regression that started this: 'Open' as a ROLE label meant the word
    // rendered regardless of whether the port was lit.
    expect(Object.values(ROLE).map((r) => r.label)).not.toContain("Open");
  });
});

describe("formatBytes", () => {
  it("scales to a readable unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("never renders a negative or non-finite counter", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(Infinity)).toBe("0 B");
  });
});
