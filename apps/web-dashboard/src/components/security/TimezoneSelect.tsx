"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.6, spec §6.4) — the opening hours' timezone.
 *
 * Every opening and closing time is a wall time in ONE zone: the site's. The
 * server never falls back to UTC or to the box's process zone, so this picker
 * is the only place the zone comes from — and a wrong zone silently shifts
 * every open/close by hours. Hence three rules:
 *
 *   1. The zone is ALWAYS on screen ("Times are in Europe/London"), for
 *      editors and read-only viewers alike.
 *   2. When the viewing device sits in a different zone, say so and offer it
 *      ("Your device is on Central Time (America/Chicago). Use that?") — but
 *      only as a suggestion: an owner away from the shop must not have the
 *      shop's zone swapped for their hotel's.
 *   3. The list is the runtime's own IANA list (`Intl.supportedValuesOf`),
 *      the same names the server validates against, plus the current value
 *      and the device's zone if the runtime happens not to list them.
 */
import { useId, useMemo } from "react";

export const COPY = {
  label: "Timezone",
  timesAreIn: "Times are in {tz}",
  noZone: "Pick the timezone the site is in. Every time on this page is read in it.",
  chooseZone: "Choose a timezone",
  deviceDiffers: "Your device is on {tz}.",
  useDevice: "Use that?",
} as const;

/** Replace `{name}` placeholders. COPY stays plain strings (the Security copy lint reads them). */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
}

/** The runtime's IANA list, or `[]` on an engine without `Intl.supportedValuesOf`. */
export function supportedTimeZones(): string[] {
  try {
    const f = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return typeof f === "function" ? f("timeZone") : [];
  } catch {
    return [];
  }
}

/**
 * "Central Time (America/Chicago)" — the zone's generic name with its id, so
 * two zones that share a name ("Central Time" is also America/Winnipeg) stay
 * distinguishable. Just the id when the runtime has no generic name for it.
 */
export function zoneLabel(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    if (!name || name === tz || /^GMT[+-]?/.test(name)) return tz;
    return `${name} (${tz})`;
  } catch {
    return tz;
  }
}

/** The runtime's canonical id for a zone, or the input when the runtime does not know it. */
function canonicalZone(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return tz;
  }
}

/**
 * Whether two ids name the same zone. Aliases are one zone ("Asia/Kolkata" is
 * "Asia/Calcutta", "Europe/Kyiv" is "Europe/Kiev"), and browsers disagree on
 * which spelling they report: the server stores Node's canonical id, and a
 * device that reports the other spelling must not be told it is elsewhere.
 */
export function sameZone(a: string, b: string): boolean {
  return a === b || canonicalZone(a) === canonicalZone(b);
}

export interface TimezoneSelectProps {
  /** The site zone, or "" when none is known yet (no saved hours, no hint, no device zone). */
  value: string;
  onChange: (tz: string) => void;
  /** The viewing device's zone (`deviceTimeZone()`), only ever a suggestion. */
  deviceZone: string | null;
  /** Below manage: the zone is shown, never offered for change. */
  readOnly?: boolean;
  /** The option list; defaults to the runtime's. Injected by tests. */
  zones?: readonly string[];
}

export function TimezoneSelect({ value, onChange, deviceZone, readOnly = false, zones }: TimezoneSelectProps) {
  const id = useId();
  const options = useMemo(() => {
    const base = zones ?? supportedTimeZones();
    const all = new Set(base);
    if (value) all.add(value);
    if (deviceZone) all.add(deviceZone);
    return Array.from(all).sort((a, b) => a.localeCompare(b));
  }, [zones, value, deviceZone]);

  const differs = Boolean(deviceZone && value && !sameZone(deviceZone, value));

  return (
    <div className="security-tz" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {!readOnly && (
        <>
          <label htmlFor={id} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {COPY.label}
          </label>
          <select
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[color:var(--text)] focus:border-[var(--brand)]"
            style={{ maxWidth: 360, minHeight: 44 }}
          >
            {value === "" && <option value="">{COPY.chooseZone}</option>}
            {options.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </>
      )}
      <p data-testid="tz-current" style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
        {value ? fill(COPY.timesAreIn, { tz: value }) : COPY.noZone}
      </p>
      {differs && deviceZone && (
        <p data-testid="tz-mismatch" style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
          {fill(COPY.deviceDiffers, { tz: zoneLabel(deviceZone) })}{" "}
          {!readOnly && (
            <button
              type="button"
              onClick={() => onChange(deviceZone)}
              // Inline in the sentence; the vertical padding gives it a 44px
              // touch target without changing the line's height.
              style={{
                border: 0,
                background: "transparent",
                padding: "12px 4px",
                margin: "0 -4px",
                font: "inherit",
                color: "var(--brand)",
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              {COPY.useDevice}
            </button>
          )}
        </p>
      )}
    </div>
  );
}
