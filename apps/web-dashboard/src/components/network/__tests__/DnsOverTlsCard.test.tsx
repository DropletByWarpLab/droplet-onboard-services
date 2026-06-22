/**
 * DnsOverTlsCard — honest gate, no fake control.
 *
 * The shipping single-box image has no DoT forwarder (stubby /
 * https-dns-proxy), and stock dnsmasq does no DoT — so a working "encrypt DNS"
 * toggle would silently no-op. This card mirrors the shipped UPnP "not
 * available" treatment: it renders an inert, honest state with NO interactive
 * control. Pins that there is no switch and no enabled-looking button.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { DnsOverTlsCard } from "../DnsOverTlsCard";

describe("DnsOverTlsCard is an honest gate", () => {
  it("renders the not-available copy and NO interactive control", () => {
    render(<DnsOverTlsCard />);
    expect(screen.getByText(/DNS over TLS/i)).toBeTruthy();
    expect(screen.getByText(/not available on this build/i)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
