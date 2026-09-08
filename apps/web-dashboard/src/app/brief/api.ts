/**
 * WARP-2752 (ADR-051) — the `/brief` data layer.
 *
 * Every read degrades to an EMPTY, EXPLICIT state rather than throwing. A brain
 * page that white-screens because a pass has never run is worse than one that
 * says "nothing yet" — the second is the honest answer on a box where
 * BRAIN_ENABLED is false, which is the default.
 */
import { authFetch } from "@/lib/auth";
import { formatMinor } from "@/components/crm/types";

export type Finding = {
  id: string;
  kind: "loss" | "risk" | "inefficiency" | "opportunity" | "inconsistency";
  title: string;
  rationale: string;
  /** Minor units as a STRING — BigInt does not survive JSON. */
  impactMinor: string | null;
  currency: string | null;
  confidence: number | null;
  status: "new" | "acknowledged" | "actioned" | "dismissed" | "stale";
  detectorKey: string;
  firstSeenAt: string;
  lastConfirmedAt: string;
  evidence: { digestIds?: string[]; sources?: { sourceKind: string; sourceId: string; quote: string }[] };
};

export type Coverage = {
  /** WARP-2812 — whether the brain is scheduled at all. The page cannot infer
   *  this from a failed fetch: /coverage answers 200 with a well-formed body on
   *  a box where BRAIN_ENABLED is false, because it reads BrainPass rows that
   *  were never seeded and counts files nothing will ever digest. Optional so a
   *  dashboard newer than its orchestrator does not read `undefined` as off and
   *  paint a running brain disabled. */
  enabled?: boolean;
  passes: {
    passKey: string;
    enabled: boolean;
    /** WARP-2850 — "running" means a pass holds the lease right now. Optional
     *  on the wire so a dashboard newer than its orchestrator does not read
     *  `undefined` as idle and offer a button that will 409. */
    runState?: "idle" | "running";
    runningSince?: string | null;
    lastRunAt: string | null;
    lastSucceededAt: string | null;
    lastError: string | null;
    unitsSeen: number;
    unitsDigested: number;
    rowsWritten: number;
  }[];
  corpus: { documentsReady: number; documentsDigested: number };
};

/**
 * Is the brain switched off, or simply quiet? (WARP-2812)
 *
 * These are DIFFERENT ANSWERS to "no findings", and the page says different
 * things for them: a quiet brain is good news, an off one is a setup step.
 *
 * The page used to key that on whether `fetchCoverage` returned a value, which
 * could never distinguish them — `GET /api/brain/coverage` answers 200 with a
 * well-formed body whichever way BRAIN_ENABLED is set, because it reads
 * BrainPass rows that were never seeded and counts files nothing will ever
 * digest. So a box where the brain had never run reported an all-clear.
 *
 * `enabled` is optional on the wire: a dashboard newer than its orchestrator
 * gets `undefined`, which must read as "cannot tell, assume running" rather
 * than painting a working brain disabled. Only an explicit `false` is off.
 */
export function brainIsOff(coverage: Coverage | null): boolean {
  return coverage === null || coverage.enabled === false;
}

export async function fetchFindings(status?: string): Promise<{ findings: Finding[]; total: number }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await authFetch(`/api/brain/findings${qs}`);
  // A box that has never enabled the brain 404s/403s here. That is "nothing
  // yet", not an error worth a red banner.
  if (!res.ok) return { findings: [], total: 0 };
  return res.json();
}

export async function fetchCoverage(): Promise<Coverage | null> {
  const res = await authFetch(`/api/brain/coverage`);
  if (!res.ok) return null;
  return res.json();
}

export type RunPassOutcome =
  | { ok: true }
  | { ok: false; reason: "busy" | "disabled" | "too_soon" | "off" | "failed"; retryAfterSeconds?: number };

/**
 * Ask the box to run a pass now (WARP-2850).
 *
 * Returns rather than throws, because every refusal here is a THING TO SAY to
 * the operator and not an error: already running, switched off, too soon, or
 * the brain is off entirely. Collapsing them into one failure is what made
 * /admin/sessions report a permissions decision as an outage.
 */
export async function runBrainPass(passKey: string): Promise<RunPassOutcome> {
  const res = await authFetch(`/api/brain/passes/${encodeURIComponent(passKey)}/run`, {
    method: "POST",
  });
  if (res.ok) return { ok: true };
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retryAfterSeconds?: number };
    return { ok: false, reason: "too_soon", retryAfterSeconds: body.retryAfterSeconds };
  }
  if (res.status === 503) return { ok: false, reason: "off" };
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: body.error === "disabled" ? "disabled" : "busy" };
  }
  return { ok: false, reason: "failed" };
}

export async function moveFinding(
  id: string,
  body: { status: Finding["status"]; dismissedReason?: string },
): Promise<{ ok: boolean; error?: string }> {
  const res = await authFetch(`/api/brain/findings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return { ok: true };
  const detail = await res.json().catch(() => ({}));
  return { ok: false, error: (detail as { error?: string }).error ?? "failed" };
}

/**
 * Minor units + ISO currency -> a string a human reads.
 *
 * DELEGATES to `formatMinor` (components/crm/types.ts) rather than
 * reimplementing it. The first draft did `Number(minor) / 100`, which is the
 * exact float64 coercion `formatMinor`'s own docstring says it exists to avoid
 * — "correct for every deal a demo contains and wrong for the one that
 * matters" — and left two currency formatters to keep in step.
 *
 * The one thing kept from the local version is the non-numeric guard: this
 * value arrives from JSON as an unvalidated string, and a null is the honest
 * answer for something that is not a number at all.
 */
export function formatImpact(minor: string | null, currency: string | null): string | null {
  if (minor === null || currency === null) return null;
  if (!/^-?\d+$/.test(minor)) return null;
  return formatMinor(minor, currency);
}
