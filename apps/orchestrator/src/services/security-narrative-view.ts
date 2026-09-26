/**
 * WARP-2979 (ADR-059 P4 §6.11.3, DS-005, D21) — who may read a "Summary by
 * Droplet". THE one rule route 18, route 28 and the assistant's A2 (PR-3)
 * call.
 *
 * THE VIEWER FIRST (WARP-2979 review of #2423; narrows spec D21, §6.11.3):
 * only a viewer who sees every camera AND may read threats ever gets a
 * summary — `mayReadSummaries`, P5's verdict rule (`seesEverything`),
 * independent of the incident. A summary is written once, from the whole
 * incident, so any rule that looked at the incident's hidden evidence would
 * answer differently for an incident with hidden evidence than for the same
 * incident built from her own cameras alone — and that difference is the
 * hint DS-005 forbids (the R1 pg pin: a camera-limited viewer's page must be
 * the same either way). A viewer-only rule answers `null` in both. The cost:
 * a camera-limited viewer never gets a summary, even of an incident entirely
 * on her own cameras — the spec's per-incident audience, narrowed to viewers
 * who see everything. It never widens what anyone sees.
 *
 * Then the incident-level checks (`narrativeIncidentVisible`), unreachable
 * for today's admitted viewers — who see every camera and every reason — and
 * kept as the second fence for when the viewer rule or reasonVisibleTo's lock
 * clause widens (P4 PR-4's mayReadLocks):
 *   · the view is not PARTIAL (P3's rule: no top-severity reason hidden);
 *   · EVERY reason passes THE reason-visibility rule (`reasonVisibleTo`,
 *     lib/security-reason-visibility.ts: its evidence camera, its related
 *     camera, its related lock — P4 PR-4 swaps the lock clause there for
 *     `mayReadLocks`, DS-019, and this follows), with the incident's scope
 *     rule for a camera-less reason;
 *   · every camera of its audience (`narrativeAudience.cameras`) and of the
 *     incident — the union, so a Regenerate in flight or a state with no
 *     text yet is judged against the incident as it is now — and a named
 *     lock, read through the same rule;
 *   · threats ⇒ `mayReadThreats` (the audience says so, the incident is about
 *     network and sign-in warnings, or a reason's evidence is a threat row);
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
import { reasonVisibleTo } from "../lib/security-reason-visibility.js";
import { seesEverything, type IncidentProjection, type IncidentViewer } from "./security-incident-view.js";

/**
 * What a seal, a resolve that seals, and route 28 write to ask for the
 * incident's summary (§6.9.1): `pending`, with the lease and the attempts
 * cleared — so a narration in flight misses its write. Only on notice/alert
 * incidents (plain activity is never narrated, CHECK), only while summaries
 * are on. Never the incident's version.
 */
export const NARRATIVE_ON_SEAL = { narrativeState: "pending", narrativeAttemptAt: null, narrativeAttempts: 0 } as const;

/** Route 28: under this long since the last attempt or the text → 409 NARRATIVE_COOLDOWN. */
export const NARRATIVE_COOLDOWN_MS = 10 * 60_000;

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

/**
 * The viewer rule (see the header): sees every camera and may read threats —
 * `seesEverything`, the verdict's rule. Route 28 asks it before it reads an
 * incident, so its refusal is the same for every id.
 */
export function mayReadSummaries(viewer: IncidentViewer): boolean {
  return seesEverything(viewer);
}

/**
 * DS-005 for the summary — THE rule route 18, route 28 and A2 call: the viewer
 * first, then the incident. `projection` null = the viewer may not know the
 * incident exists.
 */
export function narrativeVisibleTo(
  row: NarrativeRow,
  reasons: readonly NarrativeReasonRef[],
  projection: Pick<IncidentProjection, "codes" | "partial"> | null,
  viewer: IncidentViewer,
): boolean {
  return mayReadSummaries(viewer) && narrativeIncidentVisible(row, reasons, projection, viewer);
}

/** The incident-level checks, after the viewer rule. Exported for its tests; callers use `narrativeVisibleTo`. */
export function narrativeIncidentVisible(
  row: NarrativeRow,
  reasons: readonly NarrativeReasonRef[],
  projection: Pick<IncidentProjection, "codes" | "partial"> | null,
  viewer: IncidentViewer,
): boolean {
  if (!projection || projection.partial) return false;
  const audience = requiredAudience(row, reasons);
  if (!audience) return false;
  // A camera-less reason follows the incident's scope (security-incident-view's `reasonVisible`).
  const siteEvidence = row.scope === "site_threat" ? viewer.mayReadThreats : row.scope === "site_camera_system";
  if (!reasons.every((r) => reasonVisibleTo(r, viewer, siteEvidence))) return false;
  if (!audience.cameras.every((camera) => reasonVisibleTo({ evidenceCamera: camera }, viewer, false))) return false;
  if (audience.locks && !reasonVisibleTo({ evidenceCamera: null, relatedLock: true }, viewer, true)) return false;
  if (audience.threats && !viewer.mayReadThreats) return false;
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
  projection: Pick<IncidentProjection, "codes" | "partial"> | null,
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
