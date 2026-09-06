/**
 * WARP-2752 (ADR-051) — the `/brief` data layer.
 *
 * Every read degrades to an EMPTY, EXPLICIT state rather than throwing. A brain
 * page that white-screens because a pass has never run is worse than one that
 * says "nothing yet" — the second is the honest answer on a box where
 * BRAIN_ENABLED is false, which is the default.
 */
import { authFetch } from "@/lib/auth";

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
 * Returns null for a missing amount rather than "0" or "—" baked in: a finding
 * with no impact is a real finding, and rendering a zero would state a number
 * the detector explicitly refused to invent.
 */
export function formatImpact(minor: string | null, currency: string | null): string | null {
  if (minor === null || currency === null) return null;
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n / 100);
  } catch {
    // An unknown or malformed vendor currency code must not blank the row.
    return `${(n / 100).toFixed(0)} ${currency}`;
  }
}
