"use client";

/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4) — add expected activity: this
 * label, at this area or camera, in this window of hours on these days, is
 * normal — so Droplet stops flagging it as unusual until the date chosen. It
 * quiets the three pattern flags only; it never hides someone inside after
 * hours (the server refuses anything else).
 *
 * A right-edge side panel on the `Dialog` primitive (focus moves in, Escape
 * closes, focus returns to the opener), which the shell turns into a
 * full-width sheet on a phone — so it owns a labelled Close control
 * (a11y.side-panel-close.test.ts). The day and flag groups are fieldsets with
 * legends. Rendered only when route 32's `canManage` says the server would
 * accept it.
 *
 * The places are the keys route 29 already filtered for this viewer (DS-005);
 * the server checks the target again. The body sent is exactly route 33's.
 * A refusal (400/404/409/503) is shown here in the security domain's friendly
 * words, and the form stays open so the person can fix it or back out.
 */
import { useEffect, useId, useState, type FormEvent, type RefObject } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { translateError } from "@/lib/friendly-errors";
import type { SecurityPatternCode, SecurityPatternsOverview, SecuritySuppressionCreateBody, SecuritySuppressionDays } from "@/lib/types";
import {
  COPY,
  DAYS_NAME,
  EXPECTED_COPY,
  EXPECTED_DIALOG_COPY as D,
  EXPECTED_LENGTHS,
  PATTERN_NAME,
  PATTERN_ORDER,
  fillCopy,
  hourTick,
  labelName,
} from "./patterns-copy";

type Key = SecurityPatternsOverview["keys"][number];

/** The server's cap on the reason (characters, after trimming). */
export const EXPECTED_REASON_MAX = 120;

/**
 * What the server refuses in a reason (`chainSafeText` + `hasUnsafeDisplayChars`):
 * controls, line and paragraph separators, the bidi embeddings, overrides and
 * isolates, U+FEFF — and a lone surrogate.
 */
const REASON_UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩﻿]/u;
function hasLoneSurrogate(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0xd800 && c <= 0xdfff) return true;
  }
  return false;
}

const DAYS_ORDER: readonly SecuritySuppressionDays[] = ["every_day", "weekdays", "weekends"];

/** The site's hour right now, so the form starts at "now" (the device's zone only when the site has none). */
function siteHour(now: Date, timeZone: string | null): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? undefined, hour: "numeric", hourCycle: "h23" }).format(now);
    return Number(h) % 24;
  } catch {
    return now.getHours();
  }
}

/** `camera:<name>` → the Frigate name. */
const cameraOfKey = (zoneKey: string) => zoneKey.slice("camera:".length);

export interface ExpectedActivityDialogProps {
  open: boolean;
  onClose: () => void;
  /** The places this viewer may see (route 29's keys). */
  keys: readonly Key[];
  timezone: string | null;
  now: Date;
  /** Reject to keep the dialog open; the error is shown here. */
  onCreate: (body: SecuritySuppressionCreateBody) => Promise<unknown>;
  triggerRef?: RefObject<HTMLElement | null>;
}

export function ExpectedActivityDialog({ open, onClose, keys, timezone, now, onCreate, triggerRef }: ExpectedActivityDialogProps) {
  const uid = useId();
  const ids = {
    title: `${uid}-title`,
    intro: `${uid}-intro`,
    where: `${uid}-where`,
    what: `${uid}-what`,
    from: `${uid}-from`,
    for: `${uid}-for`,
    reason: `${uid}-reason`,
    until: `${uid}-until`,
    dwell: `${uid}-dwell`,
    problem: `${uid}-problem`,
  };

  const [zoneKey, setZoneKey] = useState(keys[0]?.zoneKey ?? "");
  const [label, setLabel] = useState(keys[0]?.labels[0] ?? "person");
  const [days, setDays] = useState<SecuritySuppressionDays>("every_day");
  const [hourFrom, setHourFrom] = useState(() => siteHour(now, timezone));
  const [hourCount, setHourCount] = useState(1);
  const [codes, setCodes] = useState<SecurityPatternCode[]>(["out_of_place"]);
  const [reason, setReason] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A fresh form on every open.
  useEffect(() => {
    if (!open) return;
    setZoneKey(keys[0]?.zoneKey ?? "");
    setLabel(keys[0]?.labels[0] ?? "person");
    setDays("every_day");
    setHourFrom(siteHour(now, timezone));
    setHourCount(1);
    setCodes(["out_of_place"]);
    setReason("");
    setExpiresInDays(30);
    setProblem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const key = keys.find((k) => k.zoneKey === zoneKey) ?? null;
  const labels = key?.labels ?? [];
  const dwellAllowed = label === "person";

  const pickKey = (next: string) => {
    setZoneKey(next);
    const nextLabels = keys.find((k) => k.zoneKey === next)?.labels ?? [];
    if (!nextLabels.includes(label)) pickLabel(nextLabels[0] ?? "person");
  };
  const pickLabel = (next: string) => {
    setLabel(next);
    // Only people can stay longer than usual (the server refuses long_dwell otherwise).
    if (next !== "person") setCodes((c) => c.filter((x) => x !== "long_dwell"));
  };
  const toggle = (code: SecurityPatternCode, on: boolean) => {
    setCodes((c) => (on ? [...c, code] : c.filter((x) => x !== code)));
    if (problem === D.needFlag) setProblem(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending || !key) return;
    const trimmed = reason.trim();
    let found: string | null = null;
    if (codes.length === 0) found = D.needFlag;
    else if (trimmed.length === 0) found = D.needReason;
    else if ([...trimmed].length > EXPECTED_REASON_MAX || REASON_UNSAFE.test(trimmed) || hasLoneSurrogate(trimmed)) found = D.badReason;
    if (found) {
      setProblem(found);
      return;
    }
    setProblem(null);
    const body: SecuritySuppressionCreateBody = {
      target: key.kind === "area" ? { kind: "area", zoneId: key.zoneId! } : { kind: "camera", camera: cameraOfKey(key.zoneKey) },
      label,
      days,
      hourFrom,
      hourCount,
      codes: PATTERN_ORDER.filter((c) => codes.includes(c)),
      reason: trimmed,
      expiresInDays,
    };
    setPending(true);
    try {
      await onCreate(body);
      onClose();
    } catch (err) {
      // Friendly words only — never the server's message. The form stays open.
      setProblem(translateError(err, "security"));
    } finally {
      setPending(false);
    }
  };

  const areas = keys.filter((k) => k.kind === "area");
  const cameras = keys.filter((k) => k.kind === "camera");
  const field = { display: "grid", gap: 6 } as const;
  const labelStyle = { fontSize: 12.5, fontWeight: 500, color: "var(--text-muted)" } as const;

  return (
    <Dialog open={open} onClose={onClose} placement="right" labelledBy={ids.title} describedBy={ids.intro} triggerRef={triggerRef} flush>
      <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
        <div className="expected-dialog-h">
          <h2 id={ids.title} style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)" }}>
            {D.title}
          </h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>

        <div style={{ display: "grid", gap: 18, padding: 20, flex: 1 }}>
          <p id={ids.intro} style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
            {D.intro}
          </p>

          <div style={field}>
            <label htmlFor={ids.where} style={labelStyle}>
              {D.where}
            </label>
            <select id={ids.where} className="usual-select" value={zoneKey} onChange={(e) => pickKey(e.target.value)}>
              {areas.length > 0 && (
                <optgroup label={COPY.areasGroup}>
                  {areas.map((k) => (
                    <option key={k.zoneKey} value={k.zoneKey}>
                      {k.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {cameras.length > 0 && (
                <optgroup label={COPY.camerasGroup}>
                  {cameras.map((k) => (
                    <option key={k.zoneKey} value={k.zoneKey}>
                      {k.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div style={field}>
            <label htmlFor={ids.what} style={labelStyle}>
              {D.what}
            </label>
            <select id={ids.what} className="usual-select" value={label} onChange={(e) => pickLabel(e.target.value)}>
              {labels.map((l) => (
                <option key={l} value={l}>
                  {labelName(l)}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="expected-fieldset">
            <legend style={labelStyle}>{D.days}</legend>
            <div className="expected-choices">
              {DAYS_ORDER.map((d) => (
                <label key={d} className="expected-choice">
                  <input type="radio" name={`${uid}-days`} value={d} checked={days === d} onChange={() => setDays(d)} />
                  {DAYS_NAME[d]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="expected-hours">
            <div style={field}>
              <label htmlFor={ids.from} style={labelStyle}>
                {D.from}
              </label>
              <select id={ids.from} className="usual-select" value={hourFrom} onChange={(e) => setHourFrom(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_x, h) => (
                  <option key={h} value={h}>
                    {hourTick(h)}
                  </option>
                ))}
              </select>
            </div>
            <div style={field}>
              <label htmlFor={ids.for} style={labelStyle}>
                {D.for}
              </label>
              <select id={ids.for} className="usual-select" value={hourCount} onChange={(e) => setHourCount(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_x, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n === 24 ? EXPECTED_COPY.allDay : n === 1 ? D.hoursOne : fillCopy(D.hoursMany, { n })}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="expected-fieldset">
            <legend style={labelStyle}>{D.flags}</legend>
            <div className="expected-choices">
              {PATTERN_ORDER.map((code) => {
                const disabled = code === "long_dwell" && !dwellAllowed;
                return (
                  <label key={code} className="expected-choice" data-disabled={disabled || undefined}>
                    <input
                      type="checkbox"
                      value={code}
                      checked={codes.includes(code)}
                      disabled={disabled}
                      aria-describedby={code === "long_dwell" ? ids.dwell : undefined}
                      onChange={(e) => toggle(code, e.target.checked)}
                    />
                    {PATTERN_NAME[code]}
                  </label>
                );
              })}
            </div>
            <p id={ids.dwell} style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              {D.dwellPersonOnly}
            </p>
          </fieldset>

          <div style={field}>
            <label htmlFor={ids.reason} style={labelStyle}>
              {D.reason}
            </label>
            <input
              id={ids.reason}
              type="text"
              className="expected-input"
              value={reason}
              maxLength={EXPECTED_REASON_MAX}
              autoComplete="off"
              placeholder={D.reasonPlaceholder}
              onChange={(e) => {
                setReason(e.target.value);
                if (problem === D.needReason || problem === D.badReason) setProblem(null);
              }}
              aria-invalid={problem === D.needReason || problem === D.badReason}
              aria-describedby={problem ? ids.problem : undefined}
            />
          </div>

          <div style={field}>
            <label htmlFor={ids.until} style={labelStyle}>
              {D.until}
            </label>
            <select id={ids.until} className="usual-select" value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
              {EXPECTED_LENGTHS.map((l) => (
                <option key={l.days} value={l.days}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          {problem && (
            <p id={ids.problem} role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>
              {problem}
            </p>
          )}
        </div>

        <div className="expected-dialog-f">
          <button type="button" className="btn ghost" onClick={onClose} disabled={pending}>
            {D.cancel}
          </button>
          <button type="submit" className="btn primary" disabled={pending || !key}>
            {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {pending ? D.saving : D.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
