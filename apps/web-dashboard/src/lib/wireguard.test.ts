import { describe, expect, it } from "vitest";

import { dashboardIpFromConf } from "./wireguard";

const conf = (dns: string) =>
  `[Interface]\nPrivateKey = abc\nAddress = 10.66.0.2/32\nDNS = ${dns}\n\n[Peer]\nEndpoint = box.duckdns.org:51820\n`;

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
