/**
 * The Security viewer's scope: which cameras, threats and door locks a
 * request may read. A leaf module (no imports) so the services that take a
 * scope — security-zones.service.ts among them — need not import
 * security-access.ts, which imports the lock adapter's reader type: that
 * edge closed an import cycle through security-events → security-incidents
 * → security-zones (WARP-3193 ARCH-1's guard, import-cycles.test.ts).
 * security-access.ts re-exports it, so other importers are unchanged.
 */
export interface SecurityViewerScope {
  /** `"all"` for owner/admin; otherwise exactly the granted Frigate camera names. */
  visibleCameras: "all" | ReadonlySet<string>;
  /** Mirrored threats (and the threat_mirror health row) — owner/admin only. */
  mayReadThreats: boolean;
  /** Lock rows, lock links, the `locks` health row (WARP-2977 P2b-2, DS-019) — `mayReadLocksFor`. */
  mayReadLocks: boolean;
}
