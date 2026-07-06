import { ChevronRight, Home } from "lucide-react";

interface BreadcrumbNavProps {
  path: string;
  onNavigate: (path: string) => void;
}

export function BreadcrumbNav({ path, onNavigate }: BreadcrumbNavProps) {
  const segments = path.split("/").filter(Boolean);

  return (
    <nav
      aria-label="Breadcrumbs"
      className="flex items-center gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-input)] px-3 py-2 overflow-x-auto"
    >
      <button
        onClick={() => onNavigate("/")}
        aria-label="Home"
        className="flex items-center gap-1 type-subheadline text-[color:var(--brand)] hover:text-[color:var(--brand-hover)] transition-colors flex-shrink-0 min-h-[28px]"
      >
        <Home size={14} aria-hidden="true" />
        <span>Home</span>
      </button>

      {segments.map((segment, idx) => {
        const segmentPath = "/" + segments.slice(0, idx + 1).join("/");
        const isLast = idx === segments.length - 1;

        return (
          <span key={segmentPath} className="flex items-center gap-1 flex-shrink-0">
            <ChevronRight size={12} className="text-[color:var(--text-faint)]" />
            {isLast ? (
              <span className="type-subheadline text-[color:var(--text)] font-medium">
                {segment}
              </span>
            ) : (
              <button
                onClick={() => onNavigate(segmentPath)}
                className="type-subheadline text-[color:var(--brand)] hover:text-[color:var(--brand-hover)] transition-colors"
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
