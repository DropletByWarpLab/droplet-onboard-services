import { Building2, ChevronRight, FolderOpen } from "lucide-react";

interface BreadcrumbNavProps {
  path: string;
  onNavigate: (path: string) => void;
  /**
   * WARP-1267 — a non-navigating crumb rendered before "My files", used for team
   * spaces: the department name prefixes the breadcrumb ("Engineering /
   * Platform / …") even though Nextcloud mounts the team library flat — the
   * dashboard owns this hierarchy illusion (ADR-029 §D-3).
   */
  prefixCrumb?: string;
  /**
   * WARP-1944 — the root crumb's label. It names the ACTIVE SPACE, so a
   * Workspace/department/team browse never claims "My files": the caller
   * passes the space's display label (e.g. "Workspace", the team name).
   * Defaults to "My files" — the personal space and every caller that
   * predates spaces. Label only: the root crumb always navigates to "/",
   * the space's own root.
   */
  rootLabel?: string;
  /**
   * WARP-1338 (UX review) — display-name override for a crumb. A volume
   * deep-link lands on /files?path=/<mount-tail>; for a legacy pool the tail
   * is the full fs UUID, and a GUID must never be the primary location label
   * (WARP-1337). Returning undefined keeps the raw segment; navigation always
   * uses the REAL path — the WebDAV listing is keyed by the raw tail.
   */
  labelForSegment?: (segment: string, index: number) => string | undefined;
}

export function BreadcrumbNav({
  path,
  onNavigate,
  prefixCrumb,
  rootLabel = "My files",
  labelForSegment,
}: BreadcrumbNavProps) {
  const segments = path.split("/").filter(Boolean);

  return (
    <nav
      aria-label="Breadcrumbs"
      // WARP-1876: `w-fit` — the bar used to stretch the full content width
      // around a single "My files" crumb, which reads as an unfinished
      // toolbar. It hugs its crumbs now, and still scrolls (`max-w-full` +
      // `overflow-x-auto`) once a path is deep enough to overflow.
      className="flex w-fit max-w-full items-center gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-input)] px-3 py-2 overflow-x-auto"
    >
      {prefixCrumb && (
        <span className="flex items-center gap-1 type-subheadline text-[color:var(--text-muted)] flex-shrink-0 min-h-[28px]">
          <Building2 size={13} aria-hidden="true" />
          {prefixCrumb}
          <ChevronRight size={12} className="text-[color:var(--text-faint)]" aria-hidden="true" />
        </span>
      )}
      <button
        onClick={() => onNavigate("/")}
        aria-label={rootLabel}
        className="flex items-center gap-1 type-subheadline text-[color:var(--brand)] hover:text-[color:var(--brand-hover)] transition-colors flex-shrink-0 min-h-[28px]"
      >
        <FolderOpen size={14} aria-hidden="true" />
        <span>{rootLabel}</span>
      </button>

      {segments.map((segment, idx) => {
        const segmentPath = "/" + segments.slice(0, idx + 1).join("/");
        const isLast = idx === segments.length - 1;
        const label = labelForSegment?.(segment, idx) ?? segment;

        return (
          <span key={segmentPath} className="flex items-center gap-1 flex-shrink-0">
            <ChevronRight size={12} className="text-[color:var(--text-faint)]" />
            {isLast ? (
              <span className="type-subheadline text-[color:var(--text)] font-medium">
                {label}
              </span>
            ) : (
              <button
                onClick={() => onNavigate(segmentPath)}
                className="type-subheadline text-[color:var(--brand)] hover:text-[color:var(--brand-hover)] transition-colors"
              >
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
