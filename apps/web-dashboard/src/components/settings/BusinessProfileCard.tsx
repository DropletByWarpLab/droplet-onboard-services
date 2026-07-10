"use client";

/**
 * WARP-1121 — Settings → Workspace → Business profile (design brief §6 Card 2).
 *
 * States: filled (completed — six editable rows + provenance meta + Re-run
 * onboarding) · empty (not_started|skipped — hint + Run business setup +
 * Add details yourself) · in-flight (in_progress|re_running — read-only rows
 * + Open the interview). Every edit is dirty→Save→confirm; never instant.
 */
import { useEffect, useMemo, useState } from "react";
import { Building2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  fetchBusinessProfile,
  patchBusinessProfile,
  startBusinessOnboarding,
  type BusinessProfileView,
} from "@/lib/api";
import { INTERVIEW_COPY, PROFILE_ROWS } from "@/lib/interview";

const SUB_LINE =
  "What Droplet knows about your business. Everything here stays on this box.";
const EMPTY_LINE = "Droplet hasn't learned your business yet.";
const IN_FLIGHT_LINE = "Interview in progress — finish it in Chat.";

function metaLine(p: BusinessProfileView): string | null {
  if (!p.updatedAt || !p.lastSource) return null;
  const date = new Date(p.updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return p.lastSource === "onboarding"
    ? `Updated ${date} · from your onboarding chat`
    : `Updated ${date} · edited here`;
}

export function BusinessProfileCard() {
  const router = useRouter();
  const [profile, setProfile] = useState<BusinessProfileView | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [manualAdd, setManualAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await fetchBusinessProfile();
        if (cancelled) return;
        setProfile(p);
        setFields(
          Object.fromEntries(
            PROFILE_ROWS.map(({ field }) => [
              field,
              ((p as Record<string, unknown>)[field] as string) ?? "",
            ]),
          ),
        );
      } catch {
        /* card renders nothing on fetch failure — Settings stays usable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!profile) return false;
    return PROFILE_ROWS.some(
      ({ field }) =>
        (fields[field] ?? "") !==
        (((profile as Record<string, unknown>)[field] as string) ?? ""),
    );
  }, [fields, profile]);

  if (!profile || profile.onboardingState === undefined) return null;

  const state = profile.onboardingState;
  const inFlight = state === "in_progress" || state === "re_running";
  const filled = state === "completed";
  const empty = !filled && !inFlight;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const changed = Object.fromEntries(
        Object.entries(fields).filter(
          ([k, v]) =>
            v !== (((profile as Record<string, unknown>)[k] as string) ?? ""),
        ),
      );
      const next = await patchBusinessProfile(changed);
      setProfile(next);
      setManualAdd(false);
    } catch {
      setError(INTERVIEW_COPY.applyError);
    } finally {
      setSaving(false);
    }
  }

  async function openInterview(_reRun: boolean) {
    setError(null);
    try {
      const r = await startBusinessOnboarding();
      router.push(`/chat?c=${encodeURIComponent(r.conversationId)}`);
    } catch {
      setError(INTERVIEW_COPY.applyError);
    }
  }

  const meta = metaLine(profile);

  return (
    <div className="dp-card !p-5 space-y-4" data-testid="business-profile-card">
      <div className="flex items-start gap-2.5">
        <Building2 size={18} className="text-label-secondary mt-0.5" aria-hidden />
        <div>
          <p className="type-headline text-label-primary">Business profile</p>
          <p className="type-footnote text-label-secondary">{SUB_LINE}</p>
        </div>
      </div>

      {empty && !manualAdd && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="type-body text-label-secondary">{EMPTY_LINE}</span>
          <button
            type="button"
            onClick={() => void openInterview(false)}
            className="px-4 py-2 rounded-full bg-accent-subtle text-accent type-subheadline hover:bg-accent/15"
          >
            Run business setup
          </button>
          <button
            type="button"
            onClick={() => setManualAdd(true)}
            className="type-subheadline text-label-secondary hover:text-label-primary"
          >
            Add details yourself
          </button>
        </div>
      )}

      {inFlight && (
        <div className="space-y-2">
          {PROFILE_ROWS.map(({ field, label }) => (
            <div key={field} className="flex items-start gap-3">
              <span className="type-caption-1 text-label-secondary w-28 shrink-0">
                {label}
              </span>
              <span className="type-body text-label-primary">
                {(fields[field] ?? "") || (
                  <span className="text-label-quaternary">—</span>
                )}
              </span>
            </div>
          ))}
          <p className="type-footnote text-label-secondary">{IN_FLIGHT_LINE}</p>
          <button
            type="button"
            onClick={() => void openInterview(false)}
            className="type-subheadline text-accent hover:text-accent-hover"
          >
            Open the interview
          </button>
        </div>
      )}

      {(filled || manualAdd) && !inFlight && (
        <div className="space-y-2.5">
          {PROFILE_ROWS.map(({ field, label }) => (
            <div key={field} className="flex items-start gap-3">
              <label
                htmlFor={`bp-${field}`}
                className="type-caption-1 text-label-secondary w-28 shrink-0 pt-2"
              >
                {label}
              </label>
              <span className="flex-1">
                <input
                  id={`bp-${field}`}
                  className="dp-input w-full"
                  value={fields[field] ?? ""}
                  maxLength={600}
                  onChange={(e) =>
                    setFields((f) => ({ ...f, [field]: e.target.value }))
                  }
                />
                {(fields[field] ?? "").length >= 500 && (
                  <span className="font-mono type-caption-2 text-label-tertiary">
                    {(fields[field] ?? "").length}/600
                  </span>
                )}
              </span>
            </div>
          ))}
          {filled && meta && (
            <p className="type-footnote text-label-tertiary">{meta}</p>
          )}
          {filled && (
            <button
              type="button"
              onClick={() => void openInterview(true)}
              className="inline-flex items-center gap-1.5 type-subheadline text-label-secondary hover:text-label-primary"
            >
              <RefreshCw size={13} aria-hidden />
              {"Re-run onboarding"}
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="type-footnote text-system-red">
          {error}
        </p>
      )}

      {(filled || manualAdd) && !inFlight && (
        <div className="flex items-center gap-3 pt-2 border-t border-separator">
          <span className="type-caption-1 px-2.5 py-1 rounded-full bg-surface-secondary text-label-secondary">
            {INTERVIEW_COPY.safetyChip}
          </span>
          <a
            href="/chat"
            className="type-footnote text-label-secondary hover:text-label-primary"
          >
            Manage remembered facts →
          </a>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="ml-auto px-5 py-2 rounded-full bg-accent text-white type-subheadline hover:bg-accent-hover disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
