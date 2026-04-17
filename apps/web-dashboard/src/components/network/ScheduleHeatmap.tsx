"use client";

/**
 * 7×24 heatmap preview of a schedule's weekly windows.
 *
 * Each cell represents one hour of one day (Sun..Sat, 0..23). A cell is
 * "covered" if any window intersects that (day, hour) bucket for any minute.
 * Overlap count drives opacity so multiple windows covering the same hour
 * render darker. Midnight-wrap is handled: a window "Sat 23:00-Sun 07:00" will
 * color Sat[23] AND Sun[0..6].
 *
 * This is a read-only preview — editing happens in WeeklyWindowsEditor.
 */

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_BIT = [1, 2, 4, 8, 16, 32, 64];

export interface HeatmapWindow {
  daysOfWeek: number;
  startMin: number;
  endMin: number;
}

interface Props {
  windows: HeatmapWindow[];
}

/**
 * Build a 7×24 overlap-count matrix by walking each window's minutes across
 * up to 7 day-of-week start days. We collect the set of (day, hour) pairs
 * any minute of the window touches, then increment the overlap counter for
 * that pair. This keeps the midnight-wrap logic trivial — we just iterate
 * `startMin` up to `startMin + length` and modulo into (day+1, hour-24).
 */
function buildOverlap(windows: HeatmapWindow[]): number[][] {
  // matrix[day][hour] = overlap count
  const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  for (const w of windows) {
    const length =
      w.endMin > w.startMin ? w.endMin - w.startMin : 1440 - w.startMin + w.endMin;
    if (length <= 0) continue;

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      if ((w.daysOfWeek & DAY_BIT[dayIdx]) === 0) continue;

      // Collect every (day, hour) cell this window touches, starting on dayIdx.
      const touched = new Set<string>();
      for (let m = 0; m < length; m++) {
        const absMin = w.startMin + m;
        const dayOffset = Math.floor(absMin / 1440);
        const minInDay = absMin % 1440;
        const day = (dayIdx + dayOffset) % 7;
        const hour = Math.floor(minInDay / 60);
        touched.add(`${day}-${hour}`);
      }
      for (const key of touched) {
        const [d, h] = key.split("-").map((n) => Number.parseInt(n, 10));
        matrix[d][h]++;
      }
    }
  }

  return matrix;
}

export function ScheduleHeatmap({ windows }: Props) {
  const matrix = buildOverlap(windows);

  return (
    <div
      role="img"
      aria-label="Schedule heatmap: hours blocked across the week"
      className="dp-card p-3"
    >
      {/* Hour ticks */}
      <div className="grid grid-cols-[32px_repeat(24,1fr)] gap-0.5 mb-1">
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={h}
            className="type-caption-2 text-label-tertiary text-center"
            aria-hidden="true"
          >
            {h === 0 || h === 6 || h === 12 || h === 18 ? h : ""}
          </div>
        ))}
      </div>

      {/* Rows */}
      {DAY_ABBR.map((name, day) => (
        <div
          key={day}
          className="grid grid-cols-[32px_repeat(24,1fr)] gap-0.5 mb-0.5"
        >
          <div className="type-caption-2 text-label-secondary">{name}</div>
          {Array.from({ length: 24 }, (_, hour) => {
            const overlap = matrix[day][hour];
            const opacityClass =
              overlap === 0
                ? "bg-surface-secondary"
                : overlap === 1
                  ? "bg-accent/30"
                  : overlap === 2
                    ? "bg-accent/55"
                    : "bg-accent/80";
            return (
              <div
                key={hour}
                data-testid={`heatmap-cell-${day}-${hour}`}
                data-overlap={overlap}
                aria-hidden="true"
                className={`h-4 rounded-sm ${opacityClass}`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
