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
  /** WARP-2838 — whether this box's answer is the owner's to give. False when
   *  `BRAIN_ENABLED` is set in the environment, which wins in both directions.
   *  Optional for the same reason `enabled` is: an older orchestrator omits it,
   *  and `undefined` must not paint a togglable box as pinned. */
  canToggle?: boolean;
  passes: {
    passKey: string;
    enabled: boolean;
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

/**
 * WARP-2838 — "the box did not answer" is a THIRD state, not a synonym for off.
 *
 * `fetchCoverage` used to collapse every non-ok response to `null`, and the
 * page had no way back: `brainIsOff(null)` is true and `null?.canToggle ===
 * true` is false, which is the exact pair `BrainSwitchPanel` renders as *"This
 * box is pinned off by its operator (BRAIN_ENABLED) — ask whoever administers
 * it"*. A one-off 500, an expired session or a momentarily unreachable
 * orchestrator therefore produced a confident, specific, wrong diagnosis and
 * sent the owner to a sysadmin over an env var nobody had set. It could fire
 * immediately after a SUCCESSFUL toggle, because `onChanged` refetches.
 *
 * So the reachability of the box travels WITH the body rather than being
 * inferred from its absence. `reached: false` carries `coverage: null` so the
 * pair destructures, and makes the conflation unrepresentable: a caller cannot
 * reach a `Coverage` without having established that the box answered.
 */
export type CoverageResult =
  | { reached: true; coverage: Coverage }
  | { reached: false; coverage: null };

/** The box did not answer. Not "off" — unknown. */
export const COVERAGE_UNREACHABLE: CoverageResult = { reached: false, coverage: null };

export async function fetchFindings(status?: string): Promise<{ findings: Finding[]; total: number }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  // A box that has never enabled the brain 404s/403s here. That is "nothing
  // yet", not an error worth a red banner. The `try` makes the docstring above
  // true for the case it did not cover (WARP-2838 review): `fetch` REJECTS on a
  // dropped connection, and an uncaught rejection here takes down the page's
  // `Promise.all` and leaves the screen on "Loading…" for good.
  try {
    const res = await authFetch(`/api/brain/findings${qs}`);
    if (!res.ok) return { findings: [], total: 0 };
    return await res.json();
  } catch {
    return { findings: [], total: 0 };
  }
}

export async function fetchCoverage(): Promise<CoverageResult> {
  // `authFetch` calls `fetch`, which REJECTS on a dropped connection rather
  // than resolving a non-ok Response. Left to propagate it rejects the page's
  // `Promise.all` and the screen never leaves "Loading…" — so a thrown request
  // and a refused one are the same answer here: we did not get one.
  try {
    const res = await authFetch(`/api/brain/coverage`);
    if (!res.ok) return COVERAGE_UNREACHABLE;
    return { reached: true, coverage: (await res.json()) as Coverage };
  } catch {
    return COVERAGE_UNREACHABLE;
  }
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
 * WARP-2838 — turn the brain on or off.
 *
 * The write the `/brief` empty state used to describe and could not perform.
 * Returns the box's answer rather than the requested value: on a box pinned by
 * `BRAIN_ENABLED` the orchestrator answers 409 and the state is unchanged, and
 * a page that optimistically painted the switch would be lying about it.
 */
export async function setBrainEnabled(
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const res = await authFetch(`/api/brain/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (res.ok) return { ok: true };
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
