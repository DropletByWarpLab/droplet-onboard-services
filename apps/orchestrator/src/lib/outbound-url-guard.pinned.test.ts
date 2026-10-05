/**
 * WARP-3532 (ADR-069 §9) — the LAN-aware, IP-pinning half of the outbound URL
 * guard.
 *
 * `outbound-url-guard.test.ts` pins the original contract (every RFC1918 and
 * loopback range refused unless the owner sets `allowPrivateHost`). This file
 * pins the second mode a work webhook needs: a destination on the box's own
 * LAN is legitimate (a local n8n, Home Assistant, a NAS) and needs no egress
 * switch, while loopback, link-local, multicast, unspecified, metadata, the
 * compose networks and the box's own addresses stay refused, and the address
 * the guard vetted is the address the connection uses.
 *
 * Tables, not hand-written cases, for the same reason as the original file: the
 * mutation that matters is "somebody drops one range", and a table row names
 * the range it proves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookup(...args),
  default: { lookup: (...args: unknown[]) => lookup(...args) },
}));

import {
  assertLanOrPublicUrl,
  assertOutboundUrlAllowed,
  assertOutboundDestinationAllowed,
  classifyDestinationAddress,
  localNetworkFacts,
  resolvePinnedDestination,
  OutboundUrlBlockedError,
  BLOCKED_DESTINATION_MESSAGE,
  type LocalNetworkFacts,
} from "./outbound-url-guard.js";

beforeEach(() => {
  lookup.mockReset();
});

/** A box shaped like the real one: a compose bridge, an internal compose net,
 *  and the host's LAN address that host-network services listen on. */
const BOX: LocalNetworkFacts = {
  addresses: ["172.18.0.5", "172.30.0.2", "192.168.1.50", "fd00:dead:beef::5"],
  cidrs: ["172.18.0.5/16", "172.30.0.2/24", "fd00:dead:beef::5/64"],
};
const NO_LOCAL: LocalNetworkFacts = { addresses: [], cidrs: [] };

const answers = (...addrs: string[]) =>
  addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

// ── classification ────────────────────────────────────────────────────────────

/** Addresses a webhook may reach WITHOUT the egress switch. */
const LAN: ReadonlyArray<[rule: string, address: string]> = [
  ["RFC1918 10.0.0.0/8", "10.20.30.40"],
  ["RFC1918 172.16.0.0/12, low edge", "172.16.0.1"],
  ["RFC1918 172.16.0.0/12, high edge", "172.31.255.254"],
  ["RFC1918 192.168.0.0/16", "192.168.1.20"],
  ["IPv6 ULA fc00::/7 (fd prefix)", "fd12:3456:789a::7"],
  ["IPv6 ULA fc00::/7 (fc prefix)", "fc00::1234"],
  ["IPv4-mapped RFC1918", "::ffff:192.168.1.20"],
];

/** Addresses outside the boundary: allowed, but only with the switch on. */
const PUBLIC: ReadonlyArray<[rule: string, address: string]> = [
  ["ordinary IPv4", "93.184.216.34"],
  ["public DNS resolver", "8.8.8.8"],
  ["just outside 172.16.0.0/12", "172.32.0.1"],
  ["just below CGNAT 100.64.0.0/10", "100.63.255.255"],
  ["ordinary IPv6", "2606:4700:4700::1111"],
  ["IPv4-mapped public", "::ffff:8.8.8.8"],
];

/** Every address the guard must refuse in LAN-aware mode, named by its rule.
 *  The list is the ticket's: loopback, link-local, multicast, unspecified,
 *  metadata — plus the special-purpose space the original guard already
 *  refuses, which this mode must not quietly re-open. */
const REFUSED: ReadonlyArray<[rule: string, address: string]> = [
  ["loopback 127.0.0.0/8", "127.0.0.1"],
  ["loopback, non-.1", "127.9.9.9"],
  ["IPv6 loopback ::1", "::1"],
  ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ["link-local 169.254.0.0/16", "169.254.1.1"],
  ["IPv6 link-local fe80::/10", "fe80::1"],
  ["link-local with a zone id", "fe80::1%eth0"],
  ["IPv4-mapped link-local", "::ffff:169.254.1.1"],
  ["multicast 224.0.0.0/4", "224.0.0.251"],
  ["multicast, SSDP", "239.255.255.250"],
  ["IPv6 multicast ff00::/8", "ff02::fb"],
  ["unspecified 0.0.0.0", "0.0.0.0"],
  ["this-network 0.0.0.0/8", "0.1.2.3"],
  ["IPv6 unspecified ::", "::"],
  ["metadata 169.254.169.254", "169.254.169.254"],
  ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
  ["ECS task metadata 169.254.170.2", "169.254.170.2"],
  ["Alibaba metadata 100.100.100.200 (inside CGNAT)", "100.100.100.200"],
  ["EC2 IPv6 metadata fd00:ec2::254 (inside the ULA block)", "fd00:ec2::254"],
  ["EC2 IPv6 metadata, long form", "FD00:EC2:0:0:0:0:0:254"],
  ["CGNAT 100.64.0.0/10", "100.64.1.1"],
  ["IETF protocol 192.0.0.0/24", "192.0.0.8"],
  ["benchmarking 198.18.0.0/15", "198.18.0.1"],
  ["reserved 240.0.0.0/4", "240.0.0.1"],
  ["broadcast 255.255.255.255", "255.255.255.255"],
  ["6to4 2002::/16 (embeds 192.168.1.1)", "2002:c0a8:101::1"],
  ["NAT64 64:ff9b::/96 (embeds 192.168.1.1)", "64:ff9b::c0a8:101"],
  ["unparseable", "not-an-address"],
  ["empty", ""],
];

/** Refused only because of THIS box's own shape — see BOX. */
const REFUSED_AS_LOCAL: ReadonlyArray<[rule: string, address: string]> = [
  ["the box's own LAN address", "192.168.1.50"],
  ["the box's own LAN address, IPv4-mapped", "::ffff:192.168.1.50"],
  ["the compose bridge gateway (host-gateway)", "172.18.0.1"],
  ["a sibling container on the compose bridge", "172.18.77.7"],
  ["the internal compose network", "172.30.0.200"],
  ["a sibling on the compose bridge, IPv4-mapped", "::ffff:172.18.77.7"],
  ["the box's own IPv6 ULA", "fd00:dead:beef::5"],
  ["a neighbour on the box's IPv6 ULA /64", "fd00:dead:beef::99"],
];

describe("classifyDestinationAddress — what a webhook may reach (WARP-3532)", () => {
  it.each(LAN)("calls %s a LAN destination", (_rule, address) => {
    expect(classifyDestinationAddress(address, NO_LOCAL)).toEqual({ scope: "lan" });
  });

  it.each(PUBLIC)("calls %s a public destination", (_rule, address) => {
    expect(classifyDestinationAddress(address, NO_LOCAL)).toEqual({ scope: "public" });
  });

  it.each(REFUSED)("refuses %s", (_rule, address) => {
    const verdict = classifyDestinationAddress(address, NO_LOCAL);
    expect(verdict.scope).toBe("refused");
  });

  it.each(REFUSED_AS_LOCAL)("refuses %s", (_rule, address) => {
    const verdict = classifyDestinationAddress(address, BOX);
    expect(verdict.scope).toBe("refused");
    // …and the same address is an ordinary LAN host on a box that is not it.
    expect(classifyDestinationAddress(address, NO_LOCAL).scope).not.toBe("refused");
  });

  it("does not refuse a LAN host just because it is in the same private block as the box", () => {
    // 172.19.0.0/16 is a different Docker network from the box's 172.18.0.0/16.
    expect(classifyDestinationAddress("172.19.0.9", BOX)).toEqual({ scope: "lan" });
    // 192.168.1.20 is a neighbour of the box's own 192.168.1.50, not the box.
    expect(classifyDestinationAddress("192.168.1.20", BOX)).toEqual({ scope: "lan" });
  });

  it("names the rule that refused, for operators, in a field callers need not parse", () => {
    expect(classifyDestinationAddress("169.254.169.254", NO_LOCAL)).toMatchObject({
      scope: "refused",
      rule: "metadata",
    });
    expect(classifyDestinationAddress("127.0.0.1", NO_LOCAL)).toMatchObject({
      scope: "refused",
      rule: "reserved",
    });
    expect(classifyDestinationAddress("192.168.1.50", BOX)).toMatchObject({
      scope: "refused",
      rule: "own_network",
    });
  });
});

describe("localNetworkFacts — the box's own addresses and attached networks", () => {
  it("reports at least the loopback interface, with a CIDR for each address", () => {
    const facts = localNetworkFacts();
    expect(facts.addresses.length).toBeGreaterThan(0);
    expect(facts.addresses.some((a) => a === "127.0.0.1" || a === "::1")).toBe(true);
    expect(facts.cidrs.length).toBeGreaterThan(0);
    expect(facts.cidrs.every((c) => /\/\d+$/.test(c))).toBe(true);
  });
});

// ── registration-time gate ────────────────────────────────────────────────────

describe("assertLanOrPublicUrl — the synchronous registration-time gate", () => {
  it.each([
    "https://hooks.example.com/services/T0/B0/xyz",
    "http://nas.local:5678/webhook/abc",
    "http://home-assistant.home.arpa:8123/api/webhook/x",
    "http://192.168.1.20:5678/webhook/abc",
    "http://10.0.0.7/hook",
    "https://[fd12:3456::7]/hook",
    "https://93.184.216.34/hook",
    "  https://hooks.example.com/x  ",
  ])("accepts %s", (url) => {
    expect(() => assertLanOrPublicUrl(url, { local: () => NO_LOCAL })).not.toThrow();
  });

  it.each<[string, string, string]>([
    ["file:// scheme", "file:///etc/passwd", "scheme"],
    ["ftp:// scheme", "ftp://h/x", "scheme"],
    ["userinfo", "https://u:p@example.com/", "userinfo"],
    ["not a URL", "hooks.example.com/x", "malformed"],
    ["loopback literal", "http://127.0.0.1:8080/", "private_host"],
    ["loopback, decimal-encoded", "http://2130706433/", "private_host"],
    ["loopback, octal-encoded", "http://0177.0.0.1/", "private_host"],
    ["IPv6 loopback", "http://[::1]/", "private_host"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/", "private_host"],
    ["unspecified", "http://0.0.0.0/", "private_host"],
    ["link-local", "http://169.254.1.1/", "private_host"],
    ["metadata", "http://169.254.169.254/latest/meta-data/", "private_host"],
    ["IPv4-mapped metadata", "http://[::ffff:169.254.169.254]/", "private_host"],
    ["IPv6 link-local", "http://[fe80::1]/", "private_host"],
    ["multicast", "http://224.0.0.1/", "private_host"],
    ["EC2 IPv6 metadata", "http://[fd00:ec2::254]/", "private_host"],
    ["localhost", "http://localhost:3000/", "private_host"],
    ["a *.localhost name", "http://app.localhost/", "private_host"],
    ["a *.internal name (cloud metadata alias)", "http://metadata.google.internal/", "private_host"],
  ])("refuses %s", (_rule, url, reason) => {
    let thrown: unknown;
    try {
      assertLanOrPublicUrl(url, { local: () => NO_LOCAL });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OutboundUrlBlockedError);
    expect((thrown as OutboundUrlBlockedError).reason).toBe(reason);
    expect((thrown as OutboundUrlBlockedError).message).toBe(BLOCKED_DESTINATION_MESSAGE);
  });

  it("does no DNS — saving a webhook while the box is offline must still work", () => {
    assertLanOrPublicUrl("https://hooks.example.com/x", { local: () => NO_LOCAL });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a literal address that is the box itself, so the owner hears it on save", () => {
    expect(() => assertLanOrPublicUrl("http://192.168.1.50:8080/x", { local: () => BOX })).toThrow(
      OutboundUrlBlockedError,
    );
    expect(() => assertLanOrPublicUrl("http://172.18.0.1:8080/x", { local: () => BOX })).toThrow(
      OutboundUrlBlockedError,
    );
    // …but a neighbour on the same LAN is fine.
    expect(() => assertLanOrPublicUrl("http://192.168.1.20:8080/x", { local: () => BOX })).not.toThrow();
  });
});

// ── send-time resolution + pinning ───────────────────────────────────────────

describe("resolvePinnedDestination — resolve once, vet every answer, pin them", () => {
  it("resolves a public name once and returns the vetted addresses", async () => {
    lookup.mockResolvedValue(answers("93.184.216.34"));
    const dest = await resolvePinnedDestination("https://hooks.example.com/services/x?y=1", {
      local: () => NO_LOCAL,
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("hooks.example.com", { all: true, verbatim: true });
    expect(dest.scope).toBe("public");
    expect(dest.hostname).toBe("hooks.example.com");
    expect(dest.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    // The URL is the SAME parse the guard vetted, original host intact: that is
    // what Host and SNI will carry.
    expect(dest.url.host).toBe("hooks.example.com");
    expect(dest.url.pathname + dest.url.search).toBe("/services/x?y=1");
  });

  it("calls a name that resolves into RFC1918 space a LAN destination", async () => {
    lookup.mockResolvedValue(answers("192.168.1.20"));
    const dest = await resolvePinnedDestination("http://n8n.home.arpa:5678/webhook/x", {
      local: () => BOX,
    });
    expect(dest.scope).toBe("lan");
    expect(dest.addresses).toEqual([{ address: "192.168.1.20", family: 4 }]);
  });

  it("does not resolve an IP literal — the literal IS the address", async () => {
    const dest = await resolvePinnedDestination("http://192.168.1.20:5678/x", { local: () => NO_LOCAL });
    expect(lookup).not.toHaveBeenCalled();
    expect(dest.scope).toBe("lan");
    expect(dest.hostname).toBe("192.168.1.20");
    expect(dest.addresses).toEqual([{ address: "192.168.1.20", family: 4 }]);
  });

  it("unwraps brackets on an IPv6 literal", async () => {
    const dest = await resolvePinnedDestination("https://[2606:4700:4700::1111]/x", {
      local: () => NO_LOCAL,
    });
    expect(dest.hostname).toBe("2606:4700:4700::1111");
    expect(dest.addresses).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    expect(dest.scope).toBe("public");
  });

  it.each(REFUSED)("refuses a literal %s", async (_rule, address) => {
    // Bracket IPv6 for the URL; skip rows that cannot be a URL host at all.
    const host = address.includes(":") ? `[${address.split("%")[0]}]` : address;
    if (host === "" || host === "not-an-address") return;
    await expect(
      resolvePinnedDestination(`http://${host}/x`, { local: () => NO_LOCAL }),
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });

  it("refuses a public NAME that resolves to loopback — the DNS-rebind case", async () => {
    lookup.mockResolvedValue(answers("127.0.0.1"));
    await expect(
      resolvePinnedDestination("https://innocent.example.com/x", { local: () => NO_LOCAL }),
    ).rejects.toMatchObject({ reason: "private_host", message: BLOCKED_DESTINATION_MESSAGE });
  });

  it("refuses when ANY answer is forbidden, not just the first", async () => {
    lookup.mockResolvedValue(answers("93.184.216.34", "169.254.169.254"));
    await expect(
      resolvePinnedDestination("https://mixed.example.com/x", { local: () => NO_LOCAL }),
    ).rejects.toMatchObject({ reason: "private_host" });
  });

  it("refuses a name that resolves to the box's own LAN address", async () => {
    lookup.mockResolvedValue(answers("192.168.1.50"));
    await expect(
      resolvePinnedDestination("http://myself.example.com/x", { local: () => BOX }),
    ).rejects.toMatchObject({ reason: "private_host" });
  });

  it("refuses host.docker.internal-style names that resolve into the compose network", async () => {
    lookup.mockResolvedValue(answers("172.18.0.1"));
    await expect(
      resolvePinnedDestination("http://host.docker.internal:8080/x", { local: () => BOX }),
    ).rejects.toMatchObject({ reason: "private_host" });
  });

  it("scope is the STRICTEST of the answers: one public address makes it public", async () => {
    lookup.mockResolvedValue(answers("192.168.1.20", "93.184.216.34"));
    const dest = await resolvePinnedDestination("https://split.example.com/x", {
      local: () => NO_LOCAL,
    });
    expect(dest.scope).toBe("public");
    // Both are vetted, so both are pinned: the connection may use either, and
    // nothing else.
    expect(dest.addresses.map((a) => a.address)).toEqual(["192.168.1.20", "93.184.216.34"]);
  });

  it("keeps resolver order and reports each address's family", async () => {
    lookup.mockResolvedValue(answers("2606:4700:4700::1111", "93.184.216.34"));
    const dest = await resolvePinnedDestination("https://dual.example.com/x", {
      local: () => NO_LOCAL,
    });
    expect(dest.addresses).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("fails CLOSED when the name does not resolve", async () => {
    lookup.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(
      resolvePinnedDestination("https://nope.example.com/x", { local: () => NO_LOCAL }),
    ).rejects.toMatchObject({ reason: "unresolvable", message: BLOCKED_DESTINATION_MESSAGE });
  });

  it("fails CLOSED when the resolver returns nothing", async () => {
    lookup.mockResolvedValue([]);
    await expect(
      resolvePinnedDestination("https://empty.example.com/x", { local: () => NO_LOCAL }),
    ).rejects.toMatchObject({ reason: "unresolvable" });
  });

  it("fails CLOSED when the box's own addresses cannot be read", async () => {
    lookup.mockResolvedValue(answers("93.184.216.34"));
    await expect(
      resolvePinnedDestination("https://hooks.example.com/x", {
        local: () => {
          throw new Error("no interfaces");
        },
      }),
    ).rejects.toThrow("no interfaces");
  });

  it("rejects a bad scheme and credentials WITHOUT touching the resolver", async () => {
    await expect(
      resolvePinnedDestination("file:///etc/passwd", { local: () => NO_LOCAL }),
    ).rejects.toMatchObject({ reason: "scheme" });
    await expect(
      resolvePinnedDestination("https://u:p@example.com/", { local: () => NO_LOCAL }),
    ).rejects.toMatchObject({ reason: "userinfo" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("uses an injected resolver instead of dns when one is given", async () => {
    const resolve = vi.fn().mockResolvedValue(answers("93.184.216.34"));
    const dest = await resolvePinnedDestination("https://hooks.example.com/x", {
      resolve,
      local: () => NO_LOCAL,
    });
    expect(resolve).toHaveBeenCalledWith("hooks.example.com");
    expect(lookup).not.toHaveBeenCalled();
    expect(dest.scope).toBe("public");
  });
});

// ── existing callers are untouched ───────────────────────────────────────────

describe("the original entry points are unchanged (WARP-2022 callers)", () => {
  it("assertOutboundUrlAllowed still refuses what the LAN-aware gate allows", () => {
    for (const url of ["http://192.168.1.20/x", "http://10.0.0.7/x", "http://nas.local/x", "https://[fd12::7]/x"]) {
      expect(() => assertLanOrPublicUrl(url, { local: () => NO_LOCAL }), url).not.toThrow();
      expect(() => assertOutboundUrlAllowed(url), url).toThrow(OutboundUrlBlockedError);
    }
  });

  it("assertOutboundDestinationAllowed still refuses a name that resolves into RFC1918 space", async () => {
    lookup.mockResolvedValue(answers("192.168.1.20"));
    await expect(assertOutboundDestinationAllowed("https://nas.example.com/x")).rejects.toMatchObject({
      reason: "private_host",
    });
  });

  it("allowPrivateHost still bypasses the address rules and nothing else", async () => {
    expect(() => assertOutboundUrlAllowed("http://127.0.0.1:8080/", { allowPrivateHost: true })).not.toThrow();
    expect(() => assertOutboundUrlAllowed("file:///etc/passwd", { allowPrivateHost: true })).toThrow();
    await expect(
      assertOutboundDestinationAllowed("http://127.0.0.1:8080/", { allowPrivateHost: true }),
    ).resolves.toBeInstanceOf(URL);
  });
});
