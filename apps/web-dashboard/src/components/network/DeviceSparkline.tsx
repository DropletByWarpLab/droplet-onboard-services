import type { DevicePresenceDay } from "@/lib/types";

interface Props {
  days: DevicePresenceDay[];
  size?: "sm" | "lg";
}

export function DeviceSparkline({ days, size = "sm" }: Props) {
  const bars = Array.from({ length: 30 }, (_, i) => days[i]?.seenMinutes ?? 0);
  const h = size === "lg" ? 40 : 16;
  return (
    <div className="flex items-end gap-[1px]" role="img" aria-label="30-day activity">
      {bars.map((m, i) => (
        <div
          key={i}
          className="bg-[color-mix(in_srgb,var(--brand)_60%,transparent)] rounded-sm w-[3px]"
          data-testid="sparkline-bar"
          style={{ height: `${Math.max(1, (m / 1440) * h)}px` }}
        />
      ))}
    </div>
  );
}
