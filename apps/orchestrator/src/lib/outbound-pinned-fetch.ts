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

/**
 * One request's agent: the pinned lookup, keep-alive off, every deadline set.
 * Shared by `pinnedFetch` and `pinnedGet` so the two cannot drift on the
 * properties that make the dial safe.
 */
function createPinnedAgent(
  dest: PinnedDestination,
  timeoutMs: number,
  connect: Record<string, unknown> | undefined,
): Agent {
  return new Agent({
    connect: {
      ...connect,
      lookup: pinnedLookup(dest.addresses),
      timeout: Math.min(timeoutMs, 5_000),
    },
    // 0 disables keep-alive: one request, one socket.
    pipelining: 0,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
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
  const agent = createPinnedAgent(dest, timeoutMs, opts.connect);
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

/** Whole-request deadline for a GET: connect, TLS, send, and the whole body. */
export const PINNED_GET_TIMEOUT_MS = 30_000;

/**
 * Bytes of body `pinnedGet` will read before it abandons the response. A page of
 * 100 pull requests with 64 KiB bodies is about 6.5 MB; sixteen leaves room for
 * that and still means a host cannot make the box buffer whatever it likes.
 */
export const PINNED_GET_MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface PinnedGetRequest {
  headers: Record<string, string>;
  timeoutMs?: number;
  /** The caller's own abort, in addition to the deadline. */
  signal?: AbortSignal;
}

export interface PinnedGetResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/** A response that outgrew `maxBodyBytes`. A distinct code so a caller can tell a
 *  host that will not stop talking from one that is down. */
export class ResponseTooLargeError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";
  constructor(readonly limit: number) {
    super(`response body exceeded ${limit} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * GET from a vetted destination and read the answer.
 *
 * The same dial as `pinnedFetch` — the vetted addresses and nothing else, the
 * original Host and SNI, certificate checking on, no redirect followed (a 3xx is
 * returned as the answer), a fresh agent that is torn down in `finally` — with
 * the difference the GitHub / GitLab poll needs: the status, the headers and the
 * body come back. The body is read under `maxBodyBytes`; past it the response is
 * cancelled, which closes the socket, and the call rejects.
 *
 * The agent outlives the response only until the body has been read, which is
 * why this returns bytes and not a stream: a stream would leave the agent's
 * lifetime to the caller.
 */
export async function pinnedGet(
  dest: PinnedDestination,
  req: PinnedGetRequest,
  opts: { connect?: Record<string, unknown>; maxBodyBytes?: number } = {},
): Promise<PinnedGetResponse> {
  const timeoutMs = req.timeoutMs ?? PINNED_GET_TIMEOUT_MS;
  const maxBodyBytes = opts.maxBodyBytes ?? PINNED_GET_MAX_BODY_BYTES;
  const agent = createPinnedAgent(dest, timeoutMs, opts.connect);
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const res = await undiciFetch(dest.url, {
      method: "GET",
      headers: req.headers,
      redirect: "manual",
      signal: req.signal ? AbortSignal.any([deadline, req.signal]) : deadline,
      dispatcher: agent,
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ResponseTooLargeError(maxBodyBytes);
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.byteLength;
    }
    return { status: res.status, headers: res.headers as unknown as Headers, body };
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}
