"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { SafetyChip } from "@/components/email/SafetyChip";
import { Sect, Toggle } from "@/components/shell/primitives";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import {
  fetchPersona,
  patchPersona,
  type PersonaPreset,
  type PersonaSettings,
  type PersonaUpdate,
  type PersonaVerbosity,
} from "@/lib/api";
import { buildGreeting, PRESET_TILES } from "@/lib/persona-preview";

/**
 * WARP-1119 — Settings → Workspace → "AI personality" (design brief §6
 * Card 1).
 *
 * How Droplet talks — preset picker (2×2 radio tiles with serif greeting
 * previews), the verbosity segmented control + first-names switch, the
 * 1200-cap custom-instructions field, and a LIVE serif preview capsule that
 * re-renders as controls change (local only — it never calls the model).
 *
 * Everything goes through the dirty → Save → confirm pattern (§10): the
 * Save click IS the write confirmation (footer carries the §6 write chip);
 * nothing instant-commits. Saving toasts `Personality updated` (§9) and
 * takes effect on the next reply — the backend reads the persona row fresh
 * per request, so there is nothing to invalidate client-side.
 *
 * Renders NOTHING for family/guest — Settings is an admin surface (§6.3),
 * and the raw customInstructions text is owner/admin-only anyway (§7.3).
 * This component owns the whole "Workspace" Settings group; the business
 * profile card (Phase 3) slots in after the personality card inside the
 * same <section>, passed as `children` — that is the only way a headless
 * card (one with no <Sect> of its own) can land under this group's heading
 * with intra-group spacing instead of the 40px mb-10 gap that separates
 * groups. Children ride the same owner/admin gate: Settings is an admin
 * surface (§6.3), and every card in this group is owner/admin-only anyway.
 *
 * Copy is VERBATIM from the design brief §9 — sentence case, no emoji, no
 * exclamation marks. Indigo shell tokens only (.card / .btn primary / shell
 * Toggle / Sect + the indigo CSS vars, system-red for errors); counters are
 * mono. The serif preview capsules keep `type-display` (Instrument Serif) per
 * the personality design brief — WARP-1344.
 */

const CUSTOM_INSTRUCTIONS_CAP = 1200;

const VERBOSITY_OPTIONS: Array<{ value: PersonaVerbosity; label: string }> = [
  { value: "concise", label: "Concise" },
  { value: "balanced", label: "Balanced" },
  { value: "detailed", label: "Detailed" },
];

/** §9 "Apply error" line — the same never-lose-edits contract applies to a
 *  failed Save here (design brief §7.9). */
const SAVE_ERROR_LINE =
  "That didn’t save — your answers are still here. Try again.";

export function PersonalityCard({ children }: { children?: ReactNode }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const firstName = user?.displayName?.trim().split(/\s+/)[0] || null;

  // Baseline = the last server-acknowledged persona; the controls below are
  // the working copy. Dirty = any difference between the two.
  const [saved, setSaved] = useState<PersonaSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [preset, setPreset] = useState<PersonaPreset>("warm_friendly");
  const [verbosity, setVerbosity] = useState<PersonaVerbosity>("balanced");
  const [useFirstNames, setUseFirstNames] = useState(true);
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const applyServerState = useCallback((p: PersonaSettings) => {
    setSaved(p);
    setPreset(p.preset);
    setVerbosity(p.verbosity);
    setUseFirstNames(p.useFirstNames ?? true);
    setCustom(p.customInstructions ?? "");
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await fetchPersona();
        if (!cancelled) applyServerState(p);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, applyServerState]);

  if (!isAdmin) return null;

  const dirty =
    saved !== null &&
    (preset !== saved.preset ||
      verbosity !== saved.verbosity ||
      useFirstNames !== (saved.useFirstNames ?? true) ||
      custom !== (saved.customInstructions ?? ""));

  // Any edit clears the previous failed-save line — the edits themselves
  // are never cleared (§7.9: never lose edits).
  const touch = () => setSaveError(null);

  const handleSave = async () => {
    if (!saved || saving) return;
    const changes: PersonaUpdate = {};
    if (preset !== saved.preset) changes.preset = preset;
    if (verbosity !== saved.verbosity) changes.verbosity = verbosity;
    if (useFirstNames !== (saved.useFirstNames ?? true)) {
      changes.useFirstNames = useFirstNames;
    }
    if (custom !== (saved.customInstructions ?? "")) {
      changes.customInstructions = custom;
    }
    // Snapshot exactly what we submitted. When the PATCH resolves we adopt
    // the server echo ONLY for fields the user hasn't touched since — edits
    // typed during the in-flight request are never clobbered (§7.9: never
    // lose edits, on the success path too, not just on failure).
    const submitted = { preset, verbosity, useFirstNames, custom };
    setSaveError(null);
    setSaving(true);
    try {
      const updated = await patchPersona(changes);
      // Baseline always advances to the acknowledged row so `dirty` stays
      // honest (a field edited mid-flight now reads dirty against it).
      setSaved(updated);
      setPreset((cur) => (cur === submitted.preset ? updated.preset : cur));
      setVerbosity((cur) =>
        cur === submitted.verbosity ? updated.verbosity : cur,
      );
      setUseFirstNames((cur) =>
        cur === submitted.useFirstNames ? updated.useFirstNames ?? true : cur,
      );
      setCustom((cur) =>
        cur === submitted.custom ? updated.customInstructions ?? "" : cur,
      );
      toast("Personality updated", "success");
    } catch {
      setSaveError(SAVE_ERROR_LINE);
    } finally {
      setSaving(false);
    }
  };

  const previewLine = buildGreeting(preset, verbosity, useFirstNames, firstName);

  return (
    <section className="mb-10">
      <Sect title="Workspace" />

      <div className="card space-y-4">
        {/* Head */}
        <div className="flex items-start gap-2.5">
          <Sparkles
            size={16}
            className="mt-0.5"
            style={{ color: "var(--text-muted)" }}
            aria-hidden
          />
          <div>
            <p className="type-headline" style={{ color: "var(--text)" }}>
              AI personality
            </p>
            <p className="type-footnote mt-0.5" style={{ color: "var(--text-muted)" }}>
              How Droplet talks — on this dashboard and on voice. It never
              changes what stays private.
            </p>
          </div>
        </div>

        {loadFailed ? (
          <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
            Couldn’t load personality settings — refresh to try again.
          </p>
        ) : saved === null ? null : (
          <>
            {/* Preset picker — 2×2 radio tiles, stack on narrow viewports */}
            <div
              role="radiogroup"
              aria-label="Personality preset"
              className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            >
              {PRESET_TILES.map((t) => {
                const on = preset === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      setPreset(t.id);
                      touch();
                    }}
                    className={`text-left rounded-lg border p-3 transition-colors duration-200 ease-smooth
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
                      ${on ? "border-[var(--brand)] ring-1 ring-[var(--brand)] bg-[var(--brand-subtle)]" : "border-[var(--border)] hover:border-[var(--text-faint)]"}`}
                  >
                    <span className="block type-subheadline" style={{ color: "var(--text)" }}>
                      {t.name}
                    </span>
                    <span className="block type-footnote mt-0.5" style={{ color: "var(--text-muted)" }}>
                      {t.desc}
                    </span>
                    {/* Serif preview capsule — type-display (Instrument Serif) is
                        spec'd by the personality design brief and stays. */}
                    <span
                      className="block bg-[var(--brand-subtle)] rounded-md px-2.5 py-1.5 mt-2 type-display text-[15px] leading-snug"
                      style={{ color: "var(--text)" }}
                    >
                      {t.preview(firstName)}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Traits row */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <div className="flex items-center gap-2.5">
                <span className="type-footnote" style={{ color: "var(--text-muted)" }}>
                  Replies:
                </span>
                <div
                  role="radiogroup"
                  aria-label="Reply length"
                  className="inline-flex rounded-lg bg-[var(--inset)] p-0.5"
                >
                  {VERBOSITY_OPTIONS.map((o) => {
                    const on = verbosity === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          setVerbosity(o.value);
                          touch();
                        }}
                        className={`px-3 py-1.5 min-h-[32px] rounded-md type-footnote transition-colors duration-200 ease-smooth
                          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]
                          ${on ? "bg-[var(--card-bg)] text-[var(--text)] shadow-sm font-medium" : "text-[var(--text-muted)]"}`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* The shell Toggle primitive (droplet-shell .sw) — reused, not
                  re-drawn, so the brand on-state color and thumb motion stay
                  cohesive with every other indigo-shell toggle (WARP-1344). */}
              <span className="flex items-center gap-2.5">
                <span className="type-footnote" style={{ color: "var(--text-muted)" }}>
                  Use first names
                </span>
                <Toggle
                  on={useFirstNames}
                  ariaLabel="Use first names"
                  onChange={(next) => {
                    setUseFirstNames(next);
                    touch();
                  }}
                />
              </span>
            </div>

            {/* Custom instructions */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="persona-custom-instructions"
                  className="type-footnote"
                  style={{ color: "var(--text-muted)" }}
                >
                  Custom instructions
                </label>
                <span
                  className="font-mono type-caption-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  {custom.length}/{CUSTOM_INSTRUCTIONS_CAP}
                </span>
              </div>
              <textarea
                id="persona-custom-instructions"
                rows={2}
                value={custom}
                maxLength={CUSTOM_INSTRUCTIONS_CAP}
                placeholder='Anything else about how Droplet should communicate — e.g. “Always give the numbers first.”'
                className="w-full px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-shadow resize-y"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
                onChange={(e) => {
                  setCustom(e.target.value);
                  touch();
                }}
              />
            </div>

            {/* Live preview — serif capsule (type-display stays per the
                personality design brief), re-renders as controls change */}
            <div>
              <p
                className="flex items-center gap-1 type-caption-1 mb-1.5"
                style={{ color: "var(--text-muted)" }}
              >
                <Sparkles size={12} aria-hidden /> Preview
              </p>
              <p
                data-testid="persona-live-preview"
                className="bg-[var(--brand-subtle)] rounded-lg px-3.5 py-2.5 type-display text-[17px] leading-snug"
                style={{ color: "var(--text)" }}
              >
                {previewLine}
              </p>
            </div>

            {saveError && (
              <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
                {saveError}
              </p>
            )}

            {/* Footer — write chip + dirty-gated Save (§10: the Save click
                is the confirmation) */}
            <div
              className="flex items-center justify-between gap-2 pt-3"
              style={{ borderTop: "1px solid var(--card-bd)" }}
            >
              <SafetyChip safety="Write · confirm" />
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || saving}
                className="btn primary type-subheadline !min-h-[40px]"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Design brief §6 Card 2 — the business profile card renders here, in
          this group's <section>, so the two Workspace cards sit 12px apart
          like every other intra-group pair rather than 40px apart. */}
      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}
