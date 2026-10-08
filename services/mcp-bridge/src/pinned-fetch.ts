/**
 * WARP-3914 — public-address DNS pinning for every outbound hop this bridge
 * makes to a remote MCP server or its OAuth endpoints.
 *
 * `assertSafeMcpUrl` (safe-url.ts) is a NAME check. It cannot see that a name
 * resolves to 169.254.169.254 or the router, which matters the moment the URL
 * is typed by a person or comes from metadata a hostile server controls. This
 * module is the ADDRESS check, and it dials the checked address:
 *
 *   1. resolve the host ONCE,
 *   2. refuse the whole destination if ANY answer is not a public address,
 *   3. connect to exactly those addresses (the socket's `lookup` returns them
 *      and never asks DNS again), so a resolver that answers differently the
 *      second time has nothing to answer: no check-to-connect window.
 *
 * PORTED, not shared: the bridge has no @droplet/* dependency by design
 * (Dockerfile), so this is a minimal copy of the orchestrator's
 * `apps/orchestrator/src/lib/outbound-url-guard.ts` (`BLOCKED_RANGES`,
 * `localNetworkFacts`, `resolvePinnedDestination`) and
 * `outbound-pinned-fetch.ts` (`pinnedLookup`). Keep the range table in step
 * with those. It is stricter than the source in one way: the source lets
 * RFC 1918 / ULA through in its LAN mode; a remote MCP server is never on the
 * LAN, so here they are refused outright.
 *
 * The connector is `node:https` rather than undici's `dispatcher`: undici is
 * not a dependency of this workspace and the global fetch cannot be pinned.
 *
 * OAUTH HOPS MUST USE THIS. WARP-2401/2405 add protected-resource metadata,
 * authorization-server metadata, token, revocation and dynamic client
 * registration requests. Every one of them, and any URL taken from a metadata
 * document, goes through {@link guardedFetch} (or {@link createGuardedFetch})
 * — never the global `fetch`. {@link resolvePublicDestination} is the
 * check-only form for a caller that needs the verdict before building a
 * request.
 */
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UnsafeMcpUrlError } from "./safe-url.js";

/** Address space a remote MCP hop must never reach. Built once. */
const BLOCKED_RANGES = (() => {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
  list.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
  list.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
  list.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  list.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata 169.254.169.254 / .170.2
  list.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
  list.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
  list.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
  list.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
  list.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  list.addSubnet("240.0.0.0", 4, "ipv4"); // reserved, incl. 255.255.255.255
  list.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
  list.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
  list.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
  list.addSubnet("192.88.99.0", 24, "ipv4"); // 6to4 relay anycast
  list.addSubnet("::", 96, "ipv6"); // unspecified, loopback, IPv4-compatible
  list.addSubnet("fc00::", 7, "ipv6"); // ULA, incl. AWS IPv6 metadata fd00:ec2::254
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast
  // BlockList does not unwrap the IPv4 these carry, so refuse them whole.
  list.addSubnet("2002::", 16, "ipv6"); // 6to4
  list.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64
  list.addSubnet("64:ff9b:1::", 48, "ipv6"); // NAT64 local-use (RFC 8215)
  list.addSubnet("::ffff:0:0:0", 96, "ipv6"); // IPv4-translated (RFC 2765)
  list.addSubnet("100::", 64, "ipv6"); // discard-only
  list.addSubnet("2001::", 23, "ipv6"); // IETF assignments, incl. Teredo 2001::/32 (embeds IPv4)
  list.addSubnet("2001:db8::", 32, "ipv6"); // documentation
  return list;
})();

/** This process's own interface addresses and attached networks. Read per
 *  resolution, never cached: a compose network can be recreated under us. */
export interface LocalNetworkFacts {
  addresses: string[];
  cidrs: string[];
}

export function localNetworkFacts(): LocalNetworkFacts {
  const addresses: string[] = [];
  const cidrs: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.push(entry.address);
      if (entry.cidr) cidrs.push(entry.cidr);
    }
  }
  return { addresses, cidrs };
}

function localBlockList(local: LocalNetworkFacts): BlockList {
  const list = new BlockList();
  const family = (a: string) => (isIP(a) === 4 ? "ipv4" : "ipv6");
  for (const address of local.addresses) {
    const bare = address.split("%")[0] ?? "";
    if (isIP(bare) !== 0) list.addAddress(bare, family(bare));
  }
  for (const cidr of local.cidrs) {
    const [net, prefix] = cidr.split("/");
    const bare = (net ?? "").split("%")[0] ?? "";
    const bits = Number(prefix);
    if (isIP(bare) !== 0 && Number.isInteger(bits)) list.addSubnet(bare, bits, family(bare));
  }
  return list;
}

/** `::ffff:a.b.c.d` in any textual form, as the dotted IPv4 it carries. The URL
 *  parser canonicalises to hex groups, so `::ffff:10.0.0.1` and
 *  `::ffff:a00:1` reach the same IPv4 rules. */
function unmapV4(bare: string): string {
  if (isIP(bare) !== 6) return bare;
  const canon = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (!m) return canon;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Fails CLOSED: an address that does not parse is not public. */
export function isPublicAddress(addr: string, local: LocalNetworkFacts): boolean {
  const bare0 = (addr.trim().replace(/^\[|\]$/g, "").split("%")[0] ?? "").trim();
  if (isIP(bare0) === 0) return false;
  const bare = unmapV4(bare0);
  const family = isIP(bare) === 4 ? "ipv4" : "ipv6";
  return !BLOCKED_RANGES.check(bare, family) && !localBlockList(local).check(bare, family);
}

export interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** A destination whose every address was vetted. `url` keeps the original
 *  hostname (Host header, SNI, certificate check); `addresses` is where the
 *  socket goes. */
export interface PinnedDestination {
  readonly url: URL;
  readonly addresses: readonly PinnedAddress[];
}

export interface GuardDeps {
  /** Test seam; defaults to `dns.lookup({ all: true, verbatim: true })`. */
  resolve?: (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
  /** Test seam; defaults to this process's interfaces. */
  local?: () => LocalNetworkFacts;
  /** Test seam; defaults to a `node:https` request pinned to the addresses. */
  send?: (dest: PinnedDestination, init: RequestInit) => Promise<Response>;
}

const defaultResolve: NonNullable<GuardDeps["resolve"]> = (host) =>
  dnsLookup(host, { all: true, verbatim: true });

/**
 * Check-only form: https, no userinfo, resolve ONCE, every answer public.
 * Throws {@link UnsafeMcpUrlError}, before any request is sent, otherwise.
 * The exact-host and port rules stay in `assertSafeMcpUrl`; this is the
 * address rule.
 */
export async function resolvePublicDestination(
  raw: string | URL,
  deps: GuardDeps = {},
): Promise<PinnedDestination> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeMcpUrlError(`"${String(raw)}" is not a URL`);
  }
  if (url.protocol !== "https:") throw new UnsafeMcpUrlError(`"${url.protocol}//" is not https`);
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeMcpUrlError("the URL carries userinfo");
  }
  // ADR-072 §1: https on 443 only. The URL parser drops an explicit :443, so a
  // port left standing is another one; a server-controlled OAuth endpoint
  // such as https://public-host:6379/ must not be dialed.
  if (url.port !== "") throw new UnsafeMcpUrlError(`port ${url.port} — remote MCP hops are 443 only`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  let answers: ReadonlyArray<{ address: string; family: number }>;
  if (literal !== 0) {
    answers = [{ address: host, family: literal }];
  } else {
    try {
      answers = await (deps.resolve ?? defaultResolve)(host);
    } catch {
      throw new UnsafeMcpUrlError(`"${host}" does not resolve`); // fail closed
    }
    if (answers.length === 0) throw new UnsafeMcpUrlError(`"${host}" does not resolve`);
  }
  const local = (deps.local ?? localNetworkFacts)();
  const addresses: PinnedAddress[] = [];
  for (const { address, family } of answers) {
    // One bad answer refuses the destination: a name with a public and a
    // private answer is a rebind in progress, not a lucky draw.
    if (!isPublicAddress(address, local)) {
      throw new UnsafeMcpUrlError(`"${host}" resolves to a non-public address (${address})`);
    }
    addresses.push({ address, family: family === 6 ? 6 : 4 });
  }
  return { url, addresses };
}

/** A `net.connect` lookup that returns the vetted addresses for ANY hostname
 *  (ported from `outbound-pinned-fetch.ts`). Answers both the `all: true`
 *  (Happy Eyeballs) and single-address shapes. */
export function pinnedLookup(addresses: readonly PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(Object.assign(new Error("no pinned address"), { code: "ENOTFOUND" }), "", 4);
      return;
    }
    callback(null, first.address, first.family);
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);
/** Connect + TLS + status line. The body (an SSE stream) is not bounded here. */
const HEADERS_TIMEOUT_MS = 30_000;

/** One request to the vetted addresses, TLS verified against the original
 *  hostname. A redirect is REFUSED, never followed (the old `redirect:"error"`). */
const pinnedSend: NonNullable<GuardDeps["send"]> = (dest, init) =>
  new Promise<Response>((resolve, reject) => {
    const { url } = dest;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body;
    let payload: Buffer | undefined;
    if (typeof body === "string") payload = Buffer.from(body);
    else if (ArrayBuffer.isView(body)) payload = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else if (body != null) return reject(new TypeError("pinned fetch: unsupported request body type"));
    if (payload && headers["content-length"] === undefined) {
      headers["content-length"] = String(payload.length);
    }

    const host = url.hostname.replace(/^\[|\]$/g, "");
    const req = httpsRequest(
      {
        method: init.method ?? "GET",
        hostname: host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers,
        lookup: pinnedLookup(dest.addresses),
        ...(isIP(host) === 0 ? { servername: host } : {}),
        agent: false, // one request, one socket
      },
      (res) => {
        clearTimeout(timer);
        const status = res.statusCode ?? 502;
        if (REDIRECTS.has(status)) {
          res.destroy();
          return reject(new TypeError("pinned fetch: redirect refused"));
        }
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
        }
        if (NULL_BODY.has(status)) res.resume();
        resolve(
          new Response(NULL_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream), {
            status,
            statusText: res.statusMessage ?? "",
            headers: out,
          }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("pinned fetch: timed out waiting for response headers")),
      HEADERS_TIMEOUT_MS,
    );
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
    req.on("error", (err) => reject(err));
    req.end(payload);
  });

/** A `fetch` that vets the destination and dials only the vetted addresses. */
export function createGuardedFetch(deps: GuardDeps = {}): FetchLike {
  return async (url, init) => {
    const dest = await resolvePublicDestination(url, deps);
    return (deps.send ?? pinnedSend)(dest, init ?? {});
  };
}

/** The production guarded fetch. Use for every MCP and OAuth hop. */
export const guardedFetch: FetchLike = createGuardedFetch();
