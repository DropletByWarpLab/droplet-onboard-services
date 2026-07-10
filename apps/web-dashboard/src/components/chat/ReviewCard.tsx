"use client";

/**
 * WARP-1121 — the review & apply card (design brief §5): the ONLY place
 * learned knowledge becomes saved knowledge. Standard generative-card
 * grammar (header · body · footer with safety chip).
 *
 * States: default (editable) · unchecked-all/empty (Apply gating, §7.8) ·
 * applying · saved · apply-error (§7.9, edits never lost) · parse-failure
 * (rendered by the page when the proposal didn't parse) · read-only after a
 * 409 conflict (§7.10).
 */
import { useMemo, useState } from "react";
import { Check, Pencil, Sparkles } from "lucide-react";
import {
  INTERVIEW_COPY,
  PROFILE_ROWS,
  type Proposal,
} from "@/lib/interview";

export interface ReviewCardCommit {
  profile: Partial<Record<(typeof PROFILE_ROWS)[number]["field"], string>>;
  summary?: string;
  facts: Array<{ category: string; fact: string; audience: string }>;
}

type Phase = "editing" | "applying" | "saved" | "error";

export function ReviewCard({
  proposal,
  onApply,
  onNotYet,
  onViewSaved,
  readOnly = false,
  initialPhase = "editing",
}: {
  proposal: Proposal;
  /** Resolves on commit success; rejects on failure (card keeps edits). */
  onApply: (payload: ReviewCardCommit) => Promise<void>;
  onNotYet: () => void;
  onViewSaved: () => void;
  /** §7.10 — another admin finished; render the stored proposal inert. */
  readOnly?: boolean;
  /** "saved" when reopening a session whose proposal already committed. */
  initialPhase?: Phase;
}) {
  const [phase, setPhase] = useState<Phase>(readOnly ? "editing" : initialPhase);
  const [fields, setFields] = useState(() => ({ ...proposal.profile }));
  const [summary, setSummary] = useState(proposal.summary);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [checked, setChecked] = useState<boolean[]>(() =>
    proposal.facts.map(() => true),
  );
  const [facts, setFacts] = useState(() => proposal.facts.map((f) => ({ ...f })));
  const [summaryOpen, setSummaryOpen] = useState(false);

  const anythingToSave = useMemo(
    () =>
      checked.some(Boolean) ||
      Object.values(fields).some((v) => (v ?? "").trim() !== "") ||
      summary.trim() !== "",
    [checked, fields, summary],
  );

  async function apply() {
    setPhase("applying");
    try {
      await onApply({
        profile: Object.fromEntries(
          Object.entries(fields).filter(([, v]) => (v ?? "").trim() !== ""),
        ),
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        facts: facts.filter((_, i) => checked[i]),
      });
      setPhase("saved");
    } catch {
      setPhase("error");
    }
  }

  if (phase === "saved") {
    return (
      <div
        data-testid="review-card-saved"
        className="rounded-2xl shadow-sm border border-separator px-5 py-4 flex items-center gap-3"
      >
        <Check size={18} className="text-system-green shrink-0" aria-hidden="true" />
        <span className="type-subheadline text-label-primary">
          {INTERVIEW_COPY.savedLine}
        </span>
        <button
          type="button"
          onClick={onViewSaved}
          className="type-footnote text-accent hover:text-accent-hover ml-auto shrink-0"
        >
          {INTERVIEW_COPY.viewWhatIKnow}
        </button>
      </div>
    );
  }

  const disabled = readOnly || phase === "applying";

  return (
    <div
      data-testid="review-card"
      role="region"
      aria-label={INTERVIEW_COPY.reviewTitle}
      className="rounded-2xl shadow-sm border border-separator overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-5 pt-4">
        <Sparkles size={16} className="text-accent" aria-hidden="true" />
        <div>
          <p className="type-headline text-label-primary">
            {INTERVIEW_COPY.reviewTitle}
          </p>
          <p className="type-caption-1 text-label-secondary">
            {INTERVIEW_COPY.reviewSubtitle}
          </p>
        </div>
      </div>

      {/* Profile rows */}
      <div className="px-5 py-4 space-y-2">
        {PROFILE_ROWS.map(({ field, label }) => {
          const value = fields[field] ?? "";
          if (!value && readOnly) return null;
          const editing = editingField === field;
          return (
            <div key={field} className="flex items-start gap-3">
              <span className="type-caption-1 text-label-secondary w-24 shrink-0 pt-0.5">
                {label}
              </span>
              {editing ? (
                <span className="flex-1">
                  <input
                    aria-label={label}
                    className="dp-input w-full"
                    value={value}
                    maxLength={600}
                    autoFocus
                    onChange={(e) =>
                      setFields((f) => ({ ...f, [field]: e.target.value }))
                    }
                    onBlur={() => setEditingField(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape")
                        setEditingField(null);
                    }}
                  />
                  {value.length >= 500 && (
                    <span className="font-mono type-caption-2 text-label-tertiary">
                      {value.length}/600
                    </span>
                  )}
                </span>
              ) : (
                <span className="type-body text-label-primary flex-1">
                  {value || <span className="text-label-quaternary">—</span>}
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={`Edit ${label}`}
                      onClick={() => setEditingField(field)}
                      className="ml-2 text-label-tertiary hover:text-label-primary align-middle"
                    >
                      <Pencil size={12} aria-hidden="true" />
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Facts */}
      {facts.length > 0 && (
        <div className="px-5 pb-4 space-y-2">
          <p className="type-subheadline text-label-primary">
            {INTERVIEW_COPY.factsHeader}
          </p>
          {facts.map((f, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <input
                type="checkbox"
                aria-label={f.fact}
                checked={checked[i]}
                disabled={disabled}
                onChange={(e) =>
                  setChecked((c) => c.map((v, j) => (j === i ? e.target.checked : v)))
                }
                className="mt-1"
              />
              <span className="type-caption-1 px-2 py-0.5 rounded-full bg-surface-secondary text-label-secondary shrink-0">
                {f.category}
              </span>
              <input
                aria-label={`Fact ${i + 1}`}
                className="type-body text-label-primary flex-1 bg-transparent border-b border-transparent focus:border-separator focus:outline-none"
                value={f.fact}
                maxLength={280}
                disabled={disabled}
                onChange={(e) =>
                  setFacts((all) =>
                    all.map((x, j) => (j === i ? { ...x, fact: e.target.value } : x)),
                  )
                }
              />
              <select
                aria-label={`Who can see fact ${i + 1}`}
                className="dp-input !w-auto type-caption-1"
                value={f.audience}
                disabled={disabled}
                onChange={(e) =>
                  setFacts((all) =>
                    all.map((x, j) =>
                      j === i
                        ? { ...x, audience: e.target.value as "family" | "admin" }
                        : x,
                    ),
                  )
                }
              >
                <option value="family">Everyone here</option>
                <option value="admin">Admins only</option>
              </select>
            </div>
          ))}
        </div>
      )}

      {/* Summary disclosure */}
      <div className="px-5 pb-4">
        <button
          type="button"
          onClick={() => setSummaryOpen((v) => !v)}
          aria-expanded={summaryOpen}
          className="type-subheadline text-label-secondary hover:text-label-primary"
        >
          {INTERVIEW_COPY.summaryDisclosure}
        </button>
        {summaryOpen && (
          <div className="mt-2">
            <textarea
              aria-label={INTERVIEW_COPY.summaryDisclosure}
              className="dp-input w-full"
              rows={3}
              maxLength={1500}
              value={summary}
              disabled={disabled}
              onChange={(e) => setSummary(e.target.value)}
            />
            <span className="font-mono type-caption-2 text-label-tertiary">
              {summary.length}/1500
            </span>
          </div>
        )}
      </div>

      {/* Apply error (§7.9) — edits are all still in local state. */}
      {phase === "error" && (
        <p
          data-testid="review-apply-error"
          role="alert"
          className="px-5 pb-2 type-footnote text-system-red"
        >
          {INTERVIEW_COPY.applyError}
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center gap-3 px-5 py-3 border-t border-separator">
        <span className="type-caption-1 px-2.5 py-1 rounded-full bg-surface-secondary text-label-secondary">
          {INTERVIEW_COPY.safetyChip}
        </span>
        {!anythingToSave && (
          <span className="type-footnote text-label-tertiary">
            {INTERVIEW_COPY.nothingToSave}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onNotYet}
            disabled={disabled}
            className="type-subheadline text-label-secondary hover:text-label-primary px-3 py-2"
          >
            {INTERVIEW_COPY.notYet}
          </button>
          <button
            type="button"
            data-testid="review-apply"
            onClick={apply}
            disabled={disabled || !anythingToSave}
            className="px-5 py-2 rounded-full bg-accent text-white type-subheadline hover:bg-accent-hover disabled:opacity-50"
          >
            {phase === "error" ? INTERVIEW_COPY.tryAgain : INTERVIEW_COPY.apply}
          </button>
        </span>
      </div>
    </div>
  );
}
