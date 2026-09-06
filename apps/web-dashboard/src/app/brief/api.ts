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
