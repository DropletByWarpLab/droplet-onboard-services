/**
 * WARP-3532 — the connector that honours a `PinnedDestination`.
 *
 * `resolvePinnedDestination` (outbound-url-guard.ts) answers WHICH addresses a
 * work webhook may reach. This answers HOW: one POST, to exactly those
 * addresses, and nothing else.
 *
 *   - **No second resolution.** The socket's `lookup` is replaced with a
 *     function that returns the vetted addresses and ignores the hostname it
 *     is asked for. A resolver that answers differently the second time — the
 *     DNS-rebind residual the original guard documents — has nothing to
 *     answer: nobody asks it.
 *   - **Original Host and SNI.** The URL is the guard's own parse with the
 *     hostname untouched, so `Host` is the name the owner typed and TLS sends
 *     it as SNI and checks the certificate against it. Certificate checking is
 *     on and there is no switch for it.
 *   - **No redirects.** A 3xx is returned as the answer. Following it would
 *     hand a destination the guard never saw to a connector that trusts what
 *     it is given.
 *   - **No body read.** Only the status line matters; the body is cancelled,
 *     so a receiver cannot make the box buffer an answer.
 *   - **One request, one socket.** A fresh `Agent` per call with keep-alive
 *     off, torn down in `finally`: no pool to leak, nothing for a later call
 *     (to a different destination) to inherit.
 *
 * `fetch` is undici's own, imported from the package — WARP-2626: a
 * `dispatcher` is honoured only by the undici that minted it, and this repo's
 * guard test fails any module that pairs one with the runtime's built-in fetch.
 */
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { PinnedAddress, PinnedDestination } from "./outbound-url-guard.js";

/** Whole-request deadline: connect, TLS, send and wait for the status line. */
export const PINNED_FETCH_TIMEOUT_MS = 10_000;

/**
 * A `net.connect` lookup that returns the vetted addresses for ANY hostname.
 *
 * Node asks with `all: true` when it is trying every address in turn
 * (Happy Eyeballs, the default since Node 20) and without it otherwise; both
 * shapes are answered, so one name carrying an A and an AAAA record still gets
 * its fallback — but only between addresses the guard vetted.
 */
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

export interface PinnedRequest {
  headers: Record<string, string>;
  /** Sent as-is; the caller signs these exact bytes. */
  body: string;
  timeoutMs?: number;
}

export interface PinnedResponse {
  status: number;
}

/**
 * POST `req.body` to a vetted destination. Resolves with the status code of
 * whatever answered (including a 3xx, which is not followed) and rejects on a
 * transport failure: refused, unreachable, TLS, timeout.
 *
 * `opts.connect` is a TEST SEAM — extra socket options, so a test can trust
 * its throwaway CA. Nothing in production passes it.
 */
export async function pinnedFetch(
  dest: PinnedDestination,
  req: PinnedRequest,
  opts: { connect?: Record<string, unknown> } = {},
): Promise<PinnedResponse> {
  const timeoutMs = req.timeoutMs ?? PINNED_FETCH_TIMEOUT_MS;
  const agent = new Agent({
    connect: {
      ...opts.connect,
      lookup: pinnedLookup(dest.addresses),
      timeout: Math.min(timeoutMs, 5_000),
    },
    // 0 disables keep-alive: one request, one socket.
    pipelining: 0,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  try {
    const res = await undiciFetch(dest.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: agent,
    });
    // The status is the answer. Cancel rather than drain: the receiver chooses
    // how much it sends, and none of it is wanted.
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status };
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}
