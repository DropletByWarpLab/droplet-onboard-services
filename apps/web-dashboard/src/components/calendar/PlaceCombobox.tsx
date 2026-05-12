"use client";

/**
 * WARP-307 — fuzzy location autocomplete backed by the orchestrator's
 * Nominatim proxy at `GET /api/calendar/places`.
 *
 * Design choices:
 *   - Pure free-text fallback: if the API returns `[]` (offline, rate-limited,
 *     OSM down), the user can still type and submit. Selecting a suggestion
 *     replaces the field contents.
 *   - Debounced 300 ms — OSM ToS is 1 req/sec/IP and we don't want to fire
 *     six lookups for "Pari" → "Paris".
 *   - Keyboard nav: ArrowDown / ArrowUp / Enter (pick) / Escape (close).
 *   - Suggestions clear when the dialog closes (parent toggles `disabled`)
 *     so a reopened form starts from a clean slate.
 */

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { fetchPlaces, type PlaceSuggestion } from "@/lib/api";

interface PlaceComboboxProps {
  value: string;
  onChange: (next: string) => void;
  /** Optional notify when the user explicitly picks a suggestion (vs typing). */
  onSelectSuggestion?: (place: PlaceSuggestion) => void;
  disabled?: boolean;
  className?: string;
  maxLength?: number;
  placeholder?: string;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

export function PlaceCombobox({
  value,
  onChange,
  onSelectSuggestion,
  disabled = false,
  className,
  maxLength = 500,
  placeholder = "Location",
}: PlaceComboboxProps) {
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  // Track which value we just picked so we don't immediately refetch
  // suggestions for the full display name (which would then surface the
  // same suggestion as the only option).
  const lastPickedRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || disabled) return;
    if (value === lastPickedRef.current) return;
    if (value.trim().length < MIN_QUERY_LEN) {
      setSuggestions([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const places = await fetchPlaces(value, 5, ctrl.signal);
        if (!ctrl.signal.aborted) {
          setSuggestions(places);
          setActiveIdx(0);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, open, disabled]);

  function pick(place: PlaceSuggestion) {
    lastPickedRef.current = place.displayName;
    onChange(place.displayName);
    onSelectSuggestion?.(place);
    setSuggestions([]);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (e.key === "Escape") setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const picked = suggestions[activeIdx];
      if (picked) {
        e.preventDefault();
        pick(picked);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && !disabled && suggestions.length > 0;

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        aria-controls="place-suggestions"
        aria-activedescendant={
          showList ? `place-suggestion-${activeIdx}` : undefined
        }
        value={value}
        onChange={(e) => {
          // Any keystroke means the user is editing — clear the
          // "we just picked this" mark so suggestions re-fire.
          lastPickedRef.current = null;
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer close so click on a suggestion lands before blur fires.
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className={className}
        maxLength={maxLength}
        placeholder={placeholder}
        data-testid="place-input"
      />
      {showList && (
        <ul
          id="place-suggestions"
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 dp-card dp-material overflow-hidden z-40 max-h-72 overflow-y-auto"
        >
          {suggestions.map((s, idx) => (
            <li
              key={`${s.lat}|${s.lon}|${idx}`}
              id={`place-suggestion-${idx}`}
              role="option"
              aria-selected={idx === activeIdx}
              // mousedown (not click) so the picker fires BEFORE the
              // input's onBlur tears the list down.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActiveIdx(idx)}
              className={`flex items-start gap-2 px-3 py-2 cursor-pointer ${
                idx === activeIdx
                  ? "bg-accent-subtle"
                  : "hover:bg-surface-secondary"
              }`}
            >
              <MapPin
                size={14}
                className="mt-0.5 flex-shrink-0 text-label-tertiary"
                aria-hidden
              />
              <span className="type-footnote text-label-primary">
                {s.displayName}
              </span>
            </li>
          ))}
        </ul>
      )}
      {loading && !showList && value.trim().length >= MIN_QUERY_LEN && (
        // Tiny "searching…" affordance so the user knows something is
        // happening before suggestions land. Sized to not push layout.
        <span
          className="absolute right-2 top-1/2 -translate-y-1/2 type-caption-2 text-label-tertiary pointer-events-none"
          aria-hidden
        >
          …
        </span>
      )}
    </div>
  );
}
