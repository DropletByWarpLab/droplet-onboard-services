/**
 * WARP-2979 (ADR-059 P4 §6.7.2) — THE reason-visibility rule, pure, one helper
 * for all three readers: `projectIncident` (routes 16–18, re-exported from
 * services/security-incident-view.ts), the list SQL's twins
 * (`visibleReasonWhere`, security-incident-page's `visReason`) and the
 * notifier's per-recipient evidence (services/security-alerts.service.ts):
 *   · the evidence camera is visible — a camera-less reason follows
 *     `siteEvidence` (the incident's scope rule; for the notifier, owner/admin);
 *   · AND the related camera, when there is one, is visible — a recipient who
 *     can see the camera that dropped but not where the person was seen gets
 *     neither the reason nor its alert (the text would reveal presence);
 *   · AND a related lock is shown only to a viewer who sees every camera
 *     (P4 PR-4 swaps this clause for `mayReadLocks`, DS-019; PR-1 writes none).
 */
export function reasonVisibleTo(
  r: { evidenceCamera: string | null; relatedCamera?: string | null; relatedLock?: boolean },
  scope: { visibleCameras: "all" | ReadonlySet<string> },
  siteEvidence: boolean,
): boolean {
  const sees = (c: string): boolean => scope.visibleCameras === "all" || scope.visibleCameras.has(c);
  // `== null`: a row read without the P4 columns (an older select) names no second source.
  if (r.relatedLock === true && scope.visibleCameras !== "all") return false;
  if (r.relatedCamera != null && !sees(r.relatedCamera)) return false;
  return r.evidenceCamera === null ? siteEvidence : sees(r.evidenceCamera);
}
