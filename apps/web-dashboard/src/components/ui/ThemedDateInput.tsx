"use client";

import {
  forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type InputHTMLAttributes, type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { ThemedSelect } from "./ThemedSelect";
import "./themed-date-input.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  type?: "date" | "datetime-local";
  /** Editors with a separate record-clearing action can keep that action authoritative. */
  clearable?: boolean;
};
type Popup = { active: Date; value: string; label: string; host: Element; style: CSSProperties };
const GAP = 8;
const LAYOUT_CLASS = /^(?:(?:[\w-]+:)*(?:w-|min-w-|max-w-|h-|min-h-|max-h-|flex-1$|flex-auto$|flex-none$|grow(?:-|$)|shrink(?:-|$)|basis-|col-|row-|order-|self-))/;
const LAYOUT_STYLE = ["width", "minWidth", "maxWidth", "height", "minHeight", "maxHeight", "flex", "flexGrow", "flexShrink", "flexBasis", "alignSelf", "order", "gridColumn", "gridRow"] as const;

function dateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4,})-(\d{2})-(\d{2})(?:T|$)/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date); next.setDate(next.getDate() + days); return next;
}

function shiftMonths(date: Date, months: number): Date {
  const next = new Date(date); next.setDate(1); next.setMonth(next.getMonth() + months);
  const last = new Date(next); last.setMonth(last.getMonth() + 1, 0);
  next.setDate(Math.min(date.getDate(), last.getDate())); return next;
}

function dayNumber(date: Date): number {
  const utc = new Date(0); utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  utc.setUTCHours(0, 0, 0, 0); return utc.getTime() / 86400000;
}

function temporalNumber(value: string): number {
  const date = parseDate(value);
  if (!date) return NaN;
  const time = value.split("T")[1];
  if (!time) return dayNumber(date) * 86400;
  const parts = /^(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(time);
  if (!parts) return NaN;
  return dayNumber(date) * 86400 + Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3] ?? 0);
}

function fieldLabel(input: HTMLInputElement): string {
  return input.getAttribute("aria-label") || input.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ") ||
    Array.from(input.labels ?? []).map((source) => {
      const copy = source.cloneNode(true) as HTMLLabelElement;
      copy.querySelectorAll("input, button").forEach((control) => control.remove());
      return copy.textContent?.trim();
    }).filter(Boolean).join(" ") || "Date";
}

/** Native editing, validity and events with a themed calendar popup. */
export const ThemedDateInput = forwardRef<HTMLInputElement, Props>(function ThemedDateInput({
  type = "date", clearable = true, className, style, onBlur, onFocus, onKeyDown, ...props
}, forwardedRef) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = useRef<HTMLSpanElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const deferredBlur = useRef(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [label, setLabel] = useState(props["aria-label"] || "Date");
  const popupId = useId();
  const setRef = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element;
    if (typeof forwardedRef === "function") forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  }, [forwardedRef]);

  useLayoutEffect(() => {
    const next = inputRef.current ? fieldLabel(inputRef.current) : "Date";
    if (next !== label) setLabel(next);
  });

  const close = useCallback((restoreFocus = true) => {
    const input = inputRef.current;
    if (restoreFocus && popupRef.current?.contains(document.activeElement) && input && !input.matches(":disabled")) {
      input.focus();
    } else if (deferredBlur.current && input) {
      // Forward the native blur that was deferred while focus was inside the
      // picker. Blur-driven editors still commit when focus really leaves it.
      deferredBlur.current = false;
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.activeElement }));
    }
    setPopup(null);
  }, []);

  function blocked() {
    const input = inputRef.current;
    return !input || input.matches(":disabled") || input.readOnly;
  }

  function bounded(date: Date): Date {
    const input = inputRef.current;
    const min = parseDate(input?.min ?? ""); const max = parseDate(input?.max ?? "");
    if (date.getFullYear() < 1) return parseDate("0001-01-01")!;
    return min && date < min ? min : max && date > max ? max : date;
  }

  function valueFor(date: Date): string {
    const input = inputRef.current;
    const suffix = type === "datetime-local" ? (input?.value.match(/T(.+)$/)?.[1] ?? "09:00") : null;
    const value = dateKey(date) + (suffix ? `T${suffix}` : "");
    // A new datetime on a boundary day must use a time inside that boundary.
    // Existing values retain their exact time/seconds when the date changes.
    if (type === "datetime-local" && !input?.value) {
      if (input?.min.includes("T") && dateKey(date) === input.min.split("T")[0] && temporalNumber(value) < temporalNumber(input.min)) return input.min;
      if (input?.max.includes("T") && dateKey(date) === input.max.split("T")[0] && temporalNumber(value) > temporalNumber(input.max)) return input.max;
    }
    return value;
  }

  function available(date: Date): boolean {
    const input = inputRef.current;
    if (!input || !Number.isFinite(date.getTime()) || date.getFullYear() < 1) return false;
    const value = valueFor(date);
    if (temporalNumber(value) < temporalNumber(input.min) || temporalNumber(value) > temporalNumber(input.max)) return false;
    if (type === "date" && input.step !== "any") {
      const step = Number(input.step || 1);
      const base = parseDate(input.min) ?? parseDate(input.defaultValue) ?? parseDate("1970-01-01")!;
      if (step > 0 && (dayNumber(date) - dayNumber(base)) % step !== 0) return false;
    }
    return true;
  }

  function monthAvailable(date: Date): boolean {
    if (date.getFullYear() < 1) return false;
    const first = new Date(date); first.setDate(1);
    const last = new Date(first); last.setMonth(last.getMonth() + 1, 0);
    const min = parseDate(inputRef.current?.min ?? ""); const max = parseDate(inputRef.current?.max ?? "");
    return !(min && last < min) && !(max && first > max);
  }

  function open() {
    const input = inputRef.current;
    if (!input || blocked()) return;
    const computed = getComputedStyle(input);
    const token = (scoped: string, fallback: string) => computed.getPropertyValue(scoped).trim() || computed.getPropertyValue(fallback).trim();
    input.focus();
    setPopup({
      active: bounded(parseDate(input.value) ?? parseDate(dateKey(new Date()))!),
      value: input.value, label: fieldLabel(input), host: input.closest('[role="dialog"]') ?? document.body,
      style: {
        "--date-surface": token("--surface", "--color-surface-elevated"),
        "--date-hover": token("--surface-2", "--color-surface-secondary"),
        "--date-text": token("--text", "--color-label-primary"),
        "--date-muted": token("--text-muted", "--color-label-secondary"),
        "--date-brand": token("--brand", "--aurora-ink"),
        "--date-fill": token("--brand-fill", "--brand"),
        "--date-ink": token("--on-brand", "--text"),
      } as CSSProperties,
    });
  }

  function choose(value: string) {
    const input = inputRef.current;
    if (!input || blocked()) return;
    if (value !== input.value) {
      // Bypass React's value tracker so a real native event reaches onChange.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
    input.focus();
  }

  function pick(date: Date) { if (available(date)) choose(valueFor(date)); }
  function move(date: Date) { if (popup) setPopup({ ...popup, active: bounded(date) }); }

  function handlePopupKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || !popup) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") {
      const focusables = Array.from(popupRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') ?? []).filter((element) => element.tabIndex >= 0);
      const end = event.shiftKey ? focusables[0] : focusables[focusables.length - 1];
      if (document.activeElement === end) close();
      return;
    }
    // Month/year selectors retain their own native/themed keyboard behavior.
    if (!(event.target as HTMLElement).matches(".themed-date-day")) return;
    let next: Date | null = null;
    if (event.key === "ArrowLeft") next = shiftDays(popup.active, -1);
    else if (event.key === "ArrowRight") next = shiftDays(popup.active, 1);
    else if (event.key === "ArrowUp") next = shiftDays(popup.active, -7);
    else if (event.key === "ArrowDown") next = shiftDays(popup.active, 7);
    else if (event.key === "Home") next = shiftDays(popup.active, -popup.active.getDay());
    else if (event.key === "End") next = shiftDays(popup.active, 6 - popup.active.getDay());
    else if (event.key === "PageUp") next = shiftMonths(popup.active, event.shiftKey ? -12 : -1);
    else if (event.key === "PageDown") next = shiftMonths(popup.active, event.shiftKey ? 12 : 1);
    if (next) { event.preventDefault(); move(next); }
  }

  useLayoutEffect(() => {
    if (!popup) return;
    if (blocked() || inputRef.current?.value !== popup.value) close();
  });

  useEffect(() => {
    if (!popup) return;
    const outside = (event: Event) => {
      if (!fieldRef.current?.contains(event.target as Node) && !popupRef.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popupRef.current?.contains(event.target)) close(); };
    const resize = () => close();
    document.addEventListener("pointerdown", outside); document.addEventListener("mousedown", outside);
    window.addEventListener("scroll", scroll, true); window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize);
    };
  }, [Boolean(popup), close]);

  useLayoutEffect(() => {
    const panel = popupRef.current; const input = inputRef.current;
    if (!panel || !input || !popup) return;
    if (typeof panel.showPopover === "function" && !panel.matches(":popover-open")) panel.showPopover();
    panel.style.top = "0px"; panel.style.left = "0px";
    const trigger = input.getBoundingClientRect();
    panel.style.width = `${Math.min(304, window.innerWidth - GAP * 2)}px`;
    const above = Math.max(0, trigger.top - GAP * 2); const below = Math.max(0, window.innerHeight - trigger.bottom - GAP * 2);
    panel.style.maxHeight = `${Math.max(above, below)}px`;
    const origin = panel.getBoundingClientRect();
    const top = below >= origin.height || below >= above ? trigger.bottom + GAP : trigger.top - GAP - origin.height;
    const left = Math.max(GAP, Math.min(trigger.left, window.innerWidth - GAP - origin.width));
    panel.style.top = `${Math.max(GAP, top) - origin.top}px`; panel.style.left = `${left - origin.left}px`;
  }, [Boolean(popup)]);

  useLayoutEffect(() => {
    if (popup) document.getElementById(`${popupId}-${dateKey(popup.active)}`)?.focus({ preventScroll: true });
  }, [popup?.active, popupId]);

  const layoutClass = className?.split(/\s+/).filter((name) => LAYOUT_CLASS.test(name)).join(" ") ?? "";
  const layoutStyle = Object.fromEntries(LAYOUT_STYLE.filter((key) => style?.[key] !== undefined).map((key) => [key, style![key]])) as CSSProperties;
  const month = popup?.active.getMonth() ?? 0;
  const year = popup?.active.getFullYear() ?? new Date().getFullYear();
  const first = popup ? new Date(popup.active) : null;
  first?.setDate(1);
  const gridStart = first ? shiftDays(first, -first.getDay()) : null;
  const monthLabel = popup?.active.toLocaleDateString(undefined, { month: "long", year: "numeric" }) ?? "";
  const minYear = Math.max(1, year - 100, parseDate(inputRef.current?.min ?? "")?.getFullYear() ?? 1);
  const maxYear = Math.min(year + 100, parseDate(inputRef.current?.max ?? "")?.getFullYear() ?? year + 100);
  const years = Array.from({ length: Math.max(0, maxYear - minYear + 1) }, (_, index) => minYear + index);
  const today = parseDate(dateKey(new Date()))!;

  return <>
    <span ref={fieldRef} className={`themed-date-field ${layoutClass}`.trim()} style={layoutStyle}>
      <input {...props} type={type} ref={setRef} style={style} className={`themed-date-input ${className ?? ""}`.trim()}
        onFocus={(event) => { deferredBlur.current = false; onFocus?.(event); }}
        onBlur={(event) => {
          if (popupRef.current?.contains(event.relatedTarget as Node)) { deferredBlur.current = true; return; }
          deferredBlur.current = false; onBlur?.(event); close(false);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented && !blocked() && (event.key === "Enter" || event.key === " " || (event.altKey && event.key === "ArrowDown"))) {
            event.preventDefault(); if (popup) close(); else open();
          }
        }}
      />
      <button type="button" className="themed-date-trigger" aria-label={`Choose ${label}`}
        aria-haspopup="dialog" aria-expanded={Boolean(popup)} aria-controls={popup ? popupId : undefined}
        disabled={props.disabled || props.readOnly}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { if (popup) close(); else open(); }}>
        <CalendarDays size={16} aria-hidden="true" />
      </button>
    </span>
    {popup && gridStart && createPortal(
      <div ref={popupRef} id={popupId} role="dialog" aria-label={`Choose ${popup.label}`} popover="manual"
        className="themed-date-popup" style={popup.style} onKeyDown={handlePopupKeyDown}
        onClick={(event) => event.stopPropagation()}
        onBlur={(event) => {
          if (event.relatedTarget === inputRef.current || event.currentTarget.contains(event.relatedTarget as Node)) return;
          close(false);
        }}>
        <div className="themed-date-header">
          <button type="button" className="themed-date-nav" aria-label="Previous month" disabled={!monthAvailable(shiftMonths(popup.active, -1))} onClick={() => move(shiftMonths(popup.active, -1))}><ChevronLeft size={16} aria-hidden="true" /></button>
          <ThemedSelect aria-label="Month" className="themed-date-month" value={month} onChange={(event) => move(shiftMonths(popup.active, Number(event.target.value) - month))}>
            {Array.from({ length: 12 }, (_, index) => <option key={index} value={index} disabled={!monthAvailable(shiftMonths(popup.active, index - month))}>{new Date(2024, index, 1).toLocaleDateString(undefined, { month: "long" })}</option>)}
          </ThemedSelect>
          <ThemedSelect aria-label="Year" className="themed-date-year" value={year} onChange={(event) => move(shiftMonths(popup.active, (Number(event.target.value) - year) * 12))}>
            {years.map((item) => <option key={item} value={item}>{item}</option>)}
          </ThemedSelect>
          <button type="button" className="themed-date-nav" aria-label="Next month" disabled={!monthAvailable(shiftMonths(popup.active, 1))} onClick={() => move(shiftMonths(popup.active, 1))}><ChevronRight size={16} aria-hidden="true" /></button>
        </div>
        <span className="sr-only" aria-live="polite">{monthLabel}</span>
        <div role="grid" aria-label={monthLabel} className="themed-date-grid">
          <div role="row" className="themed-date-week themed-date-weekdays">
            {Array.from({ length: 7 }, (_, day) => <span key={day} role="columnheader" aria-label={new Date(2024, 5, 2 + day).toLocaleDateString(undefined, { weekday: "long" })}>{new Date(2024, 5, 2 + day).toLocaleDateString(undefined, { weekday: "narrow" })}</span>)}
          </div>
          {Array.from({ length: 6 }, (_, week) => <div key={week} role="row" className="themed-date-week">
            {Array.from({ length: 7 }, (_, day) => {
              const date = shiftDays(gridStart, week * 7 + day); const key = dateKey(date); const allowed = available(date);
              return <span key={key} role="gridcell" aria-selected={key === popup.value.split("T")[0]}>
                <button type="button" id={`${popupId}-${key}`} className="themed-date-day" data-date={key}
                  data-today={key === dateKey(today) || undefined} data-outside={date.getMonth() !== month || undefined}
                  aria-label={date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                  aria-disabled={!allowed || undefined} aria-pressed={key === popup.value.split("T")[0]}
                  tabIndex={key === dateKey(popup.active) ? 0 : -1}
                  onClick={() => pick(date)}>{date.getDate()}</button>
              </span>;
            })}
          </div>)}
        </div>
        <div className="themed-date-footer">
          <button type="button" className="themed-date-action" disabled={!available(today)} onClick={() => pick(today)}>Today</button>
          {clearable && <button type="button" className="themed-date-action" onClick={() => choose("")}>Clear</button>}
          <button type="button" className="themed-date-action" onClick={() => close()}>Done</button>
        </div>
      </div>, popup.host,
    )}
  </>;
});
