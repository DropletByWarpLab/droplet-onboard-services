interface StatusCardProps {
  title: string;
  value: string;
  subtitle?: string;
  status?: "ok" | "warning" | "error" | "offline";
}

const statusColors = {
  ok: "bg-system-green",
  warning: "bg-system-orange",
  error: "bg-system-red",
  offline: "bg-label-quaternary",
};

// Plain-English status descriptions for screen readers. The raw enum
// ("ok"/"warning") is useless when announced; WARP-298 mapped these to
// human-readable phrases.
const statusLabels = {
  ok: "All good",
  warning: "Needs attention",
  error: "Error",
  offline: "Offline",
};

export function StatusCard({ title, value, subtitle, status }: StatusCardProps) {
  return (
    <div className="dp-card p-5 hover:shadow-lg transition-shadow duration-200 ease-smooth">
      <div className="flex items-center justify-between mb-2">
        <h3 className="type-footnote text-label-secondary uppercase tracking-wide">
          {title}
        </h3>
        {status && (
          <span
            className={`w-2 h-2 rounded-full ${statusColors[status]}`}
            role="img"
            aria-label={statusLabels[status]}
          />
        )}
      </div>
      <p className="type-title-3 text-label-primary">{value}</p>
      {subtitle && (
        <p className="type-caption-1 text-label-tertiary mt-1">{subtitle}</p>
      )}
    </div>
  );
}
