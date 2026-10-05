import type { EventFilter } from "@/lib/types";

export function BusinessHoursFilter({ value, configured, onChange }: {
  value: EventFilter["businessHours"];
  configured: boolean;
  onChange: (value: EventFilter["businessHours"]) => void;
}) {
  return (
    <div>
      <div className="type-caption-2 text-[color:var(--text-muted)] mb-1.5">Business hours</div>
      <div className="pills" role="group" aria-label="Business hours">
        {([
          [undefined, "All activity"],
          ["outside", "Outside hours"],
          ["inside", "During hours"],
        ] as const).map(([scope, label]) => (
          <button
            key={label}
            type="button"
            disabled={scope !== undefined && !configured}
            onClick={() => onChange(scope)}
            className={value === scope ? "active" : undefined}
            aria-pressed={value === scope}
            title={scope !== undefined && !configured ? "Save business hours first" : undefined}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
