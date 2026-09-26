/**
 * WARP-2979 (ADR-059 P4 §6.11.3, DS-005, D21) — who may read a "Summary by
 * Droplet". THE one rule route 18, route 28 and the assistant's A2 (PR-3)
 * call.
 *
 * A summary is written once, for everyone, from the whole incident — so it is
 * shown only to a viewer who can see everything it could name:
 *   · every camera of its audience (`narrativeAudience.cameras`), of the
 *     incident itself and of every reason (evidence and related camera) —
 *     the union, so a Regenerate in flight or a state with no text yet is
 *     judged against the incident as it is now;
 *   · threats ⇒ `mayReadThreats` (the audience says so, the incident is about
 *     network and sign-in warnings, or a reason's evidence is a threat row);
 *   · a lock named ⇒ a viewer who sees every camera (reasonVisibleTo's lock
 *     clause; P4 PR-4 swaps it for `mayReadLocks`, DS-019);
 *   · and the viewer's projected codes equal the stored codes.
 * Anyone else gets `narrative: null` — no state and no hint that a summary
 * exists. A stored audience that is not the validated shape fails closed.
 */
import type {
  Prisma,
  SecurityIncidentGrouping,
  SecurityIncidentScope,
  SecurityNarrativeState,
  SecurityReasonCode,
  SecuritySeverity,
} from "@prisma/client";
import type { NarrativeAudience } from "../lib/security-narrative-prompt.js";
import type { IncidentProjection, IncidentViewer } from "./security-incident-view.js";

/** The incident columns this module reads. Route 18 selects these beside INCIDENT_VIEW_SELECT. */
export const NARRATIVE_SELECT = {
  narrativeState: true,
  narrative: true,
  narrativeModel: true,
  narrativePromptVersion: true,
  narratedAt: true,
  narrativeAudience: true,
} as const satisfies Prisma.SecurityIncidentSelect;

export interface NarrativeRow {
  scope: SecurityIncidentScope;
  severity: SecuritySeverity;
  grouping: SecurityIncidentGrouping;
  cameras: readonly string[];
  reasonCodes: readonly SecurityReasonCode[];
  narrativeState: SecurityNarrativeState;
  narrative: string | null;
  narrativeModel: string | null;
  narrativePromptVersion: number | null;
  narratedAt: Date | null;
  narrativeAudience: Prisma.JsonValue | unknown;
}

/** The reason columns this module reads (every reason of the incident, not only the viewer's). */
export interface NarrativeReasonRef {
  evidenceCamera: string | null;
  relatedCamera: string | null;
  relatedLock: boolean;
  evidenceKind?: string;
}

/** Route 18's `narrative` (§7). */
export interface NarrativeView {
  state: SecurityNarrativeState;
  text: string | null;
  writtenAt: string | null;
  model: string | null;
  promptVersion: number | null;
}

/** The stored `narrativeAudience`, validated; null for anything else. */
export function parseNarrativeAudience(v: unknown): NarrativeAudience | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.cameras) || !o.cameras.every((c) => typeof c === "string")) return null;
  if (typeof o.threats !== "boolean" || typeof o.locks !== "boolean") return null;
  return { cameras: [...(o.cameras as string[])], threats: o.threats, locks: o.locks };
}

/** Everything the summary could name: the stored audience together with the incident as it is now. */
function requiredAudience(row: NarrativeRow, reasons: readonly NarrativeReasonRef[]): NarrativeAudience | null {
  let stored: NarrativeAudience = { cameras: [], threats: false, locks: false };
  if (row.narrativeAudience !== null && row.narrativeAudience !== undefined) {
    const parsed = parseNarrativeAudience(row.narrativeAudience);
    if (!parsed) return null;
    stored = parsed;
  }
  const cameras = new Set<string>([...stored.cameras, ...row.cameras]);
  for (const r of reasons) {
    if (r.evidenceCamera) cameras.add(r.evidenceCamera);
    if (r.relatedCamera) cameras.add(r.relatedCamera);
  }
  return {
    cameras: [...cameras],
    threats: stored.threats || row.scope === "site_threat" || reasons.some((r) => r.evidenceKind === "threat"),
    locks: stored.locks || reasons.some((r) => r.relatedLock),
  };
}

/** DS-005 for the summary (see the header). `projection` null = the viewer may not know the incident exists. */
export function narrativeVisibleTo(
  row: NarrativeRow,
  reasons: readonly NarrativeReasonRef[],
  projection: Pick<IncidentProjection, "codes"> | null,
  viewer: IncidentViewer,
): boolean {
  if (!projection) return false;
  const audience = requiredAudience(row, reasons);
  if (!audience) return false;
  const sees = (c: string) => viewer.visibleCameras === "all" || viewer.visibleCameras.has(c);
  if (!audience.cameras.every(sees)) return false;
  if (audience.threats && !viewer.mayReadThreats) return false;
  if (audience.locks && viewer.visibleCameras !== "all") return false;
  const stored = new Set(row.reasonCodes);
  const seen = new Set(projection.codes);
  return stored.size === seen.size && [...stored].every((c) => seen.has(c));
}

/**
 * Route 18's `narrative` for this viewer, or null: not visible, plain
 * activity, summaries switched off, or nothing to say (`none` once the
 * incident has closed — incidents from before P4, or sealed while summaries
 * were off — and `expired` with no text). `none` while the incident is still
 * collecting IS returned: the page offers "Summarise now".
 */
export function narrativeView(
  row: NarrativeRow,
  reasons: readonly NarrativeReasonRef[],
  projection: Pick<IncidentProjection, "codes"> | null,
  viewer: IncidentViewer,
  summariesOn: boolean,
): NarrativeView | null {
  if (!summariesOn || row.severity === "info") return null;
  if (!narrativeVisibleTo(row, reasons, projection, viewer)) return null;
  const text = row.narrative;
  if (text === null && (row.narrativeState === "expired" || (row.narrativeState === "none" && row.grouping !== "collecting"))) return null;
  return {
    state: row.narrativeState,
    text,
    writtenAt: text !== null && row.narratedAt ? row.narratedAt.toISOString() : null,
    model: text !== null ? row.narrativeModel : null,
    promptVersion: text !== null ? row.narrativePromptVersion : null,
  };
}
