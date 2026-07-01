import { describe, expect, it } from "vitest";

import { dashboardIpFromConf, dashboardUrlFromConf } from "./wireguard";

const conf = (dns: string) =>
  `[Interface]\nPrivateKey = abc\nAddress = 10.66.0.2/32\nDNS = ${dns}\n\n[Peer]\nEndpoint = home.droplet-us.com:51820\n`;

describe("dashboardIpFromConf", () => {
  it("extracts the single-box gateway from the DNS line", () => {
    expect(dashboardIpFromConf(conf("192.168.20.1"))).toBe("192.168.20.1");
  });

  it("extracts the multi-box gateway", () => {
    expect(dashboardIpFromConf(conf("192.168.50.1"))).toBe("192.168.50.1");
  });

  it("takes the first address of a comma-separated DNS list", () => {
    expect(dashboardIpFromConf(conf("192.168.20.1, 1.1.1.1"))).toBe(
      "192.168.20.1",
    );
  });

  it("tolerates spacing variants around the equals sign", () => {
    expect(dashboardIpFromConf("DNS=192.168.20.1\n")).toBe("192.168.20.1");
  });

  // WIREGUARD_DNS reaches the conf unvalidated (bare z.string() schema),
  // so a mistyped env var must not surface as a dead https:// link
  // (pr-reviewer finding, 2026-06-11).
  it.each(["192.168.50.", "...", "192..168.1", "192.168.1", "300.1.1.1"])(
    "falls back to the single-box gateway on malformed DNS %j",
    (bad) => {
      expect(dashboardIpFromConf(conf(bad))).toBe("192.168.20.1");
    },
  );

  it("falls back when the conf has no DNS line at all", () => {
    expect(
      dashboardIpFromConf("[Interface]\nAddress = 10.66.0.2/32\n"),
    ).toBe("192.168.20.1");
  });
});

// ADR-023 (C4): the FQDN is the ONE address that works at home AND over VPN
// with a green padlock. dashboardUrlFromConf returns https://<fqdn> when the
// box knows its FQDN, else the existing IP-from-conf URL.
describe("dashboardUrlFromConf", () => {
  it("returns https://<fqdn> when the FQDN is set", () => {
    expect(
      dashboardUrlFromConf(conf("192.168.20.1"), "d-abc123.devices.warp-lab.ai"),
    ).toBe("https://d-abc123.devices.warp-lab.ai");
  });

  it("ignores the conf's DNS IP when an FQDN is provided", () => {
    // Even a multi-box gateway in the conf is overridden by the public FQDN.
    expect(
      dashboardUrlFromConf(conf("192.168.50.1"), "d-xyz.devices.warp-lab.ai"),
    ).toBe("https://d-xyz.devices.warp-lab.ai");
  });

  it("falls back to the IP-from-conf URL when no FQDN is set", () => {
    expect(dashboardUrlFromConf(conf("192.168.20.1"))).toBe(
      "https://192.168.20.1",
    );
  });

  it("falls back to the IP URL when the FQDN is an empty string", () => {
    expect(dashboardUrlFromConf(conf("192.168.50.1"), "")).toBe(
      "https://192.168.50.1",
    );
  });

  it("trims surrounding whitespace from the FQDN", () => {
    expect(
      dashboardUrlFromConf(conf("192.168.20.1"), "  d-abc.devices.warp-lab.ai  "),
    ).toBe("https://d-abc.devices.warp-lab.ai");
  });

  it("still IPv4-validates the conf fallback (malformed DNS -> single-box gateway)", () => {
    expect(dashboardUrlFromConf(conf("192.168.50."))).toBe(
      "https://192.168.20.1",
    );
  });
});
