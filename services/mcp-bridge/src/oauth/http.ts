/**
 * WARP-2401 — the one way an OAuth hop leaves this process.
 *
 * Every request goes through `createGuardedFetch` (WARP-3914): https, 443 only,
 * every DNS answer public, the socket dialed to the vetted addresses, redirects
 * refused. There is no other fetch in this directory. The response is read
 * under a byte cap and a deadline, because the counterparty is a server whose
 * metadata we do not control.
 */
import { createGuardedFetch, resolvePublicDestination, type GuardDeps } from "../pinned-fetch.js";
import { OAuthRefusedError } from "./errors.js";

/** Test seams of the pinned fetch (`resolve`, `local`, `send`). Production
 *  passes nothing and gets the real guard. */
export type OAuthDeps = GuardDeps;

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OAuthRefusedError("RESPONSE_TOO_LARGE", "an OAuth response exceeded the size cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One bounded request. `json` is `undefined` when the body is empty or not JSON. */
export async function fetchBounded(
  deps: OAuthDeps,
  url: string,
  init: RequestInit,
): Promise<{ status: number; json: unknown }> {
  const res = await createGuardedFetch(deps)(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await readCapped(res);
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Screen one URL taken from the wire or from a metadata document: exact host in
 * the allowed set, then the address check (https, 443, no userinfo, every
 * answer public). Throws before anything is dialed.
 */
export async function vetUrl(raw: string, allowed: ReadonlySet<string>, deps: OAuthDeps): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthRefusedError("BAD_URL", "an OAuth URL is not a URL");
  }
  if (url.hash !== "") throw new OAuthRefusedError("BAD_URL", "an OAuth URL carries a fragment");
  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new OAuthRefusedError("HOST_NOT_ALLOWED", `"${url.hostname}" is not an allowed OAuth host`);
  }
  await resolvePublicDestination(url, deps);
  return url.href;
}
