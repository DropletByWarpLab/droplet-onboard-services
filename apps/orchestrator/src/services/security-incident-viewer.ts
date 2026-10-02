/**
 * WARP-2979 (WARP-3193 ARCH-1) — who is looking at an incident, and the one
 * viewer-only rule several modules share. A LEAF: it imports no security
 * module, so the incident view (security-incident-view.ts) and the summary's
 * rules (security-narrative-view.ts) can both use it without importing each
 * other — the incident view reads the summary's rules, never the reverse.
 * security-incident-view.ts re-exports both, so its importers are unchanged.
 */

export interface IncidentViewer {
  userId: string;
  /** `"all"` for owner/admin; otherwise exactly the granted Frigate camera names. */
  visibleCameras: "all" | ReadonlySet<string>;
  mayReadThreats: boolean;
  /**
   * WARP-2977 P2b-2 (DS-019) — door-lock rows among the members, and lock
   * links when naming areas: the feed's own `mayReadLocks` (Devices view).
   */
  mayReadLocks: boolean;
  /** Owner/admin: every notice. Anyone else: their own (D34). */
  ownerOrAdmin: boolean;
}

/** Review item 2 — who may see (and give) a verdict: a viewer who sees every camera and may read threats (P4's rule). */
export function seesEverything(v: Pick<IncidentViewer, "visibleCameras" | "mayReadThreats">): boolean {
  return v.visibleCameras === "all" && v.mayReadThreats;
}
