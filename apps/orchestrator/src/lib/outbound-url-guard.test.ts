/**
 * WARP-2022 — the SSRF guard in front of every operator-supplied outbound URL.
 *
 * The blocked table is DELIBERATELY exhaustive and table-driven: the mutation
 * that this file exists to catch is "somebody drops one range from the guard".
 * A hand-written `it()` per range lets a dropped range hide behind a passing
 * neighbour; a table cannot, because the row names the range it proves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookup(...args),
  default: { lookup: (...args: unknown[]) => lookup(...args) },
}));

import {
  assertOutboundUrlAllowed,
  assertOutboundDestinationAllowed,
  isBlockedAddress,
  isBlockedHostname,
  OutboundUrlBlockedError,
  BLOCKED_DESTINATION_MESSAGE,
} from "./outbound-url-guard.js";

beforeEach(() => {
  lookup.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

/** Every rule the guard claims to enforce, one row each, named by the rule.
 *  `reason` is asserted so a row cannot pass for the wrong reason — e.g. a
 *  literal-IP row that starts failing on "malformed" would otherwise look
 *  green while the range it names went unchecked. */
const BLOCKED: ReadonlyArray<{
  rule: string;
  url: string;
  reason: "scheme" | "userinfo" | "private_host" | "malformed";
}> = [
  // ── scheme ──
  { rule: "file:// scheme", url: "file:///etc/passwd", reason: "scheme" },
  { rule: "ftp:// scheme", url: "ftp://h/x", reason: "scheme" },
  { rule: "gopher:// scheme", url: "gopher://h:70/x", reason: "scheme" },
  { rule: "data: scheme", url: "data:text/plain,hi", reason: "scheme" },
  // ── userinfo ──
  { rule: "userinfo (user:pass)", url: "http://u:p@example.com/", reason: "userinfo" },
  { rule: "userinfo (user only)", url: "https://u@example.com/", reason: "userinfo" },
  // ── IPv4 literals ──
  { rule: "IPv4 loopback 127.0.0.0/8", url: "http://127.0.0.1:8080/", reason: "private_host" },
  { rule: "IPv4 loopback, non-.1", url: "http://127.9.9.9/", reason: "private_host" },
  { rule: "RFC1918 10.0.0.0/8", url: "http://10.0.0.5/x.ics", reason: "private_host" },
  { rule: "RFC1918 172.16.0.0/12", url: "http://172.16.4.4/", reason: "private_host" },
  { rule: "RFC1918 192.168.0.0/16", url: "http://192.168.1.1/x.ics", reason: "private_host" },
  { rule: "link-local 169.254.0.0/16", url: "http://169.254.1.1/", reason: "private_host" },
  {
    rule: "cloud metadata 169.254.169.254",
    url: "http://169.254.169.254/latest/meta-data/",
    reason: "private_host",
  },
  { rule: "CGNAT 100.64.0.0/10", url: "http://100.64.1.1/", reason: "private_host" },
  { rule: "this-network 0.0.0.0/8", url: "http://0.0.0.0/", reason: "private_host" },
  { rule: "IETF protocol 192.0.0.0/24", url: "http://192.0.0.8/", reason: "private_host" },
  { rule: "benchmarking 198.18.0.0/15", url: "http://198.18.0.1/", reason: "private_host" },
  { rule: "multicast 224.0.0.0/4", url: "http://224.0.0.1/", reason: "private_host" },
  { rule: "reserved 240.0.0.0/4", url: "http://240.0.0.1/", reason: "private_host" },
  { rule: "broadcast 255.255.255.255", url: "http://255.255.255.255/", reason: "private_host" },
  // ── obfuscated IPv4 (WHATWG URL normalises these to dotted-quad) ──
  { rule: "decimal-encoded loopback", url: "http://2130706433/", reason: "private_host" },
  { rule: "octal-encoded loopback", url: "http://0177.0.0.1/", reason: "private_host" },
  // ── IPv6 literals ──
  { rule: "IPv6 loopback ::1", url: "http://[::1]/", reason: "private_host" },
  { rule: "IPv6 unspecified ::", url: "http://[::]/", reason: "private_host" },
  { rule: "IPv6 ULA fc00::/7", url: "http://[fd00::1]/", reason: "private_host" },
  { rule: "IPv6 link-local fe80::/10", url: "http://[fe80::1]/", reason: "private_host" },
  { rule: "IPv6 multicast ff00::/8", url: "http://[ff02::1]/", reason: "private_host" },
  {
    rule: "IPv4-mapped IPv6 metadata",
    url: "http://[::ffff:169.254.169.254]/",
    reason: "private_host",
  },
  { rule: "6to4 2002::/16", url: "http://[2002:a9fe:a9fe::]/", reason: "private_host" },
  { rule: "NAT64 64:ff9b::/96", url: "http://[64:ff9b::a9fe:a9fe]/", reason: "private_host" },
  // ── internal name suffixes ──
  { rule: "bare localhost", url: "http://localhost:9200/", reason: "private_host" },
  { rule: ".local (mDNS)", url: "http://box.local/x.ics", reason: "private_host" },
  { rule: ".internal", url: "http://metadata.internal/", reason: "private_host" },
  { rule: ".home.arpa", url: "http://nas.home.arpa/", reason: "private_host" },
  // ── malformed ──
  { rule: "not a URL at all", url: "not-a-url", reason: "malformed" },
];

describe("assertOutboundUrlAllowed — blocked-destination table (WARP-2022)", () => {
  it.each(BLOCKED)("rejects $rule", ({ url, reason }) => {
    let thrown: unknown;
    try {
      assertOutboundUrlAllowed(url);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OutboundUrlBlockedError);
    expect((thrown as OutboundUrlBlockedError).reason).toBe(reason);
  });

  it("never leaks the offending destination through the error MESSAGE", () => {
    // The message is what reaches lastSyncError and every log line. The
    // detail stays on a field for operators, never in the string.
    for (const { url } of BLOCKED) {
      try {
        assertOutboundUrlAllowed(url);
        throw new Error(`expected ${url} to be refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(OutboundUrlBlockedError);
        expect((err as Error).message).toBe(BLOCKED_DESTINATION_MESSAGE);
      }
    }
  });

  it("allows an ordinary public https CalDAV URL", () => {
    const url = assertOutboundUrlAllowed("https://caldav.icloud.com/1234/calendars/home/");
    expect(url.hostname).toBe("caldav.icloud.com");
    expect(url.protocol).toBe("https:");
  });

  it("allows a public http ICS feed and preserves the path + query", () => {
    const url = assertOutboundUrlAllowed("http://feeds.example.com/cal.ics?tok=abc");
    expect(url.hostname).toBe("feeds.example.com");
    expect(`${url.pathname}${url.search}`).toBe("/cal.ics?tok=abc");
  });

  it("allows a public IPv4 literal", () => {
    expect(() => assertOutboundUrlAllowed("https://8.8.8.8/cal.ics")).not.toThrow();
  });

  it("tolerates surrounding whitespace rather than treating it as malformed", () => {
    expect(assertOutboundUrlAllowed("  https://caldav.example.com/x  ").hostname).toBe(
      "caldav.example.com",
    );
  });
});

describe("allowPrivateHost escape hatch", () => {
  it("permits a LAN CalDAV URL when the owner set the flag", () => {
    const url = assertOutboundUrlAllowed("http://192.168.1.50/dav/", {
      allowPrivateHost: true,
    });
    expect(url.hostname).toBe("192.168.1.50");
  });

  it("permits loopback when the flag is set", () => {
    expect(() =>
      assertOutboundUrlAllowed("http://127.0.0.1:8080/dav/", { allowPrivateHost: true }),
    ).not.toThrow();
  });

  // MUTATION GUARD: if the flag is ever allowed to skip the scheme check
  // (e.g. by moving the scheme test inside the `allowPrivateHost !== true`
  // branch), these two turn red. The escape hatch is for RANGES only.
  it("still rejects file:// with the flag set", () => {
    expect(() =>
      assertOutboundUrlAllowed("file:///etc/passwd", { allowPrivateHost: true }),
    ).toThrow(OutboundUrlBlockedError);
  });

  it("still rejects userinfo with the flag set", () => {
    let thrown: unknown;
    try {
      assertOutboundUrlAllowed("http://u:p@192.168.1.50/", { allowPrivateHost: true });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as OutboundUrlBlockedError).reason).toBe("userinfo");
  });
});

describe("assertOutboundDestinationAllowed — DNS re-check", () => {
  it("refuses a PUBLIC hostname that resolves into private space", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    let thrown: unknown;
    try {
      await assertOutboundDestinationAllowed("https://rebind.example.com/cal.ics");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OutboundUrlBlockedError);
    expect((thrown as OutboundUrlBlockedError).reason).toBe("private_host");
  });

  it("refuses when ANY resolved address is private, not just the first", async () => {
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(
      assertOutboundDestinationAllowed("https://split.example.com/cal.ics"),
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });

  it("refuses a hostname that resolves to an IPv6 ULA", async () => {
    lookup.mockResolvedValue([{ address: "fd00::1", family: 6 }]);
    await expect(
      assertOutboundDestinationAllowed("https://v6.example.com/cal.ics"),
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });

  it("fails CLOSED when the name does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    let thrown: unknown;
    try {
      await assertOutboundDestinationAllowed("https://nx.example.com/cal.ics");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OutboundUrlBlockedError);
    expect((thrown as OutboundUrlBlockedError).reason).toBe("unresolvable");
  });

  it("fails CLOSED when the resolver returns no addresses", async () => {
    lookup.mockResolvedValue([]);
    await expect(
      assertOutboundDestinationAllowed("https://empty.example.com/"),
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  });

  it("allows a hostname that resolves to a public address", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertOutboundDestinationAllowed("https://ok.example.com/cal.ics");
    expect(url.hostname).toBe("ok.example.com");
  });

  it("does NOT resolve a literal IP — the literal was already checked", async () => {
    const url = await assertOutboundDestinationAllowed("https://8.8.8.8/cal.ics");
    expect(url.hostname).toBe("8.8.8.8");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("skips the DNS re-check when allowPrivateHost is set", async () => {
    const url = await assertOutboundDestinationAllowed("http://nas.lan/dav/", {
      allowPrivateHost: true,
    });
    expect(url.hostname).toBe("nas.lan");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a bad scheme WITHOUT ever touching the resolver", async () => {
    await expect(
      assertOutboundDestinationAllowed("file:///etc/passwd"),
    ).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("exported predicates (consumed by WARP-2039 and other outbound clients)", () => {
  it.each([
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["10.255.255.255", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.0.1", true],
    ["100.64.0.1", true],
    ["100.128.0.1", false],
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["2606:4700:4700::1111", false],
  ])("isBlockedAddress(%s) === %s", (addr, expected) => {
    expect(isBlockedAddress(addr as string)).toBe(expected);
  });

  it("fails closed on an unparseable address", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });

  it.each([
    ["localhost", true],
    ["box.local", true],
    ["svc.internal", true],
    ["nas.home.arpa", true],
    ["127.0.0.1", true],
    ["[::1]", true],
    ["caldav.icloud.com", false],
    ["localhost.example.com", false],
  ])("isBlockedHostname(%s) === %s", (host, expected) => {
    expect(isBlockedHostname(host as string)).toBe(expected);
  });
});
