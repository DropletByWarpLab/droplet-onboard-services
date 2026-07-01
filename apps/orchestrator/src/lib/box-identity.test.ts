/**
 * WARP-992 — canonical box-identity resolution.
 *
 * The regression under test: inside the container `os.hostname()` /
 * `$HOSTNAME` is the docker container id (`5639146fdc76`), and it leaked
 * onto the OLED first-boot frame ("Go to 5639146fdc76/setup") and the
 * dashboard Home identity chip. Both resolutions must NEVER fall back to
 * the container hostname — the terminal fallback is the stable LAN name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const networkInterfacesMock = vi.fn();
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: (...args: unknown[]) => networkInterfacesMock(...args),
  };
});

import {
  boxDisplayName,
  lanSetupHost,
  LAN_FALLBACK_HOST,
} from "./box-identity.js";

/** Shorthand: one interface entry of the shape `os.networkInterfaces` returns. */
function iface(address: string, family = "IPv4", internal = false) {
  return { address, family, internal, netmask: "", mac: "", cidr: null };
}

beforeEach(() => {
  networkInterfacesMock.mockReset();
  networkInterfacesMock.mockReturnValue({});
});

describe("boxDisplayName", () => {
  it("prefers the owner-chosen DROPLET_BOX_NAME over everything else", () => {
    expect(
      boxDisplayName({
        DROPLET_BOX_NAME: "aurora-loft",
        DROPLET_PUBLIC_FQDN: "d-0123456789abcdef.droplet-us.com",
        HOSTNAME: "5639146fdc76",
      }),
    ).toBe("aurora-loft");
  });

  it("normalizes the owner name through the shared ruleset (trim + lowercase)", () => {
    expect(boxDisplayName({ DROPLET_BOX_NAME: "  Aurora-Loft  " })).toBe(
      "aurora-loft",
    );
  });

  it("falls through to the FQDN when the name fails shared validation (hand-edited .env)", () => {
    expect(
      boxDisplayName({
        DROPLET_BOX_NAME: "My Box!",
        DROPLET_PUBLIC_FQDN: "d-0123456789abcdef.droplet-us.com",
      }),
    ).toBe("d-0123456789abcdef.droplet-us.com");
  });

  it("uses DROPLET_PUBLIC_FQDN when no name is set", () => {
    expect(
      boxDisplayName({ DROPLET_PUBLIC_FQDN: "d-0123456789abcdef.droplet-us.com" }),
    ).toBe("d-0123456789abcdef.droplet-us.com");
  });

  it("falls back to the stable LAN name — NEVER $HOSTNAME (the container id)", () => {
    expect(boxDisplayName({ HOSTNAME: "5639146fdc76" })).toBe(LAN_FALLBACK_HOST);
    expect(boxDisplayName({})).toBe("droplet.local");
  });

  it("treats whitespace-only values as unset", () => {
    expect(
      boxDisplayName({ DROPLET_BOX_NAME: "   ", DROPLET_PUBLIC_FQDN: "  " }),
    ).toBe(LAN_FALLBACK_HOST);
  });
});

describe("lanSetupHost", () => {
  it("honours the SCREEN_QR_HOST deployment override first", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [iface("192.168.1.87")],
    });
    expect(lanSetupHost({ SCREEN_QR_HOST: "box.example.com" })).toBe(
      "box.example.com",
    );
  });

  it("returns the first routable LAN IPv4 when host-networked", () => {
    networkInterfacesMock.mockReturnValue({
      lo: [iface("127.0.0.1", "IPv4", true)],
      eth0: [iface("fe80::1", "IPv6"), iface("192.168.1.87")],
    });
    expect(lanSetupHost({})).toBe("192.168.1.87");
  });

  it("skips docker-bridge + link-local addresses and lands on the LAN name — NEVER $HOSTNAME", () => {
    // The production container case: the only non-loopback IPv4 is the
    // 172.x docker bridge. Before WARP-992 this fell back to $HOSTNAME —
    // the container id — and the OLED read "Go to 5639146fdc76/setup".
    networkInterfacesMock.mockReturnValue({
      lo: [iface("127.0.0.1", "IPv4", true)],
      eth0: [iface("172.19.0.5")],
      veth0: [iface("169.254.10.10")],
    });
    expect(lanSetupHost({ HOSTNAME: "5639146fdc76" })).toBe(LAN_FALLBACK_HOST);
  });

  it("falls back to the LAN name when no interfaces exist at all", () => {
    networkInterfacesMock.mockReturnValue({});
    expect(lanSetupHost({})).toBe("droplet.local");
  });
});
