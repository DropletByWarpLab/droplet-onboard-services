/**
 * WARP-3914 — public-address DNS pinning.
 *
 * NOTHING HERE OPENS A SOCKET OR ASKS DNS: the resolver, the box's own
 * addresses and the sender are all injected. The only real-network code the
 * module owns is the `node:https` sender, which these tests replace.
 *
 * Hosts are RFC 2606 reserved names; addresses are the literals each refused
 * range is defined by, plus TEST-NET-3 (203.0.113.0/24) as the "public" answer.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createGuardedFetch,
  isPublicAddress,
  pinnedLookup,
  resolvePublicDestination,
  type PinnedDestination,
} from "../src/pinned-fetch.js";
import { UnsafeMcpUrlError } from "../src/safe-url.js";

const PUBLIC_IP = "203.0.113.7";
const noLocal = () => ({ addresses: [] as string[], cidrs: [] as string[] });

describe("isPublicAddress: every refused range has a case", () => {
  const refused: Array<[string, string]> = [
    ["this-network 0.0.0.0/8", "0.0.0.1"],
    ["RFC1918 10/8", "10.1.2.3"],
    ["CGNAT 100.64/10", "100.64.0.1"],
    ["CGNAT upper edge", "100.127.255.254"],
    ["loopback 127/8", "127.0.0.1"],
    ["link-local 169.254/16", "169.254.1.1"],
    ["cloud metadata 169.254.169.254", "169.254.169.254"],
    ["ECS task metadata 169.254.170.2", "169.254.170.2"],
    ["RFC1918 172.16/12", "172.16.5.5"],
    ["RFC1918 172.31 edge", "172.31.255.254"],
    ["RFC1918 192.168/16", "192.168.1.1"],
    ["IETF assignments 192.0.0/24", "192.0.0.8"],
    ["benchmarking 198.18/15", "198.18.0.1"],
    ["multicast 224/4", "224.0.0.1"],
    ["reserved 240/4", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv6 ULA fc00::/7", "fc00::1"],
    ["IPv6 ULA fd", "fd12:3456::1"],
    ["IPv6 metadata fd00:ec2::254", "fd00:ec2::254"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 multicast", "ff02::1"],
    ["6to4", "2002:c000:204::1"],
    ["NAT64", "64:ff9b::102:304"],
    ["IPv4-mapped RFC1918 (dotted)", "::ffff:10.0.0.1"],
    ["IPv4-mapped RFC1918 (hex)", "::ffff:a00:1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped CGNAT", "::ffff:100.64.0.1"],
    ["IPv4-mapped 192.168", "::ffff:c0a8:101"],
    ["bracketed literal", "[::1]"],
    ["not an address at all", "mcp.vendor.example"],
  ];
  it.each(refused)("refuses %s (%s)", (_name, addr) => {
    expect(isPublicAddress(addr, noLocal())).toBe(false);
  });

  it("refuses the box's own address and attached network, even when they look public", () => {
    const local = { addresses: ["203.0.113.50"], cidrs: ["198.51.100.0/24"] };
    expect(isPublicAddress("203.0.113.50", local)).toBe(false);
    expect(isPublicAddress("198.51.100.9", local)).toBe(false);
    expect(isPublicAddress("::ffff:203.0.113.50", local)).toBe(false);
    expect(isPublicAddress(PUBLIC_IP, local)).toBe(true);
  });

  it("accepts public addresses, including IPv4-mapped ones", () => {
    expect(isPublicAddress(PUBLIC_IP, noLocal())).toBe(true);
    expect(isPublicAddress("2001:db8::1", noLocal())).toBe(true);
    expect(isPublicAddress("::ffff:203.0.113.7", noLocal())).toBe(true);
  });
});

describe("resolvePublicDestination", () => {
  const url = "https://mcp.vendor.example/v1/mcp";

  it("returns the vetted addresses and keeps the original hostname", async () => {
    const dest = await resolvePublicDestination(url, {
      resolve: async () => [{ address: PUBLIC_IP, family: 4 }],
      local: noLocal,
    });
    expect(dest.url.hostname).toBe("mcp.vendor.example");
    expect(dest.addresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
  });

  it("refuses the whole name when ANY answer is private (a rebind in progress)", async () => {
    await expect(
      resolvePublicDestination(url, {
        resolve: async () => [
          { address: PUBLIC_IP, family: 4 },
          { address: "192.168.9.1", family: 4 },
        ],
        local: noLocal,
      }),
    ).rejects.toBeInstanceOf(UnsafeMcpUrlError);
  });

  it("fails closed when the name does not resolve", async () => {
    await expect(
      resolvePublicDestination(url, {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
        local: noLocal,
      }),
    ).rejects.toBeInstanceOf(UnsafeMcpUrlError);
    await expect(
      resolvePublicDestination(url, { resolve: async () => [], local: noLocal }),
    ).rejects.toBeInstanceOf(UnsafeMcpUrlError);
  });

  it("refuses an IP-literal URL without asking DNS", async () => {
    const resolve = vi.fn(async () => [{ address: PUBLIC_IP, family: 4 }]);
    for (const literal of ["https://169.254.169.254/x", "https://[::1]/x", "https://[::ffff:10.0.0.1]/x"]) {
      await expect(resolvePublicDestination(literal, { resolve, local: noLocal })).rejects.toBeInstanceOf(
        UnsafeMcpUrlError,
      );
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps the scheme and userinfo rules", async () => {
    const deps = { resolve: async () => [{ address: PUBLIC_IP, family: 4 }], local: noLocal };
    await expect(resolvePublicDestination("http://mcp.vendor.example/", deps)).rejects.toThrow(/not https/);
    await expect(resolvePublicDestination("https://u:p@mcp.vendor.example/", deps)).rejects.toThrow(/userinfo/);
  });
});

describe("check and connect use the same answer (no TOCTOU)", () => {
  it("a resolver that flips to a private address after the check cannot reach it", async () => {
    // First answer public, every later answer a metadata address. A guard that
    // checks with one lookup and lets the socket do its own would dial the
    // second.
    let calls = 0;
    const resolve = vi.fn(async () =>
      ++calls === 1
        ? [{ address: PUBLIC_IP, family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }],
    );
    let seen: PinnedDestination | undefined;
    const send = vi.fn(async (dest: PinnedDestination) => {
      seen = dest;
      return new Response("{}", { status: 200 });
    });

    await createGuardedFetch({ resolve, local: noLocal, send })("https://mcp.vendor.example/v1/mcp", {
      method: "POST",
    });

    expect(resolve).toHaveBeenCalledTimes(1); // resolved once, never again
    expect(seen!.addresses.map((a) => a.address)).toEqual([PUBLIC_IP]);

    // And the socket's lookup, which is what actually decides where it dials,
    // answers with only that address for ANY name it is asked about, in both
    // the Happy Eyeballs (`all`) and the single-address shape.
    const lookup = pinnedLookup(seen!.addresses);
    const all = vi.fn();
    lookup("anything.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_IP, family: 4 }]);
    const one = vi.fn();
    lookup("anything.example", {}, one);
    expect(one).toHaveBeenCalledWith(null, PUBLIC_IP, 4);
  });

  it("pinnedLookup with no addresses errors rather than resolving", () => {
    const cb = vi.fn();
    pinnedLookup([])("x.example", {}, cb);
    expect(cb.mock.calls[0]![0]).toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("a hostile metadata document cannot aim the box at a private endpoint", () => {
  // The OAuth wiring lands with WARP-2401/2405; this is the helper those hops
  // must use. A token endpoint named by metadata is refused BEFORE any request.
  it.each([
    ["a literal metadata address", "https://169.254.169.254/oauth/token", PUBLIC_IP],
    ["a name that resolves to the metadata address", "https://as.vendor.example/oauth/token", "169.254.169.254"],
    ["a name that resolves to the router", "https://as.vendor.example/oauth/token", "192.168.1.1"],
    ["a name that resolves to a mapped private address", "https://as.vendor.example/oauth/token", "::ffff:10.0.0.1"],
  ])("refuses %s before sending", async (_name, tokenUrl, answer) => {
    const send = vi.fn(async () => new Response("{}", { status: 200 }));
    const f = createGuardedFetch({
      resolve: async () => [{ address: answer, family: answer.includes(":") ? 6 : 4 }],
      local: noLocal,
      send,
    });
    await expect(
      f(tokenUrl, { method: "POST", body: "grant_type=authorization_code" }),
    ).rejects.toBeInstanceOf(UnsafeMcpUrlError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the curated path", () => {
  it("a public host passes and is sent to its vetted address", async () => {
    const send = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await createGuardedFetch({
      resolve: async () => [{ address: PUBLIC_IP, family: 4 }],
      local: noLocal,
      send,
    })("https://mcp.vendor.example/v1/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
