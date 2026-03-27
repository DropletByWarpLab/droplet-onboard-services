import { ChevronRight, Home } from "lucide-react";

interface BreadcrumbNavProps {
  path: string;
  onNavigate: (path: string) => void;
}

export function BreadcrumbNav({ path, onNavigate }: BreadcrumbNavProps) {
  const segments = path.split("/").filter(Boolean);

  return (
    <nav className="flex items-center gap-1 bg-surface-tertiary rounded-sm px-3 py-2 overflow-x-auto">
      <button
        onClick={() => onNavigate("/")}
        className="flex items-center gap-1 type-subheadline text-accent hover:text-accent-hover transition-colors flex-shrink-0 min-h-[28px]"
      >
        <Home size={14} />
        <span>Home</span>
      </button>

      {segments.map((segment, idx) => {
        const segmentPath = "/" + segments.slice(0, idx + 1).join("/");
        const isLast = idx === segments.length - 1;

        return (
          <span key={segmentPath} className="flex items-center gap-1 flex-shrink-0">
            <ChevronRight size={12} className="text-label-quaternary" />
            {isLast ? (
              <span className="type-subheadline text-label-primary font-medium">
                {segment}
              </span>
            ) : (
              <button
                onClick={() => onNavigate(segmentPath)}
                className="type-subheadline text-accent hover:text-accent-hover transition-colors"
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
