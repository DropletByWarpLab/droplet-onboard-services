"use client";

/**
 * WARP-2980 (ADR-059 P5 §8 "What's usual") — how often something was seen at
 * each hour, for one area or camera and one label.
 *
 *   · An area-or-camera select (areas first) over exactly the keys the server
 *     returned — it has already dropped any area whose cameras the viewer
 *     cannot all see, and any camera outside their grant (DS-005). Label
 *     pills: Person / Car / Dog / Cat first, then any other kept label.
 *   · Two blocks, Weekdays and Weekends, each 24 hour cells in two halves of
 *     12: one row on desktop, 2 × 12 at ≤ 480 px (patterns.css), so 375 px
 *     never scrolls sideways.
 *   · Four shades from the share of watched days something was seen (never /
 *     some days / often / most days) — tokens only — and hatched while there
 *     are not enough watched days to judge the hour.
 *   · Every cell is a button with its numbers in its aria-label; choosing one
 *     shows the detail line. One tab stop for the grid; arrow keys move across
 *     hours and between weekdays and weekends, Home / End jump to the ends.
 *
 * Read-only. The numbers are the server's (routes 29/30), computed by the
 * same arithmetic as the flags.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { translateError } from "@/lib/friendly-errors";
import { useSecurityPatternCells } from "@/lib/hooks/useSecurity";
import type { SecurityDayType, SecurityPatternCellView, SecurityPatternsOverview } from "@/lib/types";
import { COPY, fillCopy, fillStep, formatRate, formatVisit, hourRange, hourTick, labelName, sortLabels } from "./patterns-copy";
import "./patterns.css";

type Key = SecurityPatternsOverview["keys"][number];

const DAY_TYPES: readonly SecurityDayType[] = ["weekday", "weekend"];
const dayName = (dt: SecurityDayType) => (dt === "weekday" ? COPY.weekdays : COPY.weekends);
const cellId = (dt: SecurityDayType, hour: number) => `${dt}:${hour}`;

/** "Weekdays, 2 to 3 AM: seen on 0 of 20 days" / "…: not enough yet". */
export function cellAriaLabel(c: SecurityPatternCellView): string {
  const base = { days: dayName(c.dayType), range: hourRange(c.hour, " to ") };
  return c.ready
    ? fillCopy(COPY.cellSeen, { ...base, d: c.daysWithEvent, n: c.daysObserved })
    : fillCopy(COPY.cellNotReady, base);
}

/** "Weekdays 2–3 AM · seen on 0 of 20 days · usually 0 an hour · longest usual visit: 95 s". */
export function detailLine(c: SecurityPatternCellView, label: string): string {
  const base = { days: dayName(c.dayType), range: hourRange(c.hour, "–"), d: c.daysWithEvent, n: c.daysObserved };
  if (!c.ready || c.typicalPerHour === null) return fillCopy(COPY.detailNotReady, base);
  let line = fillCopy(COPY.detail, { ...base, rate: formatRate(c.typicalPerHour) });
  if (label === "person") {
    line += fillCopy(COPY.detailVisit, {
      visit: c.longestUsualVisitSec === null ? COPY.noVisits : formatVisit(c.longestUsualVisitSec),
    });
  }
  return line;
}

const LEGEND = [
  { fill: "never", ready: true, text: COPY.legendNever },
  { fill: "some", ready: true, text: COPY.legendSome },
  { fill: "often", ready: true, text: COPY.legendOften },
  { fill: "most", ready: true, text: COPY.legendMost },
  { fill: "never", ready: false, text: COPY.legendNotReady },
] as const;

export function UsualGrid({ keys }: { keys: readonly Key[] }) {
  const ordered = useMemo(() => [...keys.filter((k) => k.kind === "area"), ...keys.filter((k) => k.kind === "camera")], [keys]);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [chosenLabel, setChosenLabel] = useState("person");
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState(cellId("weekday", 0));
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const current = ordered.find((k) => k.zoneKey === chosenKey) ?? ordered[0] ?? null;
  const labels = current ? sortLabels(current.labels) : [];
  const label = current ? (labels.includes(chosenLabel) ? chosenLabel : (labels[0] ?? "person")) : null;
  const { cells, error } = useSecurityPatternCells(current?.zoneKey ?? null, label);

  const byId = useMemo(() => new Map((cells?.cells ?? []).map((c) => [cellId(c.dayType, c.hour), c])), [cells]);
  const errorCopy = useMemo(() => (error ? translateError(error, "security") : null), [error]);

  if (!current || !label) return <p className="usual-empty">{COPY.noKeys}</p>;

  const areas = ordered.filter((k) => k.kind === "area");
  const cams = ordered.filter((k) => k.kind === "camera");
  const selectedCell = selected ? byId.get(selected) ?? null : null;

  const move = (e: KeyboardEvent<HTMLButtonElement>, dt: SecurityDayType, hour: number) => {
    let next: [SecurityDayType, number] | null = null;
    if (e.key === "ArrowRight") next = [dt, Math.min(23, hour + 1)];
    else if (e.key === "ArrowLeft") next = [dt, Math.max(0, hour - 1)];
    else if (e.key === "ArrowDown") next = ["weekend", hour];
    else if (e.key === "ArrowUp") next = ["weekday", hour];
    else if (e.key === "Home") next = [dt, 0];
    else if (e.key === "End") next = [dt, 23];
    if (!next) return;
    e.preventDefault();
    const id = cellId(next[0], next[1]);
    setFocusId(id);
    buttons.current.get(id)?.focus();
  };

  return (
    <div className="usual">
      <div className="usual-controls">
        <label className="sr-only" htmlFor="usual-key">
          {COPY.keyLabel}
        </label>
        <select
          id="usual-key"
          className="usual-select"
          value={current.zoneKey}
          onChange={(e) => {
            setChosenKey(e.target.value);
          }}
        >
          {areas.length > 0 && (
            <optgroup label={COPY.areasGroup}>
              {areas.map((k) => (
                <option key={k.zoneKey} value={k.zoneKey}>
                  {k.name}
                </option>
              ))}
            </optgroup>
          )}
          {cams.length > 0 && (
            <optgroup label={COPY.camerasGroup}>
              {cams.map((k) => (
                <option key={k.zoneKey} value={k.zoneKey}>
                  {k.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <div className="pills" role="group" aria-label={COPY.labelGroup}>
          {labels.map((l) => (
            <button
              key={l}
              type="button"
              className={l === label ? "active" : undefined}
              aria-pressed={l === label}
              onClick={() => setChosenLabel(l)}
            >
              {labelName(l)}
            </button>
          ))}
        </div>
      </div>

      {errorCopy && !cells ? (
        <p className="usual-empty" role="alert">
          {errorCopy}
        </p>
      ) : !cells ? (
        <div className="empty" data-testid="usual-loading" aria-busy="true">
          <Loader2 size={20} className="animate-spin" aria-hidden />
        </div>
      ) : (
        <>
          {DAY_TYPES.map((dt) => (
            <div key={dt} className="usual-block" role="group" aria-label={dayName(dt)}>
              <p className="usual-block-h" aria-hidden>
                {dayName(dt)}
              </p>
              <div className="usual-halves">
                {[0, 12].map((start) => (
                  <div key={start} className="usual-half" data-half={start === 0 ? "am" : "pm"}>
                    <div className="usual-row">
                      {Array.from({ length: 12 }, (_x, i) => {
                        const hour = start + i;
                        const id = cellId(dt, hour);
                        const c = byId.get(id) ?? {
                          dayType: dt,
                          hour,
                          daysObserved: 0,
                          daysWithEvent: 0,
                          ready: false,
                          rare: false,
                          typicalPerHour: null,
                          longestUsualVisitSec: null,
                        };
                        return (
                          <button
                            key={id}
                            ref={(el) => {
                              if (el) buttons.current.set(id, el);
                              else buttons.current.delete(id);
                            }}
                            type="button"
                            className="usual-cell"
                            data-fill={fillStep(c.daysWithEvent, c.daysObserved)}
                            data-ready={String(c.ready)}
                            aria-label={cellAriaLabel(c)}
                            aria-pressed={selected === id}
                            tabIndex={focusId === id ? 0 : -1}
                            onClick={() => {
                              setSelected(id);
                              setFocusId(id);
                            }}
                            onKeyDown={(e) => move(e, dt, hour)}
                          />
                        );
                      })}
                    </div>
                    <div className="usual-ticks" aria-hidden>
                      <span>{hourTick(start)}</span>
                      <span>{hourTick(start + 6)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="usual-detail" data-testid="usual-detail" aria-live="polite">
            {selectedCell ? detailLine(selectedCell, label) : COPY.pick}
          </p>
          <ul className="usual-legend" data-testid="usual-legend">
            {LEGEND.map((item) => (
              <li key={item.text}>
                <span className="usual-swatch" data-fill={item.fill} data-ready={String(item.ready)} aria-hidden />
                {item.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
