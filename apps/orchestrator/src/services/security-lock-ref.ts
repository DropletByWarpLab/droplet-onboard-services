/**
 * WARP-2977 P2b-2 — the lock link ref grammar (`matter:<node>/<ep>`) and the
 * Matter id checks behind it. A leaf module (no imports): the zone service
 * validates lock links with it, and importing it from security-lock-adapter.ts
 * (which imports security-events.service.ts) closed a runtime import cycle
 * security-events → security-incidents → security-zones → security-lock-adapter
 * (WARP-3193 ARCH-1's guard, import-cycles.test.ts). The adapter re-exports
 * `lockRef` / `parseLockRef`, so its importers are unchanged.
 */

const NODE_ID = /^\d{1,20}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
/** A lock link / lock row `sourceRef`: `matter:<node>/<endpoint>`. */
export const LOCK_REF_RE = /^matter:(\d{1,20})\/(\d{1,5})$/;

/** A Matter node id: decimal uint64, canonicalised (no leading zeros) so one lock is one key. */
export function canonicalNodeId(v: unknown): string | null {
  if (typeof v !== "string" || !NODE_ID.test(v)) return null;
  const n = BigInt(v);
  return n > UINT64_MAX ? null : n.toString();
}

/** Application endpoints only: 0 is the root node, 65535 the wildcard. */
export function endpointIdOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65534 ? v : null;
}

export function lockRef(nodeId: string, endpointId: number): string {
  return `matter:${nodeId}/${endpointId}`;
}

/**
 * A lock link's `sourceRef` → its endpoint, or null. Only the CANONICAL form
 * `lockRef` writes is accepted (no leading zeros, a uint64 node, endpoint
 * 1..65534): a link is joined to lock rows by exact string equality, so a
 * ref in any other spelling could never match a row.
 */
export function parseLockRef(ref: string): { nodeId: string; endpointId: number } | null {
  const m = LOCK_REF_RE.exec(ref);
  if (!m) return null;
  const nodeId = canonicalNodeId(m[1]);
  const endpointId = endpointIdOf(Number(m[2]));
  if (nodeId === null || endpointId === null) return null;
  return lockRef(nodeId, endpointId) === ref ? { nodeId, endpointId } : null;
}
