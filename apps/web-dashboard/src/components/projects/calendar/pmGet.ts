// A GET helper for the scheduling views' own endpoints (timeline, My Work).
//
// Same contract as the private `getJson` in usePm.ts — a non-2xx becomes a
// `PmRequestError` carrying the HTTP status and the wire `error` code, so the
// friendly-copy translator can dispatch on it — kept here rather than exported
// from usePm.ts, which other slices are rewriting (paging, query API).

import { authFetch } from "@/lib/auth";
import { PmRequestError } from "../usePm";

export async function pmGet<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PmRequestError(body.error ?? `Request failed (${res.status})`, res.status, body.error);
  }
  return res.json() as Promise<T>;
}
